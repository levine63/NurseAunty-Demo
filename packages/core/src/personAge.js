// How old this person is today, and what that makes them eligible for.
//
// Age is the quietest clinical input in the app. It picks the ORS amount band, decides whether a
// newborn is inside the kangaroo-care window, chooses the zinc dose, and sets the next vaccine
// date. Nothing on screen announces that a number was derived from a birth date and a calendar, so
// an off-by-one here is invisible in a way a wrong danger sign is not.
//
// Every one of these used to sit inside mountUI and read `new Date()` for itself. That is the same
// defect as reading a variable out of a closure, with a worse consequence: an input that comes from
// the ambient clock cannot be chosen by a test. There was no way to ask "on the morning the child
// turns six months, which zinc band shows?" without waiting for that morning. So the boundaries -
// the day before, the day of, the day after - were never checked, and a boundary is the only place
// this kind of arithmetic goes wrong.
//
// `today` is a parameter here. That is the whole point of the file.
//
// Dates are handled as local calendar days, never as instants. A birth date is a day someone wrote
// down, not a moment; comparing it as a timestamp makes the answer depend on the hour the caregiver
// happens to open the app, and on which side of midnight UTC her timezone sits.

/** A YYYY-MM-DD string as a local calendar day, or null. Anything else is null, never a guess. */
export function parseDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  // Rejects 2026-02-31, which the Date constructor would silently roll into March.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** Midnight local on the same calendar day, so day arithmetic never depends on the time of day. */
export function startOfDay(date) {
  return date ? new Date(date.getFullYear(), date.getMonth(), date.getDate()) : null;
}

/** A whole number of days later, over month ends and leap years, staying on calendar days. */
export function addDays(date, days) {
  const next = startOfDay(date);
  if (!next) return null;
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Whole days lived, or null when the birth date is missing or unreadable.
 *
 * Negative when the birth date is in the future. The caller decides what that means - this does not
 * clamp it to zero, because a future birth date is a data error worth seeing rather than a
 * newborn worth treating.
 */
export function daysSinceBirth(birthDate, today) {
  const birth = startOfDay(parseDateOnly(birthDate));
  const now = startOfDay(today);
  if (!birth || !now) return null;
  return Math.round((now.getTime() - birth.getTime()) / 86400000);
}

/**
 * Completed months lived, or null.
 *
 * Completed, not rounded: a child two days short of six months is five months old, because the band
 * she belongs in is the one she has finished, not the one she is nearest. Rounding to the nearest
 * month would move roughly half of every band's children into the next band up, and for ORS and
 * zinc the band up means a larger amount.
 */
export function ageMonths(birthDate, today) {
  const birth = parseDateOnly(birthDate);
  const now = startOfDay(today);
  if (!birth || !now) return null;
  let months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (now.getDate() < birth.getDate()) months -= 1;
  return Number.isFinite(months) ? months : null;
}

/**
 * Whether this baby is inside the prototype's kangaroo-care window.
 *
 * Two ways in, and the order matters. A caregiver or health worker saying the baby was preterm or
 * low birth weight, or that KMC was advised, is believed outright - that is a clinical judgement
 * already made by someone who saw the baby. Only when nobody has said so does age decide it.
 *
 * `newbornDays` is a parameter because the window is a deployment's clinical setting, not a fact
 * about arithmetic.
 */
export function kmcEligible({ subject, birthDate, pretermLowBirthWeight, kmcAdvised } = {}, today, newbornDays) {
  if (subject !== "newborn_baby") return false;
  if (pretermLowBirthWeight === true || kmcAdvised === true) return true;
  const days = daysSinceBirth(birthDate, today);
  return days !== null && days >= 0 && days < newbornDays;
}

/**
 * The next visit on a schedule that has not yet passed, or null.
 *
 * "Not yet passed" includes today: a visit due this morning is still the next one, because a
 * caregiver opening the app on the day is the case this exists for. A visit that has passed is
 * never proposed - the app has no way to know whether she went, and inventing a missed-visit
 * message from a date alone would be telling her something about her child it does not know.
 *
 * The schedule is a parameter. It lived in ui-core.js as a JavaScript constant until 2026-08-27,
 * where validation could not see it and no clinician reading the governed data files would have
 * found it; it is config/immunization-schedule.json now.
 */
export function nextImmunizationVisit({ birthDate, schedule, today, reminderDaysBefore = 2 } = {}) {
  const birth = parseDateOnly(birthDate);
  const now = startOfDay(today);
  const visits = Array.isArray(schedule && schedule.visits) ? schedule.visits : [];
  if (!birth || !now || !visits.length) return null;

  for (const visit of visits) {
    const day = Number(visit.dayAfterBirth);
    if (!Number.isFinite(day)) continue;
    const due = addDays(birth, day);
    if (due < now) continue;
    return {
      id: visit.id,
      slug: visit.slug,
      due,
      remindOn: addDays(due, -reminderDaysBefore),
      vaccines: Array.isArray(visit.vaccines) ? visit.vaccines : [],
    };
  }
  return null;
}
