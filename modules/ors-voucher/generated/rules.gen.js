// GENERATED FILE — DO NOT EDIT.  Plain-JS twin (browser use).  hitPolicy: FIRST
function req(gd, path) { const v = gd.get(path); if (typeof v !== "number") throw new Error("rules: missing guideline '" + path + "' (pack " + gd.version + ")"); return v; }
export function evaluate(i, gd) {
  const p_any_general_danger_sign = ((i.unable_to_drink === true) || (i.vomits_everything === true) || (i.convulsions === true) || (i.lethargic_unconscious === true));
  const p_severe_dehydration = (([(i.lethargic_unconscious === true), (i.sunken_eyes === true), (i.skin_pinch_slow === true), (i.unable_to_drink === true)].filter(Boolean).length) >= 2);
  const p_some_dehydration = ((!p_severe_dehydration) && (([(i.restless_irritable === true), (i.sunken_eyes === true), (i.drinks_eagerly === true), (i.skin_pinch_slow === true)].filter(Boolean).length) >= 2));
  const p_unsafe_for_home_care = ((i.bloody_stool === true) || p_any_general_danger_sign || p_severe_dehydration || p_some_dehydration);
  const p_safe_for_home_care = ((i.diarrhoea === true) && (!p_unsafe_for_home_care));
  const predicates = {
    any_general_danger_sign: p_any_general_danger_sign,
    severe_dehydration: p_severe_dehydration,
    some_dehydration: p_some_dehydration,
    unsafe_for_home_care: p_unsafe_for_home_care,
    safe_for_home_care: p_safe_for_home_care,
  };
  if ((!p_safe_for_home_care)) return { action: "REFER_CLINIC", slug: "tx.clinical_referral_required", firedRuleId: "ORS_R1_danger_gate", matchedRules: ["ORS_R1_danger_gate"], predicates, guidelineVersion: gd.version };
  return { action: "RENDER_MIXING_GUIDE", slug: "tx.home_care_ors", firedRuleId: "__default__", matchedRules: [], predicates, guidelineVersion: gd.version };
}
