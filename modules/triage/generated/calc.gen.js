// GENERATED FILE — DO NOT EDIT.  Plain-JS twin of calc.gen.ts (browser use).
const num = (x) => (typeof x === "number" ? x : Number(x));
const reqn = (gd, p) => { const v = gd.get(p); if (typeof v !== "number") throw new Error("calc: missing guideline '" + p + "'"); return v; };
const safeDiv = (a, b) => { if (b === 0) throw new Error("calc: divide by zero"); return a / b; };
const monthsBetween = (fromISO, toISO) => {
  const f = new Date(fromISO), t = new Date(toISO);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new Error("calc: bad date");
  let m = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + (t.getUTCMonth() - f.getUTCMonth());
  if (t.getUTCDate() < f.getUTCDate()) m -= 1;
  return m;
};
const daysBetween = (fromISO, toISO) => {
  const f = new Date(fromISO), t = new Date(toISO);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new Error("calc: bad date");
  const fDay = Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate());
  const tDay = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return Math.floor((tDay - fDay) / 86400000);
};
export function derive(i, gd) {
  const c_age_mo = monthsBetween(i.birth_date, i.now);
  const c_age_days_completed = daysBetween(i.birth_date, i.now);
  const c_temp_c_from_f = safeDiv(((num(i.temp_entered_value) - 32) * 5), 9);
  return {
    age_mo: c_age_mo,
    age_days_completed: c_age_days_completed,
    temp_c_from_f: c_temp_c_from_f,
  };
}
