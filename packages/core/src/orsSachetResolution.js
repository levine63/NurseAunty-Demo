// Which sachet, which container, which method, and does the sum add up.
//
// These decisions used to live inside mountUI, where each one read the sachet the caregiver had
// chosen, the deployment's catalogues, and the guideline pack straight out of a 7,900-line closure.
// Nothing could call them. test/ors-sachet-failclosed.test.mjs had to read ui-core.js as *text* and
// brace-match the body of orsSachetVolumeMl to check it - a test that inspects source rather than
// behaviour, and one that silently stopped finding the function once it grew past the character
// window an earlier version of that test used.
//
// Every input is a parameter here. That is the point, not a side effect: what a clinical decision
// depends on should be readable in its signature, not discoverable by reading the closure around it.
//
// Fail-closed throughout. Where a value is missing or inconsistent these return null, 0, or an empty
// list, and the caller falls back to the packet's own instruction - which is always correct and
// never stale. The error that matters in this module is in the hypernatraemia direction: too little
// water concentrates the salt, while too much is merely less effective.

/** The sachet sizes this deployment stocks. Never the examples it does not. */
export function sachetCatalogRows(sachetCatalog) {
  const rows = sachetCatalog && sachetCatalog.sachets;
  return Array.isArray(rows) ? rows : [];
}

/** One stocked sachet by id, or null. */
export function sachetById(sachetCatalog, id) {
  return sachetCatalogRows(sachetCatalog).find((row) => row.id === id) || null;
}

/**
 * The volume to mix, in mL, or 0 when nothing can say honestly.
 *
 * The order matters and each step is a smaller claim than the one before:
 *   1. she told us which packet she has;
 *   2. she told us it is not one we stock, so we claim nothing;
 *   3. this deployment stocks exactly one size, so that is the reasonable assumption - and the
 *      caregiver is shown a correctable line saying so, never a silent one;
 *   4. it stocks several and she has not said which, so we do not guess between them;
 *   5. the guideline pack carries a volume.
 *
 * Step 4 is the one worth defending. Picking the first of several stocked sizes would be a coin
 * toss whose loser mixes the wrong concentration.
 */
export function resolveSachetVolumeMl({ sachetCatalog, chosenSachetId, guidelineVolumeMl } = {}) {
  const chosen = sachetById(sachetCatalog, chosenSachetId);
  if (chosen && Number(chosen.volumeMl) > 0) return Number(chosen.volumeMl);
  if (chosenSachetId === "unknown") return 0;

  const rows = sachetCatalogRows(sachetCatalog);
  if (rows.length === 1 && Number(rows[0].volumeMl) > 0) return Number(rows[0].volumeMl);
  if (rows.length > 1) return 0;

  const fromPack = Number(guidelineVolumeMl);
  return Number.isFinite(fromPack) && fromPack > 0 ? fromPack : 0;
}

/**
 * True when the app chose the volume rather than being told it.
 *
 * The caller uses this to show a correctable line. A deployment can stock one SKU while a caregiver
 * holds a packet from a different shop, so the assumption has to be visible and undoable.
 */
export function sachetVolumeWasAssumed({ sachetCatalog, chosenSachetId, guidelineVolumeMl } = {}) {
  if (chosenSachetId) return false;
  return sachetCatalogRows(sachetCatalog).length === 1
    && resolveSachetVolumeMl({ sachetCatalog, chosenSachetId, guidelineVolumeMl }) > 0;
}

/** The measurement record for one container id, or null. */
export function measurementRecordByContainerId(measurementCatalog, containerId) {
  const containers = (measurementCatalog && measurementCatalog.containers) || [];
  return containers.find((record) => record.containerId === containerId) || null;
}

/**
 * The method that fills this container to exactly the sachet's volume, or null.
 *
 * "Exactly" is the whole contract. A method whose targetVolumeMl differs from the sachet is not a
 * near-miss to be offered with a caveat; it is a different recipe.
 */
export function exactMeasurementMethodFor(measurementCatalog, container, targetMl) {
  if (!container) return null;
  const record = measurementRecordByContainerId(measurementCatalog, container.id);
  const methods = (record && Array.isArray(record.measurementMethods)) ? record.measurementMethods : [];
  return methods.find((method) => Number(method.targetVolumeMl) === Number(targetMl)) || null;
}

