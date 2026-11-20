// Foreground reminder adapter, 2026-11-12.
// Setup: import this browser-safe module; no network or native permissions are needed.
// Use sessionReminderScheduler() for prototype in-memory storage only. Inject a clock
// into visibleReminders(); the host, not a clinical module, triggers it on resume/ticks.
// Android must replace the Scheduler adapter with persisted native notification delivery.
// Do not use scheduled reminders for emergency advice.
export function sessionReminderScheduler(onChange = () => {}) {
  const pending = new Map();
  const changed = () => onChange();
  return {
    async schedule(spec) {
      if (!spec || !spec.id || !Number.isFinite(Date.parse(spec.fireAt))) throw new Error("Invalid reminder");
      const handle = "foreground:" + spec.id;
      pending.set(handle, { handle, spec: { ...spec } });
      changed();
      return handle;
    },
    async cancel(handle) {
      pending.delete(handle);
      changed();
    },
    async listPending() {
      return [...pending.values()].sort((a, b) => Date.parse(a.spec.fireAt) - Date.parse(b.spec.fireAt));
    },
  };
}

/** The latest daily occurrence, or the next future one. The calendar recurrence
 *  is evaluated in device-local days (not fixed 24-hour jumps across DST). We expose
 *  only the supported nudge-coordinator recurrence; unknown rules fail closed.
 *  A due occurrence is shown for one day, then becomes expired unless repeated. */
export function occurrenceAt(spec, at) {
  const first = new Date(spec && spec.fireAt);
  const now = new Date(at);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(now.getTime())) return null;
  const rrule = spec.recurrence && spec.recurrence.rrule;
  if (rrule && !/^FREQ=DAILY;COUNT=[1-9][0-9]*$/.test(rrule)) return null;
  const count = rrule ? Number(rrule.split("=")[2]) : 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 366) return null;
  let nearest = null;
  for (let day = 0; day < count; day++) {
    const scheduled = new Date(first.getTime());
    scheduled.setDate(first.getDate() + day);
    const delta = now.getTime() - scheduled.getTime();
    if (delta >= 0 && delta < 24 * 60 * 60 * 1000) nearest = scheduled;
    else if (delta < 0 && !nearest) { nearest = scheduled; break; }
  }
  if (!nearest) return null;
  const due = nearest.getTime() <= now.getTime();
  return { due, fireAt: nearest.toISOString(), key: spec.id + "@" + nearest.toISOString().slice(0, 10) };
}

export function visibleReminders(items, nowIso, acknowledged = new Set()) {
  const seen = acknowledged instanceof Set ? acknowledged : new Set(acknowledged);
  return (items || []).map((item) => {
    const occurrence = occurrenceAt(item.spec, nowIso);
    return occurrence ? { ...item, ...occurrence } : null;
  }).filter((item) => item && !seen.has(item.key));
}

/** The next moment any item's display changes: an occurrence becoming due, or a due one
 *  expiring a day later. Home sets one timer for that moment instead of polling, so a reminder
 *  appears on time while Home stays open. null when nothing will change. */
export function nextChangeAt(items, nowIso) {
  const now = new Date(nowIso).getTime();
  let next = null;
  for (const item of items || []) {
    const occurrence = occurrenceAt(item.spec, nowIso);
    if (!occurrence) continue;
    const at = new Date(occurrence.fireAt).getTime() + (occurrence.due ? 24 * 60 * 60 * 1000 : 0);
    if (at > now && (next === null || at < next)) next = at;
  }
  return next === null ? null : new Date(next).toISOString();
}
