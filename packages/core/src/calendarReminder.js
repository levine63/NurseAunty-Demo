// packages/core/src/calendarReminder.js - turn a nudge-coordinator reminder into a calendar file.
//
// Why: Nurse Aunty is a web page, and a page only runs while it is open, so the in-app reminder
// cannot fire on day 2 of a zinc course once she has closed it. A standard .ics file imported into
// the phone's own calendar can: the phone's alarm fires it offline with the app closed.
//
// Plain JavaScript with no imports, on purpose: tools/build-pwa.mjs wraps every packages/core module
// ui-core.js imports into the single-file build, and the slice imports it directly. No DOM and no
// globals are touched except inside downloadIcs(), which takes its environment as a parameter, so
// everything here runs in Node and is tested there.
//
// The privacy rule that matters more than the features. Whoever picks up the phone reads the
// calendar, and the calendar is outside the app's privacy controls and translation system. So the
// event carries only what the nudge coordinator already decided is safe to show on a shared phone:
// its notification title and body, which depend on the request's privacy class. This module never
// reads the request's module, topic, or phrase family, never a name, and refuses to write the file
// if the text it would write contains a danger sign, a diagnosis, a body part, a maternal
// condition, or a name the caller says to keep out (the same rule as SMS, invariant 5). A sensitive
// request gets "You have a care reminder", not "give zinc for diarrhoea".

/** One calendar entry is a 15-minute block that does not mark the caregiver busy. */
export const EVENT_MINUTES = 15;
/** A course longer than this is a configuration mistake, not a reminder. Zinc runs 10-14 days. */
export const MAX_COURSE_DAYS = 60;
/** The file name a caregiver sees in Downloads. Neutral: no module, no condition. */
export const ICS_FILE_NAME = "reminder.ics";

export class CalendarReminderError extends Error {}

// Words that must never reach a shared-phone calendar. Prefix matches catch inflections
// ("diarrhoea", "diarrhea"); the short body-part words are whole-word so "early" is not "ear".
// This is a guard behind the structural rule above, not the rule itself.
const SENSITIVE_PREFIXES = /\b(zinc|ors\b|oral rehydration|diarrh|blood|stool|fever|danger|convuls|vomit|dehydrat|pneumon|malaria|measles|cough|breath|chest|breast|pregnan|labou?r|birth|postpartum|newborn|miscarr|bleed|contracept|hiv\b|tubercul|abdomen|belly)/i;
const SENSITIVE_WORDS = /\b(ear|ears|eye|eyes|tooth|teeth|skin|womb|uterus|vagina|period|periods)\b/i;

/** Throws if `text` would put something sensitive on a shared phone's calendar. `forbidden` is a
 *  list of strings that must not appear (for example the people's names in the app). */
export function assertCalendarSafe(text, forbidden = []) {
  const value = String(text == null ? "" : text);
  if (SENSITIVE_PREFIXES.test(value) || SENSITIVE_WORDS.test(value)) {
    throw new CalendarReminderError("calendar text contains a sensitive term: " + value.slice(0, 40));
  }
  const lowered = value.toLowerCase();
  for (const name of forbidden) {
    const needle = String(name || "").trim().toLowerCase();
    if (needle.length >= 2 && lowered.includes(needle)) {
      throw new CalendarReminderError("calendar text contains a name that must stay private");
    }
  }
  return value;
}

/** The only recurrence the calendar export understands: every day for N days. Anything else is
 *  refused rather than guessed, because a wrong repeat count is a wrong treatment length. */
export function parseDailyCount(rrule) {
  const match = /^FREQ=DAILY;COUNT=(\d{1,3})$/.exec(String(rrule || ""));
  if (!match) throw new CalendarReminderError("unsupported recurrence: " + String(rrule).slice(0, 40));
  const count = Number(match[1]);
  if (count < 1 || count > MAX_COURSE_DAYS) throw new CalendarReminderError("course length out of range: " + count);
  return count;
}

/** The window a reminder may fire in, today: the preferred hours, or if they have already passed,
 *  from one minute from now for a day, so an explicit tap is not rejected as expired. Same fallback
 *  as requestInAppReminder() in apps/pwa-sandbox/ui-core.js. Local-time arithmetic: the caregiver's
 *  "6 pm" is her phone's 6 pm. */
export function reminderWindow({ now, startTime = "18:00", endTime = "21:00" }) {
  const at = (hhmm) => {
    const [h, m] = String(hhmm).split(":").map(Number);
    const d = new Date(now.getTime());
    d.setHours(h, m, 0, 0);
    return d;
  };
  let start = at(startTime);
  let end = at(endTime);
  if (start < now) { start = new Date(now.getTime() + 60000); end = new Date(start.getTime() + 24 * 60 * 60 * 1000); }
  if (end <= start) end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
  return { windowStart: start.toISOString(), windowEnd: end.toISOString() };
}

/** A nudge request for a course of daily reminders, in the shape the coordinator takes. The number
 *  of days is a parameter: callers pass the resolved course length (zincCourseDays), never a literal. */
export function dailyCourseRequest({ now, moduleId, topic, nudge = {}, days, privacyClass = "sensitive_topic" }) {
  const { windowStart, windowEnd } = reminderWindow({
    now,
    startTime: (nudge.defaultWindow && nudge.defaultWindow.start) || "18:00",
    endTime: (nudge.defaultWindow && nudge.defaultWindow.end) || "21:00",
  });
  parseDailyCount("FREQ=DAILY;COUNT=" + days);
  return {
    requestId: moduleId + "-calendar-" + now.getTime(),
    moduleId,
    topic,
    urgencyTier: nudge.urgencyTier === "clinical_safety" ? "clinical_safety" : nudge.urgencyTier === "time_sensitive" ? "adherence_habit" : "informational_encouragement",
    windowStart,
    windowEnd,
    phraseFamily: nudge.phraseFamily || "tx.nudge.encouragement",
    privacyClass,
    channelsAllowed: ["local"],
    expiresAt: new Date(new Date(windowEnd).getTime() + 86400000).toISOString(),
    bundleKey: nudge.bundleKey || "care-planning",
    recurrence: { rrule: "FREQ=DAILY;COUNT=" + days },
  };
}

