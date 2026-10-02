// Which antenatal comic to offer, and when.
//
// David Levine, 2026-08-20: "prioritize toothbrushing, handwashing, and Womb with a View -- one
// comic / month or per ANC visit." Two cadences, because a programme whose mothers attend the
// eight-contact schedule and a programme that reaches mothers between visits want different
// rhythms. The deployment picks one; see config/switches.json ancComicCadence.
//
// Presentation only. Nothing here decides care. The antenatal contact weeks come from the guideline
// pack rather than from this file, so a programme on a different schedule changes the pack, not the
// code.

export const CADENCES = Object.freeze(["per_anc_contact", "per_month"]);

/**
 * Completed weeks of pregnancy on `today`, from a due date.
 *
 * Returns null when the due date is unusable rather than guessing, and reports weeks past term
 * honestly instead of clamping them away - a caregiver at 41 weeks is exactly the one whose screen
 * must not quietly claim she is at 40.
 */
export function gestationWeeks(dueDateIso, today, fullTermWeeks) {
  const due = parseDateOnly(dueDateIso);
  const now = parseDateOnly(today) || (today instanceof Date ? stripTime(today) : null);
  if (!due || !now || !Number.isFinite(fullTermWeeks) || fullTermWeeks <= 0) return null;
  const daysUntilDue = Math.round((due.getTime() - now.getTime()) / 86400000);
  const weeks = fullTermWeeks - daysUntilDue / 7;
  if (!Number.isFinite(weeks)) return null;
  return Math.floor(weeks);
}

/** Months of pregnancy completed, counting a month as four weeks. */
export function gestationMonth(weeks) {
  if (weeks === null || !Number.isFinite(weeks)) return null;
  return Math.max(0, Math.floor(weeks / 4));
}

/**
 * How many antenatal contacts are due by now, given the pack's contact weeks.
 * A mother at week 21 on a 12/20/26 schedule has had two contacts due, so she is owed comic 2.
 */
export function contactsDue(weeks, contactWeeks) {
  if (weeks === null || !Array.isArray(contactWeeks)) return null;
  let due = 0;
  for (const contactWeek of contactWeeks) if (weeks >= contactWeek) due++;
  return due;
}

/**
 * The comic series in reading order, each marked with whether it has been reached yet.
 *
 * Every comic is returned, including ones not yet due, because the caller shows the series and not
 * only its current item. `unlocked` says which have been reached; `current` marks the newest one.
 * A caregiver may read ahead - see the policy note in content/anc_comic_schedule.json. Withholding
 * a mother's own health information to enforce a drip feed would be the wrong trade.
 */
export function comicSeriesState({ comics, cadence, weeks, contactWeeks }) {
  const ordered = [...(comics || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const usable = CADENCES.includes(cadence) ? cadence : CADENCES[0];
  const reached = usable === "per_month" ? gestationMonth(weeks) : contactsDue(weeks, contactWeeks);

  let currentOrder = null;
  const items = ordered.map((comic) => {
    const milestone = usable === "per_month" ? comic.gestationMonth : comic.ancContact;
    // With no usable pregnancy date the series is still browsable - it just cannot say which one is
    // "now". Showing nothing would be worse than showing the series without a pointer.
    const unlocked = reached === null ? false : Number.isFinite(milestone) && reached >= milestone;
    if (unlocked) currentOrder = comic.order;
    return { ...comic, milestone, unlocked };
  });

  return {
    cadence: usable,
    reached,
    comics: items.map((item) => ({ ...item, current: item.order === currentOrder })),
    // Both normalise to null rather than undefined. A caller writing `state.next ?? fallback` and a
    // test writing `assert.equal(state.next, null)` should agree about "there isn't one".
    current: items.find((item) => item.order === currentOrder) || null,
    next: items.find((item) => !item.unlocked) || null,
    allUnlocked: items.length > 0 && items.every((item) => item.unlocked),
  };
}

function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseDateOnly(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : stripTime(value);
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}
