import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {formatCountdown, selectCalendar} from './logic.js';

const STATE_DIR = GLib.build_filenamev([
    GLib.getenv('XDG_STATE_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']),
    'teams-calendar-notification',
]);
const SNAPSHOT = GLib.build_filenamev([STATE_DIR, 'snapshot.json']);
const ACTIONS = GLib.build_filenamev([STATE_DIR, 'actions.json']);

function readJson(path, fallback) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : fallback;
    } catch (_error) {
        return fallback;
    }
}

function button(label, callback) {
    const item = new St.Button({
        label,
        style_class: 'teams-calendar-action',
        can_focus: true,
        reactive: true,
        track_hover: true,
    });
    item.connect('clicked', callback);
    return item;
}

export default class TeamsCalendarNotification extends Extension {
    enable() {
        this._soundDueKeys = new Set();
        GLib.mkdir_with_parents(STATE_DIR, 0o700);
        this._actions = readJson(ACTIONS, {});
        if (!this._actions || Array.isArray(this._actions) || typeof this._actions !== 'object') this._actions = {};
        this._snapshot = readJson(SNAPSHOT, null);
        this._indicator = new PanelMenu.Button(0.0, 'Reuniões Teams', false);
        const row = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        const iconDir = this.dir.get_child('icons');
        this._calendarIcons = Array.from({length: 10}, (_, number) =>
            new Gio.FileIcon({file: iconDir.get_child(`calendar-${number}.svg`)}));
        this._plainCalendarIcon = new Gio.FileIcon({file: iconDir.get_child('calendar.svg')});
        this._icon = new St.Icon({gicon: this._calendarIcons[0], style_class: 'system-status-icon'});
        this._countLabel = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._label = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'teams-calendar-panel-label'});
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        row.add_child(this._icon);
        row.add_child(this._countLabel);
        row.add_child(this._label);
        this._badge = new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            style_class: 'teams-calendar-sync-badge',
            accessible_name: 'Agenda sem atualização recente',
            visible: false,
        });
        row.add_child(this._badge);
        this._indicator.add_child(row);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator._clickGesture.set_required_button(1);
        this._contextMenu = new PopupMenu.PopupMenu(this._indicator, 0.0, St.Side.TOP);
        this._contextMenu.actor.add_style_class_name('panel-menu');
        Main.uiGroup.add_child(this._contextMenu.actor);
        this._contextMenu.actor.hide();
        this._contextMenuManager = new PopupMenu.PopupMenuManager(this._indicator);
        this._contextMenuManager.addMenu(this._contextMenu);
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._contextMenu.close();
        });
        const contextClick = new Clutter.ClickGesture({required_button: 3, recognize_on_press: true});
        contextClick.connect('recognize', () => this._toggleContextMenu());
        this._indicator.add_action(contextClick);
        this._indicator.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Menu ||
                (event.get_key_symbol() === Clutter.KEY_F10 && event.get_state() & Clutter.ModifierType.SHIFT_MASK)) {
                this._toggleContextMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._card = new St.BoxLayout({vertical: true, style_class: 'teams-calendar-card', visible: false});
        Main.layoutManager.addChrome(this._card, {trackFullscreen: false});
        this._monitor = Gio.File.new_for_path(STATE_DIR).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitorId = this._monitor.connect('changed', (_monitor, file) => {
            if (file.get_basename() === 'snapshot.json') {
                this._snapshot = readJson(SNAPSHOT, null);
                this._refresh();
            }
        });
        this._layoutId = Main.layoutManager.connect('monitors-changed', () => this._placeCard());
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._refresh();
    }

    disable() {
        this._diagnosticDialog?.destroy();
        this._contextMenu?.destroy();
        this._contextMenu = null;
        this._contextMenuManager = null;
        if (this._timer) GLib.Source.remove(this._timer);
        if (this._monitorId) this._monitor.disconnect(this._monitorId);
        this._monitor?.cancel();
        if (this._layoutId) Main.layoutManager.disconnect(this._layoutId);
        this._card?.destroy();
        this._indicator?.destroy();
        this._timer = this._monitorId = this._layoutId = 0;
        this._monitor = this._card = this._indicator = null;
    }

    _saveActions() {
        GLib.file_set_contents(ACTIONS, JSON.stringify(this._actions));
    }

    _refresh() {
        const now = Date.now();
        const {events, active, upcoming, remainingToday, due, stale} = selectCalendar(this._snapshot, this._actions, now);

        this._badge.visible = stale;
        this._icon.gicon = remainingToday < 10 ? this._calendarIcons[remainingToday] : this._plainCalendarIcon;
        const current = due[0] || active[0];
        this._label.remove_style_class_name('teams-calendar-panel-active');
        if (current) {
            this._label.text = `${current.title.replace(/\s+/g, ' ')}${active.length > 1 ? ` (+${active.length - 1})` : ''}`;
            this._label.add_style_class_name('teams-calendar-panel-active');
        } else if (upcoming) {
            this._label.text = formatCountdown(upcoming.start, now);
        } else {
            this._label.text = '';
        }
        this._countLabel.visible = remainingToday >= 10;
        this._countLabel.text = remainingToday >= 10
            ? `${remainingToday}${this._label.text ? ' ·' : ''}` : '';
        const remainingDescription = `${remainingToday} ${remainingToday === 1 ? 'reunião restante' : 'reuniões restantes'} hoje`;
        const nextDescription = upcoming ? ` · Próxima reunião em ${formatCountdown(upcoming.start, now).slice(2)}` : '';
        this._indicator.accessible_name = `Reuniões Teams · ${remainingDescription}${nextDescription}${stale ? ' · Agenda sem atualização recente' : ''}`;
        if (this._contextMenu.isOpen) this._updateSyncStatus();
        const menuSignature = JSON.stringify([events.map(e => [e.occurrenceKey, e.title, e.start, e.end]), Math.floor(now / 60000)]);
        if (menuSignature !== this._menuSignature) {
            this._menuSignature = menuSignature;
            this._renderMenu(events, now);
        }
        const cardSignature = JSON.stringify([due.map(e => e.occurrenceKey), Math.floor(now / 60000), this._selectedDueKey]);
        if (cardSignature !== this._cardSignature) {
            this._cardSignature = cardSignature;
            this._renderCard(due);
        }
        const playSound = due.some(event => !this._soundDueKeys.has(event.occurrenceKey));
        this._soundDueKeys = new Set(due.map(event => event.occurrenceKey));
        if (playSound) {
            try {
                global.display.get_sound_player().play_from_theme('message', 'Reunião Teams', null);
            } catch (error) {
                logError(error, 'Não foi possível tocar o aviso de reunião');
            }
        }
    }

    _syncStatus() {
        const now = Date.now();
        const {stale} = selectCalendar(this._snapshot, this._actions, now);
        const last = Date.parse(this._snapshot?.lastSuccessfulSync);
        return [
            stale ? 'Não foi possível atualizar a agenda' : 'Agenda atualizada',
            Number.isFinite(last)
                ? `Última atualização: ${new Date(last).toLocaleString('pt-BR')} · há ${Math.max(0, Math.floor((now - last) / 60000))} min`
                : 'Nenhuma sincronização bem-sucedida',
            stale ? 'Tentando novamente automaticamente. Os eventos salvos continuam disponíveis.' : '',
        ].filter(Boolean);
    }

    _updateSyncStatus() {
        const lines = this._syncStatus();
        this._statusItems.forEach((item, index) => {
            item.label.text = lines[index] || '';
            item.visible = Boolean(lines[index]);
        });
    }

    _toggleContextMenu() {
        this._indicator.menu.close();
        if (!this._contextMenu.isOpen) {
            this._contextMenu.removeAll();
            this._statusItems = Array.from({length: 3}, () => {
                const item = new PopupMenu.PopupMenuItem('', {reactive: false});
                this._contextMenu.addMenuItem(item);
                return item;
            });
            this._updateSyncStatus();
            this._contextMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._contextMenu.addAction('Ver diagnóstico…', () => this._showDiagnostics());
        }
        this._contextMenu.toggle();
    }

    _showDiagnostics() {
        this._contextMenu.close();
        if (this._diagnosticDialog) return;
        const dialog = new ModalDialog.ModalDialog();
        this._diagnosticDialog = dialog;
        const status = this._syncStatus().join('\n');
        dialog.contentLayout.add_child(new St.Label({text: 'Diagnóstico da agenda Teams', style_class: 'teams-calendar-title'}));
        const scroll = new St.ScrollView({style_class: 'teams-calendar-diagnostics', overlay_scrollbars: true});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const content = new St.BoxLayout({vertical: true});
        const label = new St.Label({text: `${status}\n\nCarregando registros do serviço…`});
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        content.add_child(label);
        scroll.set_child(content);
        dialog.contentLayout.add_child(scroll);
        dialog.setButtons([
            {label: 'Copiar diagnóstico', action: () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, label.text)},
            {label: 'Fechar', action: () => dialog.close(), key: Clutter.KEY_Escape, default: true},
        ]);
        const cancellable = new Gio.Cancellable();
        let process = null;
        dialog.connect('destroy', () => {
            cancellable.cancel();
            process?.force_exit();
            this._diagnosticDialog = null;
        });
        if (!dialog.open()) {
            dialog.destroy();
            return;
        }
        try {
            process = Gio.Subprocess.new([
                'journalctl', '--user', '-u', 'teams-calendar-notification.service',
                '-n', '50', '--no-pager', '--output=short-iso',
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            process.communicate_utf8_async(null, cancellable, (source, result) => {
                try {
                    const [, stdout] = source.communicate_utf8_finish(result);
                    if (!cancellable.is_cancelled()) {
                        const logs = source.get_successful() ? stdout.trim() || 'Nenhum registro disponível.' : 'Não foi possível ler os registros do serviço.';
                        label.text = `${status}\n\nÚltimos 50 registros do serviço:\n${logs}`;
                    }
                } catch (_error) {
                    if (!cancellable.is_cancelled()) label.text = `${status}\n\nNão foi possível ler os registros do serviço.`;
                } finally {
                    process = null;
                }
            });
        } catch (_error) {
            label.text = `${status}\n\nNão foi possível iniciar a leitura dos registros.`;
        }
    }

    _renderMenu(events, now) {
        const menu = this._indicator.menu;
        menu.removeAll();
        const relevant = events.filter(e => Date.parse(e.end) > now && Date.parse(e.start) < now + 86400000);
        if (!relevant.length) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem('Nenhuma reunião Teams próxima', {reactive: false}));
            return;
        }
        const today = new Date(now).toDateString();
        let shownDay = null;
        for (const event of relevant) {
            const date = new Date(event.start);
            const day = date.toDateString();
            if (day !== shownDay) {
                if (shownDay !== null) menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                const label = day === today ? 'Hoje' : 'Amanhã';
                const shortDate = date.toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'});
                const heading = new PopupMenu.PopupMenuItem(`${label} · ${shortDate}`, {reactive: false});
                heading.label.add_style_class_name('teams-calendar-day-heading');
                menu.addMenuItem(heading);
                shownDay = day;
            }
            const when = date.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
            const item = new PopupMenu.PopupMenuItem(`${when} · ${event.title}`);
            item.connect('activate', () => {
                this._actions[event.occurrenceKey] = {};
                this._saveActions();
                this._refresh();
            });
            menu.addMenuItem(item);
        }
    }

    _renderCard(due) {
        this._card.destroy_all_children();
        if (!due.length) {
            this._card.hide();
            return;
        }
        const selected = due.findIndex(e => e.occurrenceKey === this._selectedDueKey);
        const event = due[selected < 0 ? 0 : selected];
        const now = Date.now();
        const mins = Math.floor((now - Date.parse(event.start)) / 60000);
        const start = new Date(event.start).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
        const end = new Date(event.end).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
        const title = new St.Label({text: event.title, style_class: 'teams-calendar-title'});
        title.clutter_text.set_line_wrap(true);
        this._card.add_child(title);
        this._card.add_child(new St.Label({
            text: `${start}–${end} · ${mins ? `começou há ${mins} min` : 'no horário da reunião'}`,
            style_class: 'teams-calendar-subtitle',
        }));
        if (due.length > 1) this._card.add_child(new St.Label({text: `Mais ${due.length - 1} reunião(ões) em andamento`}));
        const actions = new St.BoxLayout({style_class: 'teams-calendar-actions'});
        if (typeof event.joinUrl === 'string' && event.joinUrl.startsWith('https://')) {
            actions.add_child(button('Entrar', () => this._openAndDismiss(event)));
        }
        actions.add_child(button('Adiar 2 min', () => this._snooze(event)));
        actions.add_child(button('Dispensar', () => this._dismiss(event)));
        if (due.length > 1) actions.add_child(button('Próxima', () => {
            this._selectedDueKey = due[((selected < 0 ? 0 : selected) + 1) % due.length].occurrenceKey;
            this._refresh();
        }));
        this._card.add_child(actions);
        this._card.show();
        this._placeCard();
    }

    _dismiss(event) {
        this._actions[event.occurrenceKey] = {dismissed: true};
        this._saveActions();
        this._refresh();
    }

    _snooze(event) {
        this._actions[event.occurrenceKey] = {snoozeUntil: Date.now() + 120000};
        this._saveActions();
        this._refresh();
    }

    _openAndDismiss(event) {
        try {
            const isTeamsMeeting = /^https:\/\/teams\.(?:microsoft\.com|live\.com|cloud\.microsoft)\/(?:l\/meetup-join\/|meet\/)/i.test(event.joinUrl);
            const uri = isTeamsMeeting ? event.joinUrl.replace(/^https:/i, 'msteams:') : event.joinUrl;
            if (Gio.AppInfo.launch_default_for_uri(uri, null)) this._dismiss(event);
        } catch (error) {
            logError(error, 'Não foi possível abrir o link Teams');
        }
    }

    _placeCard() {
        if (!this._card?.visible) return;
        const monitor = Main.layoutManager.primaryMonitor;
        const [, width] = this._card.get_preferred_width(-1);
        const [indicatorX] = this._indicator.get_transformed_position();
        const x = Math.max(monitor.x + 8, Math.min(indicatorX, monitor.x + monitor.width - width - 8));
        this._card.set_position(x, monitor.y + Main.panel.height + 12);
    }
}