/**
 * Containers this deployment can honestly offer, best first.
 *
 * ADR-028: a container that divides the sachet exactly is always offered. One that needs a part pour
 * is offered too, but only while the deployer switch allows approximate fractions and only when the
 * planner puts it inside its own error ceiling. Exact options come first, so the caregiver meets the
 * one with no judgement call in it before any that has one.
 *
 * With no governed sachet volume this returns the exact list only - it does not fall back to
 * ranking, because ranking without a target would be arithmetic about nothing.
 */
export function offerableContainers({
  containers = [],
  measurementCatalog,
  sachetMl,
  allowFractions = false,
  rankContainersForSachet,
} = {}) {
  const ors = containers.filter((container) => container.kind === "ors");
  const exact = ors.filter((container) => !!exactMeasurementMethodFor(measurementCatalog, container, sachetMl));
  if (!rankContainersForSachet || allowFractions !== true) return exact;
  if (!sachetMl) return exact;

  const already = new Set(exact.map((container) => container.id));
  const extra = rankContainersForSachet(ors, { sachetVolumeMl: sachetMl, allowFractions: true })
    .filter((entry) => !already.has(entry.container.id))
    .map((entry) => entry.container);
  return exact.concat(extra);
}

/**
 * The numbers behind the mixing diagram, or null when they do not add up.
 *
 * A diagram that does not add up is worse than no diagram: it lends a picture's authority to a wrong
 * ratio. So this refuses rather than rounds - unit x count must equal the target exactly, and the
 * target must equal the sachet.
 */
export function orsArithmeticFacts(container, method, sachetMl) {
  if (!container || !method || !sachetMl) return null;
  const target = Number(method.targetVolumeMl);
  if (!Number.isFinite(target) || target !== Number(sachetMl)) return null;

  if (method.kind === "whole_fills" || method.kind === "supplied_measure") {
    const unit = Number(method.kind === "supplied_measure" ? method.measureVolumeMl : method.fillVolumeMl);
    const count = Number(method.fillCount);
    if (!Number.isFinite(unit) || unit <= 0 || !Number.isFinite(count) || count <= 0) return null;
    if (unit * count !== target) return null;
    return { kind: "whole_fills", unitMl: unit, count, totalMl: target };
  }

  if (method.kind === "marked_line") {
    const line = Number(method.lineVolumeMl);
    if (!Number.isFinite(line) || line !== target) return null;
    return { kind: "marked_line", unitMl: line, count: 1, totalMl: target };
  }

  return null;
}

/**
 * How many days of zinc this deployment gives, or 0 when nobody has said.
 *
 * "Ten days" was written into the calendar, the copy and the reminder while the guideline pack
 * said ten to FOURTEEN. A clinical number living in the user interface is exactly what
 * CONTRACTS.md 3a forbids, and it is the defect the 2026-08-18 decision register recorded as R-12
 * and nobody had closed.
 *
 * The pack owns the permitted range; a deployment picks one number inside it. That split matters:
 * how long to treat, within the clinically permitted window, is a local programme decision, and
 * the app has no standing to invent it. David, 2026-08-28: "Zinc duration should be a parameter
 * locally set as a #."
 *
 * Fail-closed, and in the safe direction. An unset, non-integer, or out-of-range value returns 0,
 * and the caller then shows no day count at all - the product's own instruction and the health
 * worker are the answer, which is always correct and never stale. Silently defaulting to ten would
 * be the app asserting a treatment length no one configured, which is the whole defect.
 */
export function zincCourseDays({ configuredDays, packMinDays, packMaxDays } = {}) {
  // typeof, not Number(): Number("10") is 10, so a coercing check accepts a clinical parameter
  // written as a string in JSON. For a treatment length, a malformed config should be seen and
  // fixed, not quietly accepted.
  const days = typeof configuredDays === "number" ? configuredDays : NaN;
  const min = Number(packMinDays);
  const max = Number(packMaxDays);
  if (!Number.isInteger(days) || days <= 0) return 0;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return 0;
  // Out of range is refused rather than clamped. Clamping would silently treat a deployment's
  // stated intent as a typo, and the two possible mistakes are not symmetric: too short
  // under-treats a child, too long is a programme error someone should see and fix.
  if (days < min || days > max) return 0;
  return days;
}

/** How many days of the course are marked, over however many days the course runs. */
export function zincDaysGiven(zincDayState, courseDays) {
  const total = Number.isInteger(courseDays) && courseDays > 0 ? courseDays : 0;
  let given = 0;
  for (let day = 1; day <= total; day += 1) if (zincDayState && zincDayState[day]) given += 1;
  return given;
}