/** Run one request through the real nudge coordinator on its own, and return the ScheduleSpec it
 *  produced. A throwaway coordinator, not the in-app one: a calendar export should not be bundled
 *  with, or dropped by the budget of, whatever else the app has scheduled. Quiet hours, privacy
 *  class and neutral copy still apply, because they are the coordinator's. */
export async function coordinatorSpecFor({ createNudgeCoordinator, request, preferences, translate, now }) {
  let captured = null;
  const coordinator = createNudgeCoordinator({
    clock: { now: () => now.toISOString() },
    scheduler: {
      schedule: async (spec) => { captured = spec; return "calendar:" + spec.id; },
      cancel: async () => {},
      listPending: async () => (captured ? [{ handle: "calendar:" + captured.id, spec: captured }] : []),
    },
    audit: { log: async () => {} },
    i18n: { t: translate },
  }, { preferences });
  const decisions = await coordinator.scheduleRequests([request]);
  const decision = decisions.find((d) => (d.requestIds || []).includes(request.requestId)) || { action: "dropped_expired" };
  return { spec: decision.action === "scheduled" || decision.action === "bundled" ? captured : null, decision };
}

// --- the file ----------------------------------------------------------------------------------
const pad = (n, width = 2) => String(n).padStart(width, "0");
const utcStamp = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
// "Floating" local time (no Z, no zone): the phone reads it in its own zone, so a daily 6 pm
// reminder stays at 6 pm across a clock change instead of drifting an hour with UTC.
const localStamp = (d, offsetMinutes) => {
  const l = new Date(d.getTime() + offsetMinutes * 60000);
  return l.getUTCFullYear() + pad(l.getUTCMonth() + 1) + pad(l.getUTCDate()) + "T" + pad(l.getUTCHours()) + pad(l.getUTCMinutes()) + pad(l.getUTCSeconds());
};

/** RFC 5545 TEXT escaping. */
function escapeText(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** RFC 5545 line folding: lines longer than 75 octets continue on the next line after a space,
 *  never splitting a multi-byte character (Hindi and French text are not ASCII). */
export function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > limit) { out.push(current); current = " "; bytes = 1; limit = 75; }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n");
}

/** A stable id that does not leak what the reminder is for: ScheduleSpec ids contain the module
 *  name, so the calendar's UID is a hash of it. Not security, just not telling. */
function opaqueId(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Build the .ics text from a coordinator ScheduleSpec. Reads only spec.fireAt, spec.recurrence and
 *  spec.payload.notification: nothing about the module, topic or people can get into the file.
 *  `now` is a Date; `timezoneOffsetMinutes` is the caregiver's offset from UTC (as the nudge
 *  preferences carry it); `forbidden` is a list of names to keep out. */
export function scheduleSpecToIcs(spec, { now, timezoneOffsetMinutes = 0, forbidden = [] } = {}) {
  if (!spec || typeof spec !== "object") throw new CalendarReminderError("no reminder to export");
  const fireAt = new Date(spec.fireAt);
  if (Number.isNaN(fireAt.getTime())) throw new CalendarReminderError("reminder has no valid start time");
  const notification = spec.payload && spec.payload.notification;
  if (!notification || !String(notification.title || "").trim() || !String(notification.body || "").trim()) {
    throw new CalendarReminderError("reminder has no neutral text to show");
  }
  const title = assertCalendarSafe(notification.title, forbidden);
  const body = assertCalendarSafe(notification.body, forbidden);
  const count = spec.recurrence ? parseDailyCount(spec.recurrence.rrule) : 0;
  const stamp = now instanceof Date ? now : new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NurseAunty//Reminder//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    "UID:" + opaqueId(String(spec.id || fireAt.toISOString())) + "@nurseaunty.local",
    "DTSTAMP:" + utcStamp(stamp),
    "DTSTART:" + localStamp(fireAt, timezoneOffsetMinutes),
    "DURATION:PT" + EVENT_MINUTES + "M",
    "SUMMARY:" + escapeText(title),
    "DESCRIPTION:" + escapeText(body),
  ];
  if (count) lines.push("RRULE:FREQ=DAILY;COUNT=" + count);
  lines.push(
    "TRANSP:TRANSPARENT",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:" + escapeText(title),
    "TRIGGER:PT0S",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  );
  return { text: lines.map(foldLine).join("\r\n") + "\r\n", filename: ICS_FILE_NAME, count };
}

/** Hand the file to the browser as a download, so Android passes it to the calendar app. `env` is
 *  the page's globals (document, Blob, URL); a parameter so a test can supply fakes. */
export function downloadIcs(result, env = globalThis) {
  const blob = new env.Blob([result.text], { type: "text/calendar;charset=utf-8" });
  const url = env.URL.createObjectURL(blob);
  const link = env.document.createElement("a");
  link.href = url;
  link.download = result.filename;
  link.style.display = "none";
  env.document.body.appendChild(link);
  link.click();
  env.document.body.removeChild(link);
  // Revoke after the click has been processed; revoking synchronously can cancel the download.
  env.setTimeout(() => env.URL.revokeObjectURL(url), 10000);
}
