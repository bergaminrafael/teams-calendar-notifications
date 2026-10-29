export function selectCalendar(snapshot, actions, now) {
    const events = snapshot?.schemaVersion === 1 && Array.isArray(snapshot.events)
        ? snapshot.events.filter(event => {
            const start = Date.parse(event.start);
            const end = Date.parse(event.end);
            return typeof event.occurrenceKey === 'string' && typeof event.title === 'string' &&
                Number.isFinite(start) && Number.isFinite(end) && end > start;
        }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        : [];
    const last = Date.parse(snapshot?.lastSuccessfulSync);
    const stale = snapshot?.status !== 'ok' || !Number.isFinite(last) || now - last > 180000;
    const active = events.filter(event => Date.parse(event.start) <= now && now < Date.parse(event.end));
    const today = new Date(now);
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const dayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
    const upcoming = events.find(event => now < Date.parse(event.start) && Date.parse(event.start) < dayEnd);
    const remainingToday = events.filter(event => {
        const start = Date.parse(event.start);
        return dayStart <= start && start < dayEnd && Date.parse(event.end) > now;
    }).length;
    const due = active.filter(event => {
        const action = actions[event.occurrenceKey] || {};
        return !action.dismissed && (!action.snoozeUntil || action.snoozeUntil <= now);
    });
    return {events, active, upcoming, remainingToday, due, stale};
}

export function formatCountdown(start, now) {
    const minutes = Math.ceil((Date.parse(start) - now) / 60000);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours ? `- ${hours}h${rest || ''}` : `- ${minutes}m`;
}
