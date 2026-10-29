import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {formatCountdown, selectCalendar} from '../extension/teams-calendar-notification@local/logic.js';

const start = Date.parse('2026-09-29T17:00:00Z');
const one = {occurrenceKey: 'series-1', title: 'Daily', start: '2026-09-29T17:00:00Z', end: '2026-09-29T17:30:00Z'};
const two = {occurrenceKey: 'series-2', title: 'Daily', start: '2026-09-29T17:05:00Z', end: '2026-09-29T17:35:00Z'};
const snapshot = {schemaVersion: 1, status: 'ok', lastSuccessfulSync: '2026-09-29T17:00:00Z', events: [one, two]};

test('next meeting and remaining events include meetings in progress', () => {
    assert.equal(selectCalendar(snapshot, {}, start - 300000).upcoming?.occurrenceKey, 'series-1');
    assert.equal(selectCalendar(snapshot, {}, start - 300001).upcoming?.occurrenceKey, 'series-1');
    assert.equal(selectCalendar(snapshot, {}, start - 300001).remainingToday, 2);
    assert.deepEqual(selectCalendar(snapshot, {}, start).due.map(e => e.occurrenceKey), ['series-1']);
    assert.equal(selectCalendar(snapshot, {}, start).remainingToday, 2);
    assert.equal(selectCalendar(snapshot, {}, start + 30 * 60000).remainingToday, 1);
    assert.equal(selectCalendar(snapshot, {}, start + 35 * 60000).remainingToday, 0);
});

test('countdown rounds up to minutes and abbreviates complete hours', () => {
    assert.equal(formatCountdown(one.start, start - 26 * 60000), '- 26m');
    assert.equal(formatCountdown(one.start, start - (93 * 60000 + 1000)), '- 1h34');
    assert.equal(formatCountdown(one.start, start - 120 * 60000), '- 2h');
    assert.equal(formatCountdown(one.start, start - 1000), '- 1m');
});

test('remaining count uses the local start day and excludes ended events', () => {
    const localEvent = (key, startAt, endAt) => ({
        occurrenceKey: key, title: key, start: startAt.toISOString(), end: endAt.toISOString(),
    });
    const today = new Date(2026, 9, 28, 23, 40);
    const todaySnapshot = {schemaVersion: 1, status: 'ok', lastSuccessfulSync: today.toISOString(), events: [
        localEvent('ended', new Date(2026, 9, 28, 8), new Date(2026, 9, 28, 9)),
        localEvent('active', new Date(2026, 9, 28, 23), new Date(2026, 9, 29, 0, 20)),
        localEvent('future', new Date(2026, 9, 28, 23, 50), new Date(2026, 9, 29, 0, 30)),
        localEvent('tomorrow', new Date(2026, 9, 29, 0, 10), new Date(2026, 9, 29, 0, 40)),
    ]};
    assert.equal(selectCalendar(todaySnapshot, {}, today.getTime()).remainingToday, 2);
    assert.equal(selectCalendar(todaySnapshot, {}, today.getTime()).upcoming?.occurrenceKey, 'future');
    assert.equal(selectCalendar(todaySnapshot, {}, new Date(2026, 9, 28, 23, 55).getTime()).upcoming, undefined);
    assert.equal(selectCalendar(todaySnapshot, {}, new Date(2026, 9, 29, 0, 5).getTime()).remainingToday, 1);
    assert.equal(selectCalendar(todaySnapshot, {}, new Date(2026, 9, 29, 0, 5).getTime()).upcoming?.occurrenceKey, 'tomorrow');
    assert.equal(selectCalendar(todaySnapshot, {}, new Date(2026, 9, 29, 0, 40).getTime()).remainingToday, 0);
});

test('snooze, dismissal, overlap, and end are occurrence specific', () => {
    const actions = {'series-1': {snoozeUntil: start + 120000}};
    assert.deepEqual(selectCalendar(snapshot, actions, start + 60000).due.map(e => e.occurrenceKey), []);
    assert.deepEqual(selectCalendar(snapshot, actions, start + 120000).due.map(e => e.occurrenceKey), ['series-1']);
    actions['series-1'] = {dismissed: true};
    assert.deepEqual(selectCalendar(snapshot, actions, start + 360000).due.map(e => e.occurrenceKey), ['series-2']);
    assert.deepEqual(selectCalendar(snapshot, actions, start + 36 * 60000).due, []);
});

