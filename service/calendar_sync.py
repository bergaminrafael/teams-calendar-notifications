#!/usr/bin/env python3
"""Query Teams for Linux through MQTT and publish a small local calendar snapshot."""

import argparse
import json
import logging
import os
import queue
import ssl
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

APP = "teams-calendar-notification"
LOG = logging.getLogger(APP)
STATE = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / APP
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / APP / "config.json"
SNAPSHOT = STATE / "snapshot.json"


def utc_iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def graph_time(value):
    stamp = datetime.fromisoformat(value["dateTime"].replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        name = value["timeZone"]
        stamp = stamp.replace(tzinfo=timezone.utc if name == "UTC" else ZoneInfo(name))
    return stamp.astimezone(timezone.utc)


def calendar_data(response):
    if response.get("success") is not True or not isinstance(response.get("data"), dict):
        code = (response.get("error") or {}).get("code") if isinstance(response.get("error"), dict) else None
        raise ValueError(f"calendar query failed ({code})" if code else "calendar query failed")
    data = response["data"]
    if not isinstance(data.get("value"), list):
        raise ValueError("calendar response has no event list")
    return data


def collect_calendar(start, end, request):
    queries = 0

    def collect(window_start, window_end):
        nonlocal queries
        queries += 1
        if queries > 64:
            raise ValueError("calendar requires too many queries")
        data = calendar_data(request(window_start, window_end))
        if "@odata.nextLink" not in data:
            return data["value"]
        seconds = int((window_end - window_start).total_seconds())
        if seconds < 2:
            raise ValueError("calendar remains paginated at minimum window")
        middle = window_start + timedelta(seconds=seconds // 2)
        return collect(window_start, middle) + collect(middle, window_end)

    return {"success": True, "data": {"value": collect(start, end)}}


def normalize(response, start, end):
    data = calendar_data(response)
    if "@odata.nextLink" in data:
        raise ValueError("calendar response is paginated; refusing a partial snapshot")
    events = []
    for item in data["value"]:
        if not isinstance(item, dict) or item.get("isCancelled") or item.get("isAllDay"):
            continue
        if (item.get("responseStatus") or {}).get("response") == "declined":
            continue
        if item.get("isOnlineMeeting") is not True or item.get("onlineMeetingProvider") != "teamsForBusiness":
            continue
        url = (item.get("onlineMeeting") or {}).get("joinUrl") or item.get("onlineMeetingUrl")
        if not isinstance(url, str) or not url.startswith("https://"):
            continue
        key = item.get("occurrenceId") or item.get("iCalUId") or item.get("id")
        if not isinstance(key, str) or not key:
            raise ValueError("Teams event has no occurrence identity")
        begins, finishes = graph_time(item["start"]), graph_time(item["end"])
        if finishes <= begins:
            raise ValueError("Teams event has invalid times")
        events.append({
            "occurrenceKey": key,
            "title": str(item.get("subject") or "Reunião Teams"),
            "start": utc_iso(begins),
            "end": utc_iso(finishes),
            "joinUrl": url,
        })
    unique = {}
    for event in events:
        key = event["occurrenceKey"]
        if key in unique and unique[key] != event:
            raise ValueError("duplicate occurrence identity")
        unique[key] = event
    return {
        "schemaVersion": 1,
        "lastSuccessfulSync": utc_iso(datetime.now(timezone.utc)),
        "coverageStart": utc_iso(start),
        "coverageEnd": utc_iso(end),
        "status": "ok",
        "events": sorted(unique.values(), key=lambda e: (e["start"], e["occurrenceKey"])),
    }


def write_snapshot(value, path=SNAPSHOT):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, temporary = tempfile.mkstemp(prefix=".snapshot-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def mark_unavailable():
    try:
        previous = json.loads(SNAPSHOT.read_text())
    except (OSError, ValueError):
        previous = {"schemaVersion": 1, "events": []}
    if previous.get("lastSuccessfulSync"):
        return  # The extension marks the last good snapshot stale after three minutes.
    previous["status"] = "unavailable"
    write_snapshot(previous)


def wait_for_next_query(seconds=60):
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(min(5, deadline - time.time()))


def password_from_pass(entry):
    if not isinstance(entry, str) or not entry or entry.startswith('-'):
        raise ValueError("passwordEntry must name a pass entry")
    result = subprocess.run(
        ["pass", "show", entry], check=True, capture_output=True, text=True, timeout=60,
    )
    password = result.stdout.splitlines()[0] if result.stdout else ""
    if not password:
        raise ValueError("pass entry has an empty password")
    return password


def run(config):
    import paho.mqtt.client as mqtt

    url = urlparse(config["brokerUrl"])
    if url.scheme not in ("mqtt", "mqtts") or not url.hostname:
        raise ValueError("brokerUrl must be an mqtt:// or mqtts:// URL")
    if url.scheme == "mqtt" and url.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("network brokers must use mqtts:// to protect calendar data and credentials")
    prefix = config.get("topicPrefix", "teams").strip("/")
    if not prefix or any(c in prefix for c in "+#"):
        raise ValueError("invalid topicPrefix")
    ready = threading.Event()
    inbox = queue.Queue()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=config.get("clientId", "teams-calendar-notification"))
    client.username_pw_set(config["username"], password_from_pass(config["passwordEntry"]))
    if url.scheme == "mqtts":
        client.tls_set(ca_certs=config.get("caFile"), tls_version=ssl.PROTOCOL_TLS_CLIENT)

    def on_connect(client, _userdata, _flags, reason, _properties):
        if not reason.is_failure:
            client.subscribe(f"{prefix}/calendar", qos=1)
        else:
            LOG.warning("MQTT connection refused: %s", reason)

    def on_subscribe(_client, _userdata, _mid, reasons, _properties):
        if reasons and all(not reason.is_failure for reason in reasons):
            ready.set()

    def on_disconnect(_client, _userdata, _flags, _reason, _properties):
        ready.clear()

    def on_message(_client, _userdata, message):
        if message.retain:
            return
        inbox.put(message.payload)

    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.connect_async(url.hostname, url.port or (8883 if url.scheme == "mqtts" else 1883))
    client.loop_start()
    try:
        while True:
            if not ready.wait(20):
                LOG.warning("MQTT unavailable")
                mark_unavailable()
                wait_for_next_query(40)
                continue
            while not inbox.empty():
                inbox.get_nowait()
            now = datetime.now(timezone.utc)
            start = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            end = (now + timedelta(days=2)).replace(hour=0, minute=0, second=0, microsecond=0)
            try:
                def request(window_start, window_end):
                    command = {"action": "get-calendar", "startDate": utc_iso(window_start), "endDate": utc_iso(window_end)}
                    result = client.publish(f"{prefix}/command", json.dumps(command), qos=1, retain=False)
                    if result.rc != mqtt.MQTT_ERR_SUCCESS:
                        raise ValueError("MQTT publish failed")
                    payload = inbox.get(timeout=20)
                    if not ready.is_set():
                        raise ValueError("MQTT disconnected during query")
                    return json.loads(payload)

                snapshot = normalize(collect_calendar(start, end, request), start, end)
                write_snapshot(snapshot)
                LOG.info("calendar synced: %d Teams meetings", len(snapshot["events"]))
            except (queue.Empty, ValueError, KeyError, TypeError, UnicodeDecodeError) as error:
                LOG.warning("calendar sync failed: %s", error if isinstance(error, ValueError) else type(error).__name__)
                mark_unavailable()
            wait_for_next_query()
    finally:
        client.loop_stop()
        client.disconnect()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG)
    parser.add_argument("--demo", action="store_true", help="write a synthetic meeting starting in 10 seconds")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if args.demo:
        now = datetime.now(timezone.utc)
        write_snapshot({
            "schemaVersion": 1,
            "lastSuccessfulSync": utc_iso(now),
            "coverageStart": utc_iso(now),
            "coverageEnd": utc_iso(now + timedelta(hours=1)),
            "status": "ok",
            "events": [{
                "occurrenceKey": "demo-meeting",
                "title": "Demonstração · reunião Teams",
                "start": utc_iso(now + timedelta(seconds=10)),
                "end": utc_iso(now + timedelta(minutes=5)),
                "joinUrl": "",
            }],
        })
        return
    config = json.loads(args.config.read_text())
    run(config)


if __name__ == "__main__":
    main()
