// How to measure the sachet's water using a container the caregiver actually has.
//
// The mixing illustration used to carry a painted "5 mugs = 1 L" strip, so it said the same thing
// whatever the caregiver chose. David, 2026-08-20: "if I pick 500 ml. should show 2 500 ml and a
// larger bowl or bottle holding the mixture." A painting cannot follow a choice; arithmetic can.
//
// Presentation only. The sachet volume is a governed number from the guideline pack and the
// container volumes come from config; nothing here invents either.

/** Fractions a caregiver can actually eyeball, with the words to describe them. */
// `words` names the part when it follows whole pours ("3 mugs plus one third of a mug"); `short`
// names it when the container is already the subject ("fill the bottle two thirds full"), which
// otherwise produced "fill the large bottle to two thirds of a large bottle".
// `hint` brackets the part between two marks a caregiver can find by eye, rather than describing it
// loosely. David, 2026-08-24, on one third: "(between 1/4 and 1/2)" - a bracket she can check
// against the container, where "a bit less than half" was a feeling.
const EYEBALL_FRACTIONS = Object.freeze([
  { value: 1 / 4, slug: "quarter", words: "one quarter of a {container}", short: "one quarter", hint: "a quarter of the way up" },
  { value: 1 / 3, slug: "third", words: "one third of a {container}", short: "one third", hint: "between one quarter and one half" },
  { value: 1 / 2, slug: "half", words: "half a {container}", short: "half", hint: "halfway up" },
  { value: 2 / 3, slug: "two_thirds", words: "two thirds of a {container}", short: "two thirds", hint: "between one half and three quarters" },
  { value: 3 / 4, slug: "three_quarters", words: "three quarters of a {container}", short: "three quarters", hint: "three quarters of the way up" },
]);

/**
 * The largest error we will accept when rounding a remainder to an eyeballable fraction, as a
 * share of the total mix.
 *
 * David, 2026-08-20, on 3 and a third mugs of 300 mL against a litre: "I think 3.25 and 3.4 mugs of
 * 300 ml is close enough; that is, 3% error. Requires local MD approval, but I will not ban before
 * the MDs decide." So 3% of the total, not 3% of the fraction - what matters to the child is the
 * concentration of the whole mix, not the tidiness of the last pour.
 */
export const MAX_TOTAL_ERROR_SHARE = 0.03;

/**
 * Work out how to reach `sachetVolumeMl` using containers of `containerVolumeMl`.
 *
 * Returns null when it cannot answer, rather than guessing - a missing sachet volume or a
 * nonsensical container is exactly the case where a confident wrong answer does harm.
 */
export function planOrsMeasure({ sachetVolumeMl, containerVolumeMl, allowFractions = false }) {
  const sachet = Number(sachetVolumeMl);
  const container = Number(containerVolumeMl);
  if (!isUsable(sachet) || !isUsable(container)) return null;

  const wholeCount = Math.floor(sachet / container + 1e-9);
  const remainderMl = Math.round(sachet - wholeCount * container);

  // The container divides the sachet exactly: the happy case, and the one to prefer.
  if (remainderMl === 0 && wholeCount > 0) {
    return { kind: "exact", wholeCount, remainderMl: 0, fraction: null, totalMl: sachet, errorMl: 0, exact: true };
  }

  // One container is bigger than the whole sachet. Filling it to a line is a different instruction
  // from counting pours, so say so rather than reporting "0 containers plus a fraction".
  if (wholeCount === 0) {
    const fraction = allowFractions ? nearestFraction(sachet / container, container, sachet) : null;
    return fraction
      ? { kind: "part_of_one", wholeCount: 0, remainderMl: sachet, fraction, totalMl: wholeCount * container + fraction.value * container, errorMl: Math.round(Math.abs(fraction.value * container - sachet)), exact: false }
      : { kind: "too_large", wholeCount: 0, remainderMl: sachet, fraction: null, totalMl: 0, errorMl: 0, exact: false };
  }

  if (!allowFractions) {
    // Fractions are switched off for this deployment, so this container cannot be used honestly.
    return { kind: "not_exact", wholeCount, remainderMl, fraction: null, totalMl: wholeCount * container, errorMl: remainderMl, exact: false };
  }

  const fraction = nearestFraction(remainderMl / container, container, sachet);
  if (!fraction) {
    return { kind: "not_exact", wholeCount, remainderMl, fraction: null, totalMl: wholeCount * container, errorMl: remainderMl, exact: false };
  }
  const totalMl = wholeCount * container + fraction.value * container;
  return {
    kind: "whole_plus_fraction",
    wholeCount,
    remainderMl,
    fraction,
    totalMl: Math.round(totalMl),
    errorMl: Math.round(Math.abs(totalMl - sachet)),
    exact: false,
  };
}

/** The nearest eyeballable fraction, or null when none lands inside the accepted error. */
function nearestFraction(share, containerVolumeMl, sachetVolumeMl) {
  if (!isFinite(share) || share <= 0) return null;
  let best = null;
  for (const candidate of EYEBALL_FRACTIONS) {
    const errorMl = Math.abs(candidate.value - share) * containerVolumeMl;
    if (!best || errorMl < best.errorMl) best = { ...candidate, errorMl };
  }
  if (!best) return null;
  return best.errorMl / sachetVolumeMl <= MAX_TOTAL_ERROR_SHARE ? best : null;
}

function isUsable(value) {
  return Number.isFinite(value) && value > 0;
}

/**
 * Rank the containers a caregiver could use, best first: exact divisions before approximations,
 * then fewer pours before more. Counting to five is easier than counting to seven, and a container
 * that divides exactly removes the judgement call entirely.
 */
export function rankContainersForSachet(containers, { sachetVolumeMl, allowFractions = false }) {
  return (containers || [])
    .map((container) => ({ container, plan: planOrsMeasure({ sachetVolumeMl, containerVolumeMl: container.volumeMl, allowFractions }) }))
    .filter((entry) => entry.plan && entry.plan.kind !== "too_large" && entry.plan.kind !== "not_exact")
    .sort((a, b) => {
      if (a.plan.exact !== b.plan.exact) return a.plan.exact ? -1 : 1;
      const pours = (p) => p.wholeCount + (p.fraction ? 1 : 0);
      return pours(a.plan) - pours(b.plan);
    });
}