test('stale snapshot is flagged while cached meeting remains visible', () => {
    const state = selectCalendar(snapshot, {}, start + 181000);
    assert.equal(state.stale, true);
    assert.equal(state.due.length, 1);
});

test('meeting sound plays on arrival and snooze return, not on refresh or navigation', () => {
    let now = start - 1000;
    let sounds = 0;
    let errors = 0;
    let failSound = false;
    const source = readFileSync(new URL('../extension/teams-calendar-notification@local/extension.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace('export default class', 'globalThis.CalendarExtension = class');
    const context = vm.createContext({
        Extension: class {}, selectCalendar, formatCountdown,
        GLib: {build_filenamev: parts => parts.join('/'), getenv: () => '/tmp', get_home_dir: () => '/tmp'},
        Date: class extends Date { static now() { return now; } },
        global: {display: {get_sound_player: () => ({play_from_theme: (name, description, cancellable) => {
            sounds++;
            assert.equal(name, 'message');
            assert.equal(cancellable, null);
            if (failSound) throw new Error('Audio unavailable');
        }})}},
        logError: () => errors++,
    });
    vm.runInContext(source, context);
    const extension = new context.CalendarExtension();
    Object.assign(extension, {
        _snapshot: snapshot, _actions: {}, _soundDueKeys: new Set(), _icon: {},
        _calendarIcons: Array.from({length: 10}, (_, number) => String(number)), _plainCalendarIcon: 'plain',
        _countLabel: {},
        _badge: {}, _indicator: {}, _contextMenu: {isOpen: false},
        _label: {remove_style_class_name() {}, add_style_class_name() {}},
        _renderMenu() {}, _renderCard() {}, _saveActions() {},
    });
    extension._refresh();
    assert.equal(sounds, 0);
    assert.equal(extension._label.text, '- 1m');
    assert.equal(extension._icon.gicon, '2');
    now = start;
    extension._refresh();
    assert.equal(sounds, 1);
    now += 60000;
    extension._refresh();
    assert.equal(sounds, 1);
    extension._snooze(one);
    now += 120000;
    extension._refresh();
    assert.equal(sounds, 2);
    assert.equal(extension._badge.visible, false);
    now = start + 181000;
    extension._refresh();
    assert.equal(extension._badge.visible, true);
    assert.equal(extension._label.text, 'Daily');
    assert.equal(sounds, 2, 'sync failure does not play a sound');
    extension._snapshot = {...snapshot, lastSuccessfulSync: new Date(now).toISOString()};
    extension._refresh();
    assert.equal(extension._badge.visible, false, 'badge clears on recovery');
    assert.equal(extension._label.text, 'Daily');
    assert.equal(sounds, 2);
    now = start + 300000;
    extension._refresh();
    assert.equal(sounds, 3);
    extension._selectedDueKey = two.occurrenceKey;
    extension._refresh();
    extension._dismiss(two);
    extension._dismiss(one);
    assert.equal(sounds, 3);
    extension._actions = {};
    failSound = true;
    extension._refresh();
    extension._refresh();
    assert.equal(sounds, 4, 'simultaneous arrivals play once, even if playback fails');
    assert.equal(errors, 1);
    now = start + 36 * 60000;
    extension._refresh();
    assert.equal(extension._badge.visible, true);
    assert.equal(extension._label.text, '', 'cached meeting disappears at its end');
    assert.equal(extension._icon.gicon, '0');
    assert.equal(sounds, 4);

    const later = Array.from({length: 10}, (_, index) => ({
        occurrenceKey: `later-${index}`, title: 'Later',
        start: new Date(now + 3600000 + index * 60000).toISOString(),
        end: new Date(now + 5400000 + index * 60000).toISOString(),
    }));
    extension._snapshot = {...snapshot, lastSuccessfulSync: new Date(now).toISOString(), events: later};
    extension._refresh();
    assert.equal(extension._icon.gicon, 'plain');
    assert.equal(extension._countLabel.text, '10 ·');
    assert.equal(extension._countLabel.visible, true);
    assert.equal(extension._label.text, '- 1h');
    assert.match(extension._indicator.accessible_name, /10 reuniões restantes hoje/);
    extension._snapshot = {...extension._snapshot, events: later.slice(0, 9)};
    extension._refresh();
    assert.equal(extension._icon.gicon, '9');
    assert.equal(extension._countLabel.visible, false);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    extension._snapshot = {...extension._snapshot, events: [{
        occurrenceKey: 'tomorrow', title: 'Tomorrow', start: tomorrow.toISOString(),
        end: new Date(tomorrow.getTime() + 3600000).toISOString(),
    }]};
    extension._refresh();
    assert.equal(extension._label.text, '', 'tomorrow does not get a countdown');
    assert.equal(extension._icon.gicon, '0');
    assert.doesNotMatch(extension._indicator.accessible_name, /Próxima reunião em/);
});

test('context menu offers diagnostics; journal is loaded asynchronously and can be copied', () => {
    const source = readFileSync(new URL('../extension/teams-calendar-notification@local/extension.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace('export default class', 'globalThis.CalendarExtension = class');
    let callback, copied, command, dialog;
    class Actor {
        constructor(props) { Object.assign(this, props); this.children = []; this.clutter_text = {
            set_line_wrap() {}, set_line_wrap_mode() {}, set_ellipsize() {},
        }; }
        add_child(child) { this.children.push(child); }
        set_child(child) { this.child = child; }
        set_policy() {}
    }
    const context = vm.createContext({
        Extension: class {}, selectCalendar, Date,
        GLib: {build_filenamev: parts => parts.join('/'), getenv: () => '/tmp'},
        St: {Label: Actor, BoxLayout: Actor, ScrollView: Actor, PolicyType: {NEVER: 0, AUTOMATIC: 1}, ClipboardType: {CLIPBOARD: 1},
            Clipboard: {get_default: () => ({set_text: (_type, text) => { copied = text; }})}},
        Pango: {WrapMode: {WORD_CHAR: 1}, EllipsizeMode: {NONE: 0}},
        Clutter: {KEY_Escape: 1},
        ModalDialog: {ModalDialog: class {
            constructor() { dialog = this; this.contentLayout = new Actor(); }
            setButtons(buttons) { this.buttons = buttons; }
            connect(_name, handler) { this.onDestroy = handler; }
            open() { return true; }
            close() { this.onDestroy(); }
        }},
        Gio: {
            Cancellable: class { cancel() { this.cancelled = true; } is_cancelled() { return this.cancelled; } },
            SubprocessFlags: {STDOUT_PIPE: 1, STDERR_PIPE: 2},
            Subprocess: {new: args => {
                command = args;
                return {communicate_utf8_async: (_input, _cancel, handler) => { callback = handler; }};
            }},
        },
        PopupMenu: {PopupMenuItem: class extends Actor { constructor() { super(); this.label = {}; } }, PopupSeparatorMenuItem: Actor},
    });
    vm.runInContext(source, context);
    const extension = new context.CalendarExtension();
    const entries = [];
    Object.assign(extension, {_snapshot: snapshot, _actions: {}, _indicator: {menu: {close() {}}},
        _contextMenu: {isOpen: false, removeAll() { entries.length = 0; },
            addMenuItem(item) { entries.push(item); }, addAction(text, action) { entries.push({text, action}); },
            toggle() { this.isOpen = !this.isOpen; }, close() { this.isOpen = false; }}});
    extension._toggleContextMenu();
    assert.equal(extension._contextMenu.isOpen, true);
    assert.equal(entries.at(-1).text, 'Ver diagnóstico…');
    assert.match(entries[0].label.text, /Não foi possível/);
    entries.at(-1).action();
    assert.equal(extension._contextMenu.isOpen, false);
    assert.equal(command[0], 'journalctl');
    assert.ok(command.includes('teams-calendar-notification.service'));
    callback({communicate_utf8_finish: () => [true, 'WARNING calendar sync failed: Empty\n'], get_successful: () => true}, {});
    dialog.buttons[0].action();
    assert.match(copied, /Última atualização/);
    assert.match(copied, /WARNING calendar sync failed/);
    dialog.buttons[1].action();
    assert.equal(extension._diagnosticDialog, null);
});
