import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from service.calendar_sync import collect_calendar, mark_unavailable, normalize, password_from_pass, write_snapshot


def event(key, *, online=True, recurring=False, cancelled=False):
    return {
        "id": key,
        "occurrenceId": key if recurring else None,
        "iCalUId": key,
        "subject": "Teste",
        "start": {"dateTime": "2026-09-29T17:00:00.0000000", "timeZone": "UTC"},
        "end": {"dateTime": "2026-09-29T17:25:00.0000000", "timeZone": "UTC"},
        "isCancelled": cancelled,
        "isAllDay": False,
        "isOnlineMeeting": online,
        "onlineMeetingProvider": "teamsForBusiness" if online else "unknown",
        "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/test"} if online else None,
    }


class CalendarSyncTest(unittest.TestCase):
    def setUp(self):
        self.start = datetime(2026, 9, 29, tzinfo=timezone.utc)
        self.end = datetime(2026, 9, 30, tzinfo=timezone.utc)

    def test_filters_and_normalizes_real_response_shape(self):
        response = {"success": True, "data": {"value": [
            event("single"), event("occurrence", recurring=True),
            event("appointment", online=False), event("cancelled", cancelled=True),
        ]}}
        snapshot = normalize(response, self.start, self.end)
        self.assertEqual({e["occurrenceKey"] for e in snapshot["events"]}, {"single", "occurrence"})
        self.assertEqual(snapshot["events"][0]["start"], "2026-09-29T17:00:00Z")
        self.assertNotIn("attendees", json.dumps(snapshot))

    def test_refuses_partial_or_failed_response(self):
        for response in (
            {"success": False, "data": {"value": []}},
            {"success": True, "data": {"value": [], "@odata.nextLink": "next"}},
        ):
            with self.assertRaises(ValueError):
                normalize(response, self.start, self.end)

    def test_collects_paginated_calendar_by_splitting_time_window(self):
        calls = []

        def request(start, end):
            calls.append((start, end))
            if start == self.start and end == self.end:
                return {"success": True, "data": {"value": [event("first")], "@odata.nextLink": "next"}}
            if start == self.start:
                return {"success": True, "data": {"value": [event("first")]}}
            return {"success": True, "data": {"value": [event("first"), event("new")]}}

        response = collect_calendar(self.start, self.end, request)
        snapshot = normalize(response, self.start, self.end)
        self.assertEqual(len(calls), 3)
        self.assertEqual({item["occurrenceKey"] for item in snapshot["events"]}, {"first", "new"})

    def test_transient_failure_keeps_last_good_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            original = {"status": "ok", "lastSuccessfulSync": "2026-09-29T17:00:00Z", "events": [event("first")]}
            write_snapshot(original, path)
            with patch('service.calendar_sync.SNAPSHOT', path):
                mark_unavailable()
            self.assertEqual(json.loads(path.read_text()), original)

    def test_rescheduled_occurrence_keeps_key(self):
        original = event("series-instance", recurring=True)
        moved = event("series-instance", recurring=True)
        moved["start"]["dateTime"] = "2026-09-29T18:00:00.0000000"
        moved["end"]["dateTime"] = "2026-09-29T18:25:00.0000000"
        first = normalize({"success": True, "data": {"value": [original]}}, self.start, self.end)
        second = normalize({"success": True, "data": {"value": [moved]}}, self.start, self.end)
        self.assertEqual(first["events"][0]["occurrenceKey"], second["events"][0]["occurrenceKey"])
        self.assertNotEqual(first["events"][0]["start"], second["events"][0]["start"])

    def test_atomic_private_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state" / "snapshot.json"
            write_snapshot({"events": []}, path)
            self.assertEqual(json.loads(path.read_text()), {"events": []})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_password_comes_from_first_pass_line_without_shell(self):
        with patch('service.calendar_sync.subprocess.run') as run:
            run.return_value.stdout = 'secret\nusername: service\n'
            self.assertEqual(password_from_pass('mqtt/teams-calendar'), 'secret')
            self.assertEqual(run.call_args.args[0], ['pass', 'show', 'mqtt/teams-calendar'])
        with self.assertRaises(ValueError):
            password_from_pass('-bad-entry')


if __name__ == "__main__":
    unittest.main()
