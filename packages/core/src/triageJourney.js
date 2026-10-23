// Presentation-only routing for the under-five caregiver journey.
// Clinical classifications and severities are inputs from governed decision engines.
// This module only chooses one visible result and the support screens that result permits.

export const TRIAGE_SUPPORT_SCREENS = Object.freeze([
  "support.ors_request_card",
  "support.ors_directions",
  "support.zinc_course",
  "support.zinc_reminder",
]);

const PRESENTATION_SCREENS = Object.freeze({
  cough: "triage.followup.cough",
  diarrhoea: "triage.followup.diarrhoea",
  fever: "triage.followup.fever",
  tooth_mouth: "triage.followup.tooth_mouth",
  ear_problem: "triage.followup.ear_problem",
  measles_rash: "triage.followup.measles_rash",
  other_problem: "triage.followup.other_problem",
});

const CORE_RESULT_SCREENS = Object.freeze({
  very_severe: "triage.result.urgent",
  young_infant_possible_fever: "triage.result.young_infant_fever",
  // CMD-003 / register R-14: fast breathing under 2 months is possible serious bacterial
  // infection in IMCI, and was previously swallowed by the age-out-of-scope guard.
  young_infant_possible_serious_infection: "triage.result.young_infant_fast_breathing",
  incomplete_assessment: "triage.result.age_needed",
  outside_under5_sick_child_scope: "triage.result.age_out_of_scope",
  fever_incomplete_assessment: "triage.result.fever_answer_needed",
  possible_measles_pattern: "triage.result.measles_clinic",
  dysentery: "triage.result.dysentery",
  pneumonia: "triage.result.pneumonia",
  diarrhoea_some_dehydration: "triage.result.diarrhoea_dehydration",
  // WHO IMCI persistent diarrhoea. These are referrals, so like every other referral result they
  // keep the ORS/zinc home-support screens off: the request card says no antibiotics are needed,
  // which is not a claim to put in front of a child who needs assessing. The referral text itself
  // still tells the caregiver to keep giving ORS.
  diarrhoea_persistent: "triage.result.diarrhoea_persistent",
  diarrhoea_persistent_severe: "triage.result.diarrhoea_persistent_urgent",
  diarrhoea_persistent_young_infant: "triage.result.diarrhoea_persistent_urgent",
  diarrhoea_no_dehydration: "triage.result.diarrhoea_home",
  cough_or_cold: "triage.result.cough_home",
  fever_malaria_test_needed: "triage.result.fever_malaria_test",
  fever_malaria_positive: "triage.result.fever_malaria_positive",
  fever_prolonged: "triage.result.fever_prolonged",
  fever_persistent_not_improving: "triage.result.fever_persistent",
  fever_no_malaria: "triage.result.fever_home",
  unclassified: "triage.result.followup",
});

const SEVERITY_ORDER = Object.freeze([
  "emergency",
  "urgent_clinic",
  "routine_clinic",
  "ask_more",
  "home_care",
  "followup",
]);

function rank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index < 0 ? SEVERITY_ORDER.length : index;
}

export function coreResultScreen(result) {
  return CORE_RESULT_SCREENS[result && result.classification] || "triage.result.followup";
}

export function resolveTriageJourney({
  presentations = [],
  coreResult,
  supplementalResults = [],
  needsRespiratoryRate = false,
  needsDiarrhoeaDuration = false,
} = {}) {
  if (!coreResult || typeof coreResult !== "object") {
    throw new Error("resolveTriageJourney requires coreResult");
  }

  const triageScreens = ["triage.danger_signs", "triage.presenting_complaints"];
  for (const presentation of presentations) {
    const screen = PRESENTATION_SCREENS[presentation];
    if (!screen) throw new Error("unknown triage presentation '" + presentation + "'");
    if (!triageScreens.includes(screen)) triageScreens.push(screen);
  }

  const candidates = [{
    source: "core",
    result: coreResult,
    resultScreen: coreResultScreen(coreResult),
    order: 0,
  }];
  if (needsRespiratoryRate) {
    candidates.push({
      source: "measure_breathing",
      result: { severity: "ask_more", action: "ASK_MORE", classification: "respiratory_rate_needed" },
      resultScreen: "triage.result.measure_breathing",
      order: 1,
    });
  }
  if (needsDiarrhoeaDuration) {
    candidates.push({
      source: "diarrhoea_duration",
      result: { severity: "ask_more", action: "ASK_MORE", classification: "diarrhoea_duration_needed" },
      resultScreen: "triage.result.diarrhoea_duration_needed",
      order: 2,
    });
  }
  for (let i = 0; i < supplementalResults.length; i++) {
    const candidate = supplementalResults[i];
    if (!candidate || !candidate.result || !candidate.resultScreen) {
      throw new Error("supplemental triage result requires result and resultScreen");
    }
    candidates.push({ ...candidate, order: 10 + i });
  }

  candidates.sort((left, right) =>
    rank(left.result.severity) - rank(right.result.severity) ||
    left.order - right.order
  );
  const primary = candidates[0];
  const supportScreens =
    primary.source === "core" &&
    primary.result.action === "HOME_CARE_ORS_ZINC"
      ? [...TRIAGE_SUPPORT_SCREENS]
      : [];
  const forbiddenScreens = TRIAGE_SUPPORT_SCREENS.filter(
    (screen) => !supportScreens.includes(screen)
  );

  triageScreens.push(primary.resultScreen);
  return {
    triageScreens,
    resultScreen: primary.resultScreen,
    supportScreens,
    forbiddenScreens,
    primary,
    candidates,
  };
}
