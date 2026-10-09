import {
  sachetCatalogRows as catalogRows,
  sachetById as sachetRowById,
  resolveSachetVolumeMl,
  sachetVolumeWasAssumed,
  measurementRecordByContainerId,
  exactMeasurementMethodFor,
  offerableContainers,
  orsArithmeticFacts,
  zincDaysGiven as countZincDaysGiven,
  zincCourseDays as resolveZincCourseDays,
} from "../../packages/core/src/orsSachetResolution.js";
import {
  parseDateOnly,
  addDays,
  daysSinceBirth as daysLived,
  ageMonths as completedAgeMonths,
  kmcEligible,
  nextImmunizationVisit,
} from "../../packages/core/src/personAge.js";

// apps/pwa-sandbox/ui-core.js - ONE UI for served (app.js) + single-file (standalone) builds.
// IMCI flow: general danger signs first, then main complaints; follow-ups reveal only when their
// complaint is ticked. All prompt text comes from the phrase bank (engine.t) so it is
// plain-language and translatable. engine = { triageEval, derive, orsGate, gd, t, orsContainers, malariaRegion }.
var FOLLOWUP_IMAGES = {
  chest_indrawing: "Baby's chest with the skin just below the ribs pulling INWARD as the child breathes in.",
  stridor_calm: "Child breathing in with a harsh sound; a small ear icon to show 'listen'.",
  bloody_stool: "Stool with visible red streaks of blood.",
  sunken_eyes: "Two faces side by side: normal eyes vs sunken eyes.",
  skin_pinch_slow: "Fingers pinching belly skin; the skin 'tent' stays up = slow return."
};
var FOLLOWUP_IMAGE_ASSETS = {
  chest_indrawing: "img.user_supplied.chest_indrawing_v1",
  bloody_stool: "img.user_supplied.blood_stool_sample_v2",
  sunken_eyes: "img.user_supplied.sunken_eyes_dehydration_v1",
  skin_pinch_slow: "img.user_supplied.skin_pinch_dehydration_v1"
};
var EXTRA_PRESENTING = [{ id: "ear_problem" }, { id: "tooth_mouth" }, { id: "other_problem" }];
var EAR_FU = [
  { id: "ear_discharge", img: "Child holding ear with a small warning mark for pus or discharge." },
  { id: "ear_swelling_behind", img: "Side view of child with tender swelling behind the ear highlighted." }
];
var DENTAL_FU = [
  { id: "tooth_severe_pain", img: "Child pointing to tooth or mouth pain." },
  { id: "mouth_face_swelling", img: "Face or gum swelling highlighted with a clinic arrow." },
  { id: "mouth_injury_bleeding", img: "Mouth injury or bleeding after a fall, shown without gore." },
  { id: "mouth_breathing_swallowing", img: "Mouth or face swelling with breathing or swallowing warning icon." }
];

function clinicalVariableRegistry(table, subjectScope) {
  var registry = { generalDangerSigns: [], presentingSymptoms: [], followupsBySymptom: {}, measurementsBySymptom: {}, modifiers: [], derived: [] };
  var inputs = (table && table.inputs) || {};
  var applies = function (input) {
    var scopes = input.subjectScopes || [];
    return !scopes.length || scopes.indexOf(subjectScope) >= 0;
  };
  var hasRole = function (input, role) { return (input.clinicalVariableRoles || []).indexOf(role) >= 0; };
  var desc = function (id, input) {
    return {
      id: id,
      type: input.type,
      kind: input.kind,
      label: input.label && input.label.en,
      roles: input.clinicalVariableRoles || [],
      followupFor: input.followupFor || [],
      prototypeAssignment: input.prototypeAssignment
    };
  };
  var pushByParent = function (out, item) {
    for (var i = 0; i < item.followupFor.length; i++) {
      var parent = item.followupFor[i];
      out[parent] = out[parent] || [];
      out[parent].push(item);
    }
  };
  Object.keys(inputs).forEach(function (id) {
    var input = inputs[id];
    if (!applies(input)) return;
    var item = desc(id, input);
    if (hasRole(input, "general_danger_sign")) registry.generalDangerSigns.push(item);
    if (hasRole(input, "presenting_symptom")) registry.presentingSymptoms.push(item);
    if (hasRole(input, "symptom_followup") && input.type === "boolean") pushByParent(registry.followupsBySymptom, item);
    if (hasRole(input, "measurement")) {
      if (item.followupFor.length) pushByParent(registry.measurementsBySymptom, item);
      else registry.modifiers.push(item);
    }
    if (hasRole(input, "modifier")) registry.modifiers.push(item);
    if (hasRole(input, "derived")) registry.derived.push(item);
  });
  return registry;
}

export function mountUI(engine) {
  var $ = function (id) { return document.getElementById(id); };
  var t = engine.t;
  var phraseBank = engine.phraseBank || {};
  phraseBank.phrases = phraseBank.phrases || {};
  var orsMeasurementCatalog = engine.orsMeasurementMethods || {};
  orsMeasurementCatalog.containers = Array.isArray(orsMeasurementCatalog.containers) ? orsMeasurementCatalog.containers : [];
  var catalog = engine.featureCatalog || {};
  catalog.subjects = Array.isArray(catalog.subjects) ? catalog.subjects : [];
  catalog.types = Array.isArray(catalog.types) ? catalog.types : [];
  catalog.topics = Array.isArray(catalog.topics) ? catalog.topics : [];
  catalog.personIntentRoutes = Array.isArray(catalog.personIntentRoutes) ? catalog.personIntentRoutes : [];
  catalog.features = Array.isArray(catalog.features) ? catalog.features : [];
  var toolCards = engine.toolCards || {};
  toolCards.cards = Array.isArray(toolCards.cards) ? toolCards.cards : [];
  var storyCards = engine.storyCards || {};
  storyCards.cards = Array.isArray(storyCards.cards) ? storyCards.cards : [];
  var playerDecks = engine.playerDecks || {};
  playerDecks.decks = Array.isArray(playerDecks.decks) ? playerDecks.decks : [];
  var screenCards = engine.screenCards || {};
  screenCards.cards = Array.isArray(screenCards.cards) ? screenCards.cards : [];
  // Deployment switches (config/switches.json, deployer tier). A deployment chooses within what the
  // designer tier allows; a caregiver never sets these. Read here so a question that depends on
  // equipment the deployment supplies can declare that dependency in the screen registry instead of
  // being hard-coded into a renderer.
  var deploymentSwitches = (engine.switches && engine.switches.deployer && engine.switches.deployer.switches) || {};
  var deploymentOverrides = {};
  function deployerSwitch(name) {
    if (Object.prototype.hasOwnProperty.call(deploymentOverrides, name)) return !!deploymentOverrides[name];
    var entry = deploymentSwitches[name];
    return !!(entry && entry.value);
  }
  function setDeployerSwitch(name, value) { deploymentOverrides[name] = !!value; }
  var clinicalScreens = engine.clinicalScreens || {};
  clinicalScreens.screens = Array.isArray(clinicalScreens.screens) ? clinicalScreens.screens : [];
  var clinicalScreensById = {};
  clinicalScreens.screens.forEach(function (screen) { clinicalScreensById[screen.id] = screen; });
  var screenClinicalIr = engine.screenClinicalIr || {};
  var guidanceComparisons = engine.guidanceComparisons || {};
  guidanceComparisons.sources = Array.isArray(guidanceComparisons.sources) ? guidanceComparisons.sources : [];
  guidanceComparisons.comparisons = Array.isArray(guidanceComparisons.comparisons) ? guidanceComparisons.comparisons : [];
  var assetManifest = engine.assetManifest || {};
  assetManifest.assets = Array.isArray(assetManifest.assets) ? assetManifest.assets : [];
  assetManifest.budget = assetManifest.budget || {};
  var assetApprovalRegister = engine.assetApprovalRegister || {};
  assetApprovalRegister.approvalStates = assetApprovalRegister.approvalStates || {};
  var mediaPacks = engine.mediaPacks || (typeof MEDIA_PACKS !== "undefined" ? MEDIA_PACKS : {});
  mediaPacks.packs = Array.isArray(mediaPacks.packs) ? mediaPacks.packs : [];
  var chwQualityStandards = engine.chwQualityStandards || {};
  chwQualityStandards.components = Array.isArray(chwQualityStandards.components) ? chwQualityStandards.components : [];
  chwQualityStandards.featureMappings = Array.isArray(chwQualityStandards.featureMappings) ? chwQualityStandards.featureMappings : [];
  var moduleContracts = engine.moduleContracts || {};
  moduleContracts.contracts = Array.isArray(moduleContracts.contracts) ? moduleContracts.contracts : [];
  var moduleRegistry = engine.moduleRegistry || {};
  moduleRegistry.modules = Array.isArray(moduleRegistry.modules) ? moduleRegistry.modules : [];
  moduleRegistry.diagnostics = Array.isArray(moduleRegistry.diagnostics) ? moduleRegistry.diagnostics : [];
  var progressTrackers = engine.progressTrackers || {};
  progressTrackers.trackers = Array.isArray(progressTrackers.trackers) ? progressTrackers.trackers : [];
  var createNudgeCoordinator = engine.createNudgeCoordinator || null;
  var triagePredicateTable = engine.triagePredicateTable || {};
  var childClinicalRegistry = clinicalVariableRegistry(triagePredicateTable, "child_under5");
  var DANGER = childClinicalRegistry.generalDangerSigns.length ? childClinicalRegistry.generalDangerSigns : [{ id: "unable_to_drink" }, { id: "vomits_everything" }, { id: "convulsions" }, { id: "lethargic_unconscious" }];
  var MAIN = (childClinicalRegistry.presentingSymptoms.length ? childClinicalRegistry.presentingSymptoms : [{ id: "cough" }, { id: "diarrhoea" }, { id: "fever" }]).concat(EXTRA_PRESENTING);
  var COUGH_FU = (childClinicalRegistry.followupsBySymptom.cough || [{ id: "chest_indrawing" }, { id: "stridor_calm" }]).map(function (q) { return { id: q.id, img: FOLLOWUP_IMAGES[q.id], assetId: FOLLOWUP_IMAGE_ASSETS[q.id] }; });
  var DIAR_FU = (childClinicalRegistry.followupsBySymptom.diarrhoea || [{ id: "bloody_stool" }, { id: "sunken_eyes" }, { id: "skin_pinch_slow" }, { id: "restless_irritable" }, { id: "drinks_eagerly" }]).map(function (q) { return { id: q.id, img: FOLLOWUP_IMAGES[q.id], assetId: FOLLOWUP_IMAGE_ASSETS[q.id] }; });
  var FEVER_MEASUREMENTS = childClinicalRegistry.measurementsBySymptom.fever || [{ id: "fever_days" }];
  // The shell's markup carries an English copy of every phrase it labels with data-i18n. Until
  // 2026-08-26 this ran only when the caregiver changed language, so on first load the markup won
  // and the phrase bank lost - eight phrases had silently drifted, including three of the
  // privacy-wording replacements. Localizing here makes the bank authoritative from the first
  // paint, in every locale including English.
  //
  // It has to run BEFORE anything writes a live value into a labelled node. #status carries
  // data-i18n="tx.shell.loading", so calling this at the end of mount instead reset the status line
  // from "Ready" back to "Opening NurseAunty..." and the app never appeared to finish loading.
  localizeCaregiverChrome();
  var mode = "subject", selected = "child_under5", activeSubject = "child_under5", activePersonId = null, dangerPersonId = null, search = "", hotspot = false, slideIndex = 0, activeSlides = [], orsDeckContainerId = "", orsSachetId = "", careEntryStartsCheck = false;
  // Work navigation is explicit. Do not infer the preceding screen solely from
  // mutable catalog flags: multi-step results change those flags and repeatedly
  // made the shell Back control skip or lose a meaningful step.
  var workBackSteps = [];
  var workReturnContext = null;
  var FEATURE_PAGE_SIZE = 6, featureLimit = FEATURE_PAGE_SIZE;
  // Progress is a caregiver-confirmed prototype record, but it must never leak
  // between children who share a phone.  Keep the per-person key beside the
  // renderer rather than using a single household-wide counter.
  var dentalBrushesTodayByPerson = {}, dentalZone = -1, dentalAgeBand = "";
  var under5Journey = "sick_child";
  var kmcMinutesToday = 0, kmcActive = false;
  var laborContractions = [], laborContractionStartedAt = 0;
  var handwashStep = 0;
  var breastfeedingStep = 0;
  var pncView = "acute", pncSelections = {}, pncAnsweredViews = {};
  var under5DangerGateUpdate = null;
  var under5Stage = "danger", under5BranchQueue = [], under5BranchIndex = 0;
  // Progress reports what this check actually visited. A danger-sign short circuit must
  // never imply that the caregiver completed symptom or detail questions.
  var under5VisitedSymptoms = false, under5VisitedDetails = false;
  var under5ResultMarkup = "", under5ResultShowsBreathing = false, under5ShowingSupport = false;
  // A duration is a required numeric field, not a checklist surface. Keep its stage
  // name in one constant so the registry's checklist-coverage audit remains exact.
  var DIARRHOEA_DURATION_STAGE = "diarrhoea_duration";
  // The app replaces registry-rendered one-choice screens as the caregiver advances. Retain
  // their explicit selections separately so the decision engine and Back both see them.
  var coughChoiceState = {};
  var bfAidView = "baby_urgent", bfAidSelections = {};
  var earSelections = {};
  var feedingPlanSelections = {};
  var feedingGuideStep = 0;
  var feedingResultSteps = [];
  var feedingResultStep = 0;
  var safeWaterSelections = {};
  var registryChecklistSelections = {};
  var zincView = 0, zincDayStateByPerson = {}, zincStatusMessage = "", zincDaysSaved = false;
  // Marked zinc days belong to one child. A household-wide map showed Lina's ticked days as
  // Tariq's on a panel that otherwise picks the dose from the selected child's age (adversarial
  // review of the 2026-08-18 repairs, R1). Session memory only: nothing here outlives the app.
  function zincMarks() {
    // The same person rule as the brushing tracker: the selected child, else the default child. Keying
    // on activePersonId alone split one child's course into two ledgers, because the Tools door
    // clears the active person (review 2026-09-02, finding 3).
    var key = dentalTrackerKey();
    if (!zincDayStateByPerson[key]) zincDayStateByPerson[key] = {};
    return zincDayStateByPerson[key];
  }
  var familyPreparednessStep = 0, familyPreparednessState = {};
  var birthPlanStep = 0, birthPlanFields = {};
  var boilPreparationState = {}, boilTimerView = false;
  var uiTimer = null;
  var currentPrototypeMusic = null;
  var moduleOverrides = {};
  var editingPersonId = null;
  var inAppNudgeState = {};
  var inAppNudgeSchedules = [];
  var inAppReminderRequests = [];
  var inAppReminderPhotos = {};
  // Whether the caregiver asked for help measuring. Null until she answers, so the deck can tell
  // "not asked yet" from "said she can manage".
  var orsNeedsMeasureHelp = null;
  var openedRefillReminderIndex = null;
  var pendingRefillPhoto = null;
  // The demo family is defined by AGE, not by a fixed date of birth.
  //
  // David, 2026-09-05: "Can we change Lina's age so it is always 32 months ago (& for other ages)?"
  // Not crazy - it fixes a demo that had already quietly died. These were fixed dates, so the
  // family aged with the calendar while the ages the features need stayed still:
  //
  //   Noor was born 2026-06-20 and the kangaroo-care timer is for a baby under 28 days. He was 35
  //   days old at the frozen test date and 77 days old on 2026-09-05, so the KMC screen showed
  //   "Kangaroo care timer unavailable for this baby" to every reviewer who opened it. A test was
  //   then written asserting KMC is hidden for Noor, which recorded the drift as if it were the
  //   design.
  //
  //   Lina crossed the 24-month ORS band boundary in January 2026, so the amount a reviewer sees
  //   changed without anyone deciding it.
  //
  // Ages are derived at mount from demoToday(), which is the single seam a test can freeze -
  // invariant 7's "so it stays testable", reached without rewriting the 21 other date calls in
  // this file. Derived at RUNTIME, never at build time: a build-time date would change
  // standalone.html every day and break the artifact determinism comparison.
  //
  // These ages are product choices. Change the numbers here, not the dates.
  var DEMO_AGES = {
    lina: { ageMonths: 32 },   // an under-five in the 2-years-and-over ORS band
    noor: { ageDays: 10 },     // a newborn INSIDE the 28-day kangaroo-care window
    rina: { dueInDays: 98 }    // about 26 weeks pregnant, mid-series for the antenatal comics
  };
  function demoToday() { return new Date(); }
  function isoDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function demoDateDaysAway(days) {
    var d = demoToday();
    d.setDate(d.getDate() + days);
    return isoDate(d);
  }
  // Calendar months, not 30-day blocks, so "32 months old" is what the age line actually reads.
  // The day of the month is clamped, which is why a birthday on the 31st lands on the 30th in a
  // short month - the same rule personAge.ageMonths uses to decide the age.
  function demoBirthDateMonthsAgo(months) {
    var today = demoToday();
    var d = new Date(today.getFullYear(), today.getMonth() - months, 1);
    var lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(today.getDate(), lastDayOfTargetMonth));
    return isoDate(d);
  }
  var people = [
    { id: "demo_child", name: "Lina", subject: "child_under5", note: "", birthDate: demoBirthDateMonthsAgo(DEMO_AGES.lina.ageMonths) },
    { id: "demo_baby", name: "Noor", subject: "newborn_baby", note: "", birthDate: demoDateDaysAway(-DEMO_AGES.noor.ageDays) },
    { id: "demo_mother", name: "Meena", subject: "newborn_mom", note: "" },
    { id: "demo_pregnancy", name: "Rina", subject: "pregnancy", note: "", dueDate: demoDateDaysAway(DEMO_AGES.rina.dueInDays) }
  ];
  var initialPeople = JSON.parse(JSON.stringify(people));
  var demoActions = [
    { id: "demo-wrong", title: "1. Something's wrong", body: "Choose who needs urgent checks, then open the right checklist.", primary: true },
    { id: "demo-diarrhoea", title: "2. Child has diarrhoea", body: "Check danger signs, then show ORS and zinc support if it is appropriate." },
    { id: "demo-ors", title: "3. Mix ORS", body: "Practice the offline ORS mixing lesson." },
    { id: "demo-brushing", title: "4. Brush teeth", body: "Start the two-minute timer and mark the star chart." },
    { id: "demo-nudge", title: "5. Plan pregnancy visit", body: "Make a simple birth-preparedness checklist." }
  ];
  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function personById(id) {
    for (var i = 0; i < people.length; i++) if (people[i].id === id) return people[i];
    return null;
  }
  function personRoleLabel(person) {
    if (!person) return "";
    if (person.subject === "pregnancy") return tx("tx.person.role.pregnant", "Pregnant");
    if (person.subject === "newborn_mom") return tx("tx.person.role.new_mother", "New mother");
    if (person.subject === "newborn_baby") return tx("tx.person.role.newborn", "Newborn");
    if (person.subject === "child_under5") return tx("tx.person.role.child", "Child");
    if (person.subject === "school_child") return tx("tx.person.role.school_child", "School-age child");
    var subject = byId(catalog.subjects, person.subject);
    return subject ? t(subject.titleSlug) : person.subject;
  }
  function personSummary(person) {
    if (!person) return "";
    var role = personRoleLabel(person);
    var age = personAgeLabel(person);
    var note = String(person.note || "")
      .replace(/\s*-\s*demo(?: child| baby)?\s*$/i, "")
      .replace(/\s*-\s*new mom\s*$/i, "")
      .replace(/^\s*(pregnant|newborn|postpartum)\s*$/i, "")
      .trim();
    return age ? role + ", " + age : (note ? role + ", " + note : role);
  }
  function personAgeLabel(person) {
    if (!person || person.subject !== "child_under5") return "";
    var months = completedAgeMonths(person.birthDate, new Date());
    if (months === null || months < 0) return "";
    return tx("tx.person.age_months", "{months} months", { months: months });
  }
  function selectedPersonName() {
    var person = activePersonId ? personById(activePersonId) : null;
    if (person) return person.name;
    var subject = byId(catalog.subjects, selected);
    return subject ? t(subject.titleSlug) : "my family";
  }
  function cardByFeature(id) {
    for (var i = 0; i < toolCards.cards.length; i++) if (toolCards.cards[i].featureId === id) return toolCards.cards[i];
    return null;
  }
  function storyByFeature(id) {
    for (var i = 0; i < storyCards.cards.length; i++) if (storyCards.cards[i].featureId === id) return storyCards.cards[i];
    return null;
  }
  var KMC_PROTOTYPE_NEWBORN_DAYS = 28;
  function daysSinceBirth(person) {
    return daysLived(person && person.birthDate, new Date());
  }
  function kmcEligiblePerson(person) {
    return kmcEligible(person || {}, new Date(), KMC_PROTOTYPE_NEWBORN_DAYS);
  }
  function eligibleKmcBaby() {
    var active = activePersonId ? personById(activePersonId) : null;
    if (kmcEligiblePerson(active)) return active;
    for (var i = 0; i < people.length; i++) if (kmcEligiblePerson(people[i])) return people[i];
    return null;
  }
  function kmcEligibilityMessage() {
    var newborns = people.filter(function (person) { return person.subject === "newborn_baby"; });
    if (!newborns.length) return tx("tx.kmc_timer.add_a_newborn_first");
    var notes = newborns.map(function (person) {
      var days = daysSinceBirth(person);
      return days === null
        ? tx("tx.kmc_timer.age_unknown", null, { personName: person.name })
        : tx("tx.kmc_timer.age_days", null, { personName: person.name, days: days });
    }).join("; ");
    return tx("tx.kmc_timer.eligibility_note", null, { ages: notes });
  }
  function deckByFeature(id) {
    for (var i = 0; i < playerDecks.decks.length; i++) if (playerDecks.decks[i].featureId === id) return playerDecks.decks[i];
    return null;
  }
  function containerById(id) {
    for (var i = 0; i < engine.orsContainers.length; i++) if (engine.orsContainers[i].id === id) return engine.orsContainers[i];
    return null;
  }
  function orsMeasurementRecordByContainerId(id) {
    return measurementRecordByContainerId(orsMeasurementCatalog, id);
  }
  function exactOrsMeasurementMethod(container) {
    return exactMeasurementMethodFor(orsMeasurementCatalog, container, orsSachetVolumeMl());
  }
  // Containers this deployment can honestly offer, best first.
  //
  // ADR-028: a container that divides the sachet exactly is always offered. One that needs a part
  // pour is offered too, but only while the deployer switch allows approximate fractions and only
  // when the plan lands inside the 3% ceiling enforced in the planner. Exact options come first, so
  // the caregiver meets the one with no judgement call in it before any that has one.
  function exactOrsContainers() {
    return offerableContainers({
      containers: engine.orsContainers,
      measurementCatalog: orsMeasurementCatalog,
      sachetMl: orsSachetVolumeMl(),
      allowFractions: deployerSwitch("orsAllowApproximateFractions") === true,
      rankContainersForSachet: engine.rankContainersForSachet
    });
  }
  function screenByFeature(id) {
    for (var i = 0; i < screenCards.cards.length; i++) if (screenCards.cards[i].featureId === id) return screenCards.cards[i];
    return null;
  }
  function comparisonByFeature(id) {
    for (var i = 0; i < guidanceComparisons.comparisons.length; i++) if (guidanceComparisons.comparisons[i].featureId === id) return guidanceComparisons.comparisons[i];
    return null;
  }
  function sourceById(id) {
    for (var i = 0; i < guidanceComparisons.sources.length; i++) if (guidanceComparisons.sources[i].id === id) return guidanceComparisons.sources[i];
    return null;
  }
  function contractByFeature(id) {
    for (var i = 0; i < moduleContracts.contracts.length; i++) if (moduleContracts.contracts[i].featureId === id) return moduleContracts.contracts[i];
    return null;
  }
  function trackerByModule(id) {
    for (var i = 0; i < progressTrackers.trackers.length; i++) if (progressTrackers.trackers[i].moduleId === id) return progressTrackers.trackers[i];
    return null;
  }
  function localDateValue(date) {
    var local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }
  function dateFromLocalValue(value, hour) {
    return new Date(String(value || "") + "T" + String(hour || "00:00") + ":00");
  }
  function nudgePreferences() {
    // External review mgilkey A7: "Choosing quiet hours does not really choose quiet hours. I
    // specify a start time but not an end time." Correct - the end was hard-coded here while the
    // nudge coordinator already supported both ends of the range.
    var quietStart = $("prefquiet") && $("prefquiet").value ? $("prefquiet").value : "21:00";
    var quietEnd = $("prefquietend") && $("prefquietend").value ? $("prefquietend").value : "07:00";
    return { quietHours: { start: quietStart, end: quietEnd }, preferredChannels: ["local"], timezoneOffsetMinutes: -new Date().getTimezoneOffset() };
  }
  function createInAppNudgeCoordinator(initialState) {
    if (!createNudgeCoordinator) return null;
    return createNudgeCoordinator({
      clock: { now: function () { return new Date().toISOString(); } },
      scheduler: {
        schedule: async function (spec) {
          inAppNudgeSchedules = inAppNudgeSchedules.filter(function (item) { return item.spec.id !== spec.id; });
          var handle = "in-app:" + spec.id;
          inAppNudgeSchedules.push({ handle: handle, spec: spec });
          return handle;
        },
        cancel: async function (handle) {
          inAppNudgeSchedules = inAppNudgeSchedules.filter(function (item) { return item.handle !== handle; });
        },
        listPending: async function () { return inAppNudgeSchedules.slice(); }
      },
      audit: { log: async function () { return; } },
      i18n: { t: function (slug, vars) { return tx(slug, slug, vars); } }
    }, { initialState: initialState || inAppNudgeState, preferences: nudgePreferences() });
  }
  function reminderOpenLabel(moduleId, feature) {
    // The zinc reminder opens the same screen as the zinc progress row beside it on Home, so it
    // carries the same words. It used to say "Open zinc plan" next to a row saying "Open zinc
    // course". David, 2026-09-02: "open zinc plan is an open button, different from open timer. Why?"
    if (moduleId === "zinc_tracker") return tx("tx.home.zinc_open", "Open zinc course");
    var labels = {
      chronic_refill_tracker: "Open refill plan",
      anc_birth_plan: "Open birth plan",
      immunization_reminders: "Open vaccine visit",
      pnc_reminders: "Open mother-and-baby visit",
      bednet_hanging_reminder: "Open bednet plan"
    };
    return labels[moduleId] || tx("tx.reminder.open_named", "Open {name}", {
      name: feature ? t(feature.titleSlug) : tx("tx.reminder.plan", "plan")
    });
  }
  // A zinc course runs 10 to 14 days, so the caregiver needs to meet it where she actually opens
  // the app rather than by navigating back into a tool. David, 2026-08-24: "Once they start zinc,
  // its calendar should appear on the home screen."
  //
  // "Started" means she has marked at least one day - a dose actually given - not merely that she
  // opened the screen. Nothing appears on Home until something has happened.
  // How many days this deployment gives, from the deployer switch, bounded by the pack's range.
  // Zero when nobody has configured one - the screens then state no number at all rather than the
  // ten they used to assert while the pack said ten to fourteen (register R-12).
  function zincCourseDays() {
    var packDay = function (key) {
      return (engine.gd && engine.gd.get) ? Number(engine.gd.get("diarrhoea.zinc." + key)) : NaN;
    };
    var deployer = (engine.switches && engine.switches.deployer && engine.switches.deployer.switches) || {};
    var configured = deployer.zincCourseDays ? deployer.zincCourseDays.value : null;
    return resolveZincCourseDays({
      configuredDays: configured,
      packMinDays: packDay("durationDaysMin"),
      packMaxDays: packDay("durationDaysMax")
    });
  }
  // Zero means "no deployment has chosen a course length", NOT the number zero. Every screen that
  // would otherwise print a day count has to ask this first.
  //
  // Review finding, 2026-08-28: the resolver's own docstring said "the caller then shows no day
  // count at all" and no caller did. Zero was substituted into {days} like any other integer, so a
  // deployment that left the switch null - which the switch's own documentation says is supported -
  // rendered "Give zinc once each day for 0 days" on a caregiver screen, plus a calendar with no
  // day boxes, a Save button with nothing to save, and FREQ=DAILY;COUNT=0.
  //
  // CONTRACTS.md is explicit that this is not allowed: missing or invalid measurements "cannot be
  // converted to zero, false, or reassurance" and unresolved numeric policy "must not be silently
  // inferred by a rule or renderer". A treatment length nobody configured is exactly that.
  function zincCourseConfigured() {
    return zincCourseDays() > 0;
  }
  function zincDaysGiven() {
    return countZincDaysGiven(zincMarks(), zincCourseDays());
  }
  function zincHomePanelHtml() {
    // No configured course means no progress card at all - not a "Zinc: 0 of 0 days" one. This is
    // stated rather than relied upon: zincDaysGiven() also returns 0 here, so the card would vanish
    // by accident, and an accident is not a guarantee.
    if (!zincCourseConfigured()) return "";
    var given = zincDaysGiven();
    if (!given) return "";
    var dots = "";
    for (var day = 1; day <= zincCourseDays(); day++) {
      dots += '<span class="zinc-dot' + (zincMarks()[day] ? " done" : "") + '" aria-hidden="true"></span>';
    }
    return '<div class="today-reminder zinc-home" data-tool="zinc_tracker">'
      + '<strong>' + esc(tx("tx.home.zinc_title", null, { given: given, days: zincCourseDays() })) + '</strong>'
      + '<div class="zinc-dots" role="img" aria-label="' + esc(tx("tx.home.zinc_alt", null, { given: given, days: zincCourseDays() })) + '">' + dots + '</div>'
      + '<button id="homezincopen" type="button">' + esc(tx("tx.home.zinc_open", "Open zinc course")) + '</button>'
      + '</div>';
  }
  function bindZincHomePanel() {
    var open = $("homezincopen");
    if (!open || open.dataset.bound) return;
    open.dataset.bound = "homezinc";
    open.addEventListener("click", function () { openLaunch("tool.zinc_tracker", tx("tx.ors.open_zinc", "How to give zinc")); });
  }
  function renderTodayReminders() {
    var root = $("todayreminders");
    if (!root) return;
    var zincPanel = zincHomePanelHtml();
    if (!inAppNudgeSchedules.length) { root.innerHTML = zincPanel; bindZincHomePanel(); return; }
    var now = Date.now();
    root.innerHTML = zincPanel + inAppNudgeSchedules.map(function (item, index) {
      var payload = item.spec.payload || {};
      var notification = payload.notification || {};
      var moduleIds = Array.from(new Set(payload.moduleIds || []));
      var due = new Date(item.spec.fireAt).getTime() <= now;
      var reminderFeatures = moduleIds.map(function (moduleId) { return byId(catalog.features || [], moduleId); }).filter(Boolean);
      var reminderTitle = reminderFeatures.length === 1 ? t(reminderFeatures[0].titleSlug) : (notification.title || tx("tx.reminder.title", "Mamma reminder"));
      var label = due ? tx("tx.reminder.ready", "A reminder is ready.") : tx("tx.reminder.saved_for", "Mamma will show this reminder on {date}.", { date: new Date(item.spec.fireAt).toLocaleDateString() });
      var actions = moduleIds.map(function (moduleId) {
        var feature = byId(catalog.features || [], moduleId);
        var buttonLabel = reminderOpenLabel(moduleId, feature);
        // Same treatment as "Open timer" on the activity row above: a reminder's open button is
        // the action on that row, not a secondary link, so it is not drawn hollow.
        return '<button type="button" data-reminder-open="' + index + '" data-reminder-module="' + esc(moduleId) + '">' + esc(buttonLabel) + "</button>";
      }).join("");
      return '<div class="today-reminder" data-tool="in_app_nudge"><strong>' + esc(reminderTitle) + '</strong><span> ' + esc(label) + "</span>" + actions + "</div>";
    }).join("");
    bindZincHomePanel();
    var buttons = root.querySelectorAll ? root.querySelectorAll("[data-reminder-open]") : [];
    for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener("click", function () {
      var moduleId = this.getAttribute("data-reminder-module");
      var feature = byId(catalog.features || [], moduleId);
      if (!feature) return;
      if (moduleId === "chronic_refill_tracker") openedRefillReminderIndex = Number(this.getAttribute("data-reminder-open"));
      openLaunch(feature.launch, t(feature.titleSlug));
    });
  }
  function requestInAppReminder(options) {
    options = options || {};
    var dateValue = options.dateValue || localDateValue(new Date());
    var target = dateFromLocalValue(dateValue, options.startTime || "18:00");
    var end = dateFromLocalValue(dateValue, options.endTime || "21:00");
    var now = new Date();
    if (!dateValue || Number.isNaN(target.getTime()) || target < new Date(new Date().setHours(0, 0, 0, 0))) return Promise.reject(new Error(tx("tx.reminder.date_required", "Choose today or a future day for the reminder.")));
    // If today's preferred time has passed, keep enough delivery window for the
    // coordinator to move a request made during quiet hours to the next morning.
    // A three-hour window could end before quiet hours do and falsely reject an
    // explicit caregiver request as expired.
    if (target < now) { target = new Date(now.getTime() + 60000); end = new Date(target.getTime() + 24 * 60 * 60 * 1000); }
    if (end <= target) end = new Date(target.getTime() + 3 * 60 * 60 * 1000);
    var moduleId = options.moduleId;
    var tracker = trackerByModule(moduleId) || {};
    var nudge = tracker.nudge || {};
    var coordinator = createInAppNudgeCoordinator();
    if (!moduleId) return Promise.reject(new Error(tx("tx.reminder.module_required", "This reminder is missing its destination.")));
    if (!coordinator) return Promise.reject(new Error(tx("tx.reminder.unavailable", "The in-app reminder is unavailable. Please try again.")));
    var request = {
      requestId: moduleId + "-" + Date.now(), moduleId: moduleId, topic: options.topic || moduleId,
      urgencyTier: nudge.urgencyTier === "clinical_safety" ? "clinical_safety" : nudge.urgencyTier === "time_sensitive" ? "adherence_habit" : "informational_encouragement",
      windowStart: target.toISOString(), windowEnd: end.toISOString(), phraseFamily: nudge.phraseFamily || "tx.nudge.encouragement",
      privacyClass: options.privacyClass || (tracker.privacyClass === "neutral" ? "generic_ok" : "sensitive_topic"),
      channelsAllowed: ["local"], expiresAt: new Date(end.getTime() + 86400000).toISOString(),
      bundleKey: nudge.bundleKey || options.bundleKey || "care-planning", recurrence: options.recurrence
    };
    inAppReminderRequests = inAppReminderRequests.filter(function (item) { return item.moduleId !== request.moduleId || item.topic !== request.topic; });
    inAppReminderRequests.push(request);
    if (options.photo) inAppReminderPhotos[request.requestId] = options.photo;
    var rebuildState = { ignoredByType: inAppNudgeState.ignoredByType || [] };
    inAppNudgeSchedules = [];
    coordinator = createInAppNudgeCoordinator(rebuildState);
    return coordinator.scheduleRequests(inAppReminderRequests.slice()).then(function (decisions) {
      inAppNudgeState = coordinator.exportState();
      var decision = decisions.find(function (item) { return (item.requestIds || []).indexOf(request.requestId) >= 0; }) || { action: "dropped_expired" };
      renderTodayReminders();
      return decision;
    });
  }
  function requestInAppRefillReminder(dateValue, photo) {
    return requestInAppReminder({ moduleId: "chronic_refill_tracker", topic: "chronic_meds", dateValue: dateValue, privacyClass: "sensitive_topic", photo: photo });
  }
  function approvedMediaAsset(asset) {
    var text = String((asset.approvalStatus || "") + " " + (asset.clinicalReviewStatus || "") + " " + (asset.localReviewStatus || "")).toLowerCase();
    return /approved/.test(text) && !/needs approval|review needed|pending|not approved/.test(text);
  }
  function assetScore(asset) {
    var score = 0;
    score += Number(asset.displayPriority || 0);
    if (approvedMediaAsset(asset)) score += 100;
    if (String(asset.regionFocus || "").toLowerCase() === "north india prototype draft") score += 20;
    if (asset.targetPath) score += 3;
    if (asset.altText) score += 2;
    if (/codex_generated|generated/.test(String(asset.sourceType || "").toLowerCase())) score += 1;
    return score;
  }
  function renderableAsset(asset) {
    return !!asset && (/^data:image\//i.test(asset.targetPath || "") || /\.(svg|png|webp|jpe?g)$/i.test(asset.targetPath || "")) && !!asset.altText;
  }
  function displayAssetByFeature(id) {
    var candidates = assetManifest.assets.filter(function (asset) {
      var generatedDraft = asset.sourceType === "codex_generated_svg_draft" || asset.sourceType === "codex_generated_png_draft" || asset.sourceType === "codex_generated_reference_draft";
      return (asset.featureIds || []).indexOf(id) >= 0 && (generatedDraft || approvedMediaAsset(asset)) && renderableAsset(asset);
    });
    candidates.sort(function (a, b) {
      var score = assetScore(b) - assetScore(a);
      return score || String(a.assetId || "").localeCompare(String(b.assetId || ""));
    });
    return candidates[0] || null;
  }
  function assetById(assetId) {
    for (var i = 0; i < assetManifest.assets.length; i++) if (assetManifest.assets[i].assetId === assetId) return assetManifest.assets[i];
    return null;
  }
  function displayAsset(featureId, assetId) {
    // An explicit instructional asset carries meaning for that exact step. If it is
    // missing, fail to the step's labeled visual fallback; never substitute a generic
    // feature image whose action may contradict the instruction (for example, showing
    // ORS mixing on the preceding handwashing step).
    if (assetId) {
      var exact = assetById(assetId);
      return renderableAsset(exact) ? exact : null;
    }
    return featureId ? displayAssetByFeature(featureId) : null;
  }
  function caregiverAlt(text) {
    return String(text || "")
      // Asset provenance belongs in the manifest and reviewer view, never in the
      // caregiver's picture description.  These phrases accumulated as drafts
      // were promoted into the catalog and are especially disruptive to people
      // using a screen reader.
      .replace(/\bNorth India\s+prototype\s+draft:\s*/gi, "")
      .replace(/\bhigh-quality\s+illustration(?:\s+of)?\s*/gi, "")
      .replace(/\bPrototype\s+/gi, "")
      .replace(/\bprototype\s+/gi, "")
      .replace(/\bdraft\s+/gi, "")
      .replace(/\bgenerated\s+/gi, "")
      .replace(/\breusable\s+/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function assetThumb(assetId, label) {
    var asset = assetById(assetId);
    if (!asset || !asset.targetPath) return "";
    return '<figure class="dosecard"><img src="' + esc(asset.targetPath) + '" alt="' + esc(caregiverAlt(asset.altText || label || "")) + '" data-asset-id="' + esc(asset.assetId || "") + '"><figcaption>' + esc(label || caregiverAlt(asset.altText) || "") + "</figcaption></figure>";
  }
  function featureThumb(featureId) {
    // The catalog's thumbnail is a deliberate action-to-image mapping.  Do not
    // replace it with the highest-scored shared feature asset: a generic WASH
    // image can be valid for several tools but misleading for (for example) a
    // rolling-boil timer.
    var feature = catalog.features.find(function (candidate) { return candidate.id === featureId; });
    var asset = feature && feature.thumbnailAssetId ? assetById(feature.thumbnailAssetId) : null;
    if (!renderableAsset(asset)) asset = displayAssetByFeature(featureId);
    if (!asset) return "";
    return '<img class="featurethumb" src="' + esc(asset.targetPath) + '" alt="' + esc(caregiverAlt(asset.altText)) + '" data-asset-id="' + esc(asset.assetId || "") + '" loading="lazy">';
  }
  function esc(s) {
    var text = String(s || "").replace(/[&<>"']/g, function (ch) {
      return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;";
    });
    // A phrase written in the lead-plus-bullets convention (ADR-030) can reach any of the forty-odd
    // places that wrap text in a <p>. plainListHtml gives it a real <ul> on the surfaces that own a
    // whole screen; here is the floor for everywhere else, so no site can print a literal "- " and
    // run every action into one line. Attribute values never contain a newline, so this is inert
    // for esc() calls that build markup rather than copy.
    if (text.indexOf("\n") < 0) return text;
    return text.split(/\n+/).map(function (line) {
      var trimmed = line.trim();
      return trimmed.indexOf("- ") === 0 ? "\u2022 " + trimmed.slice(2).trim() : trimmed;
    }).filter(Boolean).join("<br>");
  }
  // A caregiver phrase may be written as a lead line plus one line per action, separated by
  // newlines. One renderer turns that into a lead paragraph and a bullet list, so a run of danger
  // signs is read as separate actions instead of one forty-word sentence.
  //
  // Gemini back-translated the whole French and Hindi bank on 2026-08-25 and flagged 199 rows for
  // sentence length alone. David: "Splitting these into single-action bullet points improves
  // comprehension significantly." The convention lives in the phrase text, not in the call site,
  // so a translator sees the same shape and the localization gate can check the line count.
  function isPlainList(text) {
    return String(text || "").indexOf("\n") >= 0;
  }
  function plainListHtml(text) {
    var lines = String(text || "").split("\n").map(function (line) { return line.trim(); }).filter(Boolean);
    var html = "";
    var open = false;
    for (var i = 0; i < lines.length; i++) {
      var bullet = lines[i].indexOf("- ") === 0;
      if (bullet && !open) { html += '<ul class="plain-list">'; open = true; }
      if (!bullet && open) { html += "</ul>"; open = false; }
      // The newline between elements is a real text node, so textContent - which is what read-aloud
      // and the tests see - keeps one line per action instead of gluing "these:Bleeding." together.
      html += bullet ? "<li>" + esc(lines[i].slice(2).trim()) + "</li>\n" : "<p>" + esc(lines[i]) + "</p>\n";
    }
    return open ? html + "</ul>" : html;
  }
  // Every surface that used to assign a caregiver phrase straight to textContent goes through this
  // instead, so the convention holds everywhere rather than on the screens someone remembered.
  function setSlideText(text) {
    var node = $("slidetext");
    if (!node) return;
    if (isPlainList(text)) node.innerHTML = plainListHtml(text);
    else node.textContent = String(text == null ? "" : text);
  }
  function tx(slug, fallback, vars) {
    var text = t(slug);
    if (!text || text === slug) text = fallback;
    vars = vars || {};
    Object.keys(vars).forEach(function (key) {
      text = text.split("{" + key + "}").join(String(vars[key]));
    });
    return text;
  }
  function localizeCaregiverChrome() {
    [document.body].forEach(function (root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll("[data-i18n]").forEach(function (node) {
        var slug = node.getAttribute("data-i18n");
        var text = tx(slug, node.textContent);
        // A phrase with a placeholder is a template that code fills in - "{count} breaths". The
        // markup holds a sensible initial state for it, so writing the raw template here would
        // print a literal brace at a caregiver.
        if (text.indexOf("{") >= 0) return;
        node.textContent = text;
      });
      root.querySelectorAll("[data-i18n-placeholder]").forEach(function (node) {
        node.setAttribute("placeholder", tx(node.getAttribute("data-i18n-placeholder"), node.getAttribute("placeholder") || ""));
      });
      root.querySelectorAll("[data-i18n-aria-label]").forEach(function (node) {
        node.setAttribute("aria-label", tx(node.getAttribute("data-i18n-aria-label"), node.getAttribute("aria-label") || ""));
      });
      root.querySelectorAll("[data-i18n-title]").forEach(function (node) {
        node.setAttribute("title", tx(node.getAttribute("data-i18n-title"), node.getAttribute("title") || ""));
      });
    });
  }
  function renderVisual(featureId, description, assetId, exactAssetOnly) {
    var asset = exactAssetOnly && !assetId ? null : displayAsset(featureId, assetId);
    if (asset) {
      return '<img class="visualasset" src="' + esc(asset.targetPath) + '" alt="' + esc(caregiverAlt(asset.altText)) + '" data-asset-id="' + esc(asset.assetId) + '" loading="eager" decoding="async">';
    }
    var fallbackTitle = exactAssetOnly
      ? tx("tx.visual.description_title", "Picture description")
      : tx("tx.visual.pending_title", "Prototype illustration pending");
    var fallbackBody = description || (exactAssetOnly
      ? tx("tx.visual.description_body", "This phone is showing a description instead of loading the picture.")
      : tx("tx.visual.pending_body", "A reviewed local image will replace this draft panel."));
    return '<div class="visualfallback" role="img" aria-label="' + esc(description || fallbackTitle) + '"><strong>' + esc(fallbackTitle) + '</strong><span>' + esc(fallbackBody) + "</span></div>";
  }
  function questionAssetHtml(q) {
    var asset = q && q.assetId ? assetById(q.assetId) : null;
    if (renderableAsset(asset)) {
      var image = '<img src="' + esc(asset.targetPath) + '" alt="' + esc(caregiverAlt(asset.altText)) + '" data-asset-id="' + esc(asset.assetId) + '" loading="lazy">';
      return '<figure class="questionasset">' + image + '<figcaption>' + esc(q.img || caregiverAlt(asset.altText)) + '</figcaption><details><summary>' + esc(tx("tx.triage.show_larger_example", "Show larger example")) + '</summary>' + image + '</details></figure>';
    }
    return q && q.img ? '<div class="imgph">Image: ' + esc(q.img) + "</div>" : "";
  }
  function questionExamplesHtml(items) {
    var examples = (items || []).map(questionAssetHtml).filter(Boolean).join("");
    if (!examples) return "";
    return '<details class="questionexamples"><summary>' +
      esc(tx("tx.clinical_screen.under5.picture_examples", "Show picture examples")) +
      "</summary>" + examples + "</details>";
  }
  function signExampleHtml(id) {
    var asset = assetById(FOLLOWUP_IMAGE_ASSETS[id]);
    if (!renderableAsset(asset)) return "";
    var alt = tx("tx.q_" + id, caregiverAlt(asset.altText));
    return '<details class="sign-example"><summary>' + esc(tx("tx.clinical.show_me", "Show me")) + '</summary>' +
      '<img src="' + esc(asset.targetPath) + '" alt="' + esc(alt) + '" data-asset-id="' + esc(asset.assetId) + '"></details>';
  }
  function comparisonAssetImage(assetId, alt, decorative) {
    var asset = assetById(assetId);
    if (!renderableAsset(asset)) return "";
    return '<img src="' + esc(asset.targetPath) + '" alt="' + esc(decorative ? "" : caregiverAlt(alt || asset.altText)) + '" data-asset-id="' + esc(asset.assetId) + '" loading="eager" decoding="async">';
  }
  function chestIndrawingComparisonHtml() {
    var rest = comparisonAssetImage("img.user_supplied.chest_indrawing_rest_v2", "", true);
    var normal = comparisonAssetImage("img.user_supplied.chest_indrawing_breath_in_normal_v2", tx("tx.u5.chest_compare.normal_alt", "A child breathing in: the chest and belly move out together."));
    var indrawing = comparisonAssetImage("img.user_supplied.chest_indrawing_breath_in_indrawing_v2", tx("tx.u5.chest_compare.indrawing_alt", "The same child breathing in: the skin just below the ribs pulls inward while the belly moves out."));
    if (!rest || !normal || !indrawing) return "";
    return '<details class="questionexamples chest-example"><summary>' + esc(tx("tx.u5.chest_compare.show", "Show chest movement example")) + '</summary>' +
      '<section class="breath-compare" id="chestindrawingcomparison" aria-label="' + esc(tx("tx.u5.chest_compare.title", "Watch the lower chest")) + '">' +
      '<h3>' + esc(tx("tx.u5.chest_compare.title", "Watch the lower chest")) + '</h3>' +
      '<p class="breath-compare-lead">' + esc(tx("tx.u5.chest_compare.lead", "When the child breathes in, the belly moves out. Watch the space just under the ribs.")) + '</p>' +
      '<div class="breath-pair">' +
        '<section class="breath-panel is-normal"><div class="breath-panel-head"><span class="badge" aria-hidden="true">&#10003;</span><span class="name">' + esc(tx("tx.u5.chest_compare.normal", "Chest and belly move out")) + '</span></div><div class="breath-stage">' + rest + '<span class="breath-frame-in">' + normal + '</span><span class="breath-cue breath-cue-out breath-cue-chest" aria-hidden="true"></span><span class="breath-cue breath-cue-out breath-cue-belly" aria-hidden="true"></span></div><p class="breath-caption">' + esc(tx("tx.u5.chest_compare.normal_caption", "The lower chest moves out with the belly.")) + '</p></section>' +
        '<section class="breath-panel is-indrawing"><div class="breath-panel-head"><span class="badge" aria-hidden="true">!</span><span class="name">' + esc(tx("tx.u5.chest_compare.indrawing", "Lower chest pulls in")) + '</span></div><div class="breath-stage">' + rest + '<span class="breath-frame-in">' + indrawing + '</span><span class="breath-zone" aria-hidden="true"></span><span class="breath-cue breath-cue-out breath-cue-chest" aria-hidden="true"></span><span class="breath-cue breath-cue-in breath-cue-lower" aria-hidden="true"></span><span class="breath-cue breath-cue-out breath-cue-belly" aria-hidden="true"></span></div><p class="breath-caption">' + esc(tx("tx.u5.chest_compare.indrawing_caption", "The circled lower chest pulls in while the belly moves out.")) + '</p></section>' +
      '</div><div class="breath-motion-control"><span>' + esc(tx("tx.u5.chest_compare.motion_label", "Watch the movement on a breath in.")) + '</span><button class="ghost" id="chestindrawingpause" type="button" aria-pressed="false">' + esc(tx("tx.u5.chest_compare.pause", "Pause movement")) + '</button></div></section></details>';
  }
  function stridorSoundExampleHtml() {
    var asset = assetById("audio.clinical.stridor_example_cc_by_sa_3");
    if (!asset || !asset.targetPath) return "";
    return '<aside class="soundexample" aria-label="' + esc(tx("tx.stridor_sound.play", "Hear an example")) + '">' +
      '<p>' + esc(tx("tx.stridor_sound.hint_short", "Listen to an example of a harsh sound when breathing in.")) + '</p>' +
      '<div class="slidecontrols wrap-controls"><button id="stridorsoundplay" type="button" data-asset-id="' + esc(asset.assetId) + '">' + esc(tx("tx.stridor_sound.play", "Hear an example")) + '</button>' +
      '<button class="ghost" id="stridorsoundstop" type="button" disabled>' + esc(tx("tx.stridor_sound.stop", "Stop sound")) + '</button>' +
      '<span id="stridorsoundstatus" class="muted" aria-live="polite"></span></div>' +
      '<details class="media-attribution"><summary>' + esc(tx("tx.stridor_sound.attribution_link", "View source and licence")) + '</summary><p>' + esc(tx("tx.stridor_sound.attribution_summary", "Sound: 'Stridor NP OGG 2.ogg,' Wikimedia Commons. Recording supplied by James Heilman, MD; processed by Natural Philo. CC BY-SA 3.0. No changes made.")) +
      ' <a href="https://commons.wikimedia.org/wiki/File:Stridor_NP_OGG_2.ogg" target="_blank" rel="noopener noreferrer">' + esc(tx("tx.stridor_sound.attribution_link", "View source and licence")) + '</a></p></details></aside>';
  }
  function bindChestIndrawingComparison() {
    var comparison = $("chestindrawingcomparison");
    var pause = $("chestindrawingpause");
    if (!comparison || !pause || pause.dataset.bound) return;
    pause.dataset.bound = "chest-indrawing-comparison";
    pause.addEventListener("click", function () {
      var paused = comparison.classList.toggle("is-paused");
      pause.setAttribute("aria-pressed", String(paused));
      pause.textContent = paused
        ? tx("tx.u5.chest_compare.play", "Play movement")
        : tx("tx.u5.chest_compare.pause", "Pause movement");
    });
  }
  // Shared checklist marking state.
  //
  // Every checklist used to hand-roll its own state object, and three of them - the birth plan,
  // the delivery kit, and the cholera alert - bound a change handler that did nothing and rendered
  // their boxes with no checked attribute. So a mark survived exactly until the next re-render.
  // External review (mgilkey A1) hit this as "I checked an item, saved, tapped Review birth plan
  // again, and my checkmark was gone". Keeping the state in one place means that bug has one place
  // to live, and a new checklist gets the behaviour by default instead of by remembering to.
  //
  // Marks last for the session only. There is no persistence anywhere in the app (ADR-027), and
  // any screen claiming otherwise is stating something untrue.
  var checklistState = {};
  function checklistMarks(groupId) {
    if (!checklistState[groupId]) checklistState[groupId] = {};
    return checklistState[groupId];
  }
  function checklistBoxHtml(groupId, id, labelHtml) {
    return '<label><input id="' + id + '" type="checkbox"' + (checklistMarks(groupId)[id] ? " checked" : "") + '> ' + labelHtml + '</label>';
  }
  function bindChecklistBoxes(groupId, ids) {
    var marks = checklistMarks(groupId);
    for (var i = 0; i < ids.length; i++) {
      (function (id) {
        var box = $(id);
        if (!box || box.dataset.bound === groupId) return;
        box.dataset.bound = groupId;
        box.addEventListener("change", function () { marks[id] = !!($(id) && $(id).checked); });
      })(ids[i]);
    }
  }
  function resetChecklistMarks(groupId) { checklistState[groupId] = {}; }
  function traceDetails(label, body) {
    // ADR-027 amendment: the prototype disclaimer belongs in the standard header once per card.
    // This summary is always visible even while the disclosure is collapsed, so it must not repeat it.
    return '<details class="trace"><summary>' + esc(label || "Review details") + '</summary>' + esc(body || "") + "</details>";
  }
  function reviewerDetails(body) {
    return traceDetails(tx("tx.review_details.label", "Review details"), body);
  }
  function reviewDetailsHtml(featureId, note) {
    return reviewerDetails((note ? note + " " : "") + provenanceSummary(featureId) + assetSummary(featureId) + contractSummary(featureId));
  }
  function combinedReviewDetailsHtml(featureIds, note) {
    var body = note ? note + " " : "";
    for (var i = 0; i < featureIds.length; i++) body += provenanceSummary(featureIds[i]) + assetSummary(featureIds[i]) + contractSummary(featureIds[i]);
    return reviewerDetails(body);
  }
  function friendlyOtherMessage() {
    return tx("tx.other_unknown_professional", "If something else worries you, contact a clinic, community health worker, or other local care provider for assessment.");
  }
  function pregnancyOtherMessage() {
    return tx("tx.urgent_pregnancy.other", "If something else worries you, contact a clinic or maternity care provider for assessment.");
  }
  function friendlyOtherTitle() {
    return tx("tx.other_concern.title", "Something else worries you");
  }
  function backHomeHtml() {
    if (mode === "person-intent" && activePersonId && personById(activePersonId)) {
      return '<p><button class="ghost" id="backperson" type="button">' + esc(tx("tx.nav.back_to_person", "Back to {personName}", { personName: personById(activePersonId).name })) + "</button></p>";
    }
    return '<p><button class="ghost" id="backhome" type="button">' + esc(tx("tx.nav.back_home", "Back to home screen")) + '</button></p>';
  }
  function backToUnder5QuestionsHtml() {
    return '<p class="result-secondary-actions"><button class="ghost" id="backtounder5questions" type="button">' + esc(tx("tx.nav.back_to_questions", "Back to questions")) + '</button></p>';
  }
  function backToUnder5ResultHtml() {
    // Name the destination. "Back to advice" did not say which advice, and by this point the
    // caregiver has passed three screens that all gave her some. David, 2026-08-20: "'Back to
    // advice' is unclear -- which advice?" The destination is the child's own result screen, so it
    // uses the child's name where there is one.
    var person = activePersonId ? personById(activePersonId) : null;
    var label = person && person.name
      ? tx("tx.nav.back_to_child_result", "Back to {personName}'s advice", { personName: person.name })
      : tx("tx.nav.back_to_result", "Back to what to do");
    return '<p><button class="ghost" id="backtounder5result" type="button">' + esc(label) + '</button></p>';
  }
  function careRouteNextAction(route, severity) {
    var urgent = severity === "emergency" || severity === "urgent_clinic";
    if (route === "dental_or_clinic") {
      return urgent
        ? tx("tx.result.action_dental_urgent", "Seek urgent medical or dental care now.")
        : tx("tx.result.action_dental_today", "Arrange dental or clinic review today.");
    }
    if (route === "child_clinic") {
      return urgent
        ? tx("tx.result.action_child_clinic_urgent", "Seek urgent clinic care now.")
        : tx("tx.result.action_child_clinic_today", "Arrange clinic or health-worker review today.");
    }
    if (route === "newborn_clinic") {
      return urgent
        ? tx("tx.result.action_newborn_urgent", "Go to urgent newborn care now.")
        : tx("tx.result.action_newborn_today", "Contact a health worker or facility today.");
    }
    if (route === "postpartum_clinic") {
      return urgent
        ? tx("tx.result.action_postpartum_urgent", "Get urgent care after birth, or clinic care, now.")
        : tx("tx.result.action_postpartum_today", "Contact after-birth care, maternity, or a clinic today.");
    }
    if (route === "maternity_clinic") {
      return urgent
        ? tx("tx.result.action_maternity_urgent", "Seek urgent maternity or clinic care now.")
        : tx("tx.result.action_maternity_today", "Contact maternity or clinic care today.");
    }
    if (route === "nutrition_clinic") {
      return urgent
        ? tx("tx.result.action_nutrition_urgent", "Seek urgent nutrition or clinic care now.")
        : tx("tx.result.action_nutrition_today", "Arrange nutrition or clinic review today.");
    }
    if (route === "home_watch") {
      return tx("tx.result.action_watch_safety", "Keep watching and seek help if a danger sign appears.");
    }
    if (route === "professional") {
      return tx("tx.result.action_see_professional", "See a healthcare professional if you are concerned.");
    }
    return urgent ? tx("tx.result.action_seek_urgent_care", "Seek urgent care now.") : tx("tx.result.action_arrange_clinic", "Arrange clinic or health-worker review today.");
  }
  function routeForResult(opts) {
    opts = opts || {};
    if (opts.careRoute) return opts.careRoute;
    if (opts.kind === "home") return "home_watch";
    return "child_clinic";
  }
  function resultRouteLabel(route, kind, severity) {
    var urgent = severity === "emergency" || severity === "urgent_clinic";
    if (route === "home_watch" || kind === "home") return tx("tx.result.route_home", "Home support");
    if (kind === "ask-more") return tx("tx.result.next_action_label", "What to do");
    if (route === "dental_or_clinic") return urgent ? tx("tx.result.route_go_now", "Go now") : tx("tx.result.route_dental_today", "Clinic or dental care today");
    if (route === "newborn_clinic") return urgent ? tx("tx.result.route_newborn_now", "Urgent newborn care") : tx("tx.result.route_clinic_today", "Clinic or health worker today");
    if (route === "postpartum_clinic") return urgent ? tx("tx.result.route_postpartum_now", "Urgent care after birth") : tx("tx.result.route_clinic_today", "Clinic or health worker today");
    if (route === "maternity_clinic") return urgent ? tx("tx.result.route_maternity_now", "Urgent maternity care") : tx("tx.result.route_clinic_today", "Clinic or health worker today");
    if (urgent) return tx("tx.result.route_go_now", "Go now");
    return tx("tx.result.route_clinic_today", "Clinic or health worker today");
  }
  function resultActionCardHtml(opts) {
    opts = opts || {};
    var kind = opts.kind === "home" ? "home" : (opts.severity === "ask_more" ? "ask-more" : "refer");
    var route = routeForResult(opts);
    var nextAction = opts.nextAction || careRouteNextAction(route, opts.severity);
    var screenAttr = opts.screenId ? ' data-screen-id="' + esc(opts.screenId) + '"' : "";
    var html = '<div class="result ' + kind + '" data-tool="result_action_renderer" data-care-route="' + esc(route) + '"' + screenAttr + '><div class="result-band">' + esc(resultRouteLabel(route, kind, opts.severity)) + '</div><div class="result-body"><h2>' + esc(opts.title || tx("tx.result.title", "Result")) + "</h2>";
    var paragraphs = opts.paragraphs || [];
    if (nextAction) {
      html += '<p class="result-action"><strong>' + esc(tx("tx.result.next_action_label", "What to do")) + ':</strong> ' + esc(nextAction) + "</p>";
    }
    if (opts.bodyHtml) html += opts.bodyHtml;
    for (var i = 0; i < paragraphs.length; i++) html += plainListHtml(paragraphs[i]);
    if (opts.nextButtonId && opts.nextButtonLabel) {
      html += '<button class="result-action-button" id="' + esc(opts.nextButtonId) + '" type="button">' + esc(opts.nextButtonLabel) + "</button>";
    }
    if (opts.extraHtml) html += opts.extraHtml;
    return html + "</div></div>";
  }
  function setSlideResult(opts) {
    $("slidetext").innerHTML = resultActionCardHtml(opts) + backHomeHtml();
    bindBackHome($("slidetext"));
    moveToNextStep("slidetext");
  }
  function finishClinicalChecklistResult(opts) {
    opts = opts || {};
    $("slideimage").classList.add("hidden");
    var againId = opts.againId || "clinicalcheckagain";
    var details = opts.featureIds
      ? combinedReviewDetailsHtml(opts.featureIds, opts.reviewText || "Submitted clinical checklist result. The result replaces the questions.")
      : reviewDetailsHtml(opts.featureId, opts.reviewText || "Submitted clinical checklist result. The result replaces the questions.");
    $("slidecache").innerHTML = '<div class="slidecontrols"><button id="' + esc(againId) + '" type="button">' +
      esc(opts.againLabel || tx("tx.clinical_check.check_again", "Check the signs again")) +
      "</button></div>" + details;
    var again = $(againId);
    bindWorkReviewAgain(again, function () {
      $("slideimage").classList.remove("hidden");
      setSlideText(opts.bodyText || "");
      if (typeof opts.render === "function") opts.render();
      moveToNextStep("slidecache");
    }, opts.boundName || "clinical-check-result");
    appendScreenDecisionTrace(opts.featureId || (opts.featureIds && opts.featureIds[0]), opts.decision);
  }
  function pushWorkBackStep(restore) {
    if (typeof restore === "function") workBackSteps.push(restore);
  }
  function pushCurrentWorkView() {
    var slides = activeSlides.slice();
    var index = slideIndex;
    var screenId = $("slideshow") && $("slideshow").getAttribute ? $("slideshow").getAttribute("data-screen-id") : "";
    pushWorkBackStep(function () {
      cancelAllUiTimers();
      activeSlides = slides;
      slideIndex = Math.max(0, Math.min(index, Math.max(0, activeSlides.length - 1)));
      activeShellScreen = "work";
      renderSlide();
      if ($("slideshow") && $("slideshow").setAttribute) $("slideshow").setAttribute("data-screen-id", screenId || "");
      applyShellVisibility();
      moveToNextStep("slideshow");
    });
  }
  function discardWorkBackStep() {
    if (workBackSteps.length) workBackSteps.pop();
  }
  function bindWorkReviewAgain(button, restore, boundName) {
    pushWorkBackStep(restore);
    if (!button || button.dataset.bound) return;
    button.dataset.bound = boundName || "work-review-again";
    button.addEventListener("click", function () {
      discardWorkBackStep();
      restore();
    });
  }
  function restoreSubmittedChecklist(opts) {
    $("slideimage").classList.remove("hidden");
    setSlideText(opts.bodyText || "");
    if (typeof opts.render === "function") opts.render();
    moveToNextStep("slidecache");
  }
  function selectedChecklistItems(ids, names, state) {
    var checked = ids.filter(function (id) { return state ? !!state[id] : !!($(id) && $(id).checked); });
    var selectedItems = checked.map(function (id) { return names[id] || id; }).join(", ") || tx("tx.tool.checklist.nothing_selected", "nothing selected yet");
    return { checked: checked, selectedItems: selectedItems };
  }
  function setChecklistSummary(opts) {
    opts = opts || {};
    var summary = selectedChecklistItems(opts.ids || [], opts.names || {}, opts.state);
    setSlideText(tx(opts.slug, opts.fallback, {
      count: summary.checked.length,
      total: (opts.ids || []).length,
      selectedItems: summary.selectedItems
    }));
    if (typeof opts.after === "function") opts.after(summary);
    return summary;
  }
  function showSubmittedChecklistResult(opts) {
    opts = opts || {};
    var summary = selectedChecklistItems(opts.ids || [], opts.names || {}, opts.state);
    // Most submitted plans are a tally: how many of these did you do. The birth plan is not - it is
    // a document a family reads out loud when labor begins, so what it owes the caregiver is what
    // she wrote, not how many boxes she ticked. Rather than let it grow a bespoke result renderer
    // beside this one, it passes its own paragraphs and its own extra control through here. One
    // implementation still owns the transition, the hidden image, the Review-again binding and the
    // back step, which is what this helper exists to guarantee.
    var summaryText = tx("tx.tool.checklist.ready_count", "{count} of {total} items ready.", {
      count: summary.checked.length,
      total: (opts.ids || []).length
    });
    setSlideResult({
      kind: "home",
      careRoute: "home_watch",
      title: opts.title || "Your plan",
      nextAction: opts.nextAction || "Use the saved steps below. Review the checklist again when something changes.",
      paragraphs: opts.paragraphs || [summaryText]
    });
    $("slideimage").classList.add("hidden");
    var againId = opts.againId || "checklistreviewagain";
    $("slidecache").innerHTML =
      '<div class="slidecontrols"><button id="' + esc(againId) + '" type="button">' +
      esc(opts.againLabel || "Review checklist again") +
      "</button>" + (opts.extraControlsHtml || "") + "</div>" +
      (opts.featureId ? reviewDetailsHtml(opts.featureId, opts.reviewText || "Submitted checklist result.") : "");
    var again = $(againId);
    bindWorkReviewAgain(again, function () { restoreSubmittedChecklist(opts); }, "submitted-checklist");
    if (typeof opts.after === "function") opts.after(summary);
    return summary;
  }
  function bindExplicitAnswerGate(opts) {
    opts = opts || {};
    var ids = opts.ids || [];
    var noneId = opts.noneId;
    var action = $(opts.actionId);
    var feedback = opts.feedbackId ? $(opts.feedbackId) : null;
    if (action && feedback && action.setAttribute) action.setAttribute("aria-describedby", opts.feedbackId);
    if (feedback && feedback.setAttribute) feedback.setAttribute("aria-live", "polite");
    function update() {
      var answered = ids.some(function (id) { return !!($(id) && $(id).checked); });
      if (action) action.disabled = !answered;
      // The disabled primary action already shows that the caregiver must answer. Repeating a
      // generic status after every selection adds noise and has repeatedly obscured the
      // actual question. A caller may opt into a specific unanswered message when needed.
      if (feedback) feedback.textContent = !answered && opts.showRequiredFeedback
        ? (opts.requiredSlug ? tx(opts.requiredSlug, opts.requiredFallback) : opts.requiredFallback || tx("tx.danger_checklist.answer_required", "Choose every sign that is happening, or choose None of these."))
        : "";
      return answered;
    }
    ids.forEach(function (id) {
      var box = $(id);
      if (!box || box.dataset.explicitAnswerGate) return;
      box.dataset.explicitAnswerGate = opts.actionId || "explicit";
      box.addEventListener("change", function () {
        if (opts.singleSelect && box.checked) {
          ids.forEach(function (otherId) {
            if (otherId !== id && $(otherId)) $(otherId).checked = false;
          });
        } else if (id === noneId && box.checked) {
          ids.forEach(function (otherId) {
            if (otherId !== noneId && $(otherId)) $(otherId).checked = false;
          });
        } else if (id !== noneId && box.checked && noneId && $(noneId)) {
          $(noneId).checked = false;
        }
        update();
      });
    });
    update();
    return update;
  }
  function clinicalScreen(surfaceId) {
    var screen = clinicalScreensById[surfaceId];
    if (!screen) throw new Error("Unregistered clinical screen: " + surfaceId);
    return screen;
  }
  // A question can declare that it depends on equipment the deployment supplies
  // (requiresDeployerSwitch). Render and bind must agree about which options exist, so both go
  // through this filter - an earlier version filtered only the renderer, and the binder then threw
  // looking for a checkbox that was never drawn.
  function clinicalOptionIsAsked(option) {
    return !option.requiresDeployerSwitch || deployerSwitch(option.requiresDeployerSwitch);
  }
  function clinicalChecklistOptionIds(screen, options) {
    return (options || screen.options || []).filter(clinicalOptionIsAsked).map(function (option) { return option.id; });
  }
  function renderClinicalChecklist(surfaceId, opts) {
    opts = opts || {};
    var screen = clinicalScreen(surfaceId);
    var groups = opts.groups || screen.groups || [];
    var options = opts.options || screen.options || [];
    var optionById = {};
    options.forEach(function (option) { optionById[option.id] = option; });
    var selected = opts.selected || {};
    var html = '<div class="slidecontrols checklist-controls clinical-checklist" data-clinical-screen-id="' + esc(surfaceId) + '">';
    if (screen.introSlug && !opts.omitIntro) html += '<p class="muted">' + esc(tx(screen.introSlug, screen.introSlug)) + "</p>";
    if (opts.beforeFieldsHtml) html += opts.beforeFieldsHtml;
    groups.forEach(function (group) {
      html += '<fieldset class="symptom-group"><legend>' + esc(group.legend || tx(group.legendSlug, group.legendSlug)) + '</legend>';
      (group.optionIds || []).forEach(function (optionId) {
        var option = optionById[optionId];
        if (!option) throw new Error("Clinical screen " + surfaceId + " references unknown option " + optionId);
        // A question that depends on equipment the deployment supplies is only asked where the
        // deployment supplies it. David, 2026-08-20: most caregivers have no arm tape, so asking
        // them to read its bands is asking a question they cannot answer.
        if (!clinicalOptionIsAsked(option)) return;
        var label = option.label || tx(option.labelSlug, option.labelSlug);
        var optionClass = "clinical-option" + (option.kind === "none" ? " clinical-option-none" : "");
        html += '<label class="' + optionClass + '"><input id="' + esc(option.id) + '" type="' + (opts.singleSelect ? "radio" : "checkbox") + '"' + (opts.singleSelect ? ' name="' + esc(surfaceId) + '-choice"' : "") + ' data-clinical-option-kind="' + esc(option.kind) + '"' +
          (selected[option.stateId || option.id] ? " checked" : "") + "> " + esc(label) + "</label>";
        if (typeof opts.optionHelpHtml === "function") html += opts.optionHelpHtml(option) || "";
      });
      html += "</fieldset>";
    });
    if (opts.afterFieldsHtml) html += opts.afterFieldsHtml;
    if (!opts.omitAction) html += '<button id="' + esc(screen.actionId) + '" type="button">' + esc(tx(screen.actionSlug, screen.actionSlug)) + "</button>";
    if (!opts.omitFeedback) html += '<p class="checklist-feedback" id="' + esc(screen.feedbackId) + '"></p>';
    if (opts.afterActionHtml) html += opts.afterActionHtml;
    return html + "</div>";
  }
  function bindClinicalChecklist(surfaceId, opts) {
    opts = opts || {};
    var screen = clinicalScreen(surfaceId);
    var options = opts.options || screen.options || [];
    var ids = clinicalChecklistOptionIds(screen, options);
    var noneId = opts.noneId || screen.noneId;
    var state = opts.state || null;
    ids.forEach(function (id) {
      var box = $(id);
      if (!box) throw new Error("Clinical screen " + surfaceId + " did not render option " + id);
      var option = options.find(function (candidate) { return candidate.id === id; });
      box.checked = state ? !!state[(option && option.stateId) || id] : false;
    });
    var update = bindExplicitAnswerGate({
      ids: ids,
      noneId: noneId,
      actionId: opts.actionId || screen.actionId,
      feedbackId: opts.feedbackId || screen.feedbackId,
      singleSelect: opts.singleSelect === true,
      readySlug: opts.readySlug,
      readyFallback: opts.readyFallback,
      requiredSlug: opts.requiredSlug || screen.requiredSlug,
      requiredFallback: opts.requiredFallback,
      showRequiredFeedback: opts.showRequiredFeedback !== false
    });
    ids.forEach(function (id) {
      var box = $(id);
      box.addEventListener("change", function () {
        if (state) {
          options.forEach(function (option) {
            state[option.stateId || option.id] = !!($(option.id) && $(option.id).checked);
          });
        }
        if (typeof opts.onChange === "function") opts.onChange(id, !!box.checked);
      });
    });
    return { screen: screen, ids: ids, update: update };
  }
  function compareClinicalValues(left, op, right) {
    if (op === ">") return left > right;
    if (op === "<") return left < right;
    if (op === ">=") return left >= right;
    if (op === "<=") return left <= right;
    if (op === "==") return left === right;
    if (op === "!=") return left !== right;
    throw new Error("unknown clinical expression op '" + op + "'");
  }
  function evalClinicalExpression(expression, inputs, predicates) {
    if (!expression || typeof expression !== "object") throw new Error("bad clinical expression");
    if (expression.ref) {
      if (!(expression.ref in predicates)) throw new Error("unknown predicate ref '" + expression.ref + "'");
      return predicates[expression.ref];
    }
    if (expression.not) return !evalClinicalExpression(expression.not, inputs, predicates);
    if (expression.allOf) return expression.allOf.every(function (child) { return evalClinicalExpression(child, inputs, predicates); });
    if (expression.anyOf) return expression.anyOf.some(function (child) { return evalClinicalExpression(child, inputs, predicates); });
    if (expression.atLeast != null) return (expression.of || []).filter(function (child) { return evalClinicalExpression(child, inputs, predicates); }).length >= expression.atLeast;
    if (expression.var) {
      if ("is" in expression) return inputs[expression.var] === expression.is;
      if ("equals" in expression) return inputs[expression.var] === expression.equals;
      if ("op" in expression) return compareClinicalValues(inputs[expression.var], expression.op, expression.value);
    }
    throw new Error("unrecognized clinical expression: " + JSON.stringify(expression));
  }
  function evaluateScreenClinicalDecision(predicateIr, decisionIr, inputs, guidelineVersion) {
    var predicates = {};
    for (var i = 0; i < (predicateIr.predicates || []).length; i++) {
      var predicate = predicateIr.predicates[i];
      predicates[predicate.id] = evalClinicalExpression(predicate, inputs, predicates);
    }
    if (decisionIr.hitPolicy === "collect_then_resolve") {
      var matches = [];
      for (var r = 0; r < (decisionIr.rules || []).length; r++) {
        var rule = decisionIr.rules[r];
        if (evalClinicalExpression(rule.when, inputs, predicates)) matches.push({ rule: rule, index: r });
      }
      if (matches.length) {
        var rank = {};
        var order = decisionIr.severityOrder || ["emergency", "urgent_clinic", "routine_clinic", "home_care", "followup"];
        for (var s = 0; s < order.length; s++) rank[order[s]] = s;
        matches.sort(function (left, right) {
          var a = rank[left.rule.then.severity] == null ? 999 : rank[left.rule.then.severity];
          var b = rank[right.rule.then.severity] == null ? 999 : rank[right.rule.then.severity];
          return (a - b) || (left.index - right.index);
        });
        var out = {};
        Object.keys(matches[0].rule.then || {}).forEach(function (key) { out[key] = matches[0].rule.then[key]; });
        out.firedRuleId = matches[0].rule.id;
        out.matchedRules = matches.map(function (entry) { return entry.rule.id; });
        out.predicates = predicates;
        out.guidelineVersion = guidelineVersion;
        return out;
      }
      var fallback = {};
      Object.keys(decisionIr.default || {}).forEach(function (key) { fallback[key] = decisionIr.default[key]; });
      fallback.firedRuleId = "__default__";
      fallback.matchedRules = [];
      fallback.predicates = predicates;
      fallback.guidelineVersion = guidelineVersion;
      return fallback;
    }
    for (var f = 0; f < (decisionIr.rules || []).length; f++) {
      var firstRule = decisionIr.rules[f];
      if (evalClinicalExpression(firstRule.when, inputs, predicates)) {
        var first = {};
        Object.keys(firstRule.then || {}).forEach(function (key) { first[key] = firstRule.then[key]; });
        first.firedRuleId = firstRule.id;
        first.matchedRules = [firstRule.id];
        first.predicates = predicates;
        first.guidelineVersion = guidelineVersion;
        return first;
      }
    }
    var def = {};
    Object.keys(decisionIr.default || {}).forEach(function (key) { def[key] = decisionIr.default[key]; });
    def.firedRuleId = "__default__";
    def.matchedRules = [];
    def.predicates = predicates;
    def.guidelineVersion = guidelineVersion;
    return def;
  }
  function screenDecision(featureId, selectedVariableIds) {
    var card = screenByFeature(featureId);
    var set = card && card.clinicalVariableSet;
    var ir = screenClinicalIr[featureId];
    if (!set || !ir || !ir.predicates || !ir.decisions) return { firedRuleId: "__missing_ir__", matchedRules: [], severity: "followup", predicates: {}, action: "FOLLOWUP", guidelineVersion: "missing-generated-screen-ir" };
    var aliases = {
      anc_triage: { pregbleeding: "ancbleeding", pregheadvision: "ancheadvision", pregbreathing: "ancbreathing", pregpainfever: "ancpainfever", pregmovement: "ancmovement", pregother: "ancother" },
      pnc_lactation: {
        pncclots: "pncbleeding",
        pncplacenta: "pncbleeding",
        pncsmelldischarge: "pncbleeding",
        pncchestpain: "pncbreathing",
        pncfastheart: "pncbreathing",
        pncdizzyfaint: "pncbreathing",
        pncbellypain: "pncheadvision",
        pncswelling: "pncheadvision"
      },
      kohl_lead_screen: { kohlaway: "kohlaccess" },
    };
    var inputs = {};
    Object.keys(ir.predicates.inputs || {}).forEach(function (id) { inputs[id] = false; });
    if (set.presentation) inputs[set.presentation] = true;
    (selectedVariableIds || []).forEach(function (raw) {
      var id = (aliases[featureId] && aliases[featureId][raw]) || raw;
      if (id in inputs) inputs[id] = true;
      else if ((featureId + "_" + id) in inputs) inputs[featureId + "_" + id] = true;
    });
    return evaluateScreenClinicalDecision(ir.predicates, ir.decisions, inputs, ir.predicates.guidelineVersionExpected || "prototype-screen-card");
  }
  function screenDecisionTraceHtml(featureId, decision) {
    if (!decision) return "";
    return '<details class="trace" data-screen-decision-engine="' + esc(featureId) + '"><summary>' + esc(tx("tx.review_details.clinical_engine", "Clinical review details")) + '</summary>' + esc(screenDecisionTraceText(decision)) + "</details>";
  }
  function screenDecisionTraceText(decision) {
    var text = "Generated predicate/DMN IR for reviewer audit only. Fired " + decision.firedRuleId + "; matched " + (decision.matchedRules || []).join(", ") + "; severity " + decision.severity + ".";
    return text;
  }
  function appendScreenDecisionTrace(featureId, decision) {
    var cache = $("slidecache");
    if (!cache || !decision) return;
    if (document.createElement && cache.appendChild) {
      var div = document.createElement("details");
      div.className = "trace";
      div.setAttribute("data-screen-decision-engine", featureId);
      var summary = document.createElement("summary");
      summary.textContent = tx("tx.review_details.clinical_engine", "Clinical review details");
      div.appendChild(summary);
      div.appendChild(document.createTextNode(screenDecisionTraceText(decision)));
      cache.appendChild(div);
    } else {
      cache.innerHTML += screenDecisionTraceHtml(featureId, decision);
    }
  }
  function trackerContractText(moduleId) {
    var tracker = trackerByModule(moduleId);
    if (!tracker) return "";
    var nudge = tracker.nudge && tracker.nudge.enabled
      ? " NudgeCoordinator intent: " + (tracker.nudge.urgencyTier || "routine") + " tier, " + (tracker.nudge.bundleKey || "unbundled") + " bundle, " + ((tracker.nudge.channelsAllowed || []).join("/") || "in_app") + " channels."
      : " NudgeCoordinator intent: none for user-facing reminders.";
    return "ProgressTracker: " + (tracker.trackerId || moduleId) + " uses " + (tracker.mode || "tracker") + " with " + (tracker.renderer || "default renderer") + "." + nudge;
  }
  function trackerContractHtml(moduleId) {
    var text = trackerContractText(moduleId);
    return text ? reviewerDetails(text) : "";
  }
  function trackerReviewDetailsHtml(moduleId, featureId, note) {
    return reviewerDetails(trackerContractText(moduleId) + " " + (note || "") + " " + provenanceSummary(featureId) + assetSummary(featureId) + contractSummary(featureId));
  }
  function nudgeStatusPanelHtml(id, state, detail) {
    return '<div class="progress-panel" data-tool="nudge_status" id="' + esc(id) + '"><strong>' + esc(tx("tx.tool.nudge_status.title", "Reminder status")) + "</strong><div>" + esc(state || tx("tx.tool.nudge_status.idle", "No reminder set yet.")) + '</div><div class="muted">' + esc(detail || tx("tx.tool.nudge_status.prototype_idle", "Shows in this app only. Your phone will not ring or buzz.")) + "</div></div>";
  }
  function setNudgeStatus(id, state, detail) {
    var status = $(id);
    if (!status) return;
    status.className = "progress-panel";
    // A status panel that says "No reminder set yet" before she has asked for anything is nineteen
    // words of nothing on a card with a word budget. Screens may render it hidden and let the first
    // real status reveal it; the ones that render it open are unaffected.
    if (status.hasAttribute && status.hasAttribute("hidden")) status.removeAttribute("hidden");
    status.setAttribute && status.setAttribute("data-tool", "nudge_status");
    status.innerHTML = '<strong>' + esc(tx("tx.tool.nudge_status.title", "Reminder status")) + "</strong><div>" + esc(state || tx("tx.tool.nudge_status.idle", "No reminder set yet.")) + '</div><div class="muted">' + esc(detail || tx("tx.tool.nudge_status.prototype_idle", "Shows in this app only. Your phone will not ring or buzz.")) + "</div>";
  }
  // Amounts and the age cut-off come from the guideline pack, never from literals here.
  function orsPerStool(key) {
    var value = engine.gd && engine.gd.get ? Number(engine.gd.get("diarrhoea.ors.perLooseStool." + key)) : NaN;
    return isFinite(value) && value > 0 ? value : null;
  }
  function orsZincCareGuideHtml(options) {
    // Inside the mixing deck the giving frame above this card already says how to give - clean cup,
    // small amounts, what to do after vomiting - so the card does not say it a second time there.
    // On its own screen the card is the only text, and keeps the line. David, 2026-09-02: "The
    // instructions are disjointed and repeat."
    var inDeck = !!(options && options.inDeck);
    // The app knows the child's age, so it shows the one band that applies. Showing both and
    // letting the caregiver pick made her do the arithmetic the app already did - and made it
    // possible to read the wrong row. David, 2026-08-20: "It gives ORS recipes for different ages,
    // but knows ages." The zinc guide below already worked this way; this one had been missed.
    var cutoff = orsPerStool("ageBandCutoffMonths");
    var underMin = orsPerStool("underCutoffMlMin"), underMax = orsPerStool("underCutoffMlMax");
    var overMin = orsPerStool("atOrOverCutoffMlMin"), overMax = orsPerStool("atOrOverCutoffMlMax");
    var haveAmounts = cutoff && underMin && underMax && overMin && overMax;
    var ageMonths = selectedChildAgeMonths();
    var person = activePersonId ? personById(activePersonId) : null;
    var childName = person && person.name ? person.name : tx("tx.person.role.child", "the child");
    var cutoffYears = cutoff ? Math.round(cutoff / 12) : 2;

    // Built from the sentence a person would say, not from components that each make sense.
    //
    // David, 2026-08-28: "That is WAY too many words of repetition... Principle of card design:
    // Start at the sensible text. Then figure out the components." The card used to state the
    // child's age band three times - once introducing it, once as a card heading, once inside the
    // amount - and say "after each loose stool" twice. For a two-year-old it also carried advice
    // about feeding a small baby with a spoon.
    //
    // When the age is known there is one answer, so the card states it once. A band heading only
    // earns its place when both bands are shown, which is only when the age is unknown and the
    // caregiver has to choose between them.
    var lines = [];
    var title;
    if (!haveAmounts) {
      // Fail closed rather than inventing an amount.
      title = tx("tx.ors_zinc.guide.title", "How much ORS");
      lines.push(tx("tx.ors_zinc.guide.amounts_missing", "This build has no ORS amounts to show. Follow the ORS packet and ask a health worker."));
    } else if (ageMonths === null) {
      // No age, so both bands stay visible. Guessing a band would be worse than one extra line.
      title = tx("tx.ors_zinc.guide.title", "How much ORS");
      lines.push(tx("tx.ors_zinc.guide.pick_by_age", null));
      lines.push(tx("tx.ors_zinc.guide.band_under", null, { years: cutoffYears, min: underMin, max: underMax }));
      lines.push(tx("tx.ors_zinc.guide.band_over", null, { years: cutoffYears, min: overMin, max: overMax }));
      if (!inDeck) lines.push(tx("tx.ors_zinc.guide.how_to_give", null));
    } else if (ageMonths < cutoff) {
      title = childName
        ? tx("tx.ors_zinc.guide.title_for_child", null, { name: childName })
        : tx("tx.ors_zinc.guide.title", "How much ORS");
      lines.push(tx("tx.ors_zinc.guide.amount_one_line", null, { min: underMin, max: underMax }));
      if (!inDeck) lines.push(tx("tx.ors_zinc.guide.how_to_give", null));
      lines.push(tx("tx.ors_zinc.guide.keep_feeding_under2", null));
    } else {
      title = childName
        ? tx("tx.ors_zinc.guide.title_for_child", null, { name: childName })
        : tx("tx.ors_zinc.guide.title", "How much ORS");
      lines.push(tx("tx.ors_zinc.guide.amount_one_line", null, { min: overMin, max: overMax }));
      if (!inDeck) lines.push(tx("tx.ors_zinc.guide.how_to_give", null));
      lines.push(tx("tx.ors_zinc.guide.keep_feeding_over2", null));
    }

    return '<div class="progress-panel" data-tool="ors_zinc_care_guide">' +
      '<strong>' + esc(title) + '</strong>' +
      lines.map(function (line) { return '<p>' + esc(line) + '</p>'; }).join("") +
      '<p class="muted">' + esc(tx("tx.ors_zinc.guide.prototype_note", "Follow the water amount on the ORS packet and the directions on the zinc product.")) + '</p></div>';
  }
  function zincCalendarHtml() {
    if (!zincCourseConfigured()) return zincNoCourseHtml();
    var boxes = "";
    for (var i = 1; i <= zincCourseDays(); i++) boxes += '<div class="zinc-box" aria-label="Zinc day ' + i + '">Day ' + i + '</div>';
    // The label is built from the same number as the boxes. It used to say "Ten-day" as a literal,
    // so a fourteen-day deployment would have shown fourteen boxes and told a screen-reader ten.
    return '<div class="zinc-calendar" role="img" aria-label="' + esc(tx("tx.zinc.calendar.alt", null, { days: zincCourseDays() })) + '">' + boxes + "</div>";
  }
  // What every zinc surface says when no course length is configured. One sentence, no number, and
  // it points at the two authorities that are always right: the product in the caregiver's hand and
  // the health worker. This is the "shows no day count at all" the resolver promised.
  function zincNoCourseHtml() {
    return '<div class="progress-panel" data-zinc-course="not-configured"><strong>'
      + esc(tx("tx.zinc.course.not_set", null)) + '</strong></div>';
  }
  function selectedChildAgeMonths() {
    var person = activePersonId ? personById(activePersonId) : null;
    if (!person || !person.birthDate) return null;
    try {
      return engine.derive({ birth_date: person.birthDate, now: new Date().toISOString(), temp_entered_value: 0 }, engine.gd).age_mo;
    } catch (e) {
      return null;
    }
  }
  // The zinc dose comes from the guideline pack, not from the sentence. It used to be written into
  // the copy as "10 mg" and "20 mg" while the pack held under6moMgPerDay and from6moMgPerDay, so a
  // programme with different doses had to edit caregiver English. CONTRACTS.md 3a.
  function zincDoseMg(key) {
    var value = engine.gd && engine.gd.get ? Number(engine.gd.get("diarrhoea.zinc." + key)) : NaN;
    return isFinite(value) && value > 0 ? value : null;
  }
  function zincMixingGuideHtml() {
    // Built from the sentence, like the ORS amount card beside it. For a two-year-old this used to
    // print the band as a heading, a line explaining that the app had read her date of birth to
    // choose that heading, and then the same authority twice - "the exact local product
    // instruction from a health worker" followed by "Follow the product label or a health worker".
    // The app knows the age, so there is one dose; provenance belongs in the panel underneath,
    // which already carries WHO.
    var ageMonths = selectedChildAgeMonths();
    var person = activePersonId ? personById(activePersonId) : null;
    var childName = person && person.name ? person.name : "";
    var underSixMg = zincDoseMg("under6moMgPerDay");
    var fromSixMg = zincDoseMg("from6moMgPerDay");
    var haveDoses = underSixMg !== null && fromSixMg !== null;

    var lines = [];
    var title = tx("tx.zinc.mixing.title", "Prepare and give zinc");
    if (!haveDoses) {
      // Fail closed rather than inventing a dose.
      lines.push(tx("tx.zinc.mixing.check_age", null));
    } else if (ageMonths === null) {
      // Deliberately NOT both bands, unlike the ORS card. Two zinc doses on one screen is two
      // numbers a caregiver could give, and the wrong one is a wrong dose rather than a wrong
      // volume - test/ui.test.ts has pinned "never shows two dose bands at once" since this screen
      // was built. With no age the product label is the answer.
      lines.push(tx("tx.zinc.mixing.check_age", null));
    } else {
      if (childName) title = tx("tx.zinc.mixing.title_for_child", null, { name: childName });
      lines.push(tx("tx.zinc.mixing.dose_one_line", null, { mg: ageMonths < 6 ? underSixMg : fromSixMg }));
    }
    lines.push(tx("tx.zinc.mixing.prepare_step", "1. Dissolve the dose in a spoon or small cup with clean water or breastmilk."));
    lines.push(tx("tx.zinc.mixing.follow_label", null));

    // The picture of the dose dissolving belongs beside the sentence that says to dissolve it, so
    // it sits after the dose line and before the caveat rather than at the top of the card.
    var dissolveVisual = '<div class="inlinevisual">'
      + renderVisual("zinc_tracker", "Dissolve the dispersible zinc dose in a spoon or small cup with clean water or breastmilk.", "img.generated.zinc_prepare_dispersible_v2")
      + '</div>';
    return '<div class="progress-panel" data-tool="zinc_mixing_guide">' +
      '<strong>' + esc(title) + '</strong>' +
      lines.slice(0, -1).map(function (line) { return '<p>' + esc(line) + '</p>'; }).join("") +
      dissolveVisual +
      '<p class="muted">' + esc(lines[lines.length - 1]) + '</p>' +
      '</div>';
  }
  function zincGivingGuideHtml() {
    return '<div class="progress-panel" data-tool="zinc_giving_guide"><strong>' + esc(tx("tx.zinc.mixing.give_step", "Give it slowly with the child sitting upright.")) + '</strong><div class="inlinevisual">' + renderVisual("zinc_tracker", "Caregiver slowly giving dissolved zinc from a spoon to a seated toddler.", "img.generated.zinc_give_toddler_v1") + '</div><p>' + esc(zincCourseConfigured() ? tx("tx.zinc.mixing.course", null, { days: zincCourseDays() }) : tx("tx.zinc.course.not_set", null)) + '</p></div>';
  }
  function bindBackHome(scope) {
    var root = scope || document;
    var personBtn = root.querySelector ? root.querySelector("#backperson") : $("backperson");
    if (personBtn && !personBtn.dataset.bound) {
      personBtn.dataset.bound = "backperson";
      personBtn.addEventListener("click", returnToActivePersonPage);
    }
    var btn = root.querySelector ? root.querySelector("#backhome") : $("backhome");
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = "backhome";
      btn.addEventListener("click", function () {
        showPanel("");
        mode = "subject";
        selected = activeSubject || "child_under5";
        dangerPersonId = null;
        if ($("out")) $("out").innerHTML = "";
        renderCatalog();
      });
    }
  }
  function bindUnder5Back(scope) {
    var root = scope || document;
    var questions = root.querySelector ? root.querySelector("#backtounder5questions") : $("backtounder5questions");
    if (questions && !questions.dataset.bound) {
      questions.dataset.bound = "under5-questions";
      questions.addEventListener("click", returnToPreviousUnder5Step);
    }
    var advice = root.querySelector ? root.querySelector("#backtounder5result") : $("backtounder5result");
    if (advice && !advice.dataset.bound) {
      advice.dataset.bound = "under5-result";
      advice.addEventListener("click", restoreUnder5Result);
    }
  }
  function returnToActivePersonPage() {
    var person = activePersonId ? personById(activePersonId) : null;
    if (!person) {
      goHome();
      return;
    }
    cancelAllUiTimers();
    // This button is an explicit exit from the work stack. Keeping a checklist
    // restore callback here makes the next shell Back redraw the just-finished
    // work instead of returning from the person's needs to the person picker.
    workBackSteps = [];
    workReturnContext = null;
    mode = "person-intent";
    selected = "";
    activeSubject = person.subject;
    dangerPersonId = null;
    search = "";
    if ($("search")) $("search").value = "";
    featureLimit = FEATURE_PAGE_SIZE;
    renderCatalog();
    showPanel("catalog");
    moveToNextStep("filtertitle");
  }
  function returnFromWork() {
    if (workBackSteps.length) {
      var restore = workBackSteps.pop();
      restore();
      return;
    }
    if (activeShellScreen === "work" && workReturnContext) {
      var context = workReturnContext;
      workReturnContext = null;
      workBackSteps = [];
      cancelAllUiTimers();
      mode = context.mode;
      selected = context.selected;
      activeSubject = context.activeSubject;
      activePersonId = context.activePersonId;
      dangerPersonId = context.dangerPersonId;
      search = context.search;
      featureLimit = context.featureLimit;
      if ($("search")) $("search").value = context.searchInput != null ? context.searchInput : search;
      activeShellScreen = context.activeShellScreen;
      renderCatalog();
      applyShellVisibility();
      moveToNextStep("catalogshell");
      return;
    }
    // The person-needs page is itself a navigable screen.  It must return to the
    // person picker, not redraw itself, when the caregiver presses the shell Back.
    if (activeShellScreen === "people" && mode === "person-intent" && !selected) {
      showCatalogScreen("people");
      return;
    }
    if (mode === "person-intent" && activePersonId && personById(activePersonId)) {
      returnToActivePersonPage();
      return;
    }
    goHome();
  }
  function goHome() {
    workBackSteps = [];
    workReturnContext = null;
    cancelAllUiTimers();
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    showPanel("");
    mode = "subject";
    selected = activeSubject || "child_under5";
    dangerPersonId = null;
    if ($("out")) $("out").innerHTML = "";
    renderCatalog();
  }
  // One vessel silhouette, drawn inside roughly x=26..66, y=12..70 of a 150x90 viewBox. Shared by
  // the container chooser and the arithmetic diagram so the picture a caregiver taps and the
  // picture that counts out the fills are unmistakably the same object.
  function containerShapeSvg(id) {
    if (id === "ceramic_mug") {
      return '<path d="M26 28 h30 v30 a8 8 0 0 1 -8 8 h-14 a8 8 0 0 1 -8 -8 z" fill="#e9f4f1" stroke="#0b6b5b" stroke-width="2"/><path d="M56 36 h9 a8 8 0 0 1 0 16 h-9" fill="none" stroke="#0b6b5b" stroke-width="2"/>';
    }
    if (id === "water_bottle_500") {
      return '<path d="M36 18 h16 v8 h5 v42 h-26 v-42 h5 z" fill="#e9f4f1" stroke="#0b6b5b" stroke-width="2"/>';
    }
    if (id === "soda_bottle_1500") {
      return '<path d="M35 12 h18 v10 c5 5 7 11 7 20 v32 h-32 v-32 c0 -9 2 -15 7 -20 z" fill="#e9f4f1" stroke="#0b6b5b" stroke-width="2"/>';
    }
    return '<rect x="28" y="22" width="30" height="42" rx="8" fill="#e9f4f1" stroke="#0b6b5b" stroke-width="2"/>';
  }
  function containerVisual(c) {
    var id = c && c.id ? c.id : "";
    var label = esc(localizedContainerLabel(c));
    if (c && c.iconPath) {
      return '<img class="cardvisual containerphoto" src="' + esc(c.iconPath) + '" alt="' + label + ' with ORS sachet for scale">';
    }
    var shape = containerShapeSvg(id);
    var mark = "";
if (id === "soda_bottle_1500") {
      mark = '<line x1="28" y1="44" x2="60" y2="44" stroke="#b3261e" stroke-width="3"/><text x="63" y="48" font-size="10" fill="#b3261e">1 L</text>';
    }
    return '<svg class="cardvisual" viewBox="0 0 150 90" role="img" aria-label="' + label + ' with ORS sachet for scale">' +
      shape + mark +
      '<rect x="88" y="26" width="34" height="46" rx="3" fill="#fff4cf" stroke="#6b4d00" stroke-width="2"/><text x="96" y="48" font-size="11" fill="#6b4d00">ORS</text><text x="92" y="61" font-size="7" fill="#6b4d00">sachet</text>' +
      '<text x="12" y="84" font-size="9" fill="#666">' + label + '</text></svg>';
  }
  // The arithmetic, drawn. David: "Generate the ORS arithmetic diagram from the chosen container."
  //
  // The old first ORS screen carried a painted "5 mugs = 1 L" strip. Painted art states one recipe
  // for one vessel, so it goes stale the moment the chosen container or the sachet volume differs
  // from what the artist drew - and it was still on screen after the deck had moved off it.
  //
  // This reads fillVolumeMl, fillCount and targetVolumeMl off the same measurement-method row that
  // produced the sentence beneath it. The picture cannot drift from the instruction, because there
  // is only one source of numbers; orsArithmeticFacts is that source, exported for the audit.
  function orsArithmeticDiagramHtml(container, method) {
    var facts = orsArithmeticFacts(container, method, orsSachetVolumeMl());
    if (!facts) return "";
    var label = localizedContainerLabel(container);
    var shape = containerShapeSvg(container.id);
    var sentence = facts.kind === "marked_line"
      ? tx("tx.ors.arithmetic.marked_line", "Fill once to the {lineMl} mL mark. That is {totalMl} mL.", { lineMl: facts.unitMl, totalMl: facts.totalMl })
      : tx("tx.ors.arithmetic.whole_fills", "{count} fills of {unitMl} mL make {totalMl} mL.", { count: facts.count, unitMl: facts.unitMl, totalMl: facts.totalMl });

    // Above six vessels the row stops being countable at a glance and starts being a texture, so
    // it collapses to one vessel and a multiplier rather than shrinking every glyph.
    var drawn = facts.count <= 6 ? facts.count : 1;
    var cellWidth = 46;
    var cells = "";
    for (var i = 0; i < drawn; i++) {
      cells += '<g transform="translate(' + (i * cellWidth - 20) + ',6) scale(0.62)">' + shape + "</g>";
    }
    var afterCells = drawn * cellWidth - 20;
    if (facts.count > 6) {
      cells += '<text x="' + (afterCells + 2) + '" y="46" font-size="17" fill="#0b6b5b" font-weight="700">&#215;' + facts.count + "</text>";
      afterCells += 34;
    }
    var equalsAt = afterCells + 8;
    var potAt = equalsAt + 22;
    var width = potAt + 62;
    return '<figure class="ors-arithmetic"><svg viewBox="0 0 ' + width + ' 78" role="img" aria-label="' + esc(sentence) + '">' +
      cells +
      '<text x="' + equalsAt + '" y="46" font-size="20" fill="#0b6b5b" font-weight="700">=</text>' +
      '<path d="M' + potAt + ' 18 h48 v34 a10 10 0 0 1 -10 10 h-28 a10 10 0 0 1 -10 -10 z" fill="#e9f4f1" stroke="#0b6b5b" stroke-width="2"/>' +
      '<text x="' + (potAt + 8) + '" y="44" font-size="12" fill="#0b6b5b">' + facts.totalMl + ' mL</text>' +
      "</svg>" +
      '<figcaption>' + esc(sentence) + "</figcaption>" +
      '<p class="muted ors-arithmetic-source">' + esc(tx("tx.ors.arithmetic.source", "Counted from the {container} you chose.", { container: label })) + "</p>" +
      "</figure>";
  }
  function localizedContainerLabel(container) {
    if (!container || !container.labels) return "container";
    var locale = $("preflanguage") ? $("preflanguage").value : "en";
    return container.labels[locale] || container.labels.en || "container";
  }
  function provenanceSummary(featureId) {
    var comparison = comparisonByFeature(featureId);
    if (!comparison) return "";
    var pubs = (comparison.sourceIds || []).map(function (id) {
      var source = sourceById(id);
      return source ? source.publisher : id;
    }).filter(Boolean);
    var unique = [];
    for (var i = 0; i < pubs.length; i++) if (unique.indexOf(pubs[i]) < 0) unique.push(pubs[i]);
    return " sources: " + (unique.join(", ") || "none loaded") + "; review: " + comparison.status + "; " + comparison.codexDecision;
  }
  function assetSummary(featureId, exactAssetId) {
    var hits = assetManifest.assets.filter(function (asset) {
      return (asset.featureIds || []).indexOf(featureId) >= 0;
    });
    if (!hits.length) return "";
    var selected = exactAssetId ? assetById(exactAssetId) : displayAssetByFeature(featureId);
    var shown = selected ? [selected] : [];
    for (var h = 0; h < hits.length && shown.length < 2; h++) {
      if (shown.indexOf(hits[h]) < 0) shown.push(hits[h]);
    }
    var audioHit = hits.filter(function (asset) { return asset.assetType === "prototype_audio"; })[0];
    if (audioHit && shown.indexOf(audioHit) < 0) shown.push(audioHit);
    return " asset: " + shown.map(function (asset) {
      var review = asset.clinicalReviewStatus || asset.localReviewStatus || asset.approvalStatus || "Review Needed";
      return asset.assetId + " (" + asset.sourceType + "; " + review + ")";
    }).join(", ") + mediaAssemblySummary(featureId);
  }
  function mediaAssemblySummary(featureId) {
    for (var p = 0; p < mediaPacks.packs.length; p++) {
      var pack = mediaPacks.packs[p];
      var feature = (pack.features || []).filter(function (candidate) { return candidate.featureId === featureId; })[0];
      if (!feature) continue;
      var layerNotes = [];
      for (var i = 0; i < (feature.layers || []).length; i++) {
        var layer = feature.layers[i];
        if (layer.source === "text") {
          layerNotes.push(layer.role + ": text");
        } else if (layer.source === "placeholder") {
          layerNotes.push(layer.role + ": placeholder");
        } else if (layer.source === "pack_asset") {
          var reusable = null;
          for (var r = 0; r < (pack.reusableAssets || []).length; r++) {
            if ((pack.reusableAssets[r].roles || []).indexOf(layer.assetRole) >= 0) reusable = pack.reusableAssets[r];
          }
          var asset = assetById(layer.assetId || (reusable && reusable.assetId));
          layerNotes.push(layer.role + ": " + (asset ? asset.assetId : "missing pack asset"));
        } else {
          var selectedAsset = displayAssetByFeature(featureId);
          layerNotes.push(layer.role + ": " + (selectedAsset ? selectedAsset.assetId : "placeholder"));
        }
      }
      return " media assembly: " + pack.packId + " (" + pack.reviewStatus + "); layers " + layerNotes.join(", ") + ".";
    }
    return "";
  }
  function contractSummary(featureId) {
    var contract = contractByFeature(featureId);
    if (!contract) return "";
    var writes = (contract.writes || []).slice(0, 4).join(", ") || "none";
    var fhir = (contract.fhirResources || []).slice(0, 5).join(", ") || "none";
    return " contract: writes " + writes + "; FHIR " + fhir + "; security " + (contract.securityPosture || "not declared") + "; review " + (contract.reviewStatus || "not declared") + ".";
  }
  function titles(list) {
    return list.map(function (x) { return { id: x.id, title: t(x.titleSlug) }; });
  }
  function featureByLaunch(launch) {
    for (var i = 0; i < catalog.features.length; i++) {
      if (catalog.features[i].launch === launch) return catalog.features[i];
    }
    return null;
  }
  function registryRecordByLaunch(launch) {
    for (var i = 0; i < moduleRegistry.modules.length; i++) {
      if (moduleRegistry.modules[i].launch === launch) return moduleRegistry.modules[i];
    }
    return null;
  }
  function registryErrors() {
    return moduleRegistry.diagnostics.filter(function (diagnostic) { return diagnostic.severity === "error"; });
  }
  function launchFromRegistry(launch) {
    var errors = registryErrors();
    if (errors.length) return { ok: false, error: "Module registry has blocking diagnostics." };
    var record = registryRecordByLaunch(launch);
    if (!record || !record.renderer) return { ok: false, error: "Unknown launch: " + launch };
    return { ok: true, featureId: record.featureId, renderer: record.renderer };
  }
  function moveToNextStep(id) {
    var panel = $(id);
    if (!panel) return;
    if (!panel.getAttribute || panel.getAttribute("tabindex") == null) {
      if (panel.setAttribute) panel.setAttribute("tabindex", "-1");
    }
    if (panel.setAttribute) panel.setAttribute("data-next-step-focus", "true");
    if (panel.scrollIntoView) panel.scrollIntoView({ behavior: "auto", block: "start" });
    if (panel.focus) {
      try { panel.focus({ preventScroll: true }); }
      catch (e) { panel.focus(); }
    }
  }
  var activeShellScreen = "home";
  var activeShellTitle = "";
  function shellScreenLabel() {
    // External review mgilkey A6: tapping the home "Care" door opened a screen headed "People", so
    // the reviewer concluded the button was mislabelled or misrouted and stopped reviewing the
    // screen. The door label is an accepted-experience row and is not changed here; what was wrong
    // is that the destination forgot why the caregiver arrived. careEntryStartsCheck already
    // carries that intent through to the person options, so the heading now carries it too.
    if (activeShellScreen === "people") {
      return careEntryStartsCheck
        ? tx("tx.shell.who_needs_care", "Who needs care?")
        : tx("tx.shell.nav_people", "People");
    }
    if (activeShellScreen === "learn") return tx("tx.shell.learn_and_practice", "Learn and practice");
    if (activeShellScreen === "tools") return tx("tx.shell.nav_tools", "Tools");
    if (activeShellScreen === "urgent-who") return tx("tx.shell.something_wrong", "Something's wrong");
    if (activeShellScreen === "urgent-check") return under5StageTitle();
    if (activeShellScreen === "work") return activeShellTitle || ($("slidetitle") && $("slidetitle").textContent ? $("slidetitle").textContent : tx("tx.shell.activity", "Activity"));
    return tx("tx.shell.today", "Today");
  }
  function triageProgressHtml() {
    if (activeShellScreen !== "urgent-check") return "";
    var activeStep = under5Stage === "danger" ? "danger"
      : under5Stage === "complaints" ? "symptoms"
      : under5Stage === "result" ? "result"
      : "details";
    var steps = [
      { id: "danger", label: tx("tx.triage.chrome.progress_danger", "Danger signs"), active: activeStep === "danger", done: activeStep !== "danger" },
      { id: "symptoms", label: tx("tx.triage.chrome.progress_main_problem", "Main problem"), active: activeStep === "symptoms", done: under5VisitedSymptoms && (activeStep === "details" || activeStep === "result"), skipped: activeStep === "result" && !under5VisitedSymptoms },
      { id: "details", label: tx("tx.triage.chrome.progress_details", "Details"), active: activeStep === "details", done: under5VisitedDetails && activeStep === "result", skipped: activeStep === "result" && !under5VisitedDetails }
    ];
    steps.push({ id: "result", label: tx("tx.triage.chrome.progress_result", "Result"), active: activeStep === "result", done: false });
    return steps.map(function (step) {
      var stateLabel = step.skipped ? tx("tx.triage.chrome.progress_not_needed", "not needed") : "";
      return '<span class="progressstep ' + (step.active ? "active " : "") + (step.done ? "done " : "") + (step.skipped ? "skipped" : "") + '"' + (step.active ? ' aria-current="step"' : "") + (stateLabel ? ' aria-label="' + esc(step.label + ": " + stateLabel) + '"' : "") + '>' + esc(step.label) + "</span>";
    }).join("");
  }
  function deckProgressHtml() {
    if (activeSlides.length < 2) return "";
    // One chip that states its own position, so it must not also carry the strip's counter badge -
    // that rendered as "1 Step 5 of 7". The strip's numbered badge is for multi-chip progress.
    return '<span class="progressstep progressstep-solo active" aria-current="step">' + esc(tx("tx.howto.step", "Step {current} of {total}", {
      current: slideIndex + 1,
      total: activeSlides.length
    })) + "</span>";
  }
  function applyShellVisibility() {
    // Help is a temporary overlay, not a second screen layer. Any state change
    // that redraws or navigates the app must dismiss it so stale instructions
    // cannot obscure the caregiver's next task.
    closeHowTo();
    var demoEnabled = $("demomodeon") && $("demomodeon").checked;
    var showHome = activeShellScreen === "home";
    var showCatalog = activeShellScreen === "people" || activeShellScreen === "learn" || activeShellScreen === "tools" || activeShellScreen === "urgent-who";
    var showWork = activeShellScreen === "work";
    var showTriage = activeShellScreen === "urgent-check";
    if (document.body && document.body.classList) document.body.classList.toggle("task-active", !showHome);
    if ($("todaypanel")) $("todaypanel").classList.toggle("hidden", !(showHome && !demoEnabled));
    if ($("demomode")) $("demomode").classList.toggle("hidden", !(showHome && demoEnabled));
    if ($("catalogshell")) $("catalogshell").classList.toggle("hidden", !showCatalog);
    var choosingPerson = activeShellScreen === "people" && mode === "subject" && !activePersonId;
    var routeChosen = !!search || (mode === "person-intent" && !!selected) || (mode === "learn" && !!selected) || (mode === "type" && !!selected);
    if ($("familypanel")) $("familypanel").classList.toggle("hidden", !choosingPerson);
    if ($("catalogstep")) $("catalogstep").classList.toggle("hidden", choosingPerson);
    if ($("featurelist")) $("featurelist").classList.toggle("hidden", choosingPerson);
    if ($("catalogtoolbar")) $("catalogtoolbar").classList.toggle("hidden", !routeChosen);
    if ($("slideshow")) $("slideshow").classList.toggle("hidden", !showWork);
    if ($("triagepanel")) $("triagepanel").classList.toggle("hidden", !showTriage);
    if ($("screenbar")) $("screenbar").classList.toggle("hidden", showHome);
    if ($("screenlabel")) $("screenlabel").textContent = shellScreenLabel();
    if ($("screenprogress")) $("screenprogress").innerHTML = showWork && activeSlides.length > 1
      ? deckProgressHtml()
      : triageProgressHtml();
    ["navhome", "navpeople", "navlearn", "navtools", "navurgent"].forEach(function (id) {
      var nav = $(id);
      if (!nav) return;
      var on = (id === "navhome" && activeShellScreen === "home") ||
        (id === "navpeople" && activeShellScreen === "people") ||
        (id === "navlearn" && activeShellScreen === "learn") ||
        (id === "navtools" && activeShellScreen === "tools") ||
        (id === "navurgent" && (activeShellScreen === "urgent-who" || activeShellScreen === "urgent-check"));
      nav.classList.toggle("active", on);
    });
  }
  function showCatalogScreen(screen, nextMode, nextSelected, startCareCheck) {
    workBackSteps = [];
    workReturnContext = null;
    stopReadAloudForContextChange("Read-aloud stopped because the screen changed.");
    activeShellScreen = screen || "people";
    if (nextMode) mode = nextMode;
    if (nextSelected) selected = nextSelected;
    if (screen === "people") { mode = "subject"; selected = ""; activeSubject = ""; activePersonId = null; dangerPersonId = null; careEntryStartsCheck = !!startCareCheck; }
    if (screen === "learn") { mode = "learn"; selected = ""; activePersonId = null; }
    if (screen === "tools") { mode = "type"; selected = ""; activePersonId = null; }
    featureLimit = FEATURE_PAGE_SIZE;
    search = "";
    if ($("search")) $("search").value = "";
    renderCatalog();
    applyShellVisibility();
    moveToNextStep("catalogshell");
  }
  function showPanel(id) {
    stopReadAloudForContextChange("Read-aloud stopped because the screen changed.");
    if (id !== "slideshow" && !workBackSteps.length) {
      workBackSteps = [];
      workReturnContext = null;
    }
    if ($("slideshow") && $("slideshow").setAttribute) $("slideshow").setAttribute("data-screen-id", "");
    // Story activities live outside .slidebox now, so unlike #slidecache they are not overwritten
    // by whatever renders next. Clear them on every panel change or they follow the caregiver
    // around: the chlorine timer briefly offered "Read Gerry the Germ".
    if ($("slidestoryactions")) $("slidestoryactions").innerHTML = "";
    if (id === "slideshow" && $("slideimage")) $("slideimage").classList.remove("hidden");
    if (id === "slideshow") {
      if (activeShellScreen !== "work") {
        workReturnContext = {
          activeShellScreen: activeShellScreen,
          mode: mode,
          selected: selected,
          activeSubject: activeSubject,
          activePersonId: activePersonId,
          dangerPersonId: dangerPersonId,
          search: search,
          searchInput: $("search") ? $("search").value : search,
          featureLimit: featureLimit
        };
        workBackSteps = [];
      }
      activeShellScreen = "work";
    }
    else if (id === "triagepanel") activeShellScreen = "urgent-check";
    else if (id === "catalog") activeShellScreen = mode === "danger" && !dangerPersonId ? "urgent-who" : (mode === "learn" ? "learn" : mode === "type" ? "tools" : "people");
    else { activeShellScreen = "home"; activeShellTitle = ""; }
    applyShellVisibility();
    updateSlideNavigation(id === "slideshow" && activeSlides.length > 1);
    if (id === "slideshow" || id === "triagepanel") moveToNextStep(id);
    else if (id === "catalog") moveToNextStep("catalogshell");
  }
  function updateSlideNavigation(visible) {
    var isDeck = !!visible && activeSlides.length > 1;
    var prev = $("slideprev"), next = $("slidenext"), read = $("slideread");
    if (prev) {
      prev.classList.toggle("hidden", !isDeck);
      prev.disabled = !isDeck || slideIndex === 0;
      prev.classList.toggle("ghost", prev.disabled);
      prev.setAttribute("aria-hidden", isDeck ? "false" : "true");
    }
    if (next) {
      next.classList.toggle("hidden", !isDeck);
      next.disabled = !isDeck || slideIndex === activeSlides.length - 1;
      next.classList.toggle("ghost", next.disabled);
      next.setAttribute("aria-hidden", isDeck ? "false" : "true");
    }
    // The listening control is live on any visible work screen. Deck pages need it
    // too, but ordinary tools and checklists must not be accidentally disabled.
    if (read) {
      var readableWorkVisible = isDeck || !!($("slideshow") && !$("slideshow").classList.contains("hidden"));
      read.disabled = !readableWorkVisible;
      read.classList.toggle("ghost", !readableWorkVisible);
      read.setAttribute("aria-disabled", readableWorkVisible ? "false" : "true");
    }
  }
  function refocusActiveWorkPanel() {
    setTimeout(function () {
      var slideshow = $("slideshow");
      var triage = $("triagepanel");
      if (slideshow && !slideshow.classList.contains("hidden")) moveToNextStep("slideshow");
      else if (triage && !triage.classList.contains("hidden")) moveToNextStep("triagepanel");
    }, 0);
  }
  function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
  }
  function applyBirthDateBounds() {
    var today = todayIsoDate();
    ["persondob", "dob"].forEach(function (id) {
      var input = $(id);
      if (!input) return;
      input.min = input.min || "1900-01-01";
      input.max = today;
    });
  }
  function isFutureBirthDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && value > todayIsoDate();
  }
  function updateAgeFromDob() {
    var dob = $("dob");
    if (!dob) return;
    var v = dob.value;
    if (!v) { $("age").textContent = ""; return; }
    if (isFutureBirthDate(v)) {
      dob.value = "";
      $("age").textContent = tx("tx.triage.chrome.future_birth_date", "Date of birth cannot be in the future.");
      return;
    }
    try { $("age").textContent = tx("tx.triage.chrome.age_months", "Age: {months} months", { months: engine.derive({ birth_date: v, now: new Date().toISOString(), temp_entered_value: 0 }, engine.gd).age_mo }); } catch (e) { $("age").textContent = ""; }
  }
  function applyKnownDob(person) {
    if (!person || !person.birthDate || !$("dob")) return;
    $("dob").value = person.birthDate;
    updateAgeFromDob();
  }
  function childPeople() {
    return people.filter(function (p) { return p.subject === "child_under5"; });
  }
  function defaultChildPerson() {
    var person = activePersonId ? personById(activePersonId) : null;
    if (!person && dangerPersonId) person = personById(dangerPersonId);
    if (!person || person.subject !== "child_under5") person = personById("demo_child") || childPeople()[0] || null;
    return person && person.subject === "child_under5" ? person : null;
  }
  function defaultChildDob() {
    var person = defaultChildPerson();
    return person && person.subject === "child_under5" ? person.birthDate || "" : "";
  }
  function renderChildSelect(selectedId) {
    var select = $("triagechildselect");
    if (!select) return;
    var kids = childPeople();
    select.innerHTML = kids.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.birthDate ? " - " + esc(tx("tx.triage.chrome.date_of_birth", "Date of birth")) + " " + esc(p.birthDate) : "") + "</option>";
    }).join("") + '<option value="">' + esc(tx("tx.triage.chrome.add_unknown_child", "Add/unknown child")) + "</option>";
    select.value = selectedId || "";
  }
  function dangerAcknowledged() {
    if ($("s_no_danger_signs") && $("s_no_danger_signs").checked) return true;
    for (var i = 0; i < DANGER.length; i++) {
      var box = $("s_" + DANGER[i].id);
      if (box && box.checked) return true;
    }
    return false;
  }
  function updateDangerGate() {
    var ack = under5DangerGateUpdate ? under5DangerGateUpdate() : dangerAcknowledged();
    if (activeShellScreen === "urgent-check") applyShellVisibility();
    return ack;
  }
  function resetDangerGate() {
    if ($("s_no_danger_signs")) $("s_no_danger_signs").checked = false;
    updateDangerGate();
  }
  function resetUnder5TriageSession() {
    // A triage check is a new caregiver report.  Do not carry any clinical
    // answer, result, or timed-breathing state into another entry or child.
    var panel = $("triagepanel");
    if (panel && panel.querySelectorAll) {
      var boxes = panel.querySelectorAll('input[type="checkbox"], input[type="radio"]');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
    }
    ["diarrhoeadays", "feverdays", "fevertempvalue"].forEach(function (id) {
      if ($(id)) $(id).value = "";
    });
    if ($("diarrhoeadays")) delete $("diarrhoeadays").dataset.notSure;
    if ($("feverrdt")) $("feverrdt").value = "not_done";
    if ($("fevertempunit")) $("fevertempunit").value = "unknown";
    if ($("fevertempsite")) $("fevertempsite").value = "unknown";
    if ($("out")) $("out").innerHTML = "";
    under5VisitedSymptoms = false;
    under5VisitedDetails = false;
    resetRR();
    resetDangerGate();
  }
  function markNoDangerSignsForDemo() {
    if ($("s_no_danger_signs")) $("s_no_danger_signs").checked = true;
    DANGER.forEach(function (q) { var box = $("s_" + q.id); if (box) box.checked = false; });
    updateDangerGate();
  }
  function prepareChildTriage(person) {
    // Every other door into the under-five gate is the ordinary sick-child check. The diarrhoea
    // supply journey sets its own value after this call.
    under5Journey = "sick_child";
    activeSubject = "child_under5";
    under5Stage = "danger";
    under5BranchQueue = [];
    under5BranchIndex = 0;
    coughChoiceState = {};
    resetUnder5TriageSession();
    person = person && person.subject === "child_under5" ? person : defaultChildPerson();
    if (person) {
      activePersonId = person.id;
      dangerPersonId = person.id;
      renderChildSelect(person.id);
      applyKnownDob(person);
    } else {
      renderChildSelect("");
    }
    renderUnder5DangerGate();
    showUnder5Stage("danger");
  }
  function cancelUiCountdown() {
    if (uiTimer && uiTimer.interval !== null) {
      clearInterval(uiTimer.interval);
    }
    uiTimer = null;
    if (currentPrototypeMusic) stopPrototypeMusic(null, "Music stopped.");
  }
  function cancelAllUiTimers() {
    cancelUiCountdown();
  }
  function formatTimerClock(seconds) {
    var remaining = Math.max(0, Math.ceil(seconds));
    var minutes = Math.floor(remaining / 60);
    var secs = remaining % 60;
    return minutes + ":" + (secs < 10 ? "0" : "") + secs;
  }
  function uiTimerStatusText(timer) {
    if (!timer) return "Timer idle.";
    if (timer.status === "paused") return timer.label + " timer paused.";
    if (timer.status === "complete") return timer.label + " timer complete.";
    if (timer.status === "idle") return timer.label + " timer ready.";
    return timer.label + " timer running.";
  }
  function updateUiTimerControls() {
    var timer = uiTimer;
    var status = $("timerstatus");
    if (status) status.textContent = uiTimerStatusText(timer);
    var clock = $("timerclock");
    var caption = $("timercaption");
    var bar = $("timerbarfill");
    if (timer && clock) clock.textContent = timer.mode === "elapsed" ? formatTimerClock(timer.elapsed || 0) : formatTimerClock(timer.remaining);
    if (timer && caption) {
      if (timer.mode === "elapsed") {
        caption.textContent = timer.status === "idle"
          ? (timer.idleCaption || "Ready to start.")
          : (timer.runningCaption || "Elapsed time. Stop when finished.");
      } else {
        caption.textContent = timer.status === "complete"
          ? "Done."
          : (timer.status === "idle" ? "Ready to start again." : timer.remaining + " seconds remaining.");
      }
    }
    if (timer && bar) {
      var pct = timer.mode === "elapsed"
        ? (timer.duration > 0 ? Math.max(0, Math.min(100, ((timer.elapsed || 0) / timer.duration) * 100)) : 0)
        : (timer.duration > 0 ? Math.max(0, Math.min(100, (timer.remaining / timer.duration) * 100)) : 0);
      bar.style.width = pct + "%";
      bar.setAttribute && bar.setAttribute("aria-valuenow", String(Math.round(pct)));
    }
    if (!timer) return;
    var start = timer.startId ? $(timer.startId) : null;
    var alternateStart = timer.alternateStartId ? $(timer.alternateStartId) : null;
    var pause = timer.pauseId ? $(timer.pauseId) : null;
    var reset = timer.resetId ? $(timer.resetId) : null;
    if (start) {
      var dedicatedPauseOwnsActiveState = timer.status === "running" || (timer.status === "paused" && !!pause);
      start.disabled = dedicatedPauseOwnsActiveState;
      start.classList.toggle("hidden", dedicatedPauseOwnsActiveState);
      start.textContent = timer.status === "running"
        ? "Timer running"
        : (timer.status === "paused"
          ? (pause ? "Timer paused" : tx("tx.control.resume_timer", "Resume timer"))
          : timer.startText);
    }
    if (alternateStart) {
      alternateStart.disabled = timer.status === "running" || timer.status === "paused";
      alternateStart.classList.toggle("hidden", timer.status === "running" || timer.status === "paused");
      alternateStart.textContent = timer.alternateStartText;
    }
    if (pause) {
      pause.disabled = timer.status === "idle" || timer.status === "complete";
      pause.textContent = timer.status === "paused"
        ? tx("tx.control.resume_timer", "Resume timer")
        : tx("tx.control.pause_timer", "Pause timer");
    }
    if (reset) reset.disabled = false;
  }
  function runUiCountdownTick() {
    if (!uiTimer || uiTimer.status !== "running") return;
    if (uiTimer.mode === "elapsed") {
      uiTimer.elapsed = (uiTimer.elapsed || 0) + 1;
      updateUiTimerControls();
      return;
    }
    uiTimer.remaining = Math.max(uiTimer.remaining - 1, 0);
    updateUiTimerControls();
    if (uiTimer.remaining <= 0) {
      if (uiTimer.interval !== null) clearInterval(uiTimer.interval);
      uiTimer.interval = null;
      uiTimer.status = "complete";
      updateUiTimerControls();
      if (uiTimer.onComplete) uiTimer.onComplete();
    }
  }
  function scheduleUiCountdown() {
    if (!uiTimer) return;
    if (uiTimer.interval !== null) clearInterval(uiTimer.interval);
    uiTimer.interval = setInterval(runUiCountdownTick, 1000);
    if (uiTimer.interval && uiTimer.interval.unref) uiTimer.interval.unref();
  }
  function startUiCountdown(label, seconds, onComplete, controls) {
    cancelUiCountdown();
    var duration = Math.max(0, Math.ceil(seconds));
    controls = controls || {};
    uiTimer = {
      mode: "countdown",
      label: label,
      duration: duration,
      remaining: duration,
      elapsed: 0,
      status: "running",
      interval: null,
      onComplete: onComplete || null,
      startId: controls.startId || "",
      alternateStartId: controls.alternateStartId || "",
      alternateStartText: controls.alternateStartText || tx("tx.handwashing_timer.start_timer_music"),
      pauseId: controls.pauseId || "",
      resetId: controls.resetId || "",
      startText: controls.startText || "Start",
      musicAssetId: controls.musicAssetId || "",
      musicControlId: controls.musicControlId || "",
      musicStatusId: controls.musicStatusId || "musicstatus",
      musicLoop: controls.musicLoop !== false
    };
    updateUiTimerControls();
    if (uiTimer.musicAssetId) playPrototypeMusic(uiTimer.musicAssetId, uiTimer.musicStatusId, uiTimer.musicLoop, { controlId: uiTimer.musicControlId });
    if (duration <= 0) runUiCountdownTick();
    else scheduleUiCountdown();
  }
  function startUiElapsedTimer(label, targetSeconds, controls) {
    cancelUiCountdown();
    var duration = Math.max(1, Math.ceil(targetSeconds || 3600));
    controls = controls || {};
    uiTimer = {
      mode: "elapsed",
      label: label,
      duration: duration,
      remaining: 0,
      elapsed: 0,
      status: "running",
      interval: null,
      onComplete: null,
      startId: controls.startId || "",
      alternateStartId: controls.alternateStartId || "",
      alternateStartText: controls.alternateStartText || tx("tx.handwashing_timer.start_timer_music"),
      pauseId: controls.pauseId || "",
      resetId: controls.resetId || "",
      startText: controls.startText || "Start",
      musicAssetId: controls.musicAssetId || "",
      musicControlId: controls.musicControlId || "",
      musicStatusId: controls.musicStatusId || "musicstatus",
      musicLoop: controls.musicLoop !== false,
      idleCaption: controls.idleCaption || "Ready to start.",
      runningCaption: controls.runningCaption || "Elapsed time. Stop when finished."
    };
    updateUiTimerControls();
    if (uiTimer.musicAssetId) playPrototypeMusic(uiTimer.musicAssetId, uiTimer.musicStatusId, uiTimer.musicLoop, { controlId: uiTimer.musicControlId });
    scheduleUiCountdown();
  }
  function pauseOrResumeUiCountdown() {
    if (!uiTimer) return;
    if (uiTimer.status === "running") {
      if (uiTimer.interval !== null) clearInterval(uiTimer.interval);
      uiTimer.interval = null;
      uiTimer.status = "paused";
      pausePrototypeMusic();
      updateUiTimerControls();
      return;
    }
    if (uiTimer.status === "paused") {
      uiTimer.status = "running";
      resumePrototypeMusic();
      updateUiTimerControls();
      scheduleUiCountdown();
    }
  }
  function resetUiCountdown() {
    if (!uiTimer) return;
    if (uiTimer.interval !== null) clearInterval(uiTimer.interval);
    uiTimer.interval = null;
    uiTimer.remaining = uiTimer.mode === "elapsed" ? 0 : uiTimer.duration;
    uiTimer.elapsed = 0;
    uiTimer.status = "idle";
    stopPrototypeMusic(null, "Music stopped. Tap Start music to play it again.");
    updateUiTimerControls();
  }
  function bindUiCountdownButton(id, action) {
    var button = $(id);
    if (button && !button.dataset.bound) {
      button.dataset.bound = "timer";
      button.addEventListener("click", action);
    }
  }
  function timerPanelHtml(title, durationLabel, readyText, options) {
    options = options || {};
    var music = options.includeMusic === false ? "" : '<div class="muted" id="musicstatus">Music ready.</div>';
    var ariaLabel = options.ariaLabel || (title + " remaining time");
    return '<div class="progress-panel timer-panel"><div class="timer-topline"><strong>' + esc(title) + '</strong><span id="timerstatus">' + esc(readyText || "Timer ready.") + '</span></div><div class="timer-clock" id="timerclock">' + esc(durationLabel) + '</div><div class="timerbar" role="progressbar" aria-label="' + esc(ariaLabel) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><div class="timerbarfill" id="timerbarfill"></div></div><div class="timer-caption" id="timercaption">' + esc(tx("tx.dental_brushing.tap_start_when_ready")) + '</div>' + music + '</div>';
  }
  function setMusicStatus(statusId, text) {
    var node = statusId ? $(statusId) : $("musicstatus");
    if (node) node.textContent = text;
  }
  function prototypeMusicState(assetId) {
    if (!currentPrototypeMusic || currentPrototypeMusic.assetId !== assetId) return "stopped";
    return currentPrototypeMusic.status || "playing";
  }
  function syncPrototypeMusicControl(controlId, assetId) {
    var button = controlId ? $(controlId) : null;
    if (!button) return;
    var state = prototypeMusicState(assetId);
    button.textContent = state === "playing"
      ? tx("tx.control.pause_music", "Pause music")
      : (state === "paused"
        ? tx("tx.control.resume_music", "Resume music")
        : tx("tx.control.start_music", "Start music"));
    button.setAttribute("data-music-state", state);
    button.setAttribute("aria-pressed", state === "playing" ? "true" : "false");
  }
  function syncCurrentPrototypeMusicControl() {
    if (!currentPrototypeMusic) return;
    syncPrototypeMusicControl(currentPrototypeMusic.controlId, currentPrototypeMusic.assetId);
  }
  function stopPrototypeMusic(statusId, text) {
    var prior = currentPrototypeMusic;
    if (currentPrototypeMusic && currentPrototypeMusic.audio) {
      try {
        currentPrototypeMusic.audio.pause();
        currentPrototypeMusic.audio.currentTime = 0;
      } catch (e) {
        // Best-effort cleanup only; visible status still matters more for the prototype.
      }
    }
    var priorStatus = statusId || (prior && prior.statusId);
    currentPrototypeMusic = null;
    if (prior) syncPrototypeMusicControl(prior.controlId, prior.assetId);
    if (text) setMusicStatus(priorStatus, text);
  }
  function pausePrototypeMusic() {
    if (!currentPrototypeMusic) return;
    if (currentPrototypeMusic.audio) {
      try { currentPrototypeMusic.audio.pause(); } catch (e) { return; }
    }
    currentPrototypeMusic.status = "paused";
    setMusicStatus(currentPrototypeMusic.statusId, "Music paused.");
    syncCurrentPrototypeMusicControl();
  }
  function resumePrototypeMusic() {
    if (!currentPrototypeMusic || !currentPrototypeMusic.audio) return;
    var music = currentPrototypeMusic;
    try {
      var playResult = music.audio.play();
      if (playResult && playResult.catch) playResult.catch(function (error) {
        if (currentPrototypeMusic !== music) return;
        if (error && error.name === "AbortError" && music.status === "paused") return;
        music.status = "paused";
        setMusicStatus(music.statusId, "Tap Resume music if the browser blocked audio.");
        syncCurrentPrototypeMusicControl();
      });
      music.status = "playing";
      setMusicStatus(music.statusId, "Music playing.");
      syncCurrentPrototypeMusicControl();
    } catch (e) {
      music.status = "paused";
      setMusicStatus(music.statusId, "Music could not play in this browser.");
      syncCurrentPrototypeMusicControl();
    }
  }
  function playPrototypeMusic(assetId, statusId, loop, labels) {
    labels = labels || {};
    var message = function (key, fallback) { return labels[key] || fallback; };
    var asset = assetById(assetId);
    if (!asset || !asset.targetPath) {
      setMusicStatus(statusId, message("missing", "Tune is missing from the asset manifest."));
      return false;
    }
    stopPrototypeMusic(statusId, "");
    if (typeof Audio === "undefined") {
      currentPrototypeMusic = { audio: null, assetId: assetId, statusId: statusId, loop: !!loop, context: labels.context || "", controlId: labels.controlId || "", status: "stopped" };
      setMusicStatus(statusId, message("unavailable", "Music is unavailable in this browser."));
      var unavailable = currentPrototypeMusic;
      currentPrototypeMusic = null;
      syncPrototypeMusicControl(unavailable.controlId, unavailable.assetId);
      return false;
    }
    try {
      var audio = new Audio(asset.targetPath);
      audio.loop = !!loop;
      audio.onended = function () {
        if (!currentPrototypeMusic || currentPrototypeMusic.audio !== audio) return;
        var completed = currentPrototypeMusic;
        currentPrototypeMusic = null;
        setMusicStatus(statusId, message("complete", "Music complete."));
        syncPrototypeMusicControl(completed.controlId, completed.assetId);
      };
      audio.onerror = function () {
        if (!currentPrototypeMusic || currentPrototypeMusic.audio !== audio) return;
        var failed = currentPrototypeMusic;
        currentPrototypeMusic = null;
        setMusicStatus(statusId, message("failed", "Music could not load; keep using the visible timer."));
        syncPrototypeMusicControl(failed.controlId, failed.assetId);
      };
      currentPrototypeMusic = { audio: audio, assetId: assetId, statusId: statusId, loop: !!loop, context: labels.context || "", controlId: labels.controlId || "", status: "playing" };
      var music = currentPrototypeMusic;
      var playResult = audio.play();
      if (playResult && playResult.catch) playResult.catch(function (error) {
        if (currentPrototypeMusic !== music) return;
        if (error && error.name === "AbortError" && music.status === "paused") return;
        currentPrototypeMusic = null;
        setMusicStatus(statusId, message("blocked", "Tap Start music if the browser blocked audio."));
        syncPrototypeMusicControl(music.controlId, music.assetId);
      });
      setMusicStatus(statusId, message("playing", "Music playing."));
      syncCurrentPrototypeMusicControl();
      return true;
    } catch (e) {
      currentPrototypeMusic = null;
      setMusicStatus(statusId, message("failed", "Music could not play in this browser."));
      syncPrototypeMusicControl(labels.controlId || "", assetId);
      return false;
    }
  }
  function togglePrototypeMusic(assetId, statusId, loop, labels) {
    labels = labels || {};
    if (currentPrototypeMusic && currentPrototypeMusic.assetId === assetId) {
      if (currentPrototypeMusic.status === "paused") {
        resumePrototypeMusic();
        return currentPrototypeMusic && currentPrototypeMusic.status === "playing";
      }
      pausePrototypeMusic();
      return false;
    }
    return playPrototypeMusic(assetId, statusId, loop, labels);
  }
  function stopPrototypeMusicForContext(context) {
    if (!context || !currentPrototypeMusic || currentPrototypeMusic.context !== context) return;
    stopPrototypeMusic(currentPrototypeMusic.statusId, "");
  }
  var currentPrototypeSpeechText = "";
  var prototypeSpeechPaused = false;
  var prototypeSpeechActive = false;
  // Every context change gets a new generation.  Browser speech callbacks can arrive after
  // cancel(), so handlers must prove they still belong to the visible screen before updating it.
  var prototypeSpeechGeneration = 0;
  var guidedSpeechItems = [];
  var guidedSpeechIndex = 0;
  var guidedSpeechActive = false;
  var guidedSpeechElement = null;
  function clearGuidedSpeechHighlight() {
    if (guidedSpeechElement && guidedSpeechElement.classList) guidedSpeechElement.classList.remove("is-speaking");
    guidedSpeechElement = null;
  }
  function collectReadAloudItems() {
    if (!document.querySelectorAll) return [];
    var candidates = document.querySelectorAll("main h1, main h2, main h3, main legend, main p, main label, main button");
    return Array.prototype.filter.call(candidates, function (el) {
      if (!el || !el.textContent || !el.textContent.trim()) return false;
      if (el.closest && (el.closest(".hidden") || el.closest(".reviewer-settings") || el.closest(".trace"))) return false;
      if (typeof window !== "undefined" && window.getComputedStyle) {
        var style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    });
  }
  var LISTEN_ICON_EAR = '<path d="M5.35 10.76a6.65 6.65 0 1 1 13.3 0c0 2.93-2.13 4.12-3.72 5.45-1.33 1.06-1.86 2-1.86 3.46a3.06 3.06 0 0 1-6.12 0c0-3.46-1.6-4.66-1.6-8.91z"></path><path d="M10.94 11.02a2.53 2.53 0 0 1 4.39 1.73c0 1.46-1.33 2.13-2.26 3.06"></path>';
  var LISTEN_ICON_STOP = '<rect x="4.5" y="4.5" width="15" height="15" rx="2.2" fill="currentColor" stroke="none"></rect>';
  function updateGuidedListenButton() {
    var button = $("listenbutton"), label = $("listenlabel");
    if (button) button.setAttribute("aria-pressed", guidedSpeechActive ? "true" : "false");
    if (label) label.textContent = guidedSpeechActive ? tx("tx.stop_listening", "Stop") : tx("tx.listen", "Listen");
    var listenIcon = button && typeof button.querySelector === "function" ? button.querySelector(".listen-icon") : null;
    if (listenIcon) listenIcon.innerHTML = guidedSpeechActive ? LISTEN_ICON_STOP : LISTEN_ICON_EAR;
  }
  function stopGuidedReading(message) {
    guidedSpeechActive = false;
    guidedSpeechItems = [];
    guidedSpeechIndex = 0;
    clearGuidedSpeechHighlight();
    cancelPrototypeSpeech(message || "Read-aloud stopped.");
    updateGuidedListenButton();
  }
  function speakNextGuidedItem() {
    if (!guidedSpeechActive || guidedSpeechIndex >= guidedSpeechItems.length) {
      stopGuidedReading("Read-aloud complete.");
      return;
    }
    clearGuidedSpeechHighlight();
    var el = guidedSpeechItems[guidedSpeechIndex++];
    guidedSpeechElement = el;
    if (el.classList) el.classList.add("is-speaking");
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
    var Utterance = typeof window !== "undefined" && window.SpeechSynthesisUtterance ? window.SpeechSynthesisUtterance : null;
    if (!Utterance || !window.speechSynthesis) { stopGuidedReading("Read-aloud is unavailable in this browser."); return; }
    var utterance = new Utterance((el.textContent || "").replace(/\s+/g, " ").trim());
    utterance.lang = "en";
    var speechGeneration = prototypeSpeechGeneration;
    utterance.onend = function () {
      if (!guidedSpeechActive || speechGeneration !== prototypeSpeechGeneration) return;
      speakNextGuidedItem();
    };
    utterance.onerror = function () {
      if (!guidedSpeechActive || speechGeneration !== prototypeSpeechGeneration) return;
      stopGuidedReading("Read-aloud error. The text remains visible.");
    };
    window.speechSynthesis.speak(utterance);
    setReadAloudStatus("Reading the highlighted item.");
  }
  function startGuidedReading() {
    stopGuidedReading();
    guidedSpeechItems = collectReadAloudItems();
    if (!guidedSpeechItems.length) { setReadAloudStatus("There is no readable text on this screen."); return; }
    guidedSpeechActive = true;
    updateGuidedListenButton();
    speakNextGuidedItem();
  }
  function setReadAloudStatus(message) {
    var localStatus = $("audiostatus");
    var globalStatus = $("globalaudiostatus");
    if (localStatus) { localStatus.textContent = message; localStatus.hidden = false; }
    if (globalStatus) { globalStatus.textContent = message; globalStatus.hidden = false; }
  }
  function setReadAloudPauseState(paused) {
    var screenButton = $("slidepauseaudio");
    if (screenButton) screenButton.textContent = paused
      ? tx("tx.control.resume_reading", "Resume reading")
      : tx("tx.control.pause_reading", "Pause reading");
    ["bfpause", "bfassistpause"].forEach(function (id) {
      var button = $(id);
      if (button) button.textContent = paused
        ? tx("tx.control.resume_tip", "Resume tip")
        : tx("tx.control.pause_tip", "Pause tip");
    });
    var restart = $("sliderestartaudio");
    if (restart) restart.textContent = tx("tx.control.restart_reading", "Restart reading");
  }
  function updateReadAloudActionButtons() {
    var reading = prototypeSpeechActive || prototypeSpeechPaused;
    ["slidepauseaudio", "sliderestartaudio", "bfpause", "bfstop", "bfassistpause", "bfassiststop"].forEach(function (id) {
      var button = $(id);
      if (button) button.disabled = !reading;
    });
  }
  function cancelPrototypeSpeech(message) {
    var wasActive = prototypeSpeechActive || prototypeSpeechPaused;
    prototypeSpeechGeneration += 1;
    if (typeof window !== "undefined" && window.speechSynthesis && window.speechSynthesis.cancel) {
      try { window.speechSynthesis.cancel(); } catch (e) { return false; }
    }
    prototypeSpeechPaused = false;
    prototypeSpeechActive = false;
    setReadAloudPauseState(false);
    updateReadAloudActionButtons();
    if (message && wasActive) setReadAloudStatus(message);
    return true;
  }
  function stopReadAloudForContextChange(message) {
    var wasReading = guidedSpeechActive || prototypeSpeechActive || prototypeSpeechPaused;
    guidedSpeechActive = false;
    guidedSpeechItems = [];
    guidedSpeechIndex = 0;
    clearGuidedSpeechHighlight();
    // A changed page must stop active speech so words never describe the wrong page.
    // Do not announce a stop when the caregiver was not listening.
    cancelPrototypeSpeech(wasReading ? (message || "Read-aloud stopped.") : "");
    updateGuidedListenButton();
  }
  function selectPreferredSpeechVoice() {
    if (typeof window === "undefined" || !window.speechSynthesis || !window.speechSynthesis.getVoices) return null;
    var voices = window.speechSynthesis.getVoices() || [];
    var englishVoices = voices.filter(function (voice) { return /^en/i.test(voice.lang || ""); });
    var pool = englishVoices.length ? englishVoices : voices;
    var preferredVoice = pool.filter(function (voice) {
      return /female|woman|zira|samantha|jenny|aria|victoria|karen|serena|susan|tessa|moira|eva/i.test((voice.name || "") + " " + (voice.voiceURI || ""));
    })[0];
    return preferredVoice || pool[0] || null;
  }
  function playPrototypeSpeech(text) {
    var Utterance = typeof window !== "undefined" && window.SpeechSynthesisUtterance ? window.SpeechSynthesisUtterance : (typeof SpeechSynthesisUtterance !== "undefined" ? SpeechSynthesisUtterance : null);
    text = (text || "").replace(/\s+/g, " ").trim();
    if (!text) {
      setReadAloudStatus("Read-aloud needs visible text on this screen.");
      return false;
    }
    if (typeof window === "undefined" || !window.speechSynthesis || !Utterance) {
      setReadAloudStatus("Read-aloud ready; browser speech synthesis is unavailable here.");
      return false;
    }
    // A screen-level reading request supersedes any guided item sequence.
    guidedSpeechActive = false;
    guidedSpeechItems = [];
    guidedSpeechIndex = 0;
    clearGuidedSpeechHighlight();
    updateGuidedListenButton();
    cancelPrototypeSpeech();
    currentPrototypeSpeechText = text;
    var utterance = new Utterance(text);
    var speechGeneration = prototypeSpeechGeneration;
    utterance.lang = "en";
    var preferredVoice = selectPreferredSpeechVoice();
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.pitch = 1.05;
    utterance.onend = function () {
      if (speechGeneration !== prototypeSpeechGeneration) return;
      prototypeSpeechPaused = false;
      prototypeSpeechActive = false;
      setReadAloudPauseState(false);
      updateReadAloudActionButtons();
      setReadAloudStatus("Read-aloud complete.");
    };
    utterance.onerror = function () {
      if (speechGeneration !== prototypeSpeechGeneration) return;
      prototypeSpeechPaused = false;
      prototypeSpeechActive = false;
      setReadAloudPauseState(false);
      updateReadAloudActionButtons();
      setReadAloudStatus("Read-aloud error; show the text and try again.");
    };
    window.speechSynthesis.speak(utterance);
    prototypeSpeechPaused = false;
    prototypeSpeechActive = true;
    setReadAloudPauseState(false);
    updateReadAloudActionButtons();
    setReadAloudStatus("Read-aloud playing through browser speech synthesis.");
    return true;
  }
  function pausePrototypeSpeech() {
    if (!prototypeSpeechActive && !prototypeSpeechPaused) return false;
    if (typeof window === "undefined" || !window.speechSynthesis || !window.speechSynthesis.pause) {
      setReadAloudStatus("Pause unavailable in this browser; the text remains visible.");
      return false;
    }
    try {
      if (prototypeSpeechPaused && window.speechSynthesis.resume) {
        window.speechSynthesis.resume();
        prototypeSpeechPaused = false;
        setReadAloudPauseState(false);
        updateReadAloudActionButtons();
        setReadAloudStatus("Read-aloud playing through browser speech synthesis.");
        return true;
      }
      window.speechSynthesis.pause();
      prototypeSpeechPaused = true;
      setReadAloudPauseState(true);
      updateReadAloudActionButtons();
      setReadAloudStatus("Read-aloud paused.");
      return true;
    } catch (e) {
      setReadAloudStatus("Pause unavailable in this browser; the text remains visible.");
      return false;
    }
  }
  function stopPrototypeSpeech() {
    // An explicit Stop deserves confirmation even if a previous page change already
    // ended the audio. Context changes, by contrast, stay quiet when nothing was playing.
    var stopped = cancelPrototypeSpeech();
    if (stopped) setReadAloudStatus("Read-aloud stopped.");
    return stopped;
  }
  function restartPrototypeSpeech(text) {
    var nextText = (text || currentPrototypeSpeechText || "").replace(/\s+/g, " ").trim();
    if (!nextText) nextText = currentScreenReadAloudText();
    return playPrototypeSpeech(nextText);
  }
  function readableTextFromElement(el) {
    if (!el) return "";
    if (typeof el.cloneNode !== "function") return (el.textContent || "").replace(/\s+/g, " ").trim();
    var clone = el.cloneNode(true);
    var remove = clone.querySelectorAll("details, script, style, .trace, .provenance, .prototype-review");
    for (var i = 0; i < remove.length; i++) remove[i].parentNode.removeChild(remove[i]);
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }
  function currentScreenReadAloudText() {
    var pieces = [];
    ["slidetitle", "slideheading", "slidetext", "slidecache", "out"].forEach(function (id) {
      var text = readableTextFromElement($(id));
      if (text && pieces.indexOf(text) === -1) pieces.push(text);
    });
    return pieces.join(". ").slice(0, 3500);
  }
  function openModuleRecord(feature, title) {
    var launched = launchFromRegistry(feature.launch);
    if (!launched.ok) {
      showPrototypeCard(title || (feature ? t(feature.titleSlug) : tx("tx.prototype.unavailable.title", "Not available in this prototype")), prototypeUnavailableBody(), tx("tx.prototype.unavailable.visual", "This activity is not available in the current prototype build."), feature && feature.id, launched.error);
      return;
    }
    var renderer = launched.renderer;
    if (renderer.kind === "triage") { prepareChildTriage(defaultChildPerson()); showPanel("triagepanel"); }
    else if (renderer.kind === "ors.voucher") openDemoDiarrhoeaGate();
    else if (renderer.kind === "sequence.deck") showDeck(feature.id);
    else if (renderer.launch === "dental.brushing") showDentalBrushingCoach();
    else if (renderer.launch === "dental.triage") showDentalTriageChecklist();
    else if (renderer.kind.indexOf("tool.") === 0) showToolCard(feature.id);
    else if (renderer.kind === "story.deck") showStoryCard(feature.id);
    else if (renderer.kind === "screen.checklist") showScreenCard(feature.id);
    else showPrototypeCard(title || (feature ? t(feature.titleSlug) : tx("tx.prototype.unavailable.title", "Not available in this prototype")), prototypeUnavailableBody(), tx("tx.prototype.unavailable.visual", "This activity is not available in the current prototype build."), feature && feature.id, "Unsupported renderer kind: " + renderer.kind);
  }
  function openLaunch(launch, title) {
    activeShellTitle = title || "";
    var feature = featureByLaunch(launch);
    if (feature) {
      activeShellTitle = t(feature.titleSlug) || title || "";
      openModuleRecord(feature, title);
      refocusActiveWorkPanel();
      return;
    }
    showPrototypeCard(title || tx("tx.prototype.unavailable.title", "Not available in this prototype"), prototypeUnavailableBody(), tx("tx.prototype.unavailable.visual", "This activity is not available in the current prototype build."), null, "Unknown launch id: " + launch);
  }
  function urgentFeaturesForSubject(subject) {
    return (catalog.features || []).filter(function (f) {
      return profileAllows(f) && !!f.dangerEligible && (f.subject || []).indexOf(subject) >= 0;
    });
  }
  function beginDangerFlow() {
    // Urgent must never silently reuse the last person viewed.  A shared phone
    // may be in a different caregiver's hands, and the wrong subject opens the
    // wrong danger screen.  Always make the subject choice explicit.
    mode = "danger";
    selected = "who";
    dangerPersonId = null;
    renderCatalog();
    showPanel("catalog");
  }
  function selectDangerPerson(personId) {
    var person = personById(personId);
    if (!person) return;
    activePersonId = person.id;
    dangerPersonId = person.id;
    activeSubject = person.subject;
    selected = "danger";
    renderCatalog();
    if (activeSubject === "child_under5") {
      prepareChildTriage(person);
      showPanel("triagepanel");
      $("out").innerHTML = "";
    } else if (activeSubject === "pregnancy") {
      showPregnancyUrgentIntake(person);
    } else if (activeSubject === "newborn_mom") {
      showPncLactationDangerChecklist();
    } else if (activeSubject === "newborn_baby") {
      showNewbornDangerChecklist();
    } else {
      var urgent = urgentFeaturesForSubject(activeSubject);
      if (urgent.length) openLaunch(urgent[0].launch, t(urgent[0].titleSlug));
    }
  }
  function openColdFluSickChildCheck() {
    activeSubject = "child_under5";
    activePersonId = "demo_child";
    mode = "danger";
    selected = "danger";
    dangerPersonId = "demo_child";
    renderCatalog();
    applyKnownDob(personById(dangerPersonId));
    resetDangerGate();
    markNoDangerSignsForDemo();
    showPanel("triagepanel");
    var cough = $("s_cough");
    if (cough) cough.checked = true;
    if ($("coughgroup")) $("coughgroup").classList.remove("hidden");
    if ($("rrsection")) $("rrsection").classList.remove("hidden");
  }
  function openDemoDiarrhoeaGate() {
    under5Journey = "ors_supply";
    activeSubject = "child_under5";
    activePersonId = "demo_child";
    mode = "danger";
    selected = "danger";
    dangerPersonId = "demo_child";
    renderCatalog();
    prepareChildTriage(personById(dangerPersonId));
    under5Journey = "ors_supply";
    showPanel("triagepanel");
    $("out").innerHTML = "";
    showUnder5Stage("danger");
  }
  function openDemoNudgePreview() {
    mode = "subject";
    selected = "pregnancy";
    activeSubject = "pregnancy";
    activePersonId = "demo_pregnancy";
    dangerPersonId = null;
    search = "";
    if ($("search")) $("search").value = "";
    renderCatalog();
    openLaunch("tool.anc_birth_plan", "Pregnancy visits");
  }
  function resetDemoState() {
    people = JSON.parse(JSON.stringify(initialPeople));
    clearPersonEditor(true, true);
    mode = "subject";
    selected = "child_under5";
    activeSubject = "child_under5";
    activePersonId = null;
    dangerPersonId = null;
    search = "";
    hotspot = false;
    slideIndex = 0;
    activeSlides = [];
    orsDeckContainerId = "";
    orsNeedsMeasureHelp = null;
    zincDayStateByPerson = {}; zincStatusMessage = ""; zincDaysSaved = false;
    dentalBrushesTodayByPerson = {};
    dentalZone = -1;
    dentalAgeBand = "";
    kmcMinutesToday = 0;
    kmcActive = false;
    handwashStep = 0;
    cancelAllUiTimers();
    moduleOverrides = {};
    if ($("search")) $("search").value = "";
    if ($("hotspotmode")) $("hotspotmode").checked = false;
    if ($("personname")) $("personname").value = "";
    if ($("persondob")) $("persondob").value = "";
    if ($("out")) $("out").innerHTML = "";
    if ($("triagepanel") && $("triagepanel").querySelectorAll) {
      var boxes = $("triagepanel").querySelectorAll('input[type="checkbox"]');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
    }
    ["coughgroup", "rrsection", "diargroup", "fevergroup", "eargroup", "dentalgroup", "measlesgroup"].forEach(function (id) {
      if ($(id)) $(id).classList.add("hidden");
    });
    if ($("feverdays")) $("feverdays").value = "";
    if ($("fevernotimproving")) $("fevernotimproving").checked = false;
    if ($("feverrdt")) $("feverrdt").value = "not_done";
    if ($("fevertempvalue")) $("fevertempvalue").value = "";
    if ($("fevertempunit")) $("fevertempunit").value = "unknown";
    if ($("fevertempsite")) $("fevertempsite").value = "unknown";
    if ($("dob")) $("dob").value = "";
    if ($("age")) $("age").textContent = "";
    showPanel("");
    renderPeople();
    renderCatalog();
  }
  function renderDemoMode() {
    if (!$("demoactions")) return;
    var demoEnabled = $("demomodeon") && $("demomodeon").checked;
    if ($("demomode")) $("demomode").classList.toggle("hidden", !demoEnabled);
    if ($("todaypanel")) $("todaypanel").classList.toggle("hidden", !!demoEnabled);
    if (!demoEnabled) {
      $("demoactions").innerHTML = "";
      return;
    }
    $("demoactions").innerHTML = demoActions.map(function (action) {
      return '<button class="demo-action ' + (action.primary ? "primary" : "") + '" id="' + action.id + '" type="button"><strong>' + esc(action.title) + '</strong><span>' + esc(action.body) + "</span></button>";
    }).join("");
    var bind = function (id, fn) {
      var btn = $(id);
      if (btn && !btn.dataset.bound) { btn.dataset.bound = "demo"; btn.addEventListener("click", fn); }
    };
    bind("demo-wrong", beginDangerFlow);
    bind("demo-diarrhoea", openDemoDiarrhoeaGate);
    bind("demo-ors", function () { openLaunch("seq.ors_mixing", "ORS mixing slideshow"); });
    bind("demo-brushing", function () { openLaunch("dental.brushing", "Toothbrushing coach"); });
    bind("demo-nudge", openDemoNudgePreview);
  }
  function renderDoors() {
    var doors = [
      { id: "subject", title: "My family", selected: "child_under5" },
      { id: "topic", title: "Topics", selected: "child_health" },
      { id: "learn", title: "Education & stories", selected: "learn" },
      { id: "type", title: "Tools", selected: "triage" },
      { id: "danger", title: "Something's wrong", selected: "danger", danger: true }
    ];
    $("maindoors").innerHTML = doors.map(function (d) {
      return '<button class="tab ' + (mode === d.id ? "active " : "") + (d.danger ? "dangerdoor" : "") + '" data-mode="' + d.id + '" data-selected="' + d.selected + '" type="button">' + d.title + "</button>";
    }).join("");
    var btns = $("maindoors").querySelectorAll ? $("maindoors").querySelectorAll(".tab") : [];
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener("click", function () {
      mode = this.dataset.mode; selected = this.dataset.selected;
      search = "";
      if ($("search")) $("search").value = "";
      if (mode === "subject") { activeSubject = selected; activePersonId = null; dangerPersonId = null; }
      renderCatalog();
      if (mode === "danger") beginDangerFlow();
      else showPanel("catalog");
    });
  }
  function renderPeople() {
    if (!$("peoplelist")) return;
    $("peoplelist").innerHTML = people.map(function (p) {
      var label = p.name + ", " + personSummary(p) + (p.birthDate ? ", date of birth " + p.birthDate : "");
      return '<div class="person-card">' +
        '<button class="person" data-person="' + esc(p.id) + '" data-subject="' + esc(p.subject) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '" type="button"><strong>' + esc(p.name) + '</strong><span class="person-summary">' + esc(personSummary(p)) + '</span></button>' +
        '<button class="ghost edit-person" data-person="' + esc(p.id) + '" aria-label="Edit ' + esc(p.name) + '" title="Edit ' + esc(p.name) + '" type="button">Edit</button>' +
        "</div>";
    }).join("");
    var list = $("peoplelist").querySelectorAll ? $("peoplelist").querySelectorAll(".person") : [];
    for (var i = 0; i < list.length; i++) list[i].addEventListener("click", function () {
      var startCareCheck = careEntryStartsCheck;
      // The home care door already states the caregiver's purpose.  Carry that
      // intent through the person selection instead of asking the same question
      // again.  My family still opens the full person-options view.
      careEntryStartsCheck = false;
      mode = "person-intent";
      selected = "";
      activeSubject = this.dataset.subject;
      activePersonId = this.dataset.person || null;
      dangerPersonId = null;
      featureLimit = FEATURE_PAGE_SIZE;
      if (startCareCheck) {
        selected = "check";
        if (openDeclaredPersonIntentDestination()) return;
        // Only skip the second choice when a governed direct-care route exists.
        // Other subjects keep their options rather than guessing a destination.
        selected = "";
      }
      renderCatalog();
      showPanel("catalog");
      moveToNextStep("filtertitle");
    });
    var editList = $("peoplelist").querySelectorAll ? $("peoplelist").querySelectorAll(".edit-person") : [];
    for (var e = 0; e < editList.length; e++) editList[e].addEventListener("click", function () {
      openPersonEditor(this.dataset.person);
    });
  }
  function clearPersonEditor(clearFeedback, closeEditor) {
    editingPersonId = null;
    if ($("personname")) $("personname").value = "";
    if ($("persondob")) $("persondob").value = "";
    if ($("personrole")) $("personrole").value = "child_under5";
    if ($("personeditlabel")) $("personeditlabel").textContent = "Add a person";
    if ($("addperson")) $("addperson").textContent = "Add person";
    if ($("cancelperson")) $("cancelperson").classList.add("hidden");
    if (clearFeedback && $("personeditfeedback")) $("personeditfeedback").textContent = "";
    if (closeEditor && $("personeditor")) $("personeditor").open = false;
  }
  function openPersonEditor(personId) {
    var person = personById(personId);
    if (!person) return;
    editingPersonId = person.id;
    if ($("personeditor")) $("personeditor").open = true;
    if ($("personeditlabel")) $("personeditlabel").textContent = "Editing " + person.name;
    if ($("personname")) $("personname").value = person.name || "";
    if ($("personrole")) $("personrole").value = person.subject || "child_under5";
    if ($("persondob")) $("persondob").value = person.birthDate || "";
    if ($("addperson")) $("addperson").textContent = "Save changes";
    if ($("cancelperson")) $("cancelperson").classList.remove("hidden");
    if ($("personeditfeedback")) $("personeditfeedback").textContent = "Change the details, then tap Save changes.";
    moveToNextStep("personname");
  }
  function confirmPersonChange(message) {
    if ($("personeditfeedback")) {
      $("personeditfeedback").textContent = message;
      moveToNextStep("personeditfeedback");
    }
    if ($("status")) {
      $("status").style.color = "#173f37";
      $("status").textContent = message;
    }
  }
  function renderRoleSelect() {
    if (!$("personrole")) return;
    var options = (catalog.subjects || []).map(function (s) { return '<option value="' + s.id + '">' + t(s.titleSlug) + "</option>"; });
    if (options.length) $("personrole").innerHTML = options.join("");
    if (!$("personrole").value) $("personrole").value = "child_under5";
  }
  function renderChips() {
    if (mode === "subject" && !activePersonId) {
      $("filtertitle").textContent = "Choose a person";
      $("filterchips").innerHTML = "";
      return;
    }
    if (mode === "danger" && !dangerPersonId) {
      $("filtertitle").textContent = "Something's wrong: Who?";
      $("filterchips").innerHTML = people.map(function (p) {
        var dob = p.birthDate ? "DOB " + p.birthDate : "DOB unknown";
        return '<button class="chip danger-person" data-person="' + p.id + '" data-subject="' + p.subject + '" type="button"><strong>' + esc(p.name) + '</strong><span> - ' + esc(personSummary(p)) + " - " + esc(dob) + "</span></button>";
      }).join("");
      var peopleChips = $("filterchips").querySelectorAll ? $("filterchips").querySelectorAll(".danger-person") : [];
      for (var p = 0; p < peopleChips.length; p++) peopleChips[p].addEventListener("click", function () { selectDangerPerson(this.dataset.person); });
      return;
    }
    var personForDanger = dangerPersonId ? personById(dangerPersonId) : null;
    var items = mode === "person-intent" ? [
      { id: "check", title: activeSubject === "pregnancy" ? tx("tx.navigation.pregnancy_check", "Pregnancy check") : "Check a problem" },
      { id: "learn", title: "Learn or practise" },
      { id: "tools", title: "Use a tool" }
    ] : mode === "learn" ? [
      { id: "learn_child", title: "Children and babies" },
      { id: "learn_family", title: "Pregnancy and family" },
      { id: "learn_home", title: "Home and hygiene" }
    ] : mode === "type" ? [
      { id: "tools_quick", title: "Timers and helpers" },
      { id: "tools_reminders", title: "Reminders" },
      { id: "tools_trackers", title: "Track progress" }
    ] : mode === "topic" ? titles(catalog.topics) : mode === "danger" ? [{ id: "danger", title: "Urgent checks for " + (personForDanger ? personForDanger.name : "this person") }] : titles(catalog.subjects);
    var subject = byId(catalog.subjects, activeSubject);
    $("filtertitle").textContent =
      mode === "person-intent" ? tx("tx.catalog.filter_title.person_intent", null, { personName: selectedPersonName() })
      : mode === "topic" ? tx("tx.catalog.filter_title.topic")
      : mode === "learn" ? tx("tx.catalog.filter_title.learn")
      : mode === "type" ? tx("tx.catalog.filter_title.tool")
      : mode === "danger" ? tx("tx.catalog.filter_title.checking", null, { subject: personForDanger ? personForDanger.name : (subject ? t(subject.titleSlug) : activeSubject) })
      : tx("tx.catalog.filter_title.for_person", null, { personName: selectedPersonName() });
    $("filterchips").innerHTML = items.map(function (it) {
      return '<button class="chip' + (selected === it.id ? " active" : "") + '" data-id="' + it.id + '" type="button">' + esc(it.title) + "</button>";
    }).join("");
    var chips = $("filterchips").querySelectorAll ? $("filterchips").querySelectorAll(".chip") : [];
    for (var i = 0; i < chips.length; i++) chips[i].addEventListener("click", function () {
      selected = this.dataset.id;
      featureLimit = FEATURE_PAGE_SIZE;
      if (mode === "subject") { activeSubject = selected; activePersonId = null; dangerPersonId = null; }
      if (openDeclaredPersonIntentDestination()) return;
      if (openOnlyEligibleDestination()) return;
      renderCatalog();
      moveToNextStep("featurelist");
    });
  }
  function topicInGroup(feature, group) {
    var topics = feature.topic || [];
    var groups = {
      learn_child: ["child_health", "diarrhoea_ors", "dental", "immunization", "newborn", "nutrition", "vision_hearing", "cold_flu"],
      learn_family: ["anc_birth", "pnc_breastfeeding", "preparedness"],
      learn_home: ["safe_water", "handwashing", "sanitation", "malaria", "lead_kohl", "chronic_meds"]
    };
    return (groups[group] || []).some(function (topic) { return topics.indexOf(topic) >= 0; });
  }
  function featureMatches(f) {
    if (!caregiverCatalogFeature(f)) return false;
    if (!search && f.integratedIntoBySubject && f.integratedIntoBySubject[activeSubject]) return false;
    var aliases = {
      u5_triage: "sick child cough diarrhoea diarrhea fever ear tooth mouth rash measles",
      dental_brushing: "brush teeth toothbrush toothbrushing brushing timer teeth timer",
      dental_triage: "tooth pain toothache mouth pain dental pain",
      breastfeeding_aid_triage: "breastfeeding assistant breastfeeding audio read aloud breastfeeding triage assistant breastfeeding aid baby feeding help latch milk supply wet nappies newborn feeding breast problem breastfeeding problem",
      handwashing_timer: "wash hands hand wash soap",
      ors_slideshow: "ors mix mixing oral rehydration",
      ors_voucher: "ors zinc diarrhoea diarrhea",

      // Inherits the retired safe-water checker's search terms as well as its own: the two cards
      // asked one procedure's questions twice, and David ruled them into one (2026-09-25, "merge").
      chlorine_contact_timer: "chlorine wait timer chlorine instructions safe water wait contact time 30 minutes water treatment disinfect treat drinking water",
      chlorine_dose_helper: "chlorine instructions dose label table local product safe water",
      // Jargon that a health worker or reviewer would type stays searchable even though the
      // caregiver-visible labels no longer show it (2026-08-19 jargon sweep). Hiding a term from
      // display is not a reason to make the feature unfindable to someone who knows that term.
      child_muac_malnutrition_screen: "muac mid upper arm circumference arm tape nutrition malnutrition wasting thin swelling",
      child_hearing_screen: "hearing audiology deaf deafness ear hearing test screening",
      child_vision_screen: "vision sight eyesight eye test screening",
      zinc_tracker: "zinc dispersible tablet course diarrhoea diarrhea"
    };
    var hay = (t(f.titleSlug) + " " + f.id + " " + (f.topic || []).join(" ") + " " + (f.type || []).join(" ") + " " + (aliases[f.id] || "")).toLowerCase();
    if (search) return hay.indexOf(search) >= 0;
    if (hotspot && hotspotRelevant(f)) return true;
    if (mode === "danger") return !!dangerPersonId && !!f.dangerEligible && (f.subject || []).indexOf(activeSubject) >= 0;
    if (mode === "person-intent") {
      if (!selected || (f.subject || []).indexOf(activeSubject) < 0) return false;
      if (selected === "check") return !!f.dangerEligible || (f.type || []).indexOf("triage") >= 0;
      if (selected === "learn") return (f.type || []).indexOf("story") >= 0 || (f.type || []).indexOf("howto") >= 0;
      return (f.type || []).some(function (type) { return ["tool", "reminder", "tracker"].indexOf(type) >= 0; });
    }
    if (mode === "learn") return !!selected && ((f.type || []).indexOf("story") >= 0 || (f.type || []).indexOf("howto") >= 0) && topicInGroup(f, selected);
    if (mode === "topic") return (f.topic || []).indexOf(selected) >= 0;
    if (mode === "type") {
      if (!selected) return false;
      if (selected === "tools_reminders") return (f.type || []).indexOf("reminder") >= 0;
      if (selected === "tools_trackers") return (f.type || []).indexOf("tracker") >= 0;
      if (selected === "tools_quick") return (f.type || []).indexOf("tool") >= 0;
      return (f.type || []).indexOf(selected) >= 0;
    }
    return (f.subject || []).indexOf(selected) >= 0;
  }
  function hotspotRelevant(f) {
    var topics = f.topic || [];
    return !!f.dangerEligible || topics.indexOf("safe_water") >= 0 || topics.indexOf("handwashing") >= 0 || topics.indexOf("diarrhoea_ors") >= 0 || topics.indexOf("sanitation") >= 0;
  }
  function currentMemoryProfile() {
    return $("memoryprofile") && $("memoryprofile").value ? $("memoryprofile").value : "low_1gb";
  }
  function profileAllows(f) {
    var profile = currentMemoryProfile();
    return !f.memoryProfile || f.memoryProfile.indexOf(profile) >= 0;
  }
  function caregiverCatalogFeature(f) {
    return (f.audience || "caregiver") !== "reviewer";
  }
  function featureVisible(f) {
    if (!profileAllows(f) || !caregiverCatalogFeature(f)) return false;
    if (f.id === "kmc_timer" && !eligibleKmcBaby()) return false;
    if (moduleOverrides[f.id] === true) return true;
    if (moduleOverrides[f.id] === false) return false;
    return featureMatches(f);
  }
  function eligibleFeaturesForCurrentView() {
    return (catalog.features || []).filter(featureVisible).sort(function (a, b) {
      if (moduleOverrides[a.id] === true && moduleOverrides[b.id] !== true) return -1;
      if (moduleOverrides[b.id] === true && moduleOverrides[a.id] !== true) return 1;
      // Optional demo packs remain discoverable, but must not displace the governed core
      // lessons from the first page merely because a clean story title sorts earlier.
      if (!!a.demoUnreviewed !== !!b.demoUnreviewed) return a.demoUnreviewed ? 1 : -1;
      return t(a.titleSlug).localeCompare(t(b.titleSlug));
    });
  }
  function openDeclaredPersonIntentDestination() {
    if (mode !== "person-intent" || !selected) return false;
    var route = catalog.personIntentRoutes.find(function (item) {
      return item.subject === activeSubject && item.intent === selected;
    });
    if (!route) return false;
    var feature = byId(catalog.features, route.featureId);
    if (!feature || !profileAllows(feature) || !caregiverCatalogFeature(feature)) return false;
    $("featurelist").innerHTML = "";
    openLaunch(feature.launch, t(feature.titleSlug));
    return true;
  }
  function openOnlyEligibleDestination() {
    var features = eligibleFeaturesForCurrentView();
    if (features.length !== 1) return false;
    $("featurelist").innerHTML = "";
    openLaunch(features[0].launch, t(features[0].titleSlug));
    return true;
  }
  function activeForManager(f) {
    if (!profileAllows(f) || !caregiverCatalogFeature(f)) return false;
    if (moduleOverrides[f.id] === true) return true;
    if (moduleOverrides[f.id] === false) return false;
    return featureMatches(f);
  }
  function renderFeatureList() {
    var hasForcedModule = Object.keys(moduleOverrides).some(function (id) { return moduleOverrides[id] === true; });
    if ((mode === "subject" && !activePersonId && !search && !hotspot && !hasForcedModule) || ((mode === "person-intent" || mode === "learn" || mode === "type") && !selected && !search && !hotspot && !hasForcedModule)) {
      $("featurelist").innerHTML = "";
      return;
    }
    if (mode === "danger" && selected === "who") {
      $("featurelist").innerHTML = "";
      return;
    }
    if (mode === "danger" && dangerPersonId && !hotspot) {
      var person = personById(dangerPersonId);
      $("featurelist").innerHTML = '<div class="muted">' + esc(tx("tx.catalog.urgent_intake_hidden_modules", "The app is asking about signs now for {person}. Other pages are hidden until you finish.", { person: person ? person.name : t("tx.catalog.this_person") })) + "</div>";
      return;
    }
    var features = eligibleFeaturesForCurrentView();
    var shown = features.slice(0, featureLimit);
    var anyPreview = shown.some(function (f) { return f.tier === "preview"; });
    var listNote = anyPreview
      ? '<p class="tier-note tier-note-list">' + esc(tx("tx.catalog.tier_preview", "Try it out. The app does not save anything here yet.")) + '</p>'
      : "";
    $("featurelist").innerHTML = listNote + shown.map(function (f) {
      var summary = featureSummary(f);
      // ADR-027 requires the caregiver to know that a preview feature keeps nothing. Almost every
      // feature is preview, so a per-card note printed the same sentence six times on one screen -
      // repetition that reads as noise and stops being read. It is now stated once above the list,
      // still on every screen that shows a preview feature. David, 2026-08-20, on the story list.
      var tierNote = "";
      return '<button class="feature" data-launch="' + f.launch + '" type="button" data-tier="' + esc(f.tier || "preview") + '"><strong>' + t(f.titleSlug) + '</strong>' + featureThumb(f.id) + (summary ? '<span>' + esc(summary) + '</span>' : "") + tierNote + "</button>";
    }).join("") + (features.length > shown.length ? '<button class="ghost show-more" id="showmorefeatures" type="button">Show ' + Math.min(FEATURE_PAGE_SIZE, features.length - shown.length) + ' more</button>' : "");
    if (!features.length) $("featurelist").innerHTML = '<div class="muted">' + esc(tx("tx.catalog.no_results", "No results for \"{query}\". Try \"brush teeth\", \"ORS\", \"chlorine\", or \"newborn\". You can also browse by person, topic, or Education & stories.", { query: search || t("tx.catalog.this_view") })) + "</div>";
    var cards = $("featurelist").querySelectorAll ? $("featurelist").querySelectorAll(".feature") : [];
    for (var i = 0; i < cards.length; i++) cards[i].addEventListener("click", function () {
      var launch = this.dataset.launch;
      if (mode === "danger" && launch === "triage.under5") applyKnownDob(personById(dangerPersonId));
      openLaunch(launch, this.querySelector("strong").textContent || tx("tx.prototype.unavailable.title", "Not available in this prototype"));
    });
    var showMore = $("showmorefeatures");
    if (showMore) showMore.addEventListener("click", function () {
      featureLimit += FEATURE_PAGE_SIZE;
      renderFeatureList();
      moveToNextStep("featurelist");
    });
  }
  function featureSummary(feature) {
    if (!feature) return "";
    // Caregiver-facing catalog summaries resolve through the phrase bank so they translate.
    // The English literal stays here only as the tx() fallback, matching the wording in the
    // slug, so a missing slug degrades to the previous copy instead of an empty card.
    // Ask the bank whether this feature has a summary, rather than keeping a second copy of the
    // English here to decide by. The map this replaced held all fourteen sentences a second time,
    // and two had already drifted from the bank - one still saying "postpartum", the jargon word the
    // plain-language pass removed. Neither copy could be seen from the other.
    var summarySlug = "tx.feature_" + feature.id + "_summary";
    if (t(summarySlug) !== summarySlug) return t(summarySlug);
    var card = cardByFeature(feature.id);
    if (card && card.bodySlug) return caregiverCardSummary(t(card.bodySlug));
    var screen = screenByFeature(feature.id);
    if (screen && screen.bodySlug) return caregiverCardSummary(t(screen.bodySlug));
    var story = storyByFeature(feature.id);
    if (story && story.slides && story.slides.length && story.slides[0].bodySlug) return caregiverCardSummary(t(story.slides[0].bodySlug));
    return "";
  }
  function caregiverCardSummary(text) {
    var s = String(text || "").trim();
    if (!s) return "";
    if (/\b(CODEX|DMN|FHIR|Scheduler|Nudge Coordinator|broker|pipeline|contract|placeholder|preview|future)\b/i.test(s)) return "";
    s = s.replace(/\bThis prototype\b/gi, "This screen")
      .replace(/\bthe prototype\b/gi, "this screen")
      .replace(/\bin this prototype\b/gi, "here")
      .replace(/\bprototype\b/gi, "screen");
    var first = s.split(/(?<=[.!?])\s+/)[0] || s;
    if (first.length > 150) first = first.slice(0, 147).replace(/\s+\S*$/, "") + "...";
    return first;
  }
  function renderModuleManager() {
    if (!$("moduletoggles")) return;
    var manageable = (catalog.features || []).filter(function (f) { return caregiverCatalogFeature(f) && profileAllows(f) && f.status !== "planned"; });
    var activeCount = manageable.filter(activeForManager).length;
    if ($("modulesummary")) $("modulesummary").textContent = activeCount + " active modules for this profile" + (hotspot ? " + hotspot" : "") + ".";
    $("moduletoggles").innerHTML = manageable.map(function (f) {
      var active = activeForManager(f);
      var verb = active ? "Remove" : "Add";
      return '<button class="module-toggle ' + (active ? "active" : "") + '" data-feature="' + f.id + '" type="button">' + verb + ' ' + t(f.titleSlug) + '</button>';
    }).join("");
    var toggles = $("moduletoggles").querySelectorAll ? $("moduletoggles").querySelectorAll(".module-toggle") : [];
    for (var i = 0; i < toggles.length; i++) toggles[i].addEventListener("click", function () {
      var fid = this.dataset.feature;
      var feature = byId(catalog.features, fid);
      var active = feature ? activeForManager(feature) : false;
      if (moduleOverrides[fid] === true && active) delete moduleOverrides[fid];
      else moduleOverrides[fid] = !active;
      renderFeatureList();
      renderModuleManager();
    });
  }
  function renderCatalog() { renderDoors(); renderChips(); renderFeatureList(); renderModuleManager(); renderDemoMode(); applyShellVisibility(); }
  function showSlides(slides) {
    activeSlides = Array.isArray(slides) && slides.length ? slides : [];
    slideIndex = 0;
    // Show the panel first, then draw into it. showPanel clears the story-activity slot on every
    // screen change, so rendering before showing meant the panel wiped what had just been drawn.
    // Every other screen here already shows then renders.
    showPanel("slideshow");
    renderSlide();
  }
  function changeSlide(nextIndex) {
    if (!activeSlides.length) return false;
    var boundedIndex = Math.max(0, Math.min(activeSlides.length - 1, nextIndex));
    if (boundedIndex === slideIndex) return false;
    stopReadAloudForContextChange("Read-aloud stopped.");
    slideIndex = boundedIndex;
    renderSlide();
    return true;
  }
  // A step the caregiver's own answer has made irrelevant. She said she can measure the packet's
  // amount, so the container chooser is skipped going forward - and going back. Previous used to
  // land on the chooser she never saw, so returning to the question took two taps. David,
  // 2026-09-02: "If I hit that button, have to hit Previous twice to return."
  function orsSlideSkipped(slide) {
    return !!slide && slide.featureId === "ors_slideshow" && slide.id === "choose_container" && orsNeedsMeasureHelp === false;
  }
  function moveSlide(delta) {
    if (!activeSlides.length) return false;
    var target = slideIndex + delta;
    while (target >= 0 && target < activeSlides.length && orsSlideSkipped(activeSlides[target])) target += delta;
    return changeSlide(target);
  }
  function moveToNextSlideOrCare() {
    var slide = activeSlides[slideIndex] || {};
    if (slide.featureId === "ors_slideshow" && slide.id === "use_same_day") {
      // ORS and zinc are one caregiver journey even though their renderers stay
      // separate. Preserve the completed ORS frame so shell Back returns here.
      pushCurrentWorkView();
      openLaunch("tool.zinc_tracker", t("tx.feature_zinc_tracker"));
      return true;
    }
    return moveSlide(1);
  }
  function renderSlide() {
    var slide = activeSlides[slideIndex] || {};
    $("slidetitle").textContent = slide.titleSlug ? t(slide.titleSlug) : (slide.title || "");
    activeShellTitle = $("slidetitle").textContent || activeShellTitle;
    var heading = slide.headingSlug ? t(slide.headingSlug) : "";
    if ($("slideheading")) {
      $("slideheading").textContent = heading;
      $("slideheading").classList.toggle("hidden", !heading);
    }
    var visualAssetId = slide.assetId || orsMeasureVisualAsset(slide);
    // An empty id from orsMeasureVisualAsset is deliberate: an ADR-028 container has no photograph,
    // and the drawn plan is the picture. Passing "" on to renderVisual let it fall through to the
    // feature's generic artwork - the retired painted five-mug recipe - above a mug she was told to
    // fill three times and a third. Draw the plan alone instead.
    var drawnPlanOnly = slide.featureId === "ors_slideshow" && slide.id === "measure" && visualAssetId === "" && orsMeasureFractionPlanned();
    $("slideimage").innerHTML = (drawnPlanOnly ? "" : renderVisual(slide.featureId, slide.img, visualAssetId, slide.exactAssetOnly))
      + orsMeasureArithmeticCaption(slide);
    // The measuring photograph is the step's one picture, so it gets the room the drawings took.
    $("slideimage").classList.toggle("ors-measure-photo",
      slide.featureId === "ors_slideshow" && slide.id === "measure" && !!orsMeasurePhotoAsset(containerById(orsDeckContainerId)));
    setSlideText(slideText(slide));
    // Deck metadata (cache profile, review state, authoring notes) never belongs in
    // caregiver copy. Each step renderer supplies only the extra help that is useful now.
    $("slidecache").innerHTML = "";
    renderOrsDeckStepControls(slide);
    renderStoryActions(slide.featureId, slide.reviewAssetId);
    updateSlideNavigation(activeSlides.length > 1);
    updateOrsSlideNavigation(slide);
    applyShellVisibility();
  }
  function deckToSlides(deck) {
    return (deck && Array.isArray(deck.steps) ? deck.steps : []).map(function (step) {
      return {
        id: step.id,
        titleSlug: step.titleSlug || deck.titleSlug,
        bodySlug: step.bodySlug,
        img: step.imageDesc || step.imageAsset || "Image placeholder for this step.",
        imageAsset: step.imageAsset,
        featureId: deck.featureId
      };
    });
  }
  // External review mgilkey C5. The reviewer looked at the five-cups picture and worked out that
  // five cups cannot make a litre - because a US cup is 237 mL. The app's cup is 200 mL, so the
  // arithmetic is right, but a numerate reader getting the wrong answer from the picture is itself
  // the defect: the cup size is not legible in the drawing. Stating the sum beside the picture
  // makes it checkable without trusting the artwork, and it is mostly digits, so it survives
  // translation and low literacy better than the sentence does.
  // A drawn sum, generated from the container the caregiver actually chose.
  //
  // The mixing picture carries a painted "5 mugs = 1 L" strip, which says the same thing whoever is
  // looking at it. David, 2026-08-20: "give ORS image is for the 5-cup reipe, which is not
  // helpful" and "if I pick 500 ml. should show 2 500 ml and a larger bowl or bottle holding the
  // mixture." Arithmetic can follow a choice; a painting cannot.
  function orsMeasurePlanForDeck() {
    if (!engine.planOrsMeasure) return null;
    var container = containerById(orsDeckContainerId);
    if (!container) return null;
    var sachetMl = orsSachetVolumeMl();
    if (!sachetMl) return null; // fail closed: no governed sachet volume, no sum
    var plan = engine.planOrsMeasure({
      sachetVolumeMl: sachetMl,
      containerVolumeMl: Number(container.volumeMl),
      allowFractions: deployerSwitch("orsAllowApproximateFractions") === true
    });
    return plan ? { plan: plan, container: container, sachetMl: sachetMl } : null;
  }
  function containerLabel(container) {
    if (!container) return tx("tx.ors.container.generic", "container");
    // A container's `slug` names its caution sentence ("This cup is smaller than a full-sachet ORS
    // mix..."), not the vessel. Reading it here put that whole sentence, lower-cased, into the sum:
    // "5 this cup is smaller than a full-sachet ors mix...s of water make 1000 mL". The vessel's
    // name lives in `labels`, per locale. David, 2026-09-02.
    var text = localizedContainerLabel(container);
    if (!text || text === "container") text = tx("tx.ors.container.generic", "container");
    // Strip the parenthetical volume; the drawing states the volume itself.
    return String(text).replace(/\s*\([^)]*\)\s*$/, "").toLowerCase();
  }
  /** What to do, for a container the exact-method catalogue does not cover. */
  function orsMeasureInstructionFromPlan() {
    var info = orsMeasurePlanForDeck();
    if (!info) return "";
    var p = info.plan;
    var name = containerLabel(info.container);
    if (p.kind === "exact") {
      return tx("tx.ors.measure.exact_action", "Fill the {container} {count} times with clean water and pour each fill into your mixing container. That makes {total} mL.",
        { container: name, count: p.wholeCount, total: info.sachetMl });
    }
    if (p.kind === "whole_plus_fraction") {
      return tx("tx.ors.measure.fraction_action", "Fill the {container} {count} times, then once more to {fraction} - {hint}. Pour every fill into your mixing container. That makes about {total} mL.",
        { container: name, count: p.wholeCount, fraction: p.fraction.short, hint: p.fraction.hint, total: info.sachetMl });
    }
    if (p.kind === "part_of_one") {
      return tx("tx.ors.measure.part_action", "Fill the {container} to {fraction} - {hint}. That makes about {total} mL.",
        { container: name, fraction: p.fraction.short, hint: p.fraction.hint, total: info.sachetMl });
    }
    return "";
  }
  /** True when the chosen container needs a part pour, so the drawing is the honest picture. */
  function orsMeasureFractionPlanned() {
    var info = orsMeasurePlanForDeck();
    return !!(info && info.plan && info.plan.fraction);
  }
  function orsMeasureSentence(info) {
    if (!info) return "";
    var name = containerLabel(info.container);
    var p = info.plan;
    if (p.kind === "exact") {
      return tx("tx.ors.sum.exact", "{count} {container}s of water make {total} mL.",
        { count: p.wholeCount, container: name, total: info.sachetMl });
    }
    if (p.kind === "whole_plus_fraction") {
      return tx("tx.ors.sum.whole_plus_fraction", "{count} {container}s of water plus {fraction} - {hint} - make about {total} mL.",
        { count: p.wholeCount, container: name, fraction: p.fraction.words.replace("{container}", name), hint: p.fraction.hint, total: info.sachetMl });
    }
    if (p.kind === "part_of_one") {
      // The container is already the subject here, so name the part on its own.
      return tx("tx.ors.sum.part_of_one", "Fill the {container} {fraction} full - {hint} - to make about {total} mL.",
        { container: name, fraction: p.fraction.short, hint: p.fraction.hint, total: info.sachetMl });
    }
    // No honest way to measure the sachet with this container. Say so; do not approximate.
    return tx("tx.ors.sum.unusable", "This {container} cannot measure {total} mL exactly. Choose another container.",
      { container: name, total: info.sachetMl });
  }
  /** One container glyph, filled to `fillShare` (0-1) of its height. */
  function orsVesselSvg(x, width, height, fillShare, baseline) {
    var top = baseline - height;
    var fillTop = baseline - Math.max(2, height * fillShare);
    return '<rect x="' + x + '" y="' + top + '" width="' + width + '" height="' + height + '" rx="4" class="ors-vessel-body"/>'
      + '<rect x="' + (x + 2) + '" y="' + fillTop + '" width="' + (width - 4) + '" height="' + (baseline - fillTop - 2) + '" rx="3" class="ors-vessel-fill"/>';
  }
  function orsMeasureDiagram(info) {
    if (!info) return "";
    var p = info.plan;
    if (p.kind === "not_exact" || p.kind === "too_large") return "";
    var sentence = orsMeasureSentence(info);
    var glyphs = [];
    for (var i = 0; i < p.wholeCount; i++) glyphs.push(1);
    if (p.fraction) glyphs.push(p.fraction.value);
    if (!glyphs.length) return "";

    var W = 46, GAP = 10, H = 62, BASE = 78;
    var x = 4;
    var parts = "";
    for (var g = 0; g < glyphs.length; g++) {
      if (g > 0) parts += '<text class="ors-vessel-op" x="' + (x - GAP / 2) + '" y="' + (BASE - H / 2 + 8) + '">+</text>';
      parts += orsVesselSvg(x, W, H, glyphs[g], BASE);
      x += W + GAP;
    }
    var eqX = x + 2;
    parts += '<text class="ors-vessel-op" x="' + eqX + '" y="' + (BASE - H / 2 + 8) + '">=</text>';
    var mixX = eqX + 18;
    // The mixing vessel is drawn taller than a pour so it reads as "all of it together".
    parts += orsVesselSvg(mixX, W + 18, H + 10, 1, BASE);
    parts += '<text class="ors-vessel-label" x="' + (mixX + (W + 14) / 2) + '" y="' + (BASE + 14) + '" text-anchor="middle">' + esc(info.sachetMl + " mL") + '</text>';
    var width = mixX + W + 26;
    return '<figure class="ors-measure-diagram">'
      + '<svg viewBox="0 0 ' + width + ' 100" width="100%" height="100" role="img" aria-label="' + esc(sentence) + '">' + parts + '</svg>'
      + '<figcaption>' + esc(sentence) + '</figcaption></figure>';
  }
  function orsMeasureArithmeticCaption(slide) {
    if (!slide || slide.featureId !== "ors_slideshow" || slide.id !== "measure") return "";
    var container = containerById(orsDeckContainerId);
    var method = exactOrsMeasurementMethod(container);
    // No catalogue method: an ADR-028 container whose part pour is planned, not photographed. The
    // drawing is the whole picture for that step, so it is produced here rather than skipped.
    if (!method) return container && orsMeasureFractionPlanned() ? orsMeasureDiagram(orsMeasurePlanForDeck()) : "";
    var fillMl = Number(method.fillVolumeMl || method.measureVolumeMl || 0);
    var fills = Number(method.fillCount || 0);
    if (!fillMl || !fills) return "";
    var total = fillMl * fills;
    // The drawn sum replaces the printed one where we can generate it, because the number of
    // vessels in a drawing is what a caregiver copies. The text stays as the fallback and as what
    // read-aloud speaks.
    //
    // Unless the catalogue supplies a photograph of the fills: then the drawing is a second picture
    // of the same sum, and only the printed sum stays under the photograph. Digits survive
    // translation, and a numerate reader can still check the arithmetic (external review mgilkey C5).
    if (!orsMeasurePhotoAsset(container)) {
      var diagram = orsMeasureDiagram(orsMeasurePlanForDeck());
      if (diagram) return diagram;
    }
    return '<p class="measure-sum" data-measure-sum="' + fills + 'x' + fillMl + '">'
      + esc(fills + " x " + fillMl + " mL = " + total + " mL")
      + '</p>';
  }
  // The photograph the exact-method catalogue pairs with this container's fills, if one is
  // deliverable. Where it exists it is the measuring step's only picture.
  // Only when the catalogue row says its picture shows the fills themselves (visualShowsFills). The
  // 500 mL bottle's picture is one bottle beside a sachet for scale; treating any picture as "the
  // fills" hid the two-bottle drawing there (review of this change, 2026-09-02, finding 1). David,
  // 2026-08-20: "if I pick 500 ml. should show 2 500 ml and a larger bowl or bottle holding the
  // mixture" still stands for every container without a photograph of its pours.
  function orsMeasurePhotoAsset(container) {
    var method = exactOrsMeasurementMethod(container);
    if (!method || !method.visualAssetRef || method.visualShowsFills !== true) return null;
    return displayAsset("ors_slideshow", method.visualAssetRef);
  }
  function orsMeasureVisualAsset(slide) {
    if (!slide || slide.featureId !== "ors_slideshow" || slide.id !== "measure") return slide && slide.imageAsset;
    var container = containerById(orsDeckContainerId);
    // She is measuring the packet's amount herself: show the marked one-litre line, which is the
    // thing she is measuring to. The deck's own artwork for this step shows the sachet going in,
    // which is the next step (AX-007: step-matched art).
    if (!container && orsNeedsMeasureHelp === false) return "img.generated.ors_measure_question_v3";
    var method = exactOrsMeasurementMethod(container);
    // Container-specific pictures prevent a correct instruction being paired with a
    // misleading number of cups. The exact-method catalog owns the eligible method and
    // its paired visual; raw nominal container capacity never authorizes a method.
    //
    // A container admitted under ADR-028 has no catalogue method and so no paired photograph. The
    // deck's own artwork is a jar filled to a one-litre line, which contradicts an instruction to
    // fill a mug three times and a third - David, 2026-08-24: "image should be close-up of 3 1/3 *
    // 300 ml containers". Returning nothing here leaves the generated drawing, which shows exactly
    // that, as the step's only picture. Better no photograph than one of a different recipe.
    if (!method && container && orsMeasureFractionPlanned()) return "";
    return (method && method.visualAssetRef) || (container && container.orsMeasurementVisualAssetId) || slide.imageAsset;
  }
  function slideText(slide) {
    if (slide.featureId !== "ors_slideshow") return t(slide.bodySlug);
    var container = containerById(orsDeckContainerId);
    if (slide.id === "measure") {
      if (!container) {
        // She answered that she can measure the packet's amount herself, so the step tells her to
        // do that. It used to send her to the container list she had just declined.
        if (orsNeedsMeasureHelp === false) return tx("tx.ors.deck.measure_yourself", "Measure {amount} of clean water into a clean container. If you cannot measure it exactly, do not guess: ask a health worker, pharmacy, or clinic.", { amount: orsSachetAmountLabel() });
        return tx("tx.seq_ors_step2_need_container", "First choose the container you will use. Then this step will tell you exactly how many times to fill it.");
      }
      // A container admitted under ADR-028 has no entry in the exact-method catalogue, so
      // orsMeasurementInstruction fell through to "first choose a container" - while the drawing
      // beside it correctly showed three mugs and a third. David, 2026-08-24: "You have chosen
      // container." Words and drawing now come from the same plan.
      var method = exactOrsMeasurementMethod(container);
      if (!method) {
        var planned = orsMeasureInstructionFromPlan();
        if (planned) return planned;
      }
      return orsMeasurementInstruction(container, method);
    }
    if (slide.id === "mix") {
      // Stirring is the next step's whole instruction, so it is not also said here. David,
      // 2026-09-02: "Stir or shake until you dissolve all the ORS powder. Is repeated 2 screens."
      if (!container) {
        if (orsNeedsMeasureHelp === false) return tx("tx.seq_ors_step3_measured", "Now add one full ORS sachet to the water you measured.");
        return tx("tx.seq_ors_step3_need_container", "Choose a container first. Measure the water. Then add one full ORS sachet.");
      }
      // "measured with the small tea cup", not "measured for Small tea cup (200 mL)": the vessel is
      // named the way a sentence names it, and its volume was the previous step's business.
      return tx("tx.seq_ors_step3_chosen", "Now add one full ORS sachet to the water you measured with the {container}.", { container: containerLabel(container) });
    }
    return t(slide.bodySlug);
  }
  function orsContainerCardsHtml() {
    return '<div class="grid ors-container-grid">' + exactOrsContainers().map(function (c) {
      var selectedClass = c.id === orsDeckContainerId ? " selected" : "";
      var label = localizedContainerLabel(c);
      var volume = String(c.volumeMl) + " mL";
      return '<button class="card ors-container-choice' + selectedClass + '" data-container-id="' + esc(c.id) + '" type="button">' + containerVisual(c) + '<strong>' + esc(label) + '</strong>' + (label.indexOf(volume) >= 0 ? "" : '<div class="vol">' + esc(volume) + "</div>") + "</button>";
    }).join("") + "</div>";
  }
  function indexOfOrsStep(stepId) {
    for (var i = 0; i < activeSlides.length; i++) if (activeSlides[i].id === stepId) return i;
    return Math.min(activeSlides.length - 1, slideIndex + 1);
  }
  function renderOrsDeckStepControls(slide) {
    if (slide.featureId !== "ors_slideshow") return;
    var container = containerById(orsDeckContainerId);
    if (slide.id === "can_measure") {
      // Offer the packet's own instruction first and only show containers if she needs them.
      // David, 2026-08-20: "offer packet first and only do fancy stuff if they need help", and
      // "You did not put in the 'screen if can measure right amount of water' before the 'choose
      // container' screen."
      var sachetMl = orsSachetVolumeMl();
      // The same words as the sachet line above the button: "1 litre (1000 mL)", not a bare
      // millilitre count. David, 2026-09-02: "Usually called one liter. Use both names."
      var amount = orsSachetAmountLabel();
      $("slidecache").innerHTML = orsSachetResolutionHtml()
        + (sachetMl
          ? '<div class="slidecontrols wrap-controls">'
            + '<button id="orscanmeasure" type="button">' + esc(tx("tx.ors.deck.can_measure_yes", "Yes, I can measure {amount}", { amount: amount })) + '</button>'
            + '<button class="ghost" id="orsneedhelp" type="button">' + esc(tx("tx.ors.deck.can_measure_no", "Show me how to measure it")) + '</button>'
            + '</div>'
          : "");
      bindOrsSachetChoices();
      var canBtn = $("orscanmeasure"), helpBtn = $("orsneedhelp");
      if (canBtn && !canBtn.dataset.bound) {
        canBtn.dataset.bound = "orsmeasure";
        canBtn.addEventListener("click", function () {
          orsNeedsMeasureHelp = false;
          orsDeckContainerId = "";
          changeSlide(indexOfOrsStep("measure"));
        });
      }
      if (helpBtn && !helpBtn.dataset.bound) {
        helpBtn.dataset.bound = "orsmeasure";
        helpBtn.addEventListener("click", function () {
          orsNeedsMeasureHelp = true;
          changeSlide(indexOfOrsStep("choose_container"));
        });
      }
    } else if (slide.id === "choose_container") {
      $("slidecache").innerHTML = '<div class="slidecontrols checklist-controls"><p class="muted">' + esc(tx("tx.ors.deck.choose_prompt", "Choose one exact way to measure 1 litre (1000 mL).")) + '</p>' + orsContainerCardsHtml() + '<p id="orscontainerstatus" class="muted">' + esc(container ? tx("tx.ors.deck.selected", "Selected: {container}", { container: localizedContainerLabel(container) }) : tx("tx.ors.deck.none_selected", "No container selected yet.")) + "</p></div>";
      bindOrsContainerChoices(true);
    } else if (slide.id === "measure") {
      // The diagram counts out the fills for the container she actually chose. It renders only when
      // the arithmetic checks out against the resolved sachet volume, so a container with no exact
      // method shows the vessel alone and the packet instruction rather than an invented ratio.
      if (!container && orsNeedsMeasureHelp === false) {
        // She said she can measure the packet's amount, so there is no container to name and
        // nothing to draw. Offering the container grid here contradicted the answer she just gave.
        $("slidecache").innerHTML = "";
      } else {
        var measureMethod = container ? exactOrsMeasurementMethod(container) : null;
        // When the catalogue has a photograph of the counted-out fills it already sits above this
        // panel. Drawing the same sum here as well, and the container's own photo under that, gave
        // the step three pictures of five cups and a jug. David, 2026-09-02: "Only one is realistic.
        // Drop the other two and magnify." The drawing stays for a container with no photograph.
        var arithmetic = container && !orsMeasurePhotoAsset(container) ? orsArithmeticDiagramHtml(container, measureMethod) : "";
        $("slidecache").innerHTML = '<div class="mix-instruction"><h3>' + esc(tx("tx.ors.mix.selected_title", "Mixing instruction")) + '</h3><p>' + esc(container ? tx("tx.ors.deck.using_container", "Using: {container}", { container: localizedContainerLabel(container) }) : tx("tx.ors.deck.choose_first", "Choose a container first.")) + '</p>' + (arithmetic || (container ? "" : orsContainerCardsHtml())) + '</div>';
        if (!container) bindOrsContainerChoices(false);
      }
    } else if (slide.id === "give") {
      // How much and how often, on its own step directly after mixing and before zinc. David,
      // 2026-08-24: "after done mixing, next optino should be how to give or how often to give,
      // prior to zinc." This lived on use_same_day until 2026-08-25 only because a giving picture
      // did not exist and every deck step needs its own image (AX-007); David supplied one, so the
      // guidance now sits on the step it describes instead of under a storage instruction.
      // The amount is matched to the child's age by the shared guide, so this is not a second copy.
      // The frame text above already says how to give, so the guide leaves that line out here.
      $("slidecache").innerHTML = orsZincCareGuideHtml({ inDeck: true });
    }
    // The mix step used to repeat its own instruction in a panel beneath itself - "Use one full ORS
    // sachet with the measured water" directly under text that already said to add one full sachet.
    // David, 2026-08-24: "Adds no value after the actual instructions."
  }
  // The sachet question, on the step that first needs the number. It renders as one correctable
  // line when the deployment stocks a single volume, as a choice when it stocks several, and as the
  // packet instruction when nothing resolves. Which of the three appears is decided by the config,
  // never by the caregiver having to know that a config exists.
  function orsSachetResolutionHtml() {
    var rows = sachetCatalogRows();
    var ml = orsSachetVolumeMl();

    if (orsSachetId === "unknown" || (!ml && rows.length)) {
      var lookFor = rows.reduce(function (all, row) {
        return all.concat(Array.isArray(row.packetTextExamples) ? row.packetTextExamples : []);
      }, []);
      // Naming the text to look for beats a photo grid: printed volume survives repackaging, is
      // not defeated by look-alike foil, and works for a SKU this catalogue never heard of.
      return '<div class="sachet-resolve">'
        + '<p>' + esc(tx("tx.ors.sachet.ask", "How much water does your packet say to use?")) + '</p>'
        + '<div class="slidecontrols wrap-controls">'
        + rows.map(function (row) {
          return '<button class="sachet-choice" data-sachet-id="' + esc(row.id) + '" type="button">'
            + esc(tx(row.slug, row.labels && row.labels.en ? row.labels.en : row.volumeMl + " mL")) + "</button>";
        }).join("")
        + '</div>'
        + (lookFor.length
          ? '<p class="muted">' + esc(tx("tx.ors.sachet.look_for", "Look on the packet for one of these:")) + " " + esc(lookFor.join(", ")) + "</p>"
          : "")
        + '<p>' + esc(tx("tx.ors.sachet.unknown", "Mix the whole packet into the amount of clean water printed on the packet.\nIf you cannot read it, ask a health worker or pharmacy. Do not guess.")).split("<br>").join("<br>") + "</p>"
        + "</div>";
    }

    if (!ml) return "";

    // Resolved. Say which volume is in play, and let her correct it in one tap. A deployment can
    // stock one SKU and a caregiver can still be holding a packet from a different shop.
    //
    // The line describes the packets this deployment stocks, not hers: the app has not read her
    // packet and must not sound as if it had. It used to say "Your packet makes Makes 1 litre" -
    // the verb was in the sentence and in the catalogue label. David, 2026-09-02: "Why does it say
    // packet size as if it can read the packet?"
    var canCorrect = rows.length > 1 || orsSachetWasAssumed();
    return '<div class="sachet-resolve">'
      + '<p class="sachet-assumed">' + esc(tx("tx.ors.sachet.assumed", "ORS packets here usually make {amount}.", { amount: orsSachetAmountLabel() })) + "</p>"
      + (canCorrect
        ? '<div class="slidecontrols wrap-controls"><button class="ghost" id="orssachetchange" type="button">'
          + esc(tx("tx.ors.sachet.assumed_change", "My packet is different")) + "</button></div>"
        : "")
      + "</div>";
  }
  function bindOrsSachetChoices() {
    var change = $("orssachetchange");
    if (change && !change.dataset.bound) {
      change.dataset.bound = "sachet";
      change.addEventListener("click", function () {
        orsSachetId = "unknown";
        orsDeckContainerId = "";
        orsNeedsMeasureHelp = null;
        renderOrsDeckStepControls(activeSlides[slideIndex]);
      });
    }
    var choices = $("slidecache").querySelectorAll ? $("slidecache").querySelectorAll(".sachet-choice") : [];
    for (var i = 0; i < choices.length; i++) {
      if (choices[i].dataset.bound) continue;
      choices[i].dataset.bound = "sachet";
      choices[i].addEventListener("click", function () {
        orsSachetId = this.dataset.sachetId;
        // A different sachet volume can invalidate the chosen container, because a container is
        // offered only when a method matches the resolved volume exactly - and her answer about
        // measuring the old volume with it.
        orsDeckContainerId = "";
        orsNeedsMeasureHelp = null;
        renderOrsDeckStepControls(activeSlides[slideIndex]);
      });
    }
  }
  function bindOrsContainerChoices(advanceAfterChoice) {
    var choices = $("slidecache").querySelectorAll ? $("slidecache").querySelectorAll(".ors-container-choice") : [];
    for (var i = 0; i < choices.length; i++) choices[i].addEventListener("click", function () {
      orsDeckContainerId = this.dataset.containerId || "";
      if (advanceAfterChoice) {
        changeSlide(Math.min(activeSlides.length - 1, slideIndex + 1));
        return;
      }
      renderSlide();
    });
  }
  function updateOrsSlideNavigation(slide) {
    if (slide.featureId !== "ors_slideshow") return;
    var next = $("slidenext");
    if (!next) return;
    next.removeAttribute("data-next-care");
    if (slide.id === "can_measure") {
      // The two answers are the way forward; a bare Next would skip the question.
      next.disabled = orsNeedsMeasureHelp === null;
      next.textContent = orsNeedsMeasureHelp === null ? tx("tx.ors.deck.answer_first", "Answer to continue") : t("tx.shell.next");
      next.classList.toggle("ghost", next.disabled);
    } else if (slide.id === "choose_container") {
      next.disabled = !orsDeckContainerId;
      next.textContent = orsDeckContainerId ? t("tx.shell.next") : "Choose container first";
      next.classList.toggle("ghost", next.disabled);
    } else if (slide.id === "use_same_day") {
      next.disabled = false;
      // Same wording as the other zinc entry points: name what happens, not the feature.
      next.textContent = tx("tx.ors.open_zinc", "How to give zinc");
      next.classList.remove("ghost");
      next.setAttribute("data-next-care", "zinc-course");
    } else {
      next.disabled = false;
      next.textContent = t("tx.shell.next");
      next.classList.remove("ghost");
    }
  }
  function storyCardToSlides(card) {
    var frames = Array.isArray(card.frames) ? card.frames : [];
    var profile = currentMemoryProfile();
    return frames.map(function (frame) {
      var isObjectFrame = frame && typeof frame === "object";
      var slug = isObjectFrame ? frame.bodySlug : frame;
      return {
        titleSlug: card.titleSlug,
        headingSlug: isObjectFrame ? frame.headingSlug : null,
        bodySlug: slug,
        img: isObjectFrame ? (frame.imageDesc || card.imageDesc) : card.imageDesc,
        assetId: isObjectFrame && frame.assetIds ? frame.assetIds[profile] : null,
        reviewAssetId: isObjectFrame && frame.assetIds ? frame.assetIds.standard_8gb : null,
        exactAssetOnly: isObjectFrame,
        featureId: card.featureId
      };
    });
  }
  function quizSpecForFeature(featureId) {
    var specs = {
      hh_handwashing_story: {
        question: "After the handwashing story, what is the best next step before eating or feeding a child?",
        options: [
          { id: "soap", label: "Wash hands with soap and clean water", correct: true },
          { id: "wipe", label: "Wipe hands on clothing" },
          { id: "wait", label: "Wait until hands look dirty" }
        ],
        correctFeedback: "Correct. Soap and clean water before eating or feeding is the habit this story is practicing.",
        retryFeedback: "Try again. The story is checking the handwashing habit, not illness or diagnosis."
      },
      hh_safe_water_story: {
        question: "What should the family do before drinking water that may be unsafe?",
        options: [
          { id: "cover", label: "Store it uncovered" },
          { id: "treat", label: "Use the local approved treatment plan and a covered container", correct: true },
          { id: "guess", label: "Guess the chlorine amount" }
        ],
        correctFeedback: "Correct. The safe-water story points to local approved treatment and covered storage.",
        retryFeedback: "Try again. This quiz never gives a dose; it checks the safe-water habit only."
      },
      hh_dental_story: {
        question: "What does the toothbrushing story ask the child to practice?",
        options: [
          { id: "sugar", label: "Choose sweets before sleep" },
          { id: "brush", label: "Brush morning and night with adult help when needed", correct: true },
          { id: "pain", label: "Ignore tooth pain" }
        ],
        correctFeedback: "Correct. The story links to brushing practice and keeps tooth-pain concerns separate.",
        retryFeedback: "Try again. The quiz checks brushing practice, not dental treatment."
      },
      hh_cold_flu_story: {
        question: "What is the prevention habit in the cold and flu story?",
        options: [
          { id: "cough", label: "Cover coughs and wash hands", correct: true },
          { id: "share", label: "Share cups when sick" },
          { id: "hide", label: "Hide breathing trouble" }
        ],
        correctFeedback: "Correct. Cover coughs and wash hands; use the sick-child check separately if the child is unwell.",
        retryFeedback: "Try again. This quiz checks prevention habits and is not a danger-sign screen."
      }
    };
    return specs[featureId] || null;
  }
  function showQuizRunner(featureId) {
    var spec = quizSpecForFeature(featureId);
    var card = storyByFeature(featureId);
    if (!spec || !card) {
      showPrototypeCard(tx("tx.prototype.quiz_unavailable.title", "Quiz not available"), tx("tx.prototype.quiz_unavailable.body", "This story does not have a quick quiz in the current prototype. You can keep reading or choose another activity."), tx("tx.prototype.unavailable.visual", "This activity is not available in the current prototype build."), featureId, "QuizRunner has no education quiz configured for " + featureId);
      return;
    }
    activeSlides = [];
    showPanel("slideshow");
    $("slidetitle").textContent = "Quick quiz";
    $("slideimage").innerHTML = renderVisual(featureId, card.imageDesc);
    setSlideText(spec.question);
    $("slidecache").innerHTML =
      '<div class="slidecontrols quiz-controls" role="group" aria-label="Quick quiz answers">' +
      spec.options.map(function (option) {
        return '<button class="ghost quizanswer" id="quiz_' + esc(option.id) + '" type="button" data-correct="' + (option.correct ? "true" : "false") + '">' + esc(option.label) + "</button>";
      }).join("") +
      '</div><div class="progress-panel" id="quizstatus"><strong>QuizRunner</strong><div class="muted">Education-only comprehension check. This quiz creates no diagnosis, triage decision, eligibility decision, or health record.</div></div>' +
      traceDetails("Review details", "QuizRunner prototype over Player slideshow/form pattern. Not reachable from danger-sign routing. " + provenanceSummary(featureId) + contractSummary(featureId));
    spec.options.forEach(function (option) {
      var button = $("quiz_" + option.id);
      if (button && !button.dataset.bound) {
        button.dataset.bound = "quiz";
        button.addEventListener("click", function () {
          var status = $("quizstatus");
          var message = option.correct ? spec.correctFeedback : spec.retryFeedback;
          setSlideText(message);
          if (status) status.innerHTML = '<strong>QuizRunner</strong><div class="muted">' + esc(message) + "</div>";
        });
      }
    });
  }
  function runDeckAction(action) {
    if (!action || !action.launch) return;
    pushCurrentWorkView();
    if (action.launch === "tool.quiz_runner") {
      showQuizRunner(action.quizFeatureId);
      return;
    }
    if (action.launch === "triage.cough") {
      openColdFluSickChildCheck();
      return;
    }
    openLaunch(action.launch, t(action.labelSlug));
  }
  function renderStoryActions(featureId, reviewAssetId) {
    var host = $("slidestoryactions") || $("slidecache");
    var card = storyByFeature(featureId);
    var actions = card && Array.isArray(card.actions) ? card.actions : [];
    // Always clear first. The slot lives outside #slidecache now, so a screen without story
    // actions no longer inherits the previous story's buttons.
    if (host) host.innerHTML = "";
    if (!actions.length) return;
    var storySource = card && card.sourceName ? "source: " + card.sourceName + ". " : "";
    // Read-aloud is owned by the shell. A second story button duplicated the
    // same target and exposed two control families for one action.
    host.innerHTML = reviewerDetails(storySource + "Story actions are Player deck actions: quiz, timer, or related checklist. " + provenanceSummary(featureId) + assetSummary(featureId, reviewAssetId) + contractSummary(featureId)) + '<div class="slidecontrols">' + actions.map(function (action) {
      var cls = action.style === "ghost" ? ' class="ghost"' : "";
      return '<button' + cls + ' id="' + esc(action.id) + '" type="button">' + esc(t(action.labelSlug)) + "</button>";
    }).join("") + "</div>";
    actions.forEach(function (action) {
      var button = $(action.id);
      if (button && !button.dataset.bound) {
        button.dataset.bound = "deckaction";
        button.addEventListener("click", function () { runDeckAction(action); });
      }
    });
  }
  function showDeck(featureId) {
    var deck = deckByFeature(featureId);
    if (!deck) {
      showPrototypeCard(t("tx.feature_" + featureId), prototypeUnavailableBody(), tx("tx.prototype.unavailable.visual", "This activity is not available in the current prototype build."), featureId, "Missing deck for " + featureId);
      return;
    }
    // A fresh visit starts with the question unanswered; a remembered "yes" would skip the chooser on
    // a deck she has just reopened, with Next already lit (review 2026-09-02, finding 2).
    if (featureId === "ors_slideshow") { orsDeckContainerId = ""; orsNeedsMeasureHelp = null; }
    showSlides(deckToSlides(deck));
    if (featureId === "ors_slideshow" && $("slideshow") && $("slideshow").setAttribute) $("slideshow").setAttribute("data-screen-id", "support.ors_directions");
  }
  function prototypeUnavailableBody() {
    return tx("tx.prototype.unavailable.body", "This activity is not ready in the current prototype. Try another activity, or use the search box to find a related topic.");
  }
  function showPrototypeCard(title, body, img, featureId, reviewNote) {
    activeSlides = [];
    showPanel("slideshow");
    $("slidetitle").textContent = title;
    $("slideimage").innerHTML = renderVisual(featureId, img);
    setSlideText(body);
    $("slidecache").innerHTML = reviewerDetails("CODEX Decision - needs approval. Prototype content only." + (reviewNote ? " " + reviewNote + "." : "") + (featureId ? contractSummary(featureId) : ""));
  }
  function dentalTrackerPerson() {
    var person = activePersonId ? personById(activePersonId) : null;
    if (!person || person.subject !== "child_under5") person = defaultChildPerson();
    return person && person.subject === "child_under5" ? person : null;
  }
  function dentalTrackerKey() {
    var person = dentalTrackerPerson();
    return person ? person.id : "unassigned_child";
  }
  function dentalBrushesToday() {
    return dentalBrushesTodayByPerson[dentalTrackerKey()] || 0;
  }
  function recordDentalBrushing() {
    var key = dentalTrackerKey();
    dentalBrushesTodayByPerson[key] = Math.min(2, dentalBrushesToday() + 1);
  }
  function dentalProgressText() {
    var tracker = trackerByModule("dental_brushing") || {};
    var target = tracker.targetCount || 2;
    var complete = dentalBrushesToday();
    var remaining = Math.max(0, target - complete);
    // "brushing session" is programme wording, and "Daily prototype target reached" restated the
    // disclaimer the standard header already carries once (UI-STANDARDS 13a).
    return tx("tx.dental_brushing.today_progress", null, { done: complete, target: target }) + " " +
      (remaining ? tx("tx.dental_brushing.more_to_go", null, { left: remaining }) : tx("tx.dental_brushing.all_done_today"));
  }
  function dentalStarChart() {
    var tracker = trackerByModule("dental_brushing") || {};
    var target = tracker.targetCount || 2;
    var stars = [];
    var complete = dentalBrushesToday();
    for (var i = 0; i < target; i++) stars.push(i < complete ? "&#9733;" : "&#9734;");
    return stars.join(" ");
  }
  // David, 2026-08-25: "brush timer when 'Done brushing' Stars are tiny. make stars their own
  // screen and give them a back to home as default next action."
  //
  // Finishing a brush used to leave the caregiver on the coach screen, with the reward as a 20px
  // row wedged between the timer and six buttons. The stars are what a child looks for, so
  // finishing now replaces the controls with a screen whose largest element is the stars, and
  // whose default action is the way out rather than another go at the timer.
  function dentalProvenanceHtml() {
    return traceDetails("Review details", "Dental brushing coach. Review the bundled brushing tune source before field release. " + provenanceSummary("dental_brushing") + assetSummary("dental_brushing") + contractSummary("dental_brushing")) + trackerContractHtml("dental_brushing");
  }
  function dentalRewardHtml() {
    var tracker = trackerByModule("dental_brushing") || {};
    var target = tracker.targetCount || 2;
    var complete = dentalBrushesToday();
    var backHome = backHomeHtml().replace(' class="ghost"', "");
    return '<div class="reward-panel">'
      + '<span class="stars" role="img" aria-label="' + esc(tx("tx.dental.stars_earned", "{complete} of {target} stars today", { complete: complete, target: target })) + '">'
      + dentalStarChart() + '</span>'
      + '<p class="reward-note">' + esc(tx("tx.dental.reward_note", "Nice work. You finished that brush.")) + '</p>'
      + '<p class="muted">' + esc(dentalProgressText()) + '</p>'
      + '<div class="reward-actions">' + backHome
      + '<button class="ghost" id="dentalbrushagain" type="button">' + esc(tx("tx.dental.brush_again", "Back to the brushing timer")) + '</button>'
      + '</div></div>' + dentalProvenanceHtml();
  }
  function showDentalBrushingReward() {
    setSlideText(tx("tx.tool_dental_brushing.done", "Nice work. That is one brushing marked for today. Brush morning and night; an adult should help young children and make sure toothpaste is spat out."));
    $("slidecache").innerHTML = dentalRewardHtml();
    bindBackHome($("slidecache"));
    var again = $("dentalbrushagain");
    if (again && !again.dataset.bound) {
      again.dataset.bound = "dentalagain";
      again.addEventListener("click", function () {
        dentalZone = -1;
        setSlideText(tx("tx.tool_dental_brushing_body", "Brush for two minutes, morning and night."));
        renderDentalControls();
      });
    }
    moveToNextStep("slidecache");
  }
  // Which toothpaste amount applies, when the app can work it out for itself.
  function dentalBandFromPerson() {
    var person = activePersonId ? personById(activePersonId) : null;
    if (!person || person.subject !== "child_under5") return "";
    var months = completedAgeMonths(person.birthDate, new Date());
    if (months === null || months < 0) return "";
    return months < 36 ? "under3" : "from3";
  }
  function renderDentalControls() {
    // David, 2026-09-25: extend the zinc rule - "never two dose bands at once" - to any age-banded
    // amount. This card printed a rice grain and a pea side by side and left the caregiver to pick,
    // while the app already knew the child's age; u5_triage prints it on its first screen.
    //
    // Same shape as the zinc screen, with one difference that matters. Zinc fails closed to the
    // product label when the age is unknown, because a wrong zinc dose is a wrong dose. There is no
    // product label that gives a per-child toothpaste amount, so failing closed here would leave
    // her with nothing. She is asked the one question instead, and then sees one amount.
    var band = dentalBandFromPerson() || dentalAgeBand;
    var doseHtml;
    if (band === "under3") {
      doseHtml = '<div class="dosegrid" aria-label="Toothpaste amount">'
        + assetThumb("img.generated.rice_grain_toothpaste_v1", tx("tx.dental.dose_under3", "Under 3 years: a tiny smear, about the size of one grain of rice"))
        + "</div>";
    } else if (band === "from3") {
      doseHtml = '<div class="dosegrid" aria-label="Toothpaste amount">'
        + assetThumb("img.generated.pea_size_toothpaste_v1", tx("tx.dental.dose_3plus", "Age 3 and up: about the size of a pea"))
        + "</div>";
    } else {
      doseHtml = '<div class="slidecontrols" data-one-purpose-step="dental-age-band"><p>'
        + esc(tx("tx.dental.ask_age", "How old is the child you are brushing for?")) + "</p>"
        + '<button class="ghost" id="dentalbandunder3" type="button">' + esc(tx("tx.dental.band_under3", "Under 3 years")) + "</button>"
        + '<button class="ghost" id="dentalbandfrom3" type="button">' + esc(tx("tx.dental.band_from3", "3 years or older")) + "</button></div>";
    }
    doseHtml = doseHtml
      // External review mgilkey C2 and C3: the app never said to spit rather than swallow, which
      // matters most for the age group it is aimed at. The fluoride benefit is stated in the same
      // breath, because saying fluoride is good without saying spit it out reads as encouragement.
      + '<p class="dose-note">' + esc(tx("tx.dental.spit_not_swallow", "Fluoride toothpaste protects teeth.\nSpit it out at the end. Do not swallow it, and do not rinse with water.")) + '</p>';
    $("slidecache").innerHTML = doseHtml + timerPanelHtml("Toothbrush timer", "2:00", "Ready") + '<div class="progress-panel"><div class="progress-row"><span>' + esc(tx("tx.dental.stars_label", "Stars")) + '</span><span class="stars">' + dentalStarChart() + '</span></div><div class="muted">' + esc(dentalProgressText()) + '</div></div><div class="slidecontrols wrap-controls"><button id="dentalstart" type="button">' + esc(tx("tx.dental_brushing.start_brushing_timer")) + '</button><button class="ghost" id="dentalpause" type="button" disabled>' + esc(tx("tx.control.pause_timer", "Pause timer")) + '</button><button class="ghost" id="dentalreset" type="button">Reset timer</button><button class="ghost" id="dentalnext" type="button">' + esc(tx("tx.dental.next_area", "Next part of the mouth")) + '</button><button class="ghost" id="dentaldone" type="button">Done brushing</button><button class="ghost" id="dentaltune" type="button">' + esc(tx("tx.control.start_music", "Start music")) + '</button></div>' + dentalProvenanceHtml();
    [["dentalbandunder3", "under3"], ["dentalbandfrom3", "from3"]].forEach(function (choice) {
      var button = $(choice[0]);
      if (!button || button.dataset.bound) return;
      button.dataset.bound = "dental-band";
      button.addEventListener("click", function () { dentalAgeBand = choice[1]; renderDentalControls(); });
    });
    var start = $("dentalstart"), next = $("dentalnext"), done = $("dentaldone"), tune = $("dentaltune");
    if (start && !start.dataset.bound) { start.dataset.bound = "dental"; start.addEventListener("click", function () {
      if (uiTimer && uiTimer.startId === "dentalstart" && uiTimer.status === "paused") {
        pauseOrResumeUiCountdown();
        return;
      }
      dentalZone = 0;
      updateDentalZone();
      // Same test-time override the respiration timer takes, so a suite can drive the coach to its end
      // without waiting two real minutes - which it must now do, because Done needs the timer finished.
      var brushSeconds = (typeof window !== "undefined" && window.__MAMMA_BRUSH_TIMER_SECONDS) ? Number(window.__MAMMA_BRUSH_TIMER_SECONDS) : 120;
      if (!isFinite(brushSeconds) || brushSeconds <= 0) brushSeconds = 120;
      startUiCountdown("Brushing", brushSeconds, null, { startId: "dentalstart", pauseId: "dentalpause", resetId: "dentalreset", startText: "Start brushing timer", musicAssetId: "audio.prototype.toothbrushing_happy_ukulele", musicStatusId: "musicstatus", musicLoop: true, musicControlId: "dentaltune" });
      // The star belongs to the child whose timer this is. Switching person through the People door
      // does not cancel a running timer, so without this a finished timer could be spent on a
      // sibling who never brushed (review 2026-09-02, finding 2).
      if (uiTimer) uiTimer.personKey = dentalTrackerKey();
    }); }
    bindUiCountdownButton("dentalpause", pauseOrResumeUiCountdown);
    bindUiCountdownButton("dentalreset", resetUiCountdown);
    if (next && !next.dataset.bound) { next.dataset.bound = "dental"; next.addEventListener("click", function () { dentalZone = dentalZone < 0 ? 0 : (dentalZone + 1) % 4; updateDentalZone(); }); }
    if (done && !done.dataset.bound) { done.dataset.bound = "dental"; done.addEventListener("click", function () {
      // A star used to arrive on any press of Done, so two presses collected the whole day without a
      // toothbrush being picked up (external caregiver review 2026-08-17, NA-12). The credit is tied
      // to this timer instance running to its end for this child: Reset or a new Start clears it, and
      // a timer started for one child is refused for another.
      if (!(uiTimer && uiTimer.startId === "dentalstart" && uiTimer.status === "complete" && uiTimer.personKey === dentalTrackerKey())) {
        setSlideText(tx("tx.tool_dental_brushing.timer_first", "Run the two-minute timer all the way to the end to mark this brushing. Tap Start brushing timer, brush until it finishes, then tap Done brushing."));
        return;
      }
      cancelUiCountdown(); recordDentalBrushing(); dentalZone = -1; showDentalBrushingReward(); }); }
    if (tune && !tune.dataset.bound) { tune.dataset.bound = "dental"; tune.addEventListener("click", function () {
      var playing = togglePrototypeMusic("audio.prototype.toothbrushing_happy_ukulele", "musicstatus", true, { controlId: "dentaltune" });
      setSlideText(playing
        ? tx("tx.tool_dental_brushing.tune_placeholder", "Brushing music is playing. Keep brushing all the way around: outside, inside, chewing surfaces, and tongue. Spit out the toothpaste when you finish.")
        : tx("tx.tool_dental_brushing.music_paused", "Music paused. The brushing timer keeps running."));
    }); }
    syncPrototypeMusicControl("dentaltune", "audio.prototype.toothbrushing_happy_ukulele");
    updateUiTimerControls();
  }
  function updateDentalZone() {
    var zones = [
      "outside teeth - small circles along the front and cheek side",
      "inside teeth - gentle strokes along the tongue side",
      "chewing teeth - short back-and-forth strokes",
      "spit out - do not swallow toothpaste"
    ];
    var zone = Math.max(0, dentalZone);
    setSlideText(tx("tx.tool_dental_brushing.zone_step", "Step {step} of 4: brush the {zone}. Keep going until you finish all four zones.", { step: zone + 1, zone: zones[zone] }));
    renderDentalControls();
  }
  function showDentalBrushingCoach() {
    activeSlides = [];
    dentalZone = -1;
    showPanel("slideshow");
    $("slidetitle").textContent = t("tx.feature_dental_brushing");
    $("slideimage").innerHTML = renderVisual("dental_brushing", "Toothbrush with a rice-grain or pea-size amount of toothpaste, depending on age.");
    setSlideText(tx("tx.tool_dental_brushing_body", "Brush for two minutes, morning and night."));
    renderDentalControls();
  }
  function renderDentalTriageChecklist() {
    $("slidecache").innerHTML =
      renderClinicalChecklist("dental_triage.main") +
      reviewDetailsHtml("dental_triage", "Dental triage checklist. No antibiotics, pain medicines, extraction advice, or diagnosis.");
    var ids = bindClinicalChecklist("dental_triage.main").ids;
    var review = $("dentalreview");
    if (review && !review.dataset.bound) {
      review.dataset.bound = "dentaltriage";
      review.addEventListener("click", function () {
        // Read the questions that are asked now rather than the list captured when this handler was
        // bound. A deployment switch can change which questions exist between renders, and a
        // handler holding a stale list silently ignores the answers it does not know about.
        var checked = clinicalChecklistOptionIds(clinicalScreen("dental_triage.main")).filter(function (id) { return !!($(id) && $(id).checked); });
        if (!checked.length) return;
        var decision = screenDecision("dental_triage", checked);
        var names = {
          dentalbreathing: "breathing or swallowing trouble",
          dentalswelling: "swelling",
          dentalfever: "fever",
          dentalinjury: "injury",
          dentalpain: "severe tooth pain",
          dentalbleeding: "bleeding",
          dentalother: "other tooth or mouth concern",
          dentalnone: "none of these"
        };
        var selectedNames = checked.map(function (id) { return names[id]; }).join(", ") || "no urgent sign selected";
        if (decision.severity === "emergency") {
          setSlideResult({
            kind: "refer",
            careRoute: "dental_or_clinic",
            severity: decision.severity,
            title: t("tx.feature_dental_triage"),
            paragraphs: [tx("tx.dental_triage.emergency", "Seek urgent medical/dental care now for breathing or swallowing trouble with mouth, jaw, or tooth symptoms. Do not wait for a dental appointment.")]
          });
        } else if (decision.severity === "routine_clinic" && ($("dentalswelling").checked || $("dentalfever").checked || $("dentalinjury").checked || $("dentalbleeding").checked)) {
          setSlideResult({
            kind: "refer",
            careRoute: "dental_or_clinic",
            severity: decision.severity,
            title: t("tx.feature_dental_triage"),
            paragraphs: [tx("tx.dental_triage.same_day", "Arrange same-day dental or clinic care for {selectedSigns}. Dental infection or injury can worsen and needs local professional review.", { selectedSigns: selectedNames })]
          });
        } else if (decision.severity === "routine_clinic" && $("dentalpain").checked) {
          setSlideResult({
            kind: "refer",
            careRoute: "dental_or_clinic",
            severity: decision.severity,
            title: t("tx.feature_dental_triage"),
            paragraphs: [tx("tx.dental_triage.pain", "Call a dentist, clinic, or health worker soon for bad or worsening tooth pain.\nCall sooner if the pain stops the child eating, sleeping, or going to school.\nSeek care today if swelling, fever, injury, or bleeding appears.")]
          });
        } else if ($("dentalother").checked) {
          setSlideResult({
            kind: "refer",
            careRoute: "professional",
            severity: "routine_clinic",
            title: tx("tx.dental_triage.other_title", "Other tooth or mouth concern"),
            paragraphs: [friendlyOtherMessage()]
          });
        } else {
          setSlideResult({
            kind: "home",
            careRoute: "home_watch",
            title: t("tx.feature_dental_triage"),
            paragraphs: [tx("tx.dental_triage.no_urgent", "No urgent dental sign selected.\nKeep the brushing guidance where you can see it.\nAvoid sugary snacks and drinks when you can.\nAsk a dentist or health worker if pain, swelling, injury, fever, or bleeding starts.")]
          });
        }
        finishClinicalChecklistResult({
          againId: "dentalcheckagain",
          againLabel: tx("tx.dental_triage.check_again", "Check tooth or mouth signs again"),
          featureId: "dental_triage",
          decision: decision,
          bodyText: tx("tx.dental_triage_intro", "Check tooth pain, swelling, fever, bleeding, or mouth injury."),
          render: renderDentalTriageChecklist
        });
      });
    }
  }
  function showDentalTriageChecklist() {
    activeSlides = [];
    showPanel("slideshow");
    $("slidetitle").textContent = t("tx.feature_dental_triage");
    $("slideimage").innerHTML = renderVisual("dental_triage", "Child holding cheek; separate small icons for swelling, injury, fever, severe pain, and breathing trouble.");
    setSlideText(tx("tx.dental_triage_intro", "Check tooth pain, swelling, fever, bleeding, or mouth injury."));
    renderDentalTriageChecklist();
  }
  function renderZincTracker() {
    $("slidetitle").textContent = t("tx.feature_zinc_tracker");
    $("slideimage").classList.add("hidden");
    if ($("slideshow") && $("slideshow").setAttribute) $("slideshow").setAttribute("data-screen-id", "support.zinc_course");
    if (zincView === 0) {
      setSlideText(tx("tx.zinc_tracker.step_1_of_4_check"));
      $("slidecache").innerHTML = '<div data-one-purpose-step="zinc-prepare">' + zincMixingGuideHtml() + '<div class="slidecontrols"><button id="zincnextgive" type="button">' + esc(tx("tx.zinc_tracker.next_give_zinc")) + '</button></div></div>' + reviewDetailsHtml("zinc_tracker", "Zinc preparation. The selected child age controls the one visible dose band; unknown age requires product-label or health-worker confirmation.");
      var nextGive = $("zincnextgive");
      if (nextGive) nextGive.addEventListener("click", function () { showZincTrackerStep(1, true); });
      return;
    }
    if (zincView === 1) {
      setSlideText("Step 2 of 4: Give the prepared zinc.");
      $("slidecache").innerHTML = '<div data-one-purpose-step="zinc-give">' + zincGivingGuideHtml() + '<div class="slidecontrols"><button id="zincnextcalendar" type="button">Next: mark zinc days</button></div></div>';
      var nextCalendar = $("zincnextcalendar");
      if (nextCalendar) nextCalendar.addEventListener("click", function () { showZincTrackerStep(2, true); });
      return;
    }
    if (zincView === 2) {
      // No configured course length means there is nothing to mark. Rendering an empty checklist
      // under a "Save zinc days" button would be a claimed action with no control behind it
      // (AGENTS.md review guardrail), so the step states the situation and offers the way forward.
      if (!zincCourseConfigured()) {
        setSlideText(tx("tx.zinc.course.not_set", null));
        $("slidecache").innerHTML = '<div data-one-purpose-step="zinc-calendar">' + zincNoCourseHtml()
          + '<div class="slidecontrols"><button id="zincnextreminder" type="button">'
          + esc(tx("tx.zinc_tracker.next_reminder", "Next: reminder")) + '</button></div></div>';
        var skipToReminder = $("zincnextreminder");
        if (skipToReminder) skipToReminder.addEventListener("click", function () { showZincTrackerStep(3, true); });
        return;
      }
      var dayControls = "";
      for (var i = 1; i <= zincCourseDays(); i++) dayControls += '<label><input id="zincday' + i + '" type="checkbox"' + (zincMarks()[i] ? " checked" : "") + '> Day ' + i + '</label>';
      setSlideText(zincStatusMessage || "Step 3 of 4: Mark each day after giving zinc.");
      $("slidecache").innerHTML = '<div data-one-purpose-step="zinc-calendar"><div class="progress-panel"><strong>' + esc(tx("tx.zinc.calendar.title", null, { days: zincCourseDays() })) + '</strong><p>' + esc(tx("tx.zinc.calendar.body", "Mark each day after you give the zinc dose. Do not stop early unless a clinician or local product instruction says to.")) + '</p></div><div class="slidecontrols checklist-controls" data-multiselect-instruction="false">' + dayControls + '<button id="zincsave" type="button">' + esc(zincDaysSaved ? tx("tx.zinc.calendar.saved", "Zinc days saved") : tx("tx.zinc.calendar.save", "Save zinc days")) + '</button><button id="zincnextreminder" type="button">' + esc(tx("tx.zinc_tracker.next_reminder", "Next: reminder")) + '</button></div></div>';
      for (var d = 1; d <= zincCourseDays(); d++) {
        var box = $("zincday" + d);
        if (box) box.addEventListener("change", (function (day) {
          return function () {
            zincMarks()[day] = !!$("zincday" + day).checked;
            renderTodayReminders();
            // A changed day is unsaved again; the button must stop saying otherwise.
            if (zincDaysSaved) { zincDaysSaved = false; renderZincTracker(); }
          };
        })(d));
      }
      var save = $("zincsave"), nextReminder = $("zincnextreminder");
      if (save) save.addEventListener("click", function () {
        var count = 0;
        for (var day = 1; day <= zincCourseDays(); day++) {
          zincMarks()[day] = !!$("zincday" + day).checked;
          if (zincMarks()[day]) count++;
        }
        // ADR-027 / decision B-8: there is no persistence, so "Saved" was a false claim. State what
        // the app actually does - the marks live for this session only.
        zincStatusMessage = tx("tx.zinc.calendar.marked_session", null, { count: count, days: zincCourseDays() });
        // The confirmation used to be written into #slidetext, above ten checkboxes - so a
        // caregiver tapping Save at the bottom of the list saw nothing move. David, 2026-08-24:
        // "Save zinc days button does nothing visible. it should turn blank and become 'zinc days
        // saved' or something." The button now answers where the tap happened, and goes live again
        // the moment a day is changed, so it never claims to have saved a later edit.
        zincDaysSaved = true;
        renderZincTracker();
        moveToNextStep("slidecache");
      });
      if (nextReminder) nextReminder.addEventListener("click", function () { showZincTrackerStep(3, true); });
      return;
    }
    // A reminder for a course of no stated length is not a reminder. Without this the button read
    // "Start 0-day reminder", scheduled FREQ=DAILY;COUNT=0 - which the nudge coordinator accepts
    // silently, since it never parses COUNT - and then claimed "Mamma saved your 0-day zinc
    // reminder" on a surface that had saved a schedule with no occurrences.
    if (!zincCourseConfigured()) {
      setSlideText(tx("tx.zinc.course.not_set", null));
      $("slidecache").innerHTML = '<div data-one-purpose-step="zinc-reminder">' + zincNoCourseHtml()
        + '<div class="slidecontrols"><button class="ghost" id="zinchelp" type="button">'
        + esc(tx("tx.control.worse_now", "Child is getting worse")) + '</button></div></div>'
        + reviewDetailsHtml("zinc_tracker", "Zinc course reminder. No course length is configured, so no reminder is offered.")
        + trackerContractHtml("zinc_tracker");
      var helpOnly = $("zinchelp");
      if (helpOnly && !helpOnly.dataset.bound) {
        helpOnly.dataset.bound = "zinc";
        helpOnly.addEventListener("click", function () {
          setSlideText(tx("tx.tool_zinc_tracker.urgent", "Get urgent care now if you see any of these:\n- Blood in the stool.\n- The child cannot drink or breastfeed.\n- The child vomits again and again.\n- The child is very sleepy or hard to wake.\n- The child has lost a lot of water.\n- The child has fever.\n- The child is getting worse.\nStart ORS if the child can drink."));
        });
      }
      return;
    }
    setSlideText("Step 4 of 4: Start an in-app reminder if useful.");
    $("slidecache").innerHTML = '<div data-one-purpose-step="zinc-reminder">' + nudgeStatusPanelHtml("zincnudgestatus") + '<div class="slidecontrols"><button id="zincstartreminder" type="button">' + esc(tx("tx.zinc.reminder.start_button", null, { days: zincCourseDays() })) + '</button><button class="ghost" id="zinchelp" type="button">' + esc(tx("tx.control.worse_now", "Child is getting worse")) + '</button></div></div>' + reviewDetailsHtml("zinc_tracker", "Zinc course reminder. The reminder stays in this app and follows quiet hours.") + trackerContractHtml("zinc_tracker");
    var startReminder = $("zincstartreminder"), help = $("zinchelp");
    if (startReminder && !startReminder.dataset.bound) {
      startReminder.dataset.bound = "zinc";
      startReminder.addEventListener("click", function () {
        setSlideText(tx("tx.zinc.reminder.starting", null, { days: zincCourseDays() }));
        setNudgeStatus("zincnudgestatus", tx("tx.reminder.saving", "Saving your reminder..."), tx("tx.reminder.saving_detail", "Mamma is applying your reminder and quiet-hours settings."));
        if ($("zincnudgestatus") && $("zincnudgestatus").setAttribute) $("zincnudgestatus").setAttribute("data-screen-id", "support.zinc_reminder");
        requestInAppReminder({
          moduleId: "zinc_tracker",
          topic: "zinc_course",
          dateValue: localDateValue(new Date()),
          privacyClass: "sensitive_topic",
          // The recurrence is the course, so it comes from the same resolved number the screen
          // shows. A literal here would have scheduled ten days under a heading that said fourteen.
          recurrence: { rrule: "FREQ=DAILY;COUNT=" + zincCourseDays() }
        }).then(function (decision) {
          if (decision.action === "scheduled" || decision.action === "bundled") {
            setNudgeStatus("zincnudgestatus", tx("tx.zinc.reminder.started", null, { days: zincCourseDays() }), tx("tx.zinc.reminder.detail", "Mamma now shows it on Home and follows your quiet-hours settings. Keep this app open when you need to see it."));
            setSlideText(tx("tx.zinc.reminder.screen_status", "Mamma now shows your zinc reminder on Home. Keep giving ORS until diarrhoea stops, and use urgent danger signs instead of waiting for a reminder."));
          } else {
            setNudgeStatus("zincnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), tx("tx.reminder.try_again", "Try again, or keep the zinc calendar where you can see it."));
          }
        }).catch(function (error) {
          setNudgeStatus("zincnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), error && error.message ? error.message : tx("tx.reminder.unavailable", "The in-app reminder is unavailable. Please try again."));
        });
      });
    }
    if (help && !help.dataset.bound) {
      help.dataset.bound = "zinc";
      help.addEventListener("click", function () {
        setSlideText(tx("tx.tool_zinc_tracker.urgent", "Get urgent care now if you see any of these:\n- Blood in the stool.\n- The child cannot drink or breastfeed.\n- The child vomits again and again.\n- The child is very sleepy or hard to wake.\n- The child has lost a lot of water.\n- The child has fever.\n- The child is getting worse.\nStart ORS if the child can drink."));
      });
    }
  }
  function showZincTrackerStep(step, rememberPrevious) {
    var previous = zincView;
    if (rememberPrevious) pushWorkBackStep(function () {
      zincView = previous;
      renderZincTracker();
      applyShellVisibility();
      moveToNextStep("slidecache");
    });
    zincView = step;
    renderZincTracker();
    applyShellVisibility();
    moveToNextStep("slidecache");
  }
  function showZincTracker() {
    activeSlides = [];
    showPanel("slideshow");
    zincView = 0;
    zincStatusMessage = "";
    zincDaysSaved = false;
    renderZincTracker();
  }
  // The Womb with a View comic series, paced by the deployment's chosen cadence.
  // David, 2026-08-20: "one comic / month or per ANC visit."
  function ancComicState() {
    var schedule = engine.ancComicSchedule;
    if (!schedule || !engine.comicSeriesState || !engine.gestationWeeks) return null;
    var mother = personById("demo_pregnancy");
    var fullTerm = Number(engine.gd && engine.gd.get ? engine.gd.get("anc.gestation_weeks_full_term") : 0);
    var contactWeeks = engine.gd && engine.gd.get ? engine.gd.get("anc.contact_weeks") : null;
    var weeks = mother && mother.dueDate && fullTerm > 0
      ? engine.gestationWeeks(mother.dueDate, new Date(), fullTerm)
      : null;
    var state = engine.comicSeriesState({
      comics: schedule.comics || [],
      cadence: deployerSwitch("ancComicCadence"),
      weeks: weeks,
      contactWeeks: contactWeeks
    });
    state.weeks = weeks;
    state.pastTerm = weeks !== null && fullTerm > 0 && weeks > fullTerm;
    return state;
  }
  function renderAncComicSeries() {
    var state = ancComicState();
    if (!state || !state.comics.length) return "";
    var comic = state.current || state.next;
    if (!comic) return "";
    var story = storyByFeature(comic.featureId);
    if (!story) return "";
    var title = t(story.titleSlug) || "Womb with a View";
    // This screen is a checklist that already sits near the 99-word limit, so the comic offer is
    // three short lines and no more. Anything longer here is words spent describing a feature
    // instead of telling the caregiver what to do next.
    var lead = state.current
      ? tx("tx.anc_comic.ready", "Your comic this visit")
      : tx("tx.anc_comic.later", "Next visit brings your first comic");
    // Say when the series runs out rather than implying another is coming.
    var tail = state.allUnlocked && !state.next
      ? '<p class="muted">' + esc(tx("tx.anc_comic.series_end", "Last one for now.")) + "</p>"
      : "";
    var termNote = state.pastTerm
      ? '<p class="muted">' + esc(tx("tx.anc_comic.past_term", "This practice due date has passed.")) + "</p>"
      : "";
    return '<div class="result-card anc-comic"><strong>' + esc(lead) + "</strong>"
      + "<p>" + esc(title) + "</p>"
      + (state.current ? '<button class="ghost" id="anccomicopen" type="button">' + esc(tx("tx.anc_comic.open", "Read it")) + "</button>" : "")
      + tail + termNote + "</div>";
  }
  function bindAncComicSeries() {
    var open = $("anccomicopen");
    if (!open || open.dataset.bound) return;
    open.dataset.bound = "anccomic";
    open.addEventListener("click", function () {
      // Recompute rather than capture: the cadence switch can change between render and click.
      var state = ancComicState();
      var comic = state && state.current;
      if (!comic) return;
      openLaunch("story." + comic.featureId, tx("tx.anc_comic.title", "Womb with a View"));
    });
  }
  // The birth plan used to be nine noun fragments under five headings. David read it on 2026-09-25
  // and found nine defects on the one card: two instructions saying the same thing, "visit dates"
  // named on a screen that has none, and rows like "Documents" and "Reviewed" that name a subject
  // without asking a question. His instruction was to stop patching it and build the thing it was
  // pretending to be - "I want users to write a birth plan. A space for contact person, etc. So it
  // should be many screens and store data to show the family when labor begins."
  //
  // So it is an authoring tool now. Five screens, one topic each, every line a sentence that stands
  // alone, and a last screen a family can read out loud when labor begins.
  //
  // The delivery-kit checklist asked six of these same questions - of the same caregiver, about the
  // same birth - in properly self-contained sentences. It is merged in here (David, 2026-09-25:
  // "merge") and its sentences are the ones that survived; they were always the better-written half
  // of the duplicate. External review mgilkey C11 had asked for grouping and for bednet and
  // micronutrient rows. The grouping is superseded by these screens. The two wellbeing rows are
  // gone because David ruled on the same reading: "Are these delivery supplies? If not, they do not
  // go here." The bednet keeps its own feature; the tablets belong with antenatal care.
  //
  // The contact name and phone fields are the first free-text identity fields in this app. They
  // exist because ADR-051 relaxed invariant 6 for the prototype phase. Nothing persists - the
  // sandbox has no Store (ADR-027) - so the plan is held in module state and is gone when the app
  // closes, and the screens say so instead of implying a safety they do not have.
  function birthPlanScreens() {
    return [
      {
        key: "place",
        bodySlug: "tx.anc_plan.step_place", bodyFallback: "Write the health centre or hospital where you plan to give birth.",
        fields: [
          ["ancplace", "tx.anc_plan.field_place", "Health centre or hospital", "text"],
          ["ancworker", "tx.anc_plan.field_worker", "Health worker you see there", "text"]
        ],
        boxes: [],
        nextSlug: "tx.anc_plan.next_journey", nextFallback: "Next: how you will get there"
      },
      {
        key: "journey",
        bodySlug: "tx.anc_plan.step_journey", bodyFallback: "Write how you will travel when labor begins, and what the journey will cost.",
        fields: [
          ["anctransportplan", "tx.anc_plan.field_transport", "How you will travel", "text"],
          ["anctransportcost", "tx.anc_plan.field_cost", "What the journey will cost", "text"]
        ],
        boxes: [],
        nextSlug: "tx.anc_plan.next_helpers", nextFallback: "Next: who will help you"
      },
      {
        key: "helpers",
        bodySlug: "tx.anc_plan.step_helpers", bodyFallback: "Write the two people your family should call when labor begins.",
        fields: [
          ["ancsupportname", "tx.anc_plan.field_support_name", "Name of the person who will stay with you", "text"],
          ["ancsupportphone", "tx.anc_plan.field_support_phone", "Their phone number", "tel"],
          ["ancemergencyname", "tx.anc_plan.field_emergency_name", "Name of the person to call in an emergency", "text"],
          ["ancemergencyphone", "tx.anc_plan.field_emergency_phone", "Their phone number", "tel"]
        ],
        boxes: [],
        // A privacy claim makes two promises and both are kept whole. The app has no store, so the
        // first is literally true; the device is assumed shared (invariant 5), so the second is the
        // one a caregiver would otherwise have to guess at.
        noteSlug: "tx.anc_plan.helpers_privacy",
        noteFallback: "These names stay in this app on this phone. They disappear when you close the app. Anyone using this phone can read them.",
        nextSlug: "tx.anc_plan.next_pack", nextFallback: "Next: what to pack"
      },
      {
        key: "pack",
        bodySlug: "tx.anc_plan.step_pack", bodyFallback: "Tick what you have already packed and set aside.",
        fields: [],
        boxes: [
          ["ancpackdocs", "tx.anc_plan.box_documents", "I packed my identity card, my pregnancy record, and the money set aside for the journey."],
          ["ancpackcloths", "tx.anc_plan.box_cloths", "I packed clean cloths and a wrap to keep the baby warm."]
        ],
        nextSlug: "tx.anc_plan.next_danger", nextFallback: "Next: danger signs"
      },
      {
        key: "danger",
        bodySlug: "tx.anc_plan.step_danger", bodyFallback: "Read the pregnancy danger signs, then save your plan.",
        fields: [],
        boxes: [
          ["ancdangerplan", "tx.anc_plan.box_danger", "I have read the pregnancy danger signs and I know to go for care straight away."]
        ],
        // David: "Reviewed XX link to list of danger signs." A screen that asks whether she read a
        // list, without showing her the list, is asking her to remember rather than to read.
        linkId: "ancdangerlist", linkSlug: "tx.anc_plan.open_danger_signs", linkFallback: "See the pregnancy danger signs",
        linkLaunch: "screen.anc_triage"
      }
    ];
  }
  function birthPlanValue(id) { return String(birthPlanFields[id] || "").trim(); }
  function birthPlanCaptureScreen(screen) {
    (screen.fields || []).forEach(function (field) {
      var input = $(field[0]);
      if (input) birthPlanFields[field[0]] = input.value;
    });
  }
  function renderAncBirthPlanChecklist() {
    var screens = birthPlanScreens();
    if (birthPlanStep >= screens.length) birthPlanStep = screens.length - 1;
    if (birthPlanStep < 0) birthPlanStep = 0;
    var screen = screens[birthPlanStep];
    var finalScreen = birthPlanStep === screens.length - 1;
    var nextId = finalScreen ? "ancsave" : "ancnext" + (birthPlanStep + 1);
    setSlideText(tx("tx.anc_plan.step_progress", "Step {part} of {total}. {instruction}", {
      part: birthPlanStep + 1, total: screens.length, instruction: tx(screen.bodySlug, screen.bodyFallback)
    }));
    var inner = (screen.fields || []).map(function (field) {
      return '<label class="plan-field">' + esc(tx(field[1], field[2]))
        + ' <input id="' + esc(field[0]) + '" type="' + esc(field[3]) + '"'
        + (field[3] === "tel" ? ' inputmode="tel"' : "")
        + ' autocomplete="off" maxlength="60" value="' + esc(birthPlanValue(field[0])) + '"></label>';
    }).join("");
    var boxIds = [];
    inner += (screen.boxes || []).map(function (box) {
      boxIds.push(box[0]);
      return checklistBoxHtml("anc", box[0], esc(tx(box[1], box[2])));
    }).join("");
    if (screen.linkId) {
      inner += '<button class="ghost" id="' + esc(screen.linkId) + '" type="button">' + esc(tx(screen.linkSlug, screen.linkFallback)) + "</button>";
    }
    if (screen.noteSlug) inner += '<p class="muted">' + esc(tx(screen.noteSlug, screen.noteFallback)) + "</p>";
    var nextLabel = finalScreen ? tx("tx.anc_plan.save_plan", "Save my birth plan") : tx(screen.nextSlug, screen.nextFallback);
    $("slidecache").innerHTML = '<div class="slidecontrols checklist-controls" data-one-purpose-step="birth-plan-' + esc(screen.key) + '" data-multiselect-instruction="false">'
      + inner + '<button id="' + esc(nextId) + '" type="button">' + esc(nextLabel) + "</button></div>"
      + (finalScreen ? renderAncComicSeries() : "")
      + trackerReviewDetailsHtml("anc_birth_plan", "anc_birth_plan", "Birth plan authoring screens. Preparedness only; no facility routing and no local visit schedule.");
    bindChecklistBoxes("anc", boxIds);
    if (finalScreen) bindAncComicSeries();
    (screen.fields || []).forEach(function (field) {
      var input = $(field[0]);
      if (!input || input.dataset.bound) return;
      input.dataset.bound = "birth-plan";
      input.addEventListener("input", function () { birthPlanFields[field[0]] = input.value; });
    });
    var link = screen.linkId ? $(screen.linkId) : null;
    if (link && !link.dataset.bound) {
      link.dataset.bound = "birth-plan";
      link.addEventListener("click", function () { openLaunch(screen.linkLaunch, t("tx.feature_anc_triage")); });
    }
    var next = $(nextId);
    if (!next || next.dataset.bound) return;
    next.dataset.bound = "birth-plan";
    if (!finalScreen) {
      next.addEventListener("click", function () {
        birthPlanCaptureScreen(screen);
        var previous = birthPlanStep;
        pushWorkBackStep(function () {
          birthPlanStep = previous;
          renderAncBirthPlanChecklist();
          applyShellVisibility();
          moveToNextStep("slidecache");
        });
        birthPlanStep++;
        renderAncBirthPlanChecklist();
        moveToNextStep("slidecache");
      });
      return;
    }
    next.addEventListener("click", function () {
      birthPlanCaptureScreen(screen);
      showAncBirthPlanResult();
    });
  }
  function birthPlanLine(labelSlug, labelFallback, value) {
    return esc(tx(labelSlug, labelFallback)) + " " + esc(value || tx("tx.anc_plan.not_written", "not written yet"));
  }
  function birthPlanContact(nameId, phoneId) {
    var name = birthPlanValue(nameId), phone = birthPlanValue(phoneId);
    if (!name && !phone) return tx("tx.anc_plan.not_written", "not written yet");
    return [name, phone].filter(Boolean).join(" ");
  }
  function showAncBirthPlanResult() {
    // The plan a family reads when labor begins. It says what was written rather than counting how
    // many boxes were ticked, and the two people to call come first because that is what someone
    // standing in the room needs.
    //
    // Budget note: the submitted-result audit caps this whole panel at 99 visible words, and it
    // measures a plan with every field empty - so it cannot see the version a caregiver actually
    // produces. Six filled fields cost roughly nine words more than the "not written yet" the audit
    // reads. Every word the app spends on itself here is a word her own plan cannot have, which is
    // why the guidance and the privacy line are as short as they can be while keeping both halves
    // of the privacy claim. A long enough entry in all four text fields will still exceed the cap;
    // that tension is a finding for David, not something to fix by shortening what she wrote.
    var marks = checklistMarks("anc");
    var packed = [];
    if (marks.ancpackdocs) packed.push(tx("tx.anc_plan.packed_documents", "papers and money"));
    if (marks.ancpackcloths) packed.push(tx("tx.anc_plan.packed_cloths", "cloths and a wrap"));
    showSubmittedChecklistResult({
      ids: ["ancpackdocs", "ancpackcloths", "ancdangerplan"],
      names: { ancpackdocs: "papers and money", ancpackcloths: "cloths and a wrap", ancdangerplan: "danger signs" },
      title: "Your birth plan",
      nextAction: tx("tx.anc_plan.result_next", "Show this to whoever is with you when labor begins. If a danger sign appears, go now."),
      paragraphs: [
        birthPlanLine("tx.anc_plan.result_call", "Call first:", birthPlanContact("ancsupportname", "ancsupportphone")),
        birthPlanLine("tx.anc_plan.result_emergency", "Emergency:", birthPlanContact("ancemergencyname", "ancemergencyphone")),
        birthPlanLine("tx.anc_plan.result_place", "Birth place:", [birthPlanValue("ancplace"), birthPlanValue("ancworker")].filter(Boolean).join(", ")),
        birthPlanLine("tx.anc_plan.result_journey", "Getting there:", [birthPlanValue("anctransportplan"), birthPlanValue("anctransportcost")].filter(Boolean).join(", ")),
        birthPlanLine("tx.anc_plan.result_packed", "Packed:", packed.join(", ")),
        tx("tx.anc_plan.result_privacy", "This plan disappears when you close the app. Anyone using this phone can read it.")
      ],
      againId: "ancreviewagain", againLabel: tx("tx.anc_plan.change_plan", "Change my birth plan"),
      extraControlsHtml: '<button class="ghost" id="ancreminder" type="button">' + esc(tx("tx.anc_plan.remind_evening", "Remind me this evening to check my plan")) + '</button><div id="ancnudgestatus" hidden></div>',
      featureId: "anc_birth_plan", reviewText: trackerContractText("anc_birth_plan") + " Saved birth plan. Preparedness only; no facility routing.",
      render: function () { birthPlanStep = 0; renderAncBirthPlanChecklist(); },
      after: bindAncBirthPlanReminder
    });
  }
  function bindAncBirthPlanReminder() {
    var reminder = $("ancreminder");
    if (!reminder || reminder.dataset.bound) return;
    reminder.dataset.bound = "anc";
    reminder.addEventListener("click", function () {
      setNudgeStatus("ancnudgestatus", tx("tx.reminder.saving", "Saving your reminder..."), tx("tx.reminder.saving_detail", "Mamma is applying your reminder and quiet-hours settings."));
      requestInAppReminder({ moduleId: "anc_birth_plan", topic: "birth_plan", dateValue: localDateValue(new Date()), privacyClass: "sensitive_topic" }).then(function (decision) {
        if (decision.action === "scheduled" || decision.action === "bundled") {
          setNudgeStatus("ancnudgestatus", tx("tx.reminder.saved", "Mamma saved your reminder."), tx("tx.reminder.home_detail", "Mamma now shows it on Home and follows your quiet-hours settings. Keep this app open when you need to see it."));
        } else setNudgeStatus("ancnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), tx("tx.reminder.try_again", "Try again, or ask a trusted person to remind you."));
      }).catch(function (error) {
        setNudgeStatus("ancnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), error && error.message ? error.message : tx("tx.reminder.unavailable", "The in-app reminder is unavailable. Please try again."));
      });
    });
  }
  function showAncBirthPlanChecklist() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("anc_birth_plan");
    $("slidetitle").textContent = t("tx.feature_anc_birth_plan");
    $("slideimage").innerHTML = renderVisual("anc_birth_plan", card ? card.imageDesc : "Pregnant person writing a birth plan with contacts and transport.");
    birthPlanStep = 0;
    renderAncBirthPlanChecklist();
  }
  function kmcProgressText() {
    return tx("tx.kmc_timer.today_minutes", null, { minutes: kmcMinutesToday });
  }
  function kmcElapsedSeconds() {
    if (!kmcActive || !uiTimer || uiTimer.mode !== "elapsed" || uiTimer.label !== "Kangaroo care") return 0;
    return Math.max(0, uiTimer.elapsed || 0);
  }
  function kmcTimerText() {
    if (!kmcActive) {
      return kmcMinutesToday ? "Timer stopped. " + kmcProgressText() : "Timer idle. Tap Start when the baby is safely skin-to-skin.";
    }
    var seconds = kmcElapsedSeconds();
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    return "Kangaroo care timer running: " + minutes + "m " + (remainder < 10 ? "0" : "") + remainder + "s. Keep the baby warm, visible, and safely positioned.";
  }
  function renderKmcTimer() {
    $("slidecache").innerHTML = timerPanelHtml("Kangaroo care timer", "0:00", kmcTimerText(), { includeMusic: false, ariaLabel: "Kangaroo care elapsed time toward one hour" }) + '<div class="progress-panel"><div class="progress-row"><span>' + esc(kmcProgressText()) + '</span></div><div class="muted">Keep this screen open while timing; phone alerts may not work if the phone sleeps.</div></div><div class="slidecontrols wrap-controls"><button id="kmcstart" type="button"' + (kmcActive ? " disabled" : "") + '>Start session</button><button class="ghost" id="kmcstop" type="button"' + (!kmcActive ? " disabled" : "") + '>Stop and record</button><button class="ghost" id="kmcadd" type="button">Add 15 minutes</button><button class="ghost" id="kmchelp" type="button">' + esc(tx("tx.control.worse_now", "Child is getting worse")) + '</button></div>' + traceDetails("Review details", "KMC session timer. Supportive only; newborn danger signs and health-worker guidance override. CODEX Decision - needs approval. " + provenanceSummary("kmc_timer") + assetSummary("kmc_timer") + contractSummary("kmc_timer")) + trackerContractHtml("kmc_timer");
    updateUiTimerControls();
    var start = $("kmcstart"), stop = $("kmcstop"), add = $("kmcadd"), help = $("kmchelp");
    if (start && !start.dataset.bound) {
      start.dataset.bound = "kmc";
      start.addEventListener("click", function () {
        kmcActive = true;
        startUiElapsedTimer("Kangaroo care", 3600, { startId: "kmcstart", startText: "Start session", idleCaption: "Tap Start when the baby is safely skin-to-skin.", runningCaption: "Elapsed skin-to-skin time. Stop when the session ends." });
        setSlideText(tx("tx.tool_kmc_timer.started", "Session started. A visible foreground timer is running. Keep the baby skin-to-skin as advised by a health worker, support feeding, and keep the baby warm and safely positioned."));
        renderKmcTimer();
      });
    }
    if (stop && !stop.dataset.bound) {
      stop.dataset.bound = "kmc";
      stop.addEventListener("click", function () {
        var recorded = Math.max(1, Math.ceil(kmcElapsedSeconds() / 60));
        kmcMinutesToday += recorded;
        kmcActive = false;
        cancelUiCountdown();
        setSlideText(tx("tx.tool_kmc_timer.stopped", "You stopped the session.\nYou added {minutes} practice minute.\nCarry on only while the caregiver and baby are safe and comfortable.\nFollow the health worker's plan for a small or early baby.", { minutes: recorded }));
        renderKmcTimer();
      });
    }
    if (add && !add.dataset.bound) {
      add.dataset.bound = "kmc";
      add.addEventListener("click", function () {
        kmcMinutesToday += 15;
        setSlideText(tx("tx.tool_kmc_timer.summary", "You have {minutes} minutes of skin-to-skin time today.\nCarry on only while the caregiver and baby are safe and comfortable.\nFollow the health worker's plan for a small or early baby.", { minutes: kmcMinutesToday }));
        renderKmcTimer();
      });
    }
    if (help && !help.dataset.bound) {
      help.dataset.bound = "kmc";
      help.addEventListener("click", function () {
        kmcActive = false;
        cancelUiCountdown();
        setSlideText(tx("tx.tool_kmc_timer.urgent", "Ask a health worker or clinic for help now if you see any of these:\n- The baby feeds poorly.\n- The baby has trouble breathing.\n- The baby is hot, or cold to touch.\n- The baby has convulsions (a fit - body shaking or gone stiff).\n- The baby's skin or eyes look yellow.\n- You feel unsafe, or worn out."));
        renderKmcTimer();
      });
    }
  }
  function showKmcTimer() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("kmc_timer");
    $("slidetitle").textContent = t("tx.feature_kmc_timer");
    $("slideimage").innerHTML = renderVisual("kmc_timer", card ? card.imageDesc : "Caregiver holding a newborn skin-to-skin under a wrap with a session timer.");
    var baby = eligibleKmcBaby();
    if (!baby) {
      cancelUiCountdown();
      kmcActive = false;
      setSlideText(kmcEligibilityMessage());
      // The eligibility sentence is already on the screen above, set by setSlideText. Printing it
      // again inside the card made a caregiver read the same paragraph twice with a heading
      // between the copies.
      $("slidecache").innerHTML = '<div class="result-card"><strong>' + esc(tx("tx.kmc_timer.kangaroo_care_timer_unavailable_for")) + '</strong><p class="muted">' + esc(tx("tx.kmc_timer.use_the_newborn_danger_check")) + '</p></div>' + traceDetails("Review details", "KMC direct launch blocked because no synthetic baby meets the prototype eligibility gate. " + provenanceSummary("kmc_timer") + assetSummary("kmc_timer") + contractSummary("kmc_timer"));
      return;
    }
    setSlideText(tx("tx.tool_kmc_timer_body", "Skin-to-skin time for a baby born early or born small, when a health worker has advised kangaroo mother care. This timer does not replace newborn danger checks, so tell a health worker if the baby seems unwell."));
    renderKmcTimer();
  }
  function renderFamilyPreparednessChecklist() {
    var items = [
      ["familyors", tx("tx.family_preparedness.we_keep_ors_packets_at"), "ORS packets at home"],
      ["familywater", tx("tx.family_preparedness.we_have_clean_drinking_water"), "clean drinking water"],
      ["familysafewater", "We have supplies for our usual water treatment and a clean, covered container.", "water-treatment supplies"],
      ["familycontact", "We wrote down clinic and emergency contacts or saved them in a phone.", "clinic and emergency contacts"],
      ["familytransport", "We know how to travel for urgent care and what the journey may cost.", "urgent transport plan"],
      ["familydocs", "We keep IDs, health records, and key documents together.", "IDs and health records"],
      ["familymeds", "We know what regular medicines remain and when to refill them.", "medicines and refill plan"],
      ["familymeetup", "If phones or travel fail, we know who will contact whom and where to meet.", "emergency contact and meet-up plan"]
    ];
    var pageSize = 2, pageCount = Math.ceil(items.length / pageSize);
    var pageItems = items.slice(familyPreparednessStep * pageSize, familyPreparednessStep * pageSize + pageSize);
    setSlideText(tx("tx.family_preparedness.part_progress", null, { part: familyPreparednessStep + 1, total: pageCount }));
    var labels = pageItems.map(function (item) {
      return '<label><input id="' + item[0] + '" type="checkbox"' + (familyPreparednessState[item[0]] ? " checked" : "") + '> ' + esc(item[1]) + '</label>';
    }).join("");
    var finalPage = familyPreparednessStep === pageCount - 1;
    var nextId = finalPage ? "familyready" : "familynext" + (familyPreparednessStep + 1);
    $("slidecache").innerHTML = '<div class="slidecontrols checklist-controls" data-one-purpose-step="family-preparedness" data-multiselect-instruction="false">' + labels + '<button id="' + nextId + '" type="button">' + (finalPage ? esc(tx("tx.family_preparedness.review_checklist")) : esc(tx("tx.family_preparedness.next_two_items"))) + '</button></div>' + reviewDetailsHtml("family_preparedness", "Family preparedness checklist. Two readiness decisions per screen.");
    pageItems.forEach(function (item) {
      var box = $(item[0]);
      if (box) box.addEventListener("change", function () { familyPreparednessState[item[0]] = !!box.checked; });
    });
    function capturePage() {
      pageItems.forEach(function (item) { familyPreparednessState[item[0]] = !!($(item[0]) && $(item[0]).checked); });
    }
    var next = finalPage ? null : $(nextId);
    if (next) next.addEventListener("click", function () {
      capturePage();
      var previous = familyPreparednessStep;
      pushWorkBackStep(function () {
        familyPreparednessStep = previous;
        renderFamilyPreparednessChecklist();
        applyShellVisibility();
        moveToNextStep("slidecache");
      });
      familyPreparednessStep++;
      renderFamilyPreparednessChecklist();
      moveToNextStep("slidecache");
    });
    var ready = $("familyready");
    if (ready) ready.addEventListener("click", function () {
      capturePage();
      var ids = items.map(function (item) { return item[0]; });
      var names = {};
      items.forEach(function (item) { names[item[0]] = item[2]; });
      showSubmittedChecklistResult({
        ids: ids, names: names, state: familyPreparednessState, slug: "tx.tool_family_preparedness.summary",
        fallback: "Family readiness list saved: {count} of {total} items selected - {selectedItems}. Follow local emergency instructions and seek urgent care for danger signs.",
        title: "Your family readiness plan", nextAction: "Follow local emergency instructions. Review any missing readiness items with your family. Seek urgent care for danger signs.",
        againId: "familyreviewagain", againLabel: "Review family checklist again", featureId: "family_preparedness",
        bodyText: "Review two family-readiness items at a time.",
        render: function () { familyPreparednessStep = 0; renderFamilyPreparednessChecklist(); }
      });
    });
  }
  function showFamilyPreparednessChecklist() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("family_preparedness");
    $("slidetitle").textContent = t("tx.feature_family_preparedness");
    $("slideimage").innerHTML = renderVisual("family_preparedness", card ? card.imageDesc : "Household checklist with water, ORS, contacts, documents, medicines, and transport.");
    familyPreparednessStep = 0;
    familyPreparednessState = {};
    renderFamilyPreparednessChecklist();
  }
  function renderChronicRefillTracker() {
    var today = localDateValue(new Date());
    var openedReminder = openedRefillReminderIndex === null ? null : inAppNudgeSchedules[openedRefillReminderIndex];
    var linkedPhoto = openedReminder && openedReminder.refillPhoto ? openedReminder.refillPhoto : pendingRefillPhoto;
    openedRefillReminderIndex = null;
    var photoNotice = linkedPhoto
      ? '<div id="refillphotostatus" class="muted">Session-only photo linked. Mamma does not show it on Home or keep it after this app session.</div><img id="refillphotopreview" class="refill-photo-preview" style="height:96px;max-height:96px" src="' + esc(linkedPhoto.previewUrl || "") + '" alt="Selected medicine reference photo">'
      : '<div id="refillphotostatus" class="muted">' + esc(tx("tx.chronic_refill_tracker.the_photo_is_optional_and")) + '</div><img id="refillphotopreview" class="refill-photo-preview hidden" style="height:96px;max-height:96px" alt="Selected medicine reference photo">';
    $("slidecache").innerHTML = '<div class="progress-panel compact-reminder-panel" data-tool="refill_reminder"><strong>' + esc(tx("tx.chronic_refill_tracker.set_a_refill_reminder")) + '</strong><label>Reminder date <input id="refillreminderdate" type="date" min="' + esc(today) + '" value="' + esc(today) + '"></label><input id="refillphoto" class="visually-hidden" type="file" accept="image/*" capture="environment"><button class="ghost" id="refillphotochoose" type="button">' + esc(tx("tx.chronic_refill_tracker.take_or_choose_photo")) + '</button>' + photoNotice + '<button id="refillstartreminder" type="button">' + esc(tx("tx.chronic_refill_tracker.save_reminder_in_mamma")) + '</button><div id="refillnudgestatus" hidden></div></div><div class="slidecontrols"><button class="ghost" id="refillhelp" type="button">' + esc(tx("tx.chronic_refill_tracker.medicine_concern_now")) + '</button></div>' + trackerReviewDetailsHtml("chronic_refill_tracker", "chronic_refill_tracker", "Medicine refill reminder. Calendar planning only.");
    var photoInput = $("refillphoto");
    var photoChoose = $("refillphotochoose");
    if (photoChoose && !photoChoose.dataset.bound) {
      photoChoose.dataset.bound = "refill";
      photoChoose.addEventListener("click", function () { if (photoInput) photoInput.click(); });
    }
    if (photoInput && !photoInput.dataset.bound) {
      photoInput.dataset.bound = "refill";
      photoInput.addEventListener("change", function () {
        var file = this.files && this.files[0];
        var status = $("refillphotostatus"), preview = $("refillphotopreview");
        if (!file) return;
        if (!/^image\//i.test(file.type || "")) {
          pendingRefillPhoto = null;
          if (status) status.textContent = "Choose a photo file, or leave this optional field empty.";
          return;
        }
        if (file.size && file.size > 5 * 1024 * 1024) {
          pendingRefillPhoto = null;
          if (status) status.textContent = "Choose a photo smaller than 5 MB, or leave this optional field empty.";
          return;
        }
        var previewUrl = window.URL && window.URL.createObjectURL ? window.URL.createObjectURL(file) : "";
        pendingRefillPhoto = { fileName: file.name || "medicine reference photo", mimeType: file.type || "image/*", previewUrl: previewUrl };
        if (status) status.textContent = "Session-only photo linked. Mamma does not show it on Home or keep it after this app session.";
        if (preview && previewUrl) { preview.src = previewUrl; preview.style.height = "96px"; preview.style.maxHeight = "96px"; preview.classList.remove("hidden"); }
      });
    }
    var help = $("refillhelp"), reminder = $("refillstartreminder");
    if (reminder && !reminder.dataset.bound) {
      reminder.dataset.bound = "refill";
      reminder.addEventListener("click", function () {
        var dateInput = $("refillreminderdate");
        setNudgeStatus("refillnudgestatus", tx("tx.tool_chronic_refill.reminder_saving", "Saving your reminder in Mamma..."), tx("tx.tool_chronic_refill.reminder_saving_detail", "Mamma is applying your reminder settings."));
        requestInAppRefillReminder(dateInput && dateInput.value, pendingRefillPhoto).then(function (decision) {
          if (decision.action === "scheduled" || decision.action === "bundled") {
            setNudgeStatus("refillnudgestatus", tx("tx.tool_chronic_refill.reminder_saved", "Mamma saved your reminder."), tx("tx.tool_chronic_refill.reminder_saved_detail", "Mamma shows it on Home."));
            setSlideText(tx("tx.tool_chronic_refill.reminder_screen_status", "Mamma now shows your refill reminder on Home. Open it any time to see the calendar date and your optional photo for this app session."));
            pendingRefillPhoto = null;
          } else {
            setNudgeStatus("refillnudgestatus", tx("tx.tool_chronic_refill.reminder_not_saved", "The app did not save the reminder."), tx("tx.tool_chronic_refill.reminder_not_saved_detail", "Choose another future date and try again."));
          }
        }).catch(function (error) {
          setNudgeStatus("refillnudgestatus", tx("tx.tool_chronic_refill.reminder_not_saved", "The app did not save the reminder."), error && error.message ? error.message : tx("tx.tool_chronic_refill.reminder_unavailable", "The in-app reminder is unavailable. Please try again."));
        });
      });
    }
    if (help && !help.dataset.bound) {
      help.dataset.bound = "refill";
      help.addEventListener("click", function () {
        setSlideText(tx("tx.tool_chronic_refill.urgent", "Get urgent care now if you see any of these:\n- A bad reaction to the medicine.\n- Trouble breathing.\n- Fainting.\n- Swelling of the lips or face.\n- A bad rash.\n- Someone swallowed poison, or took too much medicine.\n- A child took medicine by mistake.\nCall the local emergency number if there is one."));
        renderChronicRefillTracker();
      });
    }
  }
  function showChronicRefillTracker() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("chronic_refill_tracker");
    $("slidetitle").textContent = t("tx.feature_chronic_refill_tracker");
    $("slideimage").innerHTML = "";
    setSlideText(tx("tx.tool_chronic_refill_body_v2", "Choose a date for a refill reminder in this app. You can add an optional photo for this app session."));
    renderChronicRefillTracker();
  }
  function renderLaborClock() {
    var history = laborContractions.length
      ? '<ol>' + laborContractions.slice().reverse().map(function (item, reverseIndex) {
          var number = laborContractions.length - reverseIndex;
          var interval = item.intervalSeconds === null ? "first contraction" : Math.max(1, Math.round(item.intervalSeconds / 60)) + " minutes since the previous one began";
          return "<li><strong>Contraction " + number + ":</strong> " + item.durationSeconds + " seconds; " + interval + ".</li>";
        }).join("") + "</ol>"
      : "<p>" + esc(tx("tx.labor_clock.no_contractions_recorded_yet")) + "</p>";
    var running = laborContractionStartedAt > 0;
    $("slidecache").innerHTML =
      '<div class="progress-panel" aria-live="polite"><strong>' + (running ? "Contraction timing now" : "Contraction history") + '</strong><div id="laborhistory">' + history + "</div></div>" +
      '<div class="slidecontrols wrap-controls"><button id="laborstart" type="button"' + (running ? " disabled" : "") + '>Start contraction</button><button id="laborend" type="button"' + (!running ? " disabled" : "") + '>End contraction</button><button class="ghost" id="laborclear" type="button"' + (!laborContractions.length || running ? " disabled" : "") + '>Clear history</button><button class="ghost" id="laborhelp" type="button">' + esc(tx("tx.labor_clock.danger_signs_now")) + '</button></div>' +
      '<p class="muted">' + esc(tx("tx.labor_clock.keep_this_screen_open_while")) + '</p>' +
      reviewDetailsHtml("labor_clock", "Labor clock. Foreground contraction timing and transport planning support.");
    var start = $("laborstart"), end = $("laborend"), clear = $("laborclear"), help = $("laborhelp");
    if (start && !start.dataset.bound) {
      start.dataset.bound = "labor";
      start.addEventListener("click", function () {
        laborContractionStartedAt = Date.now();
        setSlideText(tx("tx.tool_labor_clock.started", "Timing this contraction now. Tap End contraction when it stops."));
        renderLaborClock();
      });
    }
    if (end && !end.dataset.bound) {
      end.dataset.bound = "labor";
      end.addEventListener("click", function () {
        if (!laborContractionStartedAt) return;
        var endedAt = Date.now();
        var previous = laborContractions.length ? laborContractions[laborContractions.length - 1] : null;
        laborContractions.push({
          startedAt: laborContractionStartedAt,
          durationSeconds: Math.max(1, Math.round((endedAt - laborContractionStartedAt) / 1000)),
          intervalSeconds: previous ? Math.max(1, Math.round((laborContractionStartedAt - previous.startedAt) / 1000)) : null
        });
        laborContractionStartedAt = 0;
        setSlideText(tx("tx.tool_labor_clock.recorded", "You recorded the contraction. Start the timer again when the next contraction begins. Follow your birth attendant's advice about when to leave for care."));
        renderLaborClock();
      });
    }
    if (clear && !clear.dataset.bound) {
      clear.dataset.bound = "labor";
      clear.addEventListener("click", function () {
        laborContractions = [];
        setSlideText(tx("tx.tool_labor_clock.cleared", "You cleared the contraction history. Tap Start contraction when the next one begins."));
        renderLaborClock();
      });
    }
    if (help && !help.dataset.bound) {
      help.dataset.bound = "labor";
      help.addEventListener("click", function () {
        setSlideText(tx("tx.tool_labor_clock.urgent", "Get urgent care now if you see any of these:\n- Bleeding.\n- Fluid leaking.\n- Bad headache, or a change in your sight.\n- Trouble breathing.\n- Bad belly pain.\n- Fever.\n- A lot of vomiting.\n- The baby stops moving, or moves less.\n- You feel unsafe."));
      });
    }
  }
  function showLaborClock() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("labor_clock");
    $("slidetitle").textContent = t("tx.feature_labor_clock");
    $("slideimage").innerHTML = renderVisual("labor_clock", card ? card.imageDesc : "Pregnant person timing a contraction with a large Start and End clock and a route to care.");
    setSlideText(tx("tx.tool_labor_clock_body", "Time when each contraction starts and ends. The app will show the length and the minutes from one contraction to the next. Follow your birth attendant's advice about when to leave, and seek care now for any pregnancy danger sign."));
    renderLaborClock();
  }
  function renderBednetReminder() {
    $("slidecache").innerHTML = '<div class="slidecontrols"><label><input id="bednetpreg" type="checkbox"> ' + esc(tx("tx.bednet_hanging_reminder.the_pregnant_person_has_a")) + '</label><label><input id="bednetchild" type="checkbox"> ' + esc(tx("tx.bednet_hanging_reminder.the_child_has_a_net")) + '</label><label><input id="bednethang" type="checkbox"> ' + esc(tx("tx.bednet_hanging_reminder.i_hung_each_net_so")) + '</label><label><input id="bednetrepair" type="checkbox"> ' + esc(tx("tx.bednet_hanging_reminder.i_checked_for_holes_tears")) + '</label><button id="bednetsave" type="button">' + esc(tx("tx.bednet_hanging_reminder.show_what_is_left")) + '</button><button class="ghost" id="bednetreminder" type="button">' + esc(tx("tx.bednet_hanging_reminder.remind_me_this_evening")) + '</button>' + nudgeStatusPanelHtml("bednetnudgestatus") + '</div>' + reviewDetailsHtml("bednet_hanging_reminder", "Bednet reminder. Malaria prevention support only.") + trackerContractHtml("bednet_hanging_reminder");
    var ids = ["bednetpreg", "bednetchild", "bednethang", "bednetrepair"];
    var save = $("bednetsave"), reminder = $("bednetreminder");
    if (save && !save.dataset.bound) {
      save.dataset.bound = "bednet";
      save.addEventListener("click", function () {
        var names = { bednetpreg: "pregnant person", bednetchild: "child", bednethang: "hung/tucked net", bednetrepair: "repair" };
        showSubmittedChecklistResult({
          ids: ids, names: names, slug: "tx.tool_bednet.summary",
          fallback: "Bednet reminder plan saved: {count} of {total} items selected - {selectedItems}. Use locally recommended insecticide-treated nets where malaria risk exists. This is prevention support only; fever needs local malaria guidance, testing, and care.",
          title: "Your bednet plan", nextAction: "Use locally recommended treated nets where malaria risk exists. Before the next sleep, prepare any net that is not ready. Fever needs local malaria testing and care.",
          againId: "bednetreviewagain", againLabel: "Review bednet plan again", featureId: "bednet_hanging_reminder",
          bodyText: tx("tx.tool_bednet_body", "Malaria prevention reminder for bednet hanging, checking, and repair. Prioritize pregnant people and children where local malaria risk and bednet guidance apply."),
          render: renderBednetReminder
        });
      });
    }
    if (reminder && !reminder.dataset.bound) {
      reminder.dataset.bound = "bednet";
      reminder.addEventListener("click", function () {
        setNudgeStatus("bednetnudgestatus", tx("tx.reminder.saving", "Saving your reminder..."), tx("tx.reminder.saving_detail", "Mamma is applying your reminder and quiet-hours settings."));
        requestInAppReminder({ moduleId: "bednet_hanging_reminder", topic: "bednet_tonight", dateValue: localDateValue(new Date()), privacyClass: "generic_ok" }).then(function (decision) {
          if (decision.action === "scheduled" || decision.action === "bundled") {
            setNudgeStatus("bednetnudgestatus", tx("tx.reminder.saved", "Mamma saved your reminder."), tx("tx.reminder.home_detail", "Mamma now shows it on Home and follows your quiet-hours settings. Keep this app open when you need to see it."));
            setSlideText(tx("tx.tool_bednet.reminder_saved", "Mamma now shows your bednet reminder on Home. Before sleep, hang, tuck, and check each net."));
          } else setNudgeStatus("bednetnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), tx("tx.reminder.try_again", "Try again, or ask someone at home to remind you before sleep."));
        }).catch(function (error) {
          setNudgeStatus("bednetnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), error && error.message ? error.message : tx("tx.reminder.unavailable", "The in-app reminder is unavailable. Please try again."));
        });
      });
    }
  }
  function showBednetReminder() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("bednet_hanging_reminder");
    $("slidetitle").textContent = t("tx.feature_bednet_hanging_reminder");
    $("slideimage").innerHTML = renderVisual("bednet_hanging_reminder", card ? card.imageDesc : "Caregiver tucking a bednet around a sleeping area with a repair reminder and malaria-prevention cue.");
    setSlideText(tx("tx.tool_bednet_body", "Malaria prevention reminder for bednet hanging, checking, and repair. Prioritize pregnant people and children where local malaria risk and bednet guidance apply."));
    renderBednetReminder();
  }
  // Kept as the registry's named entry point; the screen itself is template T3 data now.
  function renderDehydrationGuide() {
    renderRegistryChecklistScreen("dehydration_guide.main");
  }
  function showDehydrationGuide() {
    activeSlides = [];
    resetRegistryChecklist("dehydration_guide.main");
    showPanel("slideshow");
    var card = cardByFeature("dehydration_visual_guide");
    $("slidetitle").textContent = t("tx.feature_dehydration_visual_guide");
    $("slideimage").innerHTML = renderVisual("dehydration_visual_guide", card ? card.imageDesc : "Caregiver watching a tired child with cup, water bottle, and dehydration concern cues; not a diagnosis image.");
    setSlideText(tx("tx.tool_dehydration_guide_body", "Check the danger signs of losing too much water first. Then help with ORS if the child can drink."));
    renderDehydrationGuide();
  }
  function complementaryFeedingGuideSteps() {
    return [
      { title: tx("tx.feeding_plan.breastfeed_title", "Keep breastfeeding"), body: tx("tx.feeding_plan.breastfeed_body", "Breastfeed as often as before. First foods add to breastmilk; they do not replace it.") },
      { title: tx("tx.feeding_plan.start_title", "Start small and soft"), body: tx("tx.feeding_plan.start_body", "Wash hands. Offer 2 or 3 spoonfuls of thick porridge or well-mashed food twice a day. Thick food should stay on the spoon.") },
      { title: tx("tx.feeding_plan.bowl_title", "What can go in the bowl?"), body: tx("tx.feeding_plan.bowl_body", "Use safe local foods. Try well-cooked beans or lentils, egg, meat or fish; mashed vegetables or fruit; and thick porridge or mashed potatoes. Add different foods over time.") },
      { title: tx("tx.feeding_plan.cues_title", "Follow the child's cues"), body: tx("tx.feeding_plan.cues_body", "Sit the child upright. Feed slowly and patiently. Encourage, but never force. Stop when the child shows they are full.") },
      { title: tx("tx.feeding_plan.not_breastfed_title", "If the child is not breastfed"), body: tx("tx.feeding_plan.not_breastfed", "Start soft foods at about 6 months too and ask a health worker how often to feed.") }
    ];
  }
  function renderComplementaryFeedingGuide() {
    var steps = complementaryFeedingGuideSteps();
    var step = steps[feedingGuideStep];
    var progress = tx("tx.feeding_plan.lesson_progress", "Lesson {current} of {total}", { current: feedingGuideStep + 1, total: steps.length });
    var nextLabel = feedingGuideStep === steps.length - 1
      ? tx("tx.feeding_plan.open_plan", "Make a plan for today")
      : tx("tx.feeding_plan.next_lesson", "Next: {nextTitle}", { nextTitle: steps[feedingGuideStep + 1].title });
    var controls = '<div class="slidecontrols feeding-lesson-controls">' +
      (feedingGuideStep > 0 ? '<button class="ghost" id="feedingguideprev" type="button">' + esc(tx("tx.feeding_plan.previous_lesson", "Back: {previousTitle}", { previousTitle: steps[feedingGuideStep - 1].title })) + '</button>' : '') +
      '<button id="feedingguidenext" type="button">' + esc(nextLabel) + '</button></div>';
    $("slidecache").innerHTML = '<section class="feeding-guide one-purpose-step" data-one-purpose-step="feeding-guide" aria-labelledby="feedingguidetitle">' +
      '<p class="feeding-step-progress">' + esc(progress) + '</p><h3 id="feedingguidetitle">' + esc(step.title) + '</h3><p>' + esc(step.body) + '</p></section>' +
      controls + reviewDetailsHtml("complementary_feeding_card", "First-foods education. Shows one lesson at a time.");
    var previous = $("feedingguideprev");
    if (previous && !previous.dataset.bound) {
      previous.dataset.bound = "feeding-guide-previous";
      previous.addEventListener("click", function () {
      feedingGuideStep = Math.max(0, feedingGuideStep - 1);
      renderComplementaryFeedingGuide();
      moveToNextStep("slidecache");
      });
    }
    var next = $("feedingguidenext");
    if (next && !next.dataset.bound) {
      next.dataset.bound = "feeding-guide-next";
      next.addEventListener("click", function () {
      if (feedingGuideStep < steps.length - 1) {
        feedingGuideStep++;
        renderComplementaryFeedingGuide();
      } else {
        renderComplementaryFeedingPlan();
      }
      moveToNextStep("slidecache");
      });
    }
  }
  function renderComplementaryFeedingPlan() {
    var planHtml = '<section class="feeding-plan-check one-purpose-step" data-one-purpose-step="feeding-plan" aria-labelledby="feedingplantitle"><h3 id="feedingplantitle">' + esc(tx("tx.feeding_plan.check_title", "Make a plan for today")) + '</h3><p>' + esc(tx("tx.feeding_plan.check_intro", "Check what is ready. It is okay to leave boxes empty - we will show what to do next.")) + '</p>' +
      '<div class="slidecontrols checklist-controls"><label><input id="feedingage" type="checkbox"' + (feedingPlanSelections.feedingage ? " checked" : "") + '> ' + esc(tx("tx.feeding_plan.check_age", "The child is about 6 months or older.")) + '</label><label><input id="feedingdiverse" type="checkbox"' + (feedingPlanSelections.feedingdiverse ? " checked" : "") + '> ' + esc(tx("tx.feeding_plan.check_food", "I can offer thick, soft food and add different safe local foods over time.")) + '</label><label><input id="feedingresponsive" type="checkbox"' + (feedingPlanSelections.feedingresponsive ? " checked" : "") + '> ' + esc(tx("tx.feeding_plan.check_responsive", "I will keep breastfeeding and feed slowly without forcing.")) + '</label><label><input id="feedinghygiene" type="checkbox"' + (feedingPlanSelections.feedinghygiene ? " checked" : "") + '> ' + esc(tx("tx.feeding_plan.check_hygiene", "Hands, safe water, bowl, and spoon are clean.")) + '</label><label><input id="feedingsick" type="checkbox"' + (feedingPlanSelections.feedingsick ? " checked" : "") + '> ' + esc(tx("tx.feeding_plan.check_help", "I know where to get help if the child is sick, losing weight, or not eating.")) + '</label><button id="feedingsave" type="button">' + esc(tx("tx.feeding_plan.show_steps", "Show my next steps")) + '</button></div></section>';
    $("slidecache").innerHTML = planHtml + reviewDetailsHtml("complementary_feeding_card", "First-foods plan. Nutrition education only.");
    var ids = ["feedingage", "feedingdiverse", "feedingresponsive", "feedinghygiene", "feedingsick"];
    var save = $("feedingsave");
    if (save && !save.dataset.bound) {
      save.dataset.bound = "feeding";
      save.addEventListener("click", function () {
        ids.forEach(function (id) { feedingPlanSelections[id] = !!$(id).checked; });
        showComplementaryFeedingResult(ids);
      });
    }
  }
  function showComplementaryFeedingResult(ids) {
    var nextLabels = {
      feedingage: { title: tx("tx.feeding_plan.next_age_title", "Check the child's age"), body: tx("tx.feeding_plan.next_age", "Wait until the child is about 6 months old before starting these foods.\nAsk a health worker if you are not sure.") },
      feedingdiverse: { title: tx("tx.feeding_plan.next_diverse_title", "Prepare thick, soft food"), body: tx("tx.feeding_plan.next_diverse", "Start with 2 or 3 spoonfuls of thick porridge or well-mashed food twice a day. Add different safe local foods over time.") },
      feedingresponsive: { title: tx("tx.feeding_plan.next_responsive_title", "Feed slowly without forcing"), body: tx("tx.feeding_plan.next_responsive", "Keep breastfeeding as often as before. Feed slowly, encourage without forcing, and stop when the child shows they are full.") },
      feedinghygiene: { title: tx("tx.feeding_plan.next_hygiene_title", "Clean hands and utensils"), body: tx("tx.feeding_plan.next_hygiene", "Wash hands and use safe water and a clean bowl and spoon.") },
      feedingsick: { title: tx("tx.feeding_plan.next_help_title", "Know where to get help"), body: tx("tx.feeding_plan.next_help", "Contact a health worker or clinic if the child is sick, losing weight, or not eating.") }
    };
    var readyCount = ids.filter(function (id) { return !!feedingPlanSelections[id]; }).length;
    feedingResultSteps = ids.filter(function (id) { return !feedingPlanSelections[id]; }).map(function (id) { return nextLabels[id]; });
    if (!feedingResultSteps.length) {
      feedingResultSteps = [{ title: tx("tx.feeding_plan.next_complete_title", "Your feeding plan is ready"), body: tx("tx.feeding_plan.next_complete", "Keep feeding this way:\n- Keep breastfeeding.\n- Give small amounts of soft food twice a day.\n- Add different safe foods over time.\nAsk a health worker or clinic if feeding gets hard.") }];
    }
    feedingResultStep = 0;
    pushWorkBackStep(restoreComplementaryFeedingPlan);
    renderComplementaryFeedingResultStep(ids, readyCount);
  }
  function restoreComplementaryFeedingPlan() {
    $("slideimage").classList.remove("hidden");
    setSlideText(tx("tx.tool_complementary_feeding_body", "You're helping your child learn to eat. At about 6 months, keep breastfeeding and begin offering soft foods too."));
    renderComplementaryFeedingPlan();
    moveToNextStep("slidecache");
  }
  function renderComplementaryFeedingResultStep(ids, readyCount) {
    var step = feedingResultSteps[feedingResultStep];
    var total = feedingResultSteps.length;
    var title = total > 1
      ? tx("tx.feeding_plan.next_step_title", "Next step {current} of {total}: {stepTitle}", { current: feedingResultStep + 1, total: total, stepTitle: step.title })
      : step.title;
    setSlideResult({
      kind: "home",
      careRoute: "home_watch",
      screenId: "feeding.result.step",
      title: title,
      nextAction: step.body,
      paragraphs: [tx("tx.feeding_plan.count", "{count} of {total} plan items selected.", { count: readyCount, total: ids.length })]
    });
    $("slideimage").classList.add("hidden");
    var isLast = feedingResultStep === total - 1;
    var buttonId = isLast ? "feedingreviewagain" : "feedingnextstep";
    var buttonLabel = isLast
      ? tx("tx.feeding_plan.review_again", "Review feeding plan again")
      : tx("tx.feeding_plan.next_step_button", "Next step");
    $("slidecache").innerHTML = '<div class="slidecontrols"><button id="' + buttonId + '" type="button">' + esc(buttonLabel) + "</button></div>" + reviewDetailsHtml("complementary_feeding_card", "First-foods plan result. Shows one next action at a time.");
    var button = $(buttonId);
    button.addEventListener("click", function () {
      if (!isLast) {
        feedingResultStep++;
        renderComplementaryFeedingResultStep(ids, readyCount);
      } else {
        discardWorkBackStep();
        restoreComplementaryFeedingPlan();
      }
    });
  }
  function renderComplementaryFeedingCard() {
    renderComplementaryFeedingGuide();
  }
  function showComplementaryFeedingCard() {
    activeSlides = [];
    feedingPlanSelections = {};
    feedingGuideStep = 0;
    feedingResultSteps = [];
    feedingResultStep = 0;
    showPanel("slideshow");
    var card = cardByFeature("complementary_feeding_card");
    $("slidetitle").textContent = t("tx.feature_complementary_feeding_card");
    $("slideimage").innerHTML = renderVisual("complementary_feeding_card", card ? card.imageDesc : "Caregiver feeding a young child from a bowl with varied foods, cup, and handwashing cue.");
    setSlideText(tx("tx.tool_complementary_feeding_body", "You're helping your child learn to eat. At about 6 months, keep breastfeeding and begin offering soft foods too."));
    renderComplementaryFeedingGuide();
  }
  function renderChlorineDoseHelper() {
    $("slidecache").innerHTML = reviewDetailsHtml("chlorine_dose_helper", "Chlorine dose helper. Echoes local table values only; no generic dose.") + '<div class="slidecontrols"><label>Local table dose (mL) <input id="chlorinedoseml" type="number" min="0" step="0.1"></label><label>Water volume (L) <input id="chlorinevolume" type="number" min="0" step="0.1"></label><button id="chlorinedosereview" type="button">Review entered dose</button></div>';
    var review = $("chlorinedosereview");
    if (review && !review.dataset.bound) {
      review.dataset.bound = "chlorinedose";
      review.addEventListener("click", function () {
        var dose = ($("chlorinedoseml").value || "").trim();
        var volume = ($("chlorinevolume").value || "").trim();
        if (dose && volume) setSlideText(tx("tx.tool_chlorine_dose_helper.echo", "For {volume} L, use {dose} mL.\nThis is the amount you typed in from a local approved table or the product label.\nThis helper does not work out a dose of its own, and it does not replace the label.\nGet urgent care for danger signs, or if someone is losing too much water.", { dose: dose, volume: volume }));
        else setSlideText(tx("tx.tool_chlorine_dose_helper.missing", "Enter both values from the approved local table or product label. Do not use it without local WASH and product approval."));
      });
    }
  }
  function showChlorineDoseHelper() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("chlorine_dose_helper");
    $("slidetitle").textContent = t("tx.feature_chlorine_dose_helper");
    $("slideimage").innerHTML = renderVisual("chlorine_dose_helper", card ? card.imageDesc : "Covered water container and unbranded chlorine product beside a local-table checklist; no generic dose.");
    setSlideText(tx("tx.tool_chlorine_dose_helper_body", "Chlorine dose helper for an approved local table or product label."));
    renderChlorineDoseHelper();
  }
  function renderSanitationChecklist() {
    $("slidecache").innerHTML = reviewDetailsHtml("sanitation_checklist", "Sanitation checklist. Household WASH support only.") + '<div class="slidecontrols"><label><input id="sanitationlatrine" type="checkbox"> ' + esc(tx("tx.sanitation_checklist.we_can_use_a_latrine")) + '</label><label><input id="sanitationhandwash" type="checkbox"> ' + esc(tx("tx.sanitation_checklist.our_handwashing_station_has_soap")) + '</label><label><input id="sanitationchildfeces" type="checkbox"> ' + esc(tx("tx.sanitation_checklist.we_keep_diapers_and_child")) + '</label><label><input id="sanitationcleaning" type="checkbox"> ' + esc(tx("tx.sanitation_checklist.we_store_cleaning_supplies_away")) + '</label><label><input id="sanitationcontact" type="checkbox"> ' + esc(tx("tx.sanitation_checklist.we_know_the_local_wash")) + '</label><label><input id="sanitationother" type="checkbox"> Something else worries me</label><label><input id="sanitationnone" type="checkbox"> None of these</label><button id="sanitationreview" type="button">' + esc(tx("tx.sanitation_checklist.show_sanitation_steps")) + '</button></div>';
    var ids = ["sanitationlatrine", "sanitationhandwash", "sanitationchildfeces", "sanitationcleaning", "sanitationcontact", "sanitationother", "sanitationnone"];
    var review = $("sanitationreview");
    if (review && !review.dataset.bound) {
      review.dataset.bound = "sanitation";
      review.addEventListener("click", function () {
        var names = { sanitationlatrine: "latrine", sanitationhandwash: "handwashing station", sanitationchildfeces: "child stool kept away from hands, food, and water", sanitationcleaning: "cleaning supplies stored away from children and food", sanitationcontact: "local WASH contact", sanitationother: "other WASH concern", sanitationnone: "none of these" };
        if ($("sanitationother").checked) {
          setSlideResult({ kind: "clinic", careRoute: "professional_fallback", title: "Ask about the concern", nextAction: friendlyOtherMessage() });
          $("slideimage").classList.add("hidden");
          $("slidecache").innerHTML = '<div class="slidecontrols"><button id="sanitationreviewagain" type="button">Review sanitation checklist again</button></div>';
          bindWorkReviewAgain($("sanitationreviewagain"), function () {
            $("slideimage").classList.remove("hidden");
            setSlideText(tx("tx.tool_sanitation_body", "Check household sanitation steps."));
            renderSanitationChecklist();
            moveToNextStep("slidecache");
          }, "sanitation-review");
        } else {
          showSubmittedChecklistResult({
            ids: ids, names: names, slug: "tx.tool_sanitation.summary",
            fallback: "Sanitation checklist saved: {count} of {total} items selected - {selectedItems}. Keep child stool, diapers, cleaning chemicals, and dirty water away from children's hands, food, and drinking water. Follow the local WASH program for latrine, waste, and repair guidance. Use diarrhoea danger signs and urgent care pathways instead of waiting on this checklist.",
            title: "Your sanitation steps", nextAction: "Keep child stool and cleaners away from children, food, and water. Ask the local WASH program about missing steps. Use the diarrhoea danger check if someone is sick.",
            againId: "sanitationreviewagain", againLabel: "Review sanitation checklist again", featureId: "sanitation_checklist",
            bodyText: tx("tx.tool_sanitation_body", "Check household sanitation steps."),
            render: renderSanitationChecklist
          });
        }
      });
    }
  }
  function showSanitationChecklist() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("sanitation_checklist");
    $("slidetitle").textContent = t("tx.feature_sanitation_checklist");
    $("slideimage").innerHTML = renderVisual("sanitation_checklist", card ? card.imageDesc : "Household WASH scene with latrine, handwashing, and child-stool disposal cues.");
    setSlideText(tx("tx.tool_sanitation_body", "Check household sanitation steps."));
    renderSanitationChecklist();
  }
  function renderChlorineContactTimer() {
    $("slidecache").innerHTML =
      // The two steps were listed as instructions and then again as tick-boxes, and the intro said
      // them a third time. A tick-box IS the instruction: it names the step and records that it is
      // done. David, 2026-08-29: "I want cards that help users!" - so the card asks once.
      '<div id="chlorineprep">' +
      '<fieldset class="slidecontrols confirmation-steps" data-multiselect-instruction="false"><legend>' + esc(tx("tx.chlorine_contact_timer.confirm_each_step_you_completed")) + '</legend>' +
      '<label><input id="chlorineproduct" type="checkbox"> ' + esc(tx("tx.tool_chlorine_timer.confirm_dose", "I used the local dose for this container.")) + '</label>' +
      '<label><input id="chlorinecovered" type="checkbox"> ' + esc(tx("tx.tool_chlorine_timer.confirm_cover", "I covered the treated-water container.")) + '</label></fieldset></div>' +
      timerPanelHtml(tx("tx.chlorine_contact_timer.chlorine_wait_timer"), "30:00", "Ready", { includeMusic: false }) +
      '<div class="slidecontrols wrap-controls timer-actions"><button id="chlorinestart" type="button">' + esc(tx("tx.chlorine_contact_timer.start_30_minute_wait")) + '</button>' +
      '<button class="ghost" id="chlorinepause" type="button" disabled>' + esc(tx("tx.control.pause_timer", "Pause timer")) + '</button>' +
      '<button class="ghost" id="chlorinereset" type="button">Reset timer</button>' +
      '<button class="ghost" id="chlorinedone" type="button">' + esc(tx("tx.tool_chlorine_timer.check_status", "How much longer?")) + '</button></div>' +
      '<div class="progress-panel chlorine-feedback" id="chlorinefeedback" role="status" aria-live="polite" tabindex="-1">' +
      esc(tx("tx.tool_chlorine_timer.feedback_missing_both", "Do not start yet: complete both steps above.")) + '</div>' +
      reviewDetailsHtml("chlorine_contact_timer", "Chlorine wait timer. Foreground wait helper only; no dose shown.");
    var ids = ["chlorineproduct", "chlorinecovered"];
    function setChlorineFeedback(text, moveFocus) {
      var feedback = $("chlorinefeedback");
      if (!feedback) return;
      feedback.textContent = text;
      if (moveFocus && feedback.focus) feedback.focus();
    }
    function chlorineReadinessText() {
      var doseDone = !!($("chlorineproduct") && $("chlorineproduct").checked);
      var coverDone = !!($("chlorinecovered") && $("chlorinecovered").checked);
      if (doseDone && coverDone) return tx("tx.tool_chlorine_timer.feedback_ready", "Ready to start: you confirmed the local dose and covered the container.");
      if (doseDone) return tx("tx.tool_chlorine_timer.feedback_missing_cover", "Before you start, cover the treated-water container.");
      if (coverDone) return tx("tx.tool_chlorine_timer.feedback_missing_dose", "Before you start, use the chlorine dose from the local product label or approved dose table.");
      return tx("tx.tool_chlorine_timer.feedback_missing_both", "Do not start yet: complete both steps above.");
    }
    function chlorineStepsComplete() {
      return ids.every(function (id) { return !!($(id) && $(id).checked); });
    }
    function showChlorineCompleteResult() {
      setSlideResult({
        kind: "home",
        careRoute: "home_watch",
        title: tx("tx.tool_chlorine_timer.complete_title", "The 30-minute wait is complete"),
        nextAction: tx("tx.tool_chlorine_timer.complete_action", "Keep the treated water covered and use a clean cup or ladle. This app gives no chlorine dose; the product label or your approved local dose table does. Use the diarrhoea danger check if someone is sick."),
        paragraphs: [
          tx("tx.tool_chlorine_timer.summary", "You completed the 30-minute wait after using the local dose and covering the container."),
          tx("tx.tool_chlorine_timer.longer_label", "If the chlorine product label or local program tells you to wait longer, follow that longer time.")
        ]
      });
      $("slideimage").classList.add("hidden");
      $("slidecache").innerHTML = '<div class="slidecontrols"><button id="chlorineagain" type="button">' + esc(tx("tx.tool_chlorine_timer.again", "Treat another container")) + '</button></div>' + reviewDetailsHtml("chlorine_contact_timer", "Chlorine wait timer. Foreground wait helper only; no dose shown.");
      var again = $("chlorineagain");
      if (again && !again.dataset.bound) {
        again.dataset.bound = "chlorine";
        again.addEventListener("click", function () {
          $("slideimage").classList.remove("hidden");
          setSlideText(tx("tx.tool_chlorine_timer_body", "Chlorine needs time to work before the water is safe to drink."));
          renderChlorineContactTimer();
          moveToNextStep("slidecache");
        });
      }
    }
    for (var i = 0; i < ids.length; i++) {
      var box = $(ids[i]);
      if (box && !box.dataset.bound) {
        box.dataset.bound = "chlorine";
        box.addEventListener("change", function () {
          setChlorineFeedback(chlorineReadinessText(), false);
        });
      }
    }
    var start = $("chlorinestart"), done = $("chlorinedone");
    if (start && !start.dataset.bound) {
      start.dataset.bound = "chlorine";
      start.addEventListener("click", function () {
        if (!chlorineStepsComplete()) {
          setChlorineFeedback(chlorineReadinessText(), true);
          return;
        }
        startUiCountdown("Chlorine wait", 1800, function () {
          showChlorineCompleteResult();
        }, { startId: "chlorinestart", pauseId: "chlorinepause", resetId: "chlorinereset", startText: "Start 30-minute wait" });
        if ($("chlorineprep")) $("chlorineprep").hidden = true;
        if ($("slideimage")) $("slideimage").classList.add("hidden");
        setSlideText(tx("tx.tool_chlorine_timer.started", "You started the 30-minute wait. Keep the treated water covered and keep this screen open. Your phone may sleep, so this timer will not alert you in the background. Follow the local product label if it gives a different wait time."));
        setChlorineFeedback(tx("tx.tool_chlorine_timer.feedback_running", "Keep waiting. The timer shows {time} remaining.", { time: formatTimerClock(1800) }), false);
        moveToNextStep("timerstatus");
      });
    }
    bindUiCountdownButton("chlorinepause", function () {
      pauseOrResumeUiCountdown();
      if (uiTimer && uiTimer.status === "paused") {
        setChlorineFeedback(tx("tx.tool_chlorine_timer.feedback_paused", "The timer has paused. Tap Resume before you continue waiting."), false);
      } else if (uiTimer && uiTimer.status === "running") {
        setChlorineFeedback(tx("tx.tool_chlorine_timer.feedback_running", "Keep waiting. The timer shows {time} remaining.", { time: formatTimerClock(uiTimer.remaining) }), false);
      }
    });
    bindUiCountdownButton("chlorinereset", function () {
      resetUiCountdown();
      if ($("chlorineprep")) $("chlorineprep").hidden = false;
      if ($("slideimage")) $("slideimage").classList.remove("hidden");
      setChlorineFeedback(chlorineReadinessText(), false);
      setSlideText(tx("tx.tool_chlorine_timer_body", "Chlorine needs time to work before the water is safe to drink."));
    });
    if (done && !done.dataset.bound) {
      done.dataset.bound = "chlorine";
      done.addEventListener("click", function () {
        if (!uiTimer || uiTimer.status === "idle") {
          setChlorineFeedback(tx("tx.tool_chlorine_timer.feedback_not_started", "Start the timer after you complete both steps above."), true);
          return;
        }
        if (uiTimer.status === "paused") {
          setChlorineFeedback(tx("tx.tool_chlorine_timer.feedback_paused", "The timer has paused. Tap Resume before you continue waiting."), true);
          return;
        }
        if (uiTimer.status === "running") {
          setChlorineFeedback(tx("tx.tool_chlorine_timer.feedback_running", "Keep waiting. The timer shows {time} remaining.", { time: formatTimerClock(uiTimer.remaining) }), true);
          setSlideText(tx("tx.tool_chlorine_timer.waiting_status", "Keep waiting. The timer shows {time} remaining. Keep the treated water covered.", { time: formatTimerClock(uiTimer.remaining) }));
          return;
        }
        showChlorineCompleteResult();
      });
    }
  }
  function showChlorineContactTimer() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("chlorine_contact_timer");
    $("slidetitle").textContent = t("tx.feature_chlorine_contact_timer");
    $("slideimage").innerHTML = renderVisual("chlorine_contact_timer", card ? card.imageDesc : "Covered water container with chlorine product and wait clock.");
    setSlideText(tx("tx.tool_chlorine_timer_body", "Chlorine needs time to work before the water is safe to drink."));
    renderChlorineContactTimer();
  }
  function renderBoilWaterTimer() {
    var ids = ["boilclear", "boilrolling", "boilcovered"];
    if (!boilTimerView) {
      setSlideText(tx("tx.boil_water_timer.step_1_of_2_prepare"));
      $("slidecache").innerHTML = '<div class="slidecontrols confirmation-steps" data-one-purpose-step="boil-preparation" data-multiselect-instruction="false"><p><strong>Before you start</strong></p><label><input id="boilclear" type="checkbox"' + (boilPreparationState.boilclear ? " checked" : "") + '> ' + esc(tx("tx.boil_water_timer.the_water_is_clear_if")) + '</label><label><input id="boilrolling" type="checkbox"' + (boilPreparationState.boilrolling ? " checked" : "") + '> ' + esc(tx("tx.boil_water_timer.the_water_boils_strongly_across")) + '</label><label><input id="boilcovered" type="checkbox"' + (boilPreparationState.boilcovered ? " checked" : "") + '> ' + esc(tx("tx.boil_water_timer.a_clean_container_with_a")) + '</label><div id="boilfeedback" class="nudge-status" role="status" aria-live="polite">' + esc(tx("tx.boil_water_timer.complete_all_three_steps")) + '</div><button id="boilcontinue" type="button" disabled>' + esc(tx("tx.boil_water_timer.continue_to_timer")) + '</button></div>' + reviewDetailsHtml("boil_water_timer", "Boil-water preparation gate. The timer is a separate next screen.");
      function prepComplete() { return ids.every(function (id) { return !!boilPreparationState[id]; }); }
      function updatePreparation() {
        ids.forEach(function (id) { if ($(id)) boilPreparationState[id] = !!$(id).checked; });
        var complete = prepComplete(), button = $("boilcontinue"), feedback = $("boilfeedback");
        if (button) button.disabled = !complete;
        if (feedback) feedback.textContent = complete ? "Ready for the timer." : "Complete all three steps.";
      }
      ids.forEach(function (id) { if ($(id)) $(id).addEventListener("change", updatePreparation); });
      $("boilcontinue").addEventListener("click", function () {
        updatePreparation();
        if (!prepComplete()) return;
        pushWorkBackStep(function () {
          cancelUiCountdown();
          boilTimerView = false;
          renderBoilWaterTimer();
          applyShellVisibility();
          moveToNextStep("slidecache");
        });
        boilTimerView = true;
        renderBoilWaterTimer();
        moveToNextStep("slidecache");
      });
      updatePreparation();
      return;
    }
    setSlideText("Step 2 of 2: Keep a strong rolling boil. Use 3 minutes in a high mountain area.");
    $("slidecache").innerHTML = '<div data-one-purpose-step="boil-timer">' + timerPanelHtml("Boil water timer", "1:00", "Ready", { includeMusic: false }) + '<div class="slidecontrols wrap-controls"><button id="boilstart" type="button">Start 1-minute boil</button><button class="ghost" id="boilpause" type="button" disabled>' + esc(tx("tx.control.pause_timer", "Pause timer")) + '</button><button class="ghost" id="boilreset" type="button">Reset timer</button><button class="ghost" id="boilcool" type="button">What to do after boiling</button></div><div id="boilfeedback" class="nudge-status" role="status" aria-live="polite">Tap Start when the water is boiling strongly.</div></div>' + reviewDetailsHtml("boil_water_timer", "Boil-water timer. Foreground rolling-boil helper.");
    function boilStepsComplete() {
      return ids.every(function (id) { return !!boilPreparationState[id]; });
    }
    function updateBoilFeedback() {
      var feedback = $("boilfeedback");
      if (!feedback) return;
      var complete = boilStepsComplete();
      feedback.textContent = complete ? "Ready. Start the timer while the water keeps boiling strongly." : "Complete all three steps before starting the timer.";
      feedback.className = "nudge-status " + (complete ? "is-ready" : "needs-action");
    }
    var start = $("boilstart"), cool = $("boilcool");
    if (start && !start.dataset.bound) {
      start.dataset.bound = "boil";
      start.addEventListener("click", function () {
        startUiCountdown("Boil water", 60, null, { startId: "boilstart", pauseId: "boilpause", resetId: "boilreset", startText: "Start 1-minute boil" });
        setSlideText(tx("tx.tool_boil_water_timer.started", "The 1-minute timer is running. Keep the water at a strong rolling boil. In a high mountain area, boil for 3 minutes. Follow a local water advisory if it gives different instructions."));
      });
    }
    bindUiCountdownButton("boilpause", pauseOrResumeUiCountdown);
    bindUiCountdownButton("boilreset", resetUiCountdown);
    if (cool && !cool.dataset.bound) {
      cool.dataset.bound = "boil";
      cool.addEventListener("click", function () {
        setSlideText(tx("tx.tool_boil_water_timer.summary", "Turn off the heat after the full boiling time.\nLet the water cool by itself in the clean covered container.\nKeep it covered. Use a clean cup or ladle.\nDo not boil water that may have fuel or toxic chemicals in it.\nUse bottled water, or another safe source, and follow local health advice."));
        var feedback = $("boilfeedback");
        if (feedback) {
          feedback.textContent = "After boiling: cool the water in the clean covered container and keep it covered.";
          feedback.className = "nudge-status is-ready";
        }
      });
    }
    updateBoilFeedback();
  }
  function showBoilWaterTimer() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("boil_water_timer");
    $("slidetitle").textContent = t("tx.feature_boil_water_timer");
    $("slideimage").innerHTML = renderVisual("boil_water_timer", card ? card.imageDesc : "Covered pot at a rolling boil beside a one-minute clock.");
    boilPreparationState = {};
    boilTimerView = false;
    renderBoilWaterTimer();
  }
  function renderCholeraHotspotAlert() {
    $("slidecache").innerHTML = reviewDetailsHtml("cholera_hotspot_alert", "Cholera hotspot alert checklist. Local alert wording controls release copy.") + '<div class="slidecontrols">' + checklistBoxHtml("cholera", "cholerasafe", tx("tx.cholera_hotspot_alert.we_have_a_safe_water")) + checklistBoxHtml("cholera", "cholerahands", tx("tx.cholera_hotspot_alert.we_have_handwashing_soap_or")) + checklistBoxHtml("cholera", "choleralatrine", tx("tx.cholera_hotspot_alert.we_have_a_plan_to")) + checklistBoxHtml("cholera", "choleraors", tx("tx.cholera_hotspot_alert.we_have_ors_packets_or")) + checklistBoxHtml("cholera", "choleraclinic", tx("tx.cholera_hotspot_alert.we_know_the_clinic_or")) + '<button id="choleraplan" type="button">' + esc(tx("tx.cholera_hotspot_alert.review_alert_plan")) + '</button><button class="ghost" id="cholerahelp" type="button">' + esc(tx("tx.control.worse_now", "Child is getting worse")) + '</button></div>';
    var ids = ["cholerasafe", "cholerahands", "choleralatrine", "choleraors", "choleraclinic"];
    bindChecklistBoxes("cholera", ids);
    var plan = $("choleraplan"), help = $("cholerahelp");
    if (plan && !plan.dataset.bound) {
      plan.dataset.bound = "cholera";
      plan.addEventListener("click", function () {
        var names = {
          cholerasafe: "safe water",
          cholerahands: "handwashing",
          choleralatrine: "latrine/toilet cleanliness",
          choleraors: "ORS",
          choleraclinic: "clinic/CHW contact"
        };
        showSubmittedChecklistResult({
          ids: ids, names: names, slug: "tx.tool_cholera_hotspot_alert.summary",
          fallback: "Cholera readiness check saved: {count} of {total} items selected - {selectedItems}. Follow the local public-health authority for alert timing and wording. Keep urgent dehydration care visible and do not rely on phone alerts while the phone is asleep.",
          title: "Your cholera readiness plan", nextAction: "Follow local public-health alerts. Keep water, hygiene, ORS, contact, and transport steps ready. Get urgent care for dehydration danger signs; do not rely on phone alerts.",
          againId: "cholerareviewagain", againLabel: "Review readiness plan again", featureId: "cholera_hotspot_alert",
          bodyText: tx("tx.tool_cholera_hotspot_alert_body", "In a cholera or diarrhoea outbreak, put these first: safe water, handwashing, clean latrines, ORS ready at home, and urgent care for anyone losing too much water."),
          render: renderCholeraHotspotAlert
        });
      });
    }
    if (help && !help.dataset.bound) {
      help.dataset.bound = "cholera";
      help.addEventListener("click", function () {
        setSlideText(tx("tx.tool_cholera_hotspot_alert.urgent", "Get urgent care now if you see any of these:\n- Very watery diarrhoea.\n- Vomiting again and again.\n- The person is very sleepy or hard to wake.\n- The person cannot drink.\n- The person looks very ill.\nStart ORS if the person can drink."));
      });
    }
  }
  function showCholeraHotspotAlert() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("cholera_hotspot_alert");
    $("slidetitle").textContent = t("tx.feature_cholera_hotspot_alert");
    $("slideimage").innerHTML = renderVisual("cholera_hotspot_alert", card ? card.imageDesc : "Water safety alert with safe water, handwashing, latrine, ORS, and clinic icons.");
    setSlideText(tx("tx.tool_cholera_hotspot_alert_body", "In a cholera or diarrhoea outbreak, put these first: safe water, handwashing, clean latrines, ORS ready at home, and urgent care for anyone losing too much water."));
    renderCholeraHotspotAlert();
  }
  function renderHandwashingCoach(step) {
    var current = typeof step === "number" ? step : 0;
    handwashStep = current;
    $("slidecache").innerHTML = reviewDetailsHtml("handwashing_timer", "Handwashing coach. Visible 20-second timer and practice steps.") + timerPanelHtml("Handwashing timer", "0:20", "Ready") + '<div class="slidecontrols"><button id="handwashstart" type="button">Start timer</button><button class="ghost" id="handwashstartmusic" type="button">Start timer &amp; music</button><button class="ghost" id="handwashpause" type="button" disabled>' + esc(tx("tx.control.pause_timer", "Pause timer")) + '</button><button class="ghost" id="handwashreset" type="button">Reset timer</button><button class="ghost" id="handwashnext" type="button">Next step</button><button class="ghost" id="handwashdone" type="button">Done</button><button class="ghost" id="handwashtune" type="button">' + esc(tx("tx.control.start_music", "Start music")) + '</button></div>' + trackerContractHtml("handwashing_timer");
    var steps = [
      tx("tx.tool_handwashing_timer.step_wet", "Step 1 of 5: wet hands with clean running water, then add soap."),
      tx("tx.tool_handwashing_timer.step_palms", "Step 2 of 5: rub palms together, then scrub the backs of both hands."),
      tx("tx.tool_handwashing_timer.step_fingers", "Step 3 of 5: scrub between fingers, around thumbs, and under nails as part of the 20-second lather."),
      tx("tx.tool_handwashing_timer.step_rinse", "Step 4 of 5: rinse well under clean running water."),
      tx("tx.tool_handwashing_timer.step_dry", "Step 5 of 5: dry hands with a clean towel or air dry them.")
    ];
    var start = $("handwashstart"), startMusic = $("handwashstartmusic"), next = $("handwashnext"), done = $("handwashdone"), tune = $("handwashtune");
    if (start && !start.dataset.bound) {
      start.dataset.bound = "handwash";
      start.addEventListener("click", function () {
        if (uiTimer && uiTimer.startId === "handwashstart" && uiTimer.status === "paused") {
          pauseOrResumeUiCountdown();
          return;
        }
        handwashStep = 0;
        setSlideText(steps[0]);
        renderHandwashingCoach(0);
        startUiCountdown("Handwashing", 20, null, { startId: "handwashstart", pauseId: "handwashpause", resetId: "handwashreset", startText: "Start timer" });
      });
    }
    if (startMusic && !startMusic.dataset.bound) {
      startMusic.dataset.bound = "handwash";
      startMusic.addEventListener("click", function () {
        handwashStep = 0;
        setSlideText(steps[0]);
        renderHandwashingCoach(0);
        startUiCountdown("Handwashing", 20, null, { startId: "handwashstart", alternateStartId: "handwashstartmusic", alternateStartText: tx("tx.handwashing_timer.start_timer_music"), pauseId: "handwashpause", resetId: "handwashreset", startText: "Start timer", musicAssetId: "audio.prototype.handwashing_children_summer_loop", musicStatusId: "musicstatus", musicLoop: true, musicControlId: "handwashtune" });
      });
    }
    bindUiCountdownButton("handwashpause", pauseOrResumeUiCountdown);
    bindUiCountdownButton("handwashreset", resetUiCountdown);
    if (next && !next.dataset.bound) {
      next.dataset.bound = "handwash";
      next.addEventListener("click", function () {
        handwashStep = (handwashStep + 1) % steps.length;
        setSlideText(steps[handwashStep]);
        renderHandwashingCoach(handwashStep);
      });
    }
    if (done && !done.dataset.bound) {
      done.dataset.bound = "handwash";
      done.addEventListener("click", function () {
        cancelUiCountdown();
        setSlideText(tx("tx.tool_handwashing_timer.done", "20-second handwashing recorded. Wash with soap and clean water at key times such as before eating or feeding children and after toilet/cleaning tasks. Do not rely on phone alerts while the phone is asleep."));
        renderHandwashingCoach(current);
      });
    }
    if (tune && !tune.dataset.bound) {
      tune.dataset.bound = "handwash";
      tune.addEventListener("click", function () {
        var playing = togglePrototypeMusic("audio.prototype.handwashing_children_summer_loop", "musicstatus", true, { controlId: "handwashtune" });
        setSlideText(playing
          ? tx("tx.tool_handwashing_timer.tune_note", "Handwashing music is playing. Keep rubbing with soap while the countdown runs, including backs of hands, between fingers, thumbs, and under nails.")
          : tx("tx.tool_handwashing_timer.music_paused", "Music paused. The handwashing timer keeps running."));
      });
    }
    syncPrototypeMusicControl("handwashtune", "audio.prototype.handwashing_children_summer_loop");
    updateUiTimerControls();
  }
  function showHandwashingCoach() {
    activeSlides = [];
    handwashStep = 0;
    showPanel("slideshow");
    var card = cardByFeature("handwashing_timer");
    $("slidetitle").textContent = t("tx.feature_handwashing_timer");
    $("slideimage").innerHTML = renderVisual("handwashing_timer", card ? card.imageDesc : "Hands under clean running water with soap bubbles and a simple 20-second clock.");
    setSlideText(tx("tx.tool_handwashing_timer_body", "Wash with soap and clean water.\nRub palms, backs of hands, between fingers, thumbs, and under the nails.\nKeep going for at least 20 seconds."));
    renderHandwashingCoach(0);
  }
  function breastfeedingScripts() {
    return [
      tx("tx.tool_breastfeeding_audio.step_positioning", "Step 1 of 4: positioning. Sit comfortably, bring the baby close, and keep the baby's head, shoulders, and body facing the breast."),
      tx("tx.tool_breastfeeding_audio.step_attachment", "Step 2 of 4: attachment.\nHold the baby close and comfortable, with a deep latch.\nAsk for skilled help if there is pain, a hurt nipple, or the baby keeps slipping off."),
      tx("tx.tool_breastfeeding_audio.step_cues", "Step 3 of 4: signs the baby is ready to feed.\nOffer the breast when the baby:\n- turns toward the breast.\n- opens the mouth.\n- licks the lips.\n- sucks a hand.\n- becomes restless.\nTry not to wait for crying."),
      tx("tx.tool_breastfeeding_audio.step_after_feed", "Step 4 of 4: after the feed.\nNotice whether you saw or heard swallowing, and whether the baby seems calm.\nKeep track of wet nappies.\nAsk a health worker or clinic to watch a full feed and weigh the baby if:\n- You do not see or hear swallowing.\n- Wet nappies become fewer.\n- You are still worried.")
    ];
  }
  function renderBreastfeedingTipVisual(step, featureId, fallbackDescription) {
    var assets = [
      "img.generated.newborn_feeding_support_v1",
      "img.user_supplied.breastfeeding_latch_v1",
      "img.generated.newborn_feeding_support_v1",
      "img.generated.breastfeeding_after_feed_v1"
    ];
    var descriptions = [
      "A fully clothed mother holds her newborn close while a trusted older woman supports comfortable positioning.",
      "Close breastfeeding attachment view showing the baby's mouth and comfortable latch position.",
      "A mother notices observable signs that her baby is ready to feed.",
      "A calm baby rests upright after feeding while the caregiver keeps track of wet nappies."
    ];
    $("slideimage").innerHTML = renderVisual(featureId, descriptions[step] || fallbackDescription, assets[step]);
  }
  function renderBreastfeedingHelper(step) {
    var scripts = breastfeedingScripts();
    breastfeedingStep = ((typeof step === "number" ? step : breastfeedingStep) + scripts.length) % scripts.length;
    setSlideText(scripts[breastfeedingStep]);
    $("slidecache").innerHTML = reviewDetailsHtml("breastfeeding_audio", "Breastfeeding audio helper. on demand read-aloud and help prompts.") + '<div class="slidecontrols wrap-controls"><button id="bfplay" type="button">Play this tip</button><button class="ghost" id="bfpause" type="button" disabled>' + esc(tx("tx.control.pause_tip", "Pause tip")) + '</button><button class="ghost" id="bfstop" type="button" disabled>' + esc(tx("tx.control.stop_tip", "Stop tip")) + '</button><button class="ghost" id="bfprev" type="button">Previous tip</button><button class="ghost" id="bfnext" type="button">Next tip</button><button class="ghost" id="bfhelp" type="button">' + esc(tx("tx.control.worse_now", "Child is getting worse")) + '</button><span id="audiostatus" class="muted">Read-aloud idle.</span></div>';
    setReadAloudStatus("Read-aloud idle.");
    updateReadAloudActionButtons();
    var play = $("bfplay"), pause = $("bfpause"), stop = $("bfstop"), prev = $("bfprev"), next = $("bfnext"), help = $("bfhelp");
    if (play && !play.dataset.bound) { play.dataset.bound = "bf"; play.addEventListener("click", function () { var currentScripts = breastfeedingScripts(); setSlideText(currentScripts[breastfeedingStep]); playPrototypeSpeech(currentScripts[breastfeedingStep]); }); }
    if (pause && !pause.dataset.bound) { pause.dataset.bound = "bf"; pause.addEventListener("click", pausePrototypeSpeech); }
    if (stop && !stop.dataset.bound) { stop.dataset.bound = "bf"; stop.addEventListener("click", stopPrototypeSpeech); }
    if (prev && !prev.dataset.bound) { prev.dataset.bound = "bf"; prev.addEventListener("click", function () { stopReadAloudForContextChange("Read-aloud stopped because the tip changed."); renderBreastfeedingHelper(breastfeedingStep - 1); }); }
    if (next && !next.dataset.bound) { next.dataset.bound = "bf"; next.addEventListener("click", function () { stopReadAloudForContextChange("Read-aloud stopped because the tip changed."); renderBreastfeedingHelper(breastfeedingStep + 1); }); }
    if (help && !help.dataset.bound) { help.dataset.bound = "bf"; help.addEventListener("click", function () { stopReadAloudForContextChange("Read-aloud stopped because the screen changed."); setSlideText(tx("tx.tool_breastfeeding_audio.urgent", "Ask a health worker or clinic for help now if you see any of these:\n- The baby feeds poorly.\n- You cannot wake the baby to feed.\n- The baby has trouble breathing.\n- The baby has fever, or cold skin.\n- The mother has bad breast pain or redness.\n- The mother feels unsafe.\n- The mother feels overwhelmed.")); }); }
  }
  function showBreastfeedingHelper() {
    activeSlides = [];
    breastfeedingStep = 0;
    showPanel("slideshow");
    var card = cardByFeature("breastfeeding_audio");
    $("slidetitle").textContent = t("tx.feature_breastfeeding_audio");
    $("slideimage").innerHTML = renderVisual("breastfeeding_audio", card ? card.imageDesc : "Breastfeeding positioning and support audio helper.");
    renderBreastfeedingHelper(0);
  }
  function renderBreastfeedingAssistant(step) {
    var scripts = breastfeedingScripts();
    breastfeedingStep = ((typeof step === "number" ? step : breastfeedingStep) + scripts.length) % scripts.length;
    setSlideText(scripts[breastfeedingStep]);
    renderBreastfeedingTipVisual(breastfeedingStep, "breastfeeding_aid_triage", "New mother and newborn with breastfeeding support.");
    var nextLabel = breastfeedingStep === scripts.length - 1 ? tx("tx.bf.assistant.back_to_first", "Back to tip 1") : tx("tx.bf.assistant.next_tip", "Next tip");
    var remainingTips = scripts.length - breastfeedingStep;
    $("slidecache").innerHTML = reviewDetailsHtml("breastfeeding_aid_triage", "Breastfeeding assistant mode. Practical read-aloud support shares content with the breastfeeding triage module and keeps urgent checks one tap away.") +
      '<div class="slidecontrols wrap-controls"><button id="bfassistplay" type="button">' + esc(tx("tx.bf.assistant.play_tip", "Play this tip")) + '</button><button id="bfassistplayall" type="button">' + esc(tx("tx.bf.assistant.play_from_current", "Play from this tip ({count} tips)", { count: remainingTips })) + '</button><button class="ghost" id="bfassistpause" type="button" disabled>' + esc(tx("tx.control.pause_tip", "Pause tip")) + '</button><button class="ghost" id="bfassiststop" type="button" disabled>' + esc(tx("tx.control.stop_tip", "Stop tip")) + '</button><button class="ghost" id="bfassistprev" type="button"' + (breastfeedingStep === 0 ? " disabled" : "") + '>Previous tip</button><button class="ghost" id="bfassistnext" type="button">' + esc(nextLabel) + '</button><button class="dangerdoor" id="bfassisturgent" type="button">' + esc(tx("tx.breastfeeding_aid_triage.check_urgent_signs")) + '</button><span id="audiostatus" class="muted">Read-aloud idle.</span></div>';
    setReadAloudStatus("Read-aloud idle.");
    updateReadAloudActionButtons();
    var play = $("bfassistplay"), playAll = $("bfassistplayall"), pause = $("bfassistpause"), stop = $("bfassiststop"), prev = $("bfassistprev"), next = $("bfassistnext"), urgent = $("bfassisturgent");
    if (play && !play.dataset.bound) { play.dataset.bound = "bfassist"; play.addEventListener("click", function () { var currentScripts = breastfeedingScripts(); setSlideText(currentScripts[breastfeedingStep]); playPrototypeSpeech(currentScripts[breastfeedingStep]); }); }
    if (playAll && !playAll.dataset.bound) { playAll.dataset.bound = "bfassist"; playAll.addEventListener("click", function () { playPrototypeSpeech(breastfeedingScripts().slice(breastfeedingStep).join(" ")); }); }
    if (pause && !pause.dataset.bound) { pause.dataset.bound = "bfassist"; pause.addEventListener("click", pausePrototypeSpeech); }
    if (stop && !stop.dataset.bound) { stop.dataset.bound = "bfassist"; stop.addEventListener("click", stopPrototypeSpeech); }
    if (prev && !prev.dataset.bound) { prev.dataset.bound = "bfassist"; prev.addEventListener("click", function () { stopReadAloudForContextChange("Read-aloud stopped because the tip changed."); renderBreastfeedingAssistant(breastfeedingStep - 1); }); }
    if (next && !next.dataset.bound) { next.dataset.bound = "bfassist"; next.addEventListener("click", function () { stopReadAloudForContextChange("Read-aloud stopped because the tip changed."); renderBreastfeedingAssistant(breastfeedingStep + 1); }); }
    if (urgent && !urgent.dataset.bound) { urgent.dataset.bound = "bfassist"; urgent.addEventListener("click", function () { stopReadAloudForContextChange("Read-aloud stopped because the screen changed."); showBreastfeedingAidTriage("triage"); }); }
  }
  function showBreastfeedingAssistant() {
    activeSlides = [];
    breastfeedingStep = 0;
    activeShellTitle = tx("tx.bf.assistant_title", "Breastfeeding assistant");
    showPanel("slideshow");
    var card = screenByFeature("breastfeeding_aid_triage");
    $("slidetitle").textContent = tx("tx.bf.assistant_title", "Breastfeeding assistant");
    renderBreastfeedingAssistant(0);
  }
  function bfAidIds() {
    return ["bfaidinfantcannotfeed", "bfaidinfanthardtowake", "bfaidinfantbreathing", "bfaidinfantconvulsions", "bfaidinfantveryhotcold", "bfaidinfantyellowpalms", "bfaidmotherbleeding", "bfaidmotherfaint", "bfaidmotherbreathless", "bfaidmotherconvulsions", "bfaidmotherheadache", "bfaidmotherupperbelly", "bfaidmotherfever", "bfaidsmelldischarge", "bfaidbreastred", "bfaidbreastswelling", "bfaidfeedsfew", "bfaidwetfew", "bfaidswallowing", "bfaidpainfeed", "bfaidslipoff", "bfaidcracked", "bfaidwater", "bfaidcolostrum", "bfaidother"];
  }
  function bfAidInfantDangerIds() {
    return ["bfaidinfantcannotfeed", "bfaidinfanthardtowake", "bfaidinfantbreathing", "bfaidinfantconvulsions", "bfaidinfantveryhotcold", "bfaidinfantyellowpalms"];
  }
  function bfAidMotherDangerIds() {
    return ["bfaidmotherbleeding", "bfaidmotherfaint", "bfaidmotherbreathless", "bfaidmotherconvulsions", "bfaidmotherheadache", "bfaidmotherupperbelly"];
  }
  function bfAidChecked(ids) {
    return ids.some(function (id) { return !!bfAidSelections[id]; });
  }
  function bfAidNoneSelected() {
    return ["bfaidbabynone", "bfaidmothernone", "bfaidfeedingnone", "bfaidbreastnone", "bfaidattachmentnone"].some(function (id) {
      return !!bfAidSelections[id];
    });
  }
  function bfAidSurfaceId(view) {
    return "breastfeeding_aid." + (view || bfAidView);
  }
  function bfAidIntro(view) {
    if (view === "baby_urgent") return tx("tx.bf.progress.baby_intro", "First check the baby. Choose every sign you see, or choose Something else worries me or None of these.");
    if (view === "mother_urgent") return tx("tx.bf.progress.mother_intro", "Now check the mother. Choose every sign she has, or choose Something else worries me or None of these.");
    if (view === "feeding") return tx("tx.bf.progress.feeding_intro", "Check feeding and wet nappies. Choose what is happening now, or choose Something else worries me or None of these.");
    if (view === "breast") return tx("tx.bf.progress.breast_intro", "Check breast redness or swelling. Choose what is happening now, or choose Something else worries me or None of these.");
    if (view === "attachment") return tx("tx.bf.progress.attachment_intro", "Check attachment, pain, and milk questions. Choose what is happening now, or choose Something else worries me or None of these.");
    return tx("tx.bf.progress.categories_intro", "You selected no listed urgent sign. Choose the kind of breastfeeding help you need.");
  }
  function setBreastfeedingAidView(view) {
    bfAidView = view;
    setSlideText(bfAidIntro(view));
    renderBreastfeedingAidTriage();
    moveToNextStep(view === "categories" ? "slidecache" : "slidetext");
  }
  function renderBreastfeedingAidCategories() {
    $("slidecache").innerHTML = '<div class="slidecontrols"><div class="segmented pnc-categories">' +
      '<button id="bfaidnav_feeding" type="button">' + esc(tx("tx.bf.progress.feeding_button", "Feeding and wet nappies")) + '</button>' +
      '<button id="bfaidnav_breast" type="button">' + esc(tx("tx.bf.progress.breast_button", "Breast redness or swelling")) + '</button>' +
      '<button id="bfaidnav_attachment" type="button">' + esc(tx("tx.bf.progress.attachment_button", "Attachment, pain, or milk questions")) + "</button></div></div>" +
      reviewDetailsHtml("breastfeeding_aid_triage", "Progressive breastfeeding aid and triage. The caregiver completes the urgent baby and mother gates before focused support.");
    ["feeding", "breast", "attachment"].forEach(function (view) {
      var button = $("bfaidnav_" + view);
      if (button && !button.dataset.bound) {
        button.dataset.bound = "bfaid";
        button.addEventListener("click", function () { setBreastfeedingAidView(view); });
      }
    });
  }
  function renderBreastfeedingAidTriage() {
    if (bfAidView === "categories") {
      renderBreastfeedingAidCategories();
      return;
    }
    var surfaceId = bfAidSurfaceId();
    $("slidecache").innerHTML = renderClinicalChecklist(surfaceId, { selected: bfAidSelections }) +
      reviewDetailsHtml("breastfeeding_aid_triage", "Progressive breastfeeding aid and triage. The active gate is registry-backed; later concerns remain hidden until urgent baby and mother gates are answered.");
    var binding = bindClinicalChecklist(surfaceId, { state: bfAidSelections });
    var ids = binding.ids;
    var review = $(binding.screen.actionId);
    if (review && !review.dataset.bound) {
      review.dataset.bound = "bfaid";
      review.addEventListener("click", function () {
        for (var i = 0; i < ids.length; i++) if ($(ids[i])) bfAidSelections[ids[i]] = !!$(ids[i]).checked;
        if (bfAidView === "baby_urgent" && bfAidSelections.bfaidbabynone && !bfAidChecked(bfAidInfantDangerIds()) && !bfAidSelections.bfaidother) {
          setBreastfeedingAidView("mother_urgent");
          return;
        }
        if (bfAidView === "mother_urgent" && bfAidSelections.bfaidmothernone && !bfAidChecked(bfAidMotherDangerIds()) && !(bfAidSelections.bfaidmotherfever && bfAidSelections.bfaidsmelldischarge) && !bfAidSelections.bfaidother) {
          setBreastfeedingAidView("categories");
          return;
        }
        reviewBreastfeedingAidTriage();
      });
    }
  }
  function reviewBreastfeedingAidTriage() {
    var checked = bfAidIds().filter(function (id) { return !!bfAidSelections[id]; });
    if (!checked.length && !bfAidNoneSelected()) return;
    var decisionChecked = checked.filter(function (id) { return id !== "bfaidother"; });
    var decision = screenDecision("breastfeeding_aid_triage", decisionChecked);
    var infantDanger = bfAidChecked(bfAidInfantDangerIds());
    var motherDanger = bfAidChecked(bfAidMotherDangerIds()) || (bfAidSelections.bfaidmotherfever && bfAidSelections.bfaidsmelldischarge);
    var breastToday = bfAidSelections.bfaidbreastswelling || bfAidSelections.bfaidbreastred || bfAidSelections.bfaidmotherfever;
    var intakeToday = bfAidSelections.bfaidfeedsfew || bfAidSelections.bfaidwetfew || bfAidSelections.bfaidswallowing;
    var attachment = bfAidSelections.bfaidpainfeed || bfAidSelections.bfaidslipoff || bfAidSelections.bfaidcracked;
    var counsel = [];
    if (bfAidSelections.bfaidwater) counsel.push(tx("tx.bf.result.exclusive", "Breast milk alone gives babies under 6 months the food and water they need, even in hot weather. Water, honey, or other milk can make the baby ill and can reduce breastfeeding."));
    if (bfAidSelections.bfaidcolostrum) counsel.push(tx("tx.bf.result.colostrum", "The first thick yellow milk helps protect the baby against illness. Give it to the baby; do not throw it away."));
    if (infantDanger) {
      setSlideResult({
        kind: "refer",
        careRoute: "newborn_clinic",
        severity: "emergency",
        title: tx("tx.bf.title.infant_urgent", "Urgent newborn feeding help"),
        paragraphs: [tx("tx.bf.result.infant_urgent", "Go to urgent newborn care now. Keep the baby warm. Do not force the baby to feed. Bring the mother and baby together if possible.")]
      });
    } else if (motherDanger) {
      setSlideResult({
        kind: "refer",
        careRoute: "postpartum_clinic",
        severity: "emergency",
        title: tx("tx.bf.title.mother_urgent", "Urgent breastfeeding help after birth"),
        paragraphs: [tx("tx.bf.result.mother_urgent", "Get urgent care for the mother now.\nSay that she gave birth recently, and that breastfeeding or baby feeding is also a worry.\nTake the baby with her if you can.")]
      });
    } else if (breastToday) {
      setSlideResult({
        kind: "refer",
        careRoute: "postpartum_clinic",
        severity: "routine_clinic",
        title: tx("tx.bf.title.breast_today", "Breast concern to check today"),
        paragraphs: [tx("tx.bf.result.breast_today", "Contact a health worker or clinic today for the breast concern. Keep feeding as the baby normally wants if it is comfortable; do not deeply rub or press the sore area.")].concat(counsel)
      });
    } else if (intakeToday) {
      setSlideResult({
        kind: "refer",
        careRoute: "newborn_clinic",
        severity: "routine_clinic",
        title: tx("tx.bf.title.intake_today", "Feeding and weight check today"),
        paragraphs: [tx("tx.bf.result.intake_today", "See a health worker today for a feeding and weight check. While you wait, keep offering the breast often.")].concat(counsel)
      });
    } else if (attachment) {
      setSlideResult({
        kind: "refer",
        careRoute: "professional",
        severity: "followup",
        title: tx("tx.bf.title.attachment", "Watch a full feed together"),
        paragraphs: [tx("tx.bf.result.attachment_observe", "A trained person can watch a whole feed.\nThey can help you adjust how the baby is held and attached.\nGo sooner if the pain is bad, or the baby is not feeding well.")].concat(counsel),
        nextAction: tx("tx.bf.result.attachment_action", "Ask a health worker to watch a full feed within the next few days.")
      });
    } else if (bfAidSelections.bfaidother) {
      setSlideResult({
        kind: "home",
        careRoute: "professional",
        title: tx("tx.bf.title.other", "Other breastfeeding concern"),
        paragraphs: [friendlyOtherMessage()]
      });
    } else if (counsel.length) {
      setSlideResult({
        kind: "home",
        careRoute: "home_watch",
        title: tx("tx.bf.title.milk_only", "Breast milk only support"),
        paragraphs: counsel,
        nextAction: tx("tx.result.action_watch_safety", "Keep watching and seek help if a danger sign appears.")
      });
    } else {
      setSlideResult({
        kind: "home",
        careRoute: "home_watch",
        title: tx("tx.bf.title.reassuring", "No listed breastfeeding danger sign selected"),
        paragraphs: [tx("tx.bf.result.reassuring", "You selected no listed breastfeeding danger sign or concern. Keep feeding whenever the baby shows hunger, and seek help if anything changes or you remain concerned.")],
        nextAction: tx("tx.result.action_watch_safety", "Keep watching and seek help if a danger sign appears.")
      });
    }
    $("slidecache").innerHTML = '<div class="slidecontrols"><button id="bfaidreviewanother" type="button">' + esc(tx("tx.bf.progress.review_another", "Review another breastfeeding concern")) + "</button></div>" +
      reviewDetailsHtml("breastfeeding_aid_triage", "Progressive breastfeeding aid and triage result. The app replaces the checklist so the result becomes the active task.");
    var another = $("bfaidreviewanother");
    if (another && !another.dataset.bound) {
      another.dataset.bound = "bfaid";
      another.addEventListener("click", function () {
        if (bfAidSelections.bfaidbabynone && bfAidSelections.bfaidmothernone) setBreastfeedingAidView("categories");
        else {
          bfAidSelections = {};
          setBreastfeedingAidView("baby_urgent");
        }
      });
    }
    appendScreenDecisionTrace("breastfeeding_aid_triage", decision);
  }
  function breastfeedingAidEntryMode() {
    var q = (search || "").toLowerCase();
    if (mode === "danger") return "triage";
    if (q.indexOf("triage") >= 0 || q.indexOf("problem") >= 0 || q.indexOf("wrong") >= 0) return "triage";
    return "assist";
  }
  function showBreastfeedingAidTriage(entryMode, startView) {
    if (entryMode === "assist") {
      showBreastfeedingAssistant();
      return;
    }
    activeSlides = [];
    bfAidSelections = {};
    bfAidView = startView || "baby_urgent";
    if (bfAidView !== "baby_urgent") bfAidSelections.bfaidbabynone = true;
    if (["feeding", "breast", "attachment", "categories"].indexOf(bfAidView) >= 0) bfAidSelections.bfaidmothernone = true;
    activeShellTitle = t("tx.feature_breastfeeding_aid_triage");
    showPanel("slideshow");
    var card = screenByFeature("breastfeeding_aid_triage");
    $("slidetitle").textContent = t("tx.feature_breastfeeding_aid_triage");
    $("slideimage").innerHTML = renderVisual("breastfeeding_aid_triage", card ? card.imageDesc : "New mother and newborn with breastfeeding support and urgent-care contact.");
    setSlideText(bfAidIntro(bfAidView));
    renderBreastfeedingAidTriage();
  }
  function formatDateLong(date) {
    return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }
  function immunizationPerson() {
    var active = activePersonId ? personById(activePersonId) : null;
    if (active && (active.subject === "newborn_baby" || active.subject === "child_under5")) return active;
    for (var i = 0; i < people.length; i++) if (people[i].subject === "newborn_baby") return people[i];
    for (var j = 0; j < people.length; j++) if (people[j].subject === "child_under5") return people[j];
    return null;
  }
  function nextWhoImmunizationVisit(person) {
    var visit = nextImmunizationVisit({
      birthDate: person && person.birthDate,
      schedule: engine.immunizationSchedule,
      today: new Date()
    });
    if (!visit) return null;
    return {
      person: person,
      visit: tx(visit.slug),
      due: visit.due,
      alertDate: visit.remindOn,
      vaccines: visit.vaccines.map(function (row) { return tx(row.slug); })
    };
  }
  function immunizationPlanCard(plan) {
    if (!plan) {
      return '<div class="immun-plan-card" id="immunplan-card"><strong>' + esc(tx("tx.immunization.plan.card_title")) + "</strong><p>"
        + esc(tx("tx.immunization.plan.needs_a_child")) + "</p><p>"
        + esc(tx("tx.immunization.plan.confirm_with_card")) + "</p></div>";
    }
    return '<div class="immun-plan-card" id="immunplan-card"><strong id="immunperson">'
      + esc(tx("tx.immunization.plan.person_heading", null, { personName: plan.person.name })) + "</strong><p>"
      + esc(formatDateLong(plan.due)) + " - " + esc(plan.visit) + "</p><ul>"
      + plan.vaccines.map(function (item) { return "<li>" + esc(item) + "</li>"; }).join("") + "</ul><p>"
      + esc(tx("tx.immunization.plan.reminder_line", null, { reminderDate: formatDateLong(plan.alertDate) })) + " "
      + esc(tx("tx.immunization.plan.confirm_with_card")) + "</p></div>";
  }
  function immunizationPlanText(plan) {
    if (!plan) {
      return tx("tx.immunization.plan.needs_a_child_before_reminder") + " " + tx("tx.immunization.plan.confirm_with_card");
    }
    return tx("tx.immunization.plan.person_heading", null, { personName: plan.person.name })
      + ": " + formatDateLong(plan.due) + " - " + plan.visit + ". " + plan.vaccines.join(", ") + ". "
      + tx("tx.immunization.plan.reminder_line", null, { reminderDate: formatDateLong(plan.alertDate) })
      + " " + tx("tx.immunization.plan.confirm_with_card");
  }
  function renderImmunizationPlanner() {
    var today = localDateValue(new Date());
    $("slidecache").innerHTML =
      '<div class="progress-panel"><strong>' + esc(tx("tx.immunization_reminders.use_the_date_from_card")) + '</strong><p>' + esc(tx("tx.immunization_reminders.if_the_card_has_no")) + '</p></div>' +
      '<div class="slidecontrols"><label>' + esc(tx("tx.immunization_reminders.day_to_show_the_reminder")) + ' <input id="immunreminderdate" type="date" min="' + esc(today) + '"></label><button id="immunplan" type="button">' + esc(tx("tx.immunization_reminders.save_vaccine_reminder")) + '</button><div id="immunnudgestatus" hidden></div></div>' +
      reviewDetailsHtml("immunization_reminders", "Immunization reminder planner. The caregiver supplies a confirmed date from the vaccine card or local service.") +
      trackerContractHtml("immunization_reminders");
    var plan = $("immunplan");
    if (plan && !plan.dataset.bound) {
      plan.dataset.bound = "immun";
      plan.addEventListener("click", function () {
        var dateInput = $("immunreminderdate");
        setNudgeStatus("immunnudgestatus", tx("tx.reminder.saving", "Saving your reminder..."), tx("tx.reminder.saving_detail", "Mamma is applying your reminder and quiet-hours settings."));
        requestInAppReminder({
          moduleId: "immunization_reminders",
          topic: "vaccine_visit",
          dateValue: dateInput && dateInput.value,
          privacyClass: "sensitive_topic",
          startTime: "08:00",
          endTime: "18:00"
        }).then(function (decision) {
          if (decision.action === "scheduled" || decision.action === "bundled") {
            setNudgeStatus("immunnudgestatus", tx("tx.reminder.saved", "Mamma saved your reminder."), tx("tx.reminder.home_detail", "Mamma now shows it on Home and follows your quiet-hours settings. Keep this app open when you need to see it."));
            setSlideText(tx("tx.tool_immunization_reminders.saved", "Mamma now shows your vaccine-visit reminder on Home. Bring the child's vaccine card and confirm the place and time with the vaccination site."));
          } else {
            setNudgeStatus("immunnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), tx("tx.reminder.try_date_again", "Choose another future date and try again."));
          }
        }).catch(function (error) {
          setNudgeStatus("immunnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), error && error.message ? error.message : tx("tx.reminder.unavailable", "The in-app reminder is unavailable. Please try again."));
        });
      });
    }
  }
  function showImmunizationPlanner() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("immunization_reminders");
    $("slidetitle").textContent = t("tx.feature_immunization_reminders");
    $("slideimage").innerHTML = renderVisual("immunization_reminders", card ? card.imageDesc : "Caregiver checking a vaccine card with a local clinic reminder.");
    setSlideText(tx("tx.tool_immunization_reminders_body", "Save the vaccine-visit date written on the child's vaccine card or given by the clinic. The reminder will appear on Home in this app."));
    renderImmunizationPlanner();
  }
  function renderPncReminderPlanner() {
    var today = localDateValue(new Date());
    $("slidecache").innerHTML =
      '<div class="progress-panel"><strong>' + esc(tx("tx.pnc_reminders.use_the_visit_date_from")) + '</strong><p>' + esc(tx("tx.pnc_reminders.bring_the_mother_and_baby")) + '</p></div>' +
      '<div class="slidecontrols"><label>Day to show the reminder <input id="pncreminderdate" type="date" min="' + esc(today) + '"></label><button id="pncplan" type="button">' + esc(tx("tx.pnc_reminders.save_mother_and_baby_visit")) + '</button><div id="pncnudgestatus" hidden></div><button class="ghost" id="pncurgent" type="button">' + esc(tx("tx.pnc_reminders.mother_or_baby_is_unwell")) + '</button><button class="ghost" id="pncfeedinghelp" type="button">' + esc(tx("tx.pnc_reminders.get_breastfeeding_help")) + '</button></div>' +
      reviewDetailsHtml("pnc_reminders", "PNC reminder planner. The caregiver supplies a locally confirmed visit date.") +
      trackerContractHtml("pnc_reminders");
    var plan = $("pncplan"), urgent = $("pncurgent"), feeding = $("pncfeedinghelp");
    if (plan && !plan.dataset.bound) {
      plan.dataset.bound = "pnc";
      plan.addEventListener("click", function () {
        var dateInput = $("pncreminderdate");
        setNudgeStatus("pncnudgestatus", tx("tx.reminder.saving", "Saving your reminder..."), tx("tx.reminder.saving_detail", "Mamma is applying your reminder and quiet-hours settings."));
        requestInAppReminder({
          moduleId: "pnc_reminders",
          topic: "mother_baby_visit",
          dateValue: dateInput && dateInput.value,
          privacyClass: "sensitive_topic",
          startTime: "08:00",
          endTime: "18:00"
        }).then(function (decision) {
          if (decision.action === "scheduled" || decision.action === "bundled") {
            setNudgeStatus("pncnudgestatus", tx("tx.reminder.saved", "Mamma saved your reminder."), tx("tx.reminder.home_detail", "Mamma now shows it on Home and follows your quiet-hours settings. Keep this app open when you need to see it."));
            setSlideText(tx("tx.tool_pnc_reminders.saved", "Mamma now shows your mother-and-baby visit reminder on Home. Do not wait for the visit if the mother or baby becomes unwell."));
          } else {
            setNudgeStatus("pncnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), tx("tx.reminder.try_date_again", "Choose another future date and try again."));
          }
        }).catch(function (error) {
          setNudgeStatus("pncnudgestatus", tx("tx.reminder.not_saved", "The app did not save the reminder."), error && error.message ? error.message : tx("tx.reminder.unavailable", "The in-app reminder is unavailable. Please try again."));
        });
      });
    }
    if (urgent && !urgent.dataset.bound) {
      urgent.dataset.bound = "pnc";
      urgent.addEventListener("click", function () { beginDangerFlow(); });
    }
    if (feeding && !feeding.dataset.bound) {
      feeding.dataset.bound = "pnc";
      feeding.addEventListener("click", function () { openLaunch("screen.breastfeeding_aid_triage", t("tx.feature_breastfeeding_aid_triage")); });
    }
  }
  function showPncReminderPlanner() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("pnc_reminders");
    $("slidetitle").textContent = t("tx.feature_pnc_reminders");
    $("slideimage").innerHTML = renderVisual("pnc_reminders", card ? card.imageDesc : "New mother and baby visit checklist with CHW or clinic contact.");
    setSlideText(tx("tx.tool_pnc_reminders_body", "Save the mother-and-baby visit date given by the clinic or health worker. Use urgent checks now if the mother or baby is unwell; do not wait for a routine visit."));
    renderPncReminderPlanner();
  }
  function renderChannelTwinsPreview() {
    $("slidecache").innerHTML = traceDetails("Review details", "Message channel review only. This preview sends no SMS, IVR, WhatsApp, CHW dispatch, or outbound message. CODEX Decision - needs approval. " + provenanceSummary("channel_twins_preview") + assetSummary("channel_twins_preview") + contractSummary("channel_twins_preview")) + '<div class="slidecontrols"><label><input id="twinsapp" type="checkbox"> app card</label><label><input id="twinssms" type="checkbox"> SMS copy</label><label><input id="twinsivr" type="checkbox"> IVR prompt</label><label><input id="twinswa" type="checkbox"> WhatsApp flow</label><label><input id="twinschw" type="checkbox"> CHW script</label><button id="twinsreview" type="button">Review message examples</button></div>';
    if ($("twinsreview")) {
      $("twinsreview").addEventListener("click", function () {
        var ids = ["twinsapp", "twinssms", "twinsivr", "twinswa", "twinschw"];
        var names = { twinsapp: "app card", twinssms: "SMS", twinsivr: "IVR", twinswa: "WhatsApp", twinschw: "CHW script" };
        var selected = selectedChecklistItems(ids, names).checked.map(function (id) { return names[id]; });
        var label = selected.length === 5 ? "app card, SMS, IVR, WhatsApp, and CHW script" : (selected.join(", ") || "no channels selected yet");
        setSlideResult({
          kind: "home",
          title: "Your message-channel review",
          nextAction: "Keep the same approved safety, privacy, opt-out, and local-language meaning in every selected channel.",
          paragraphs: [tx("tx.tool_channel_twins.summary", "Review these message examples from approved source content: {selectedChannels}. Keep danger wording, privacy wording, opt-out wording, and local-language review together before anyone releases a channel. This page sends nothing.", { selectedChannels: label })]
        });
        $("slideimage").classList.add("hidden");
        $("slidecache").innerHTML = '<div class="slidecontrols"><button id="twinsreviewagain" type="button">Review channels again</button></div>' + reviewDetailsHtml("channel_twins_preview", "Message channel review only. This page sends nothing.");
        bindWorkReviewAgain($("twinsreviewagain"), function () {
          $("slideimage").classList.remove("hidden");
          setSlideText(tx("tx.tool_channel_twins_body", "Review message examples for one topic across an app card, SMS, IVR prompt, WhatsApp flow, and CHW script. This page sends nothing."));
          renderChannelTwinsPreview();
          moveToNextStep("slidecache");
        }, "channel-review");
      });
    }
  }
  function showChannelTwinsPreview() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("channel_twins_preview");
    $("slidetitle").textContent = t("tx.feature_channel_twins_preview");
    $("slideimage").innerHTML = renderVisual("channel_twins_preview", card ? card.imageDesc : "Message examples across app card, SMS, IVR, WhatsApp, and CHW script.");
    setSlideText(tx("tx.tool_channel_twins_body", "Review message examples for one topic across an app card, SMS, IVR prompt, WhatsApp flow, and CHW script. This page sends nothing."));
    renderChannelTwinsPreview();
  }
  function renderReferralFollowupQueue() {
    $("slidecache").innerHTML = reviewDetailsHtml("referral_followup_queue", t("tx.tool_referral_followup.prototype_note")) + '<div class="slidecontrols checklist-controls"><fieldset class="symptom-group"><legend>' + esc(t("tx.tool_referral_followup.legend")) + '</legend><label><input id="referraldanger" type="checkbox"> ' + esc(t("tx.tool_referral_followup.option_danger")) + '</label><label><input id="referralors" type="checkbox"> ' + esc(t("tx.tool_referral_followup.option_ors")) + '</label><label><input id="referralcontact" type="checkbox"> ' + esc(t("tx.tool_referral_followup.option_contact")) + '</label><label><input id="referralfailed" type="checkbox"> ' + esc(t("tx.tool_referral_followup.option_failed")) + '</label><label><input id="referralconflict" type="checkbox"> ' + esc(t("tx.tool_referral_followup.option_conflict")) + '</label><label><input id="referralresolved" type="checkbox"> ' + esc(t("tx.tool_referral_followup.option_resolved")) + '</label></fieldset><button id="referralreview" type="button">' + esc(t("tx.tool_referral_followup.action_review")) + '</button><button class="ghost" id="referralretry" type="button">' + esc(t("tx.tool_referral_followup.action_retry")) + '</button><button class="ghost" id="referralcancel" type="button">' + esc(t("tx.tool_referral_followup.action_cancel")) + '</button><p class="muted" id="referralqueuefeedback">' + esc(t("tx.tool_referral_followup.status_saved")) + "</p></div>";
    if ($("referralreview")) {
      $("referralreview").addEventListener("click", function () {
        var reasons = [];
        if ($("referraldanger").checked) reasons.push("danger referral");
        if ($("referralors").checked) reasons.push("ORS and zinc follow-up");
        if ($("referralcontact").checked) reasons.push("CHW contact attempt");
        if ($("referralfailed").checked) reasons.push("failed message retry");
        if ($("referralconflict").checked) reasons.push("conflict review");
        if ($("referralresolved").checked) {
          setSlideText(tx("tx.tool_referral_followup.closed", "Referral follow-up closure note: went to clinic or issue resolved. Keep original risk history visible for audit, and record who confirmed closure before closing a real referral. This prototype sends no live message or facility update."));
          $("referralqueuefeedback").textContent = t("tx.tool_referral_followup.status_closed");
        } else {
          setSlideText(tx("tx.tool_referral_followup.open", "Referral follow-up task opened for {selectedReasons}; record call/visit status as unresolved until a caregiver, CHW, or facility status is reviewed. No live messaging or call/visit is triggered by this prototype.", { selectedReasons: reasons.join(", ") || "selected risk event" }));
          $("referralqueuefeedback").textContent = t("tx.tool_referral_followup.status_open");
        }
      });
    }
    if ($("referralretry")) {
      $("referralretry").addEventListener("click", function () {
        setSlideText(tx("tx.tool_referral_followup.retry", "Retry queued.\nA real app would ask Messaging to send the failed messages again.\nThis demo only records the request on this phone."));
        $("referralqueuefeedback").textContent = t("tx.tool_referral_followup.status_retry");
      });
    }
    if ($("referralcancel")) {
      $("referralcancel").addEventListener("click", function () {
        setSlideText(tx("tx.tool_referral_followup.cancel", "Task canceled in prototype mode. A real queue would keep the audit trail, who canceled it, and why it was safe to close."));
        $("referralqueuefeedback").textContent = t("tx.tool_referral_followup.status_cancel");
      });
    }
  }
  function showReferralFollowupQueue() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("referral_followup_queue");
    $("slidetitle").textContent = t("tx.feature_referral_followup_queue");
    $("slideimage").innerHTML = renderVisual("referral_followup_queue", card ? card.imageDesc : "Caregiver and health worker at a clinic doorway with contact card, phone, saved status, retry, and closure cues.");
    setSlideText(tx("tx.tool_referral_followup_body", "Keep track of whether care was reached after an urgent result or an ORS and zinc request. This screen saves example tasks on this phone only. It does not place calls, send messages, or contact a facility."));
    renderReferralFollowupQueue();
  }
  function renderSharedPhonePrivacyMode() {
    $("slidecache").innerHTML = reviewDetailsHtml("shared_phone_privacy_mode", t("tx.tool_shared_phone_privacy.prototype_note")) + '<div class="slidecontrols checklist-controls"><fieldset class="symptom-group"><legend>' + esc(t("tx.tool_shared_phone_privacy.subject_legend")) + '</legend><label>' + esc(t("tx.tool_shared_phone_privacy.subject_label")) + ' <select id="privacysubject"><option value="me">' + esc(t("tx.tool_shared_phone_privacy.subject_me")) + '</option><option value="child">' + esc(t("tx.tool_shared_phone_privacy.subject_child")) + '</option><option value="someone_else">' + esc(t("tx.tool_shared_phone_privacy.subject_someone_else")) + '</option></select></label></fieldset><fieldset class="symptom-group"><legend>' + esc(t("tx.tool_shared_phone_privacy.before_saving")) + '</legend><label><input id="privacyshared" type="checkbox"> ' + esc(t("tx.tool_shared_phone_privacy.option_shared")) + '</label><label><input id="privacyhide" type="checkbox"> ' + esc(t("tx.tool_shared_phone_privacy.option_hide")) + '</label><label><input id="privacynotification" type="checkbox"> ' + esc(t("tx.tool_shared_phone_privacy.option_notification")) + '</label><label><input id="privacylocal" type="checkbox"> ' + esc(t("tx.tool_shared_phone_privacy.option_local")) + '</label><label><input id="privacyexport" type="checkbox"> ' + esc(t("tx.tool_shared_phone_privacy.option_export")) + '</label></fieldset><button id="privacyreview" type="button">' + esc(t("tx.tool_shared_phone_privacy.action_record")) + '</button><button class="ghost" id="privacyexportbtn" type="button">' + esc(t("tx.tool_shared_phone_privacy.action_export")) + '</button><button class="ghost" id="privacydeletebtn" type="button">' + esc(t("tx.tool_shared_phone_privacy.action_delete")) + '</button><p class="muted" id="privacyfeedback">' + esc(t("tx.tool_shared_phone_privacy.status_empty")) + "</p></div>";
    if ($("privacyreview")) {
      $("privacyreview").addEventListener("click", function () {
        var protections = [];
        var subjectNames = { me: t("tx.tool_shared_phone_privacy.subject_me_lower"), child: t("tx.tool_shared_phone_privacy.subject_child_lower"), someone_else: t("tx.tool_shared_phone_privacy.subject_someone_else_lower") };
        var subject = subjectNames[$("privacysubject").value] || "me";
        if ($("privacyshared").checked) protections.push("shared-phone warning");
        if ($("privacyhide").checked) protections.push("quick hide and private labels");
        if ($("privacynotification").checked) protections.push("notification wording");
        if ($("privacylocal").checked) protections.push("local-only storage");
        if ($("privacyexport").checked) protections.push("user-owned export and opt-out");
        setSlideText(tx("tx.tool_shared_phone_privacy.summary", "Shared phone privacy choices for {subject}: {selectedProtections}. Use quick hide, private labels, neutral notification wording, opt-out, local-only storage, and user-owned export before saving sensitive information.", { subject: subject, selectedProtections: protections.join(", ") || "no protection selected yet" }));
        $("privacyfeedback").textContent = tx("tx.tool_shared_phone_privacy.status_recorded", "Consent choice recorded locally for {subject}. A released app would use the approved account and privacy system.", { subject: subject });
      });
    }
    if ($("privacyexportbtn")) {
      $("privacyexportbtn").addEventListener("click", function () {
        setSlideText(tx("tx.tool_shared_phone_privacy.export", "Export explanation: show what private entries exist, who they belong to, and how to save a user-owned copy. This demo has no private records to export."));
        $("privacyfeedback").textContent = t("tx.tool_shared_phone_privacy.status_export");
      });
    }
    if ($("privacydeletebtn")) {
      $("privacydeletebtn").addEventListener("click", function () {
        setSlideText(tx("tx.tool_shared_phone_privacy.delete", "Delete explanation:\n- Check who the person is.\n- Tell the user which entries you will remove.\n- Keep the review record you must keep.\n- Then delete the local private entries.\nThis demo has no private records to delete."));
        $("privacyfeedback").textContent = t("tx.tool_shared_phone_privacy.status_delete");
      });
    }
  }
  function showSharedPhonePrivacyMode() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("shared_phone_privacy_mode");
    $("slidetitle").textContent = t("tx.feature_shared_phone_privacy_mode");
    $("slideimage").innerHTML = renderVisual("shared_phone_privacy_mode", card ? card.imageDesc : "Shared phone with shield, quick-hide cue, neutral notification, private labels, opt-out, export, and delete choices.");
    setSlideText(tx("tx.tool_shared_phone_privacy_body", "Keep private pages safe on a phone other people use.\nChoose these before you save anything private:\n- Quick hide.\n- Private labels.\n- Reminders that do not say why.\n- Saving on this phone only.\n- How to copy out or delete your entries."));
    renderSharedPhonePrivacyMode();
  }
  function renderPartnerServiceDashboard() {
    $("slidecache").innerHTML = reviewDetailsHtml("partner_service_dashboard", "Partner service dashboard. Aggregate synthetic dashboard only.") + '<div class="slidecontrols"><label><input id="dashaggregate" type="checkbox"> aggregate counts only</label><label><input id="dashsource" type="checkbox"> source/approval status</label><label><input id="dashreferral" type="checkbox"> unresolved referrals</label><label><input id="dashlanguage" type="checkbox"> language readiness</label><button id="dashreview" type="button">Review dashboard signals</button></div>';
    if ($("dashreview")) {
      $("dashreview").addEventListener("click", function () {
        var signals = [];
        if ($("dashaggregate").checked) signals.push("aggregate only");
        if ($("dashsource").checked) signals.push("source/approval status");
        if ($("dashreferral").checked) signals.push("unresolved referrals");
        if ($("dashlanguage").checked) signals.push("language readiness");
        setSlideResult({
          kind: "home",
          title: "Your dashboard-signal review",
          nextAction: "Use only aggregate synthetic signals until reviewers approve access, security, partner, and data-sharing controls.",
          paragraphs: [tx("tx.tool_partner_dashboard.summary", "Partner service dashboard summary: {selectedSignals}.\nShow channel performance and service feedback as grouped synthetic signals only.\nReal data waits for partner agreements, role-based access, server security, and data-sharing review.\nNo tracking of individual people is switched on.", { selectedSignals: signals.join(", ") || "no dashboard signal selected yet" })]
        });
        $("slideimage").classList.add("hidden");
        $("slidecache").innerHTML = '<div class="slidecontrols"><button id="dashreviewagain" type="button">Review dashboard signals again</button></div>' + reviewDetailsHtml("partner_service_dashboard", "Partner service dashboard. Aggregate synthetic dashboard only.");
        bindWorkReviewAgain($("dashreviewagain"), function () {
          $("slideimage").classList.remove("hidden");
          setSlideText(tx("tx.tool_partner_dashboard_body", "Partner service dashboard for aggregate synthetic operational signals: source/approval status, language readiness, unresolved referrals, channel performance, and service feedback."));
          renderPartnerServiceDashboard();
          moveToNextStep("slidecache");
        }, "dashboard-review");
      });
    }
  }
  function showPartnerServiceDashboard() {
    activeSlides = [];
    showPanel("slideshow");
    var card = cardByFeature("partner_service_dashboard");
    $("slidetitle").textContent = t("tx.feature_partner_service_dashboard");
    $("slideimage").innerHTML = renderVisual("partner_service_dashboard", card ? card.imageDesc : "Health worker and supervisor reviewing privacy-safe aggregate charts for source status, language readiness, referral closure, and service quality.");
    setSlideText(tx("tx.tool_partner_dashboard_body", "Partner service dashboard for aggregate synthetic operational signals: source/approval status, language readiness, unresolved referrals, channel performance, and service feedback."));
    renderPartnerServiceDashboard();
  }
  function showToolCard(featureId) {
    if (featureId === "zinc_tracker") {
      showZincTracker();
      return;
    }
    if (featureId === "anc_birth_plan") {
      showAncBirthPlanChecklist();
      return;
    }
    if (featureId === "breastfeeding_audio") {
      showBreastfeedingHelper();
      return;
    }
    if (featureId === "immunization_reminders") {
      showImmunizationPlanner();
      return;
    }
    if (featureId === "pnc_reminders") {
      showPncReminderPlanner();
      return;
    }
    if (featureId === "kmc_timer") {
      showKmcTimer();
      return;
    }
    if (featureId === "family_preparedness") {
      showFamilyPreparednessChecklist();
      return;
    }
    if (featureId === "chronic_refill_tracker") {
      showChronicRefillTracker();
      return;
    }
    if (featureId === "labor_clock") {
      showLaborClock();
      return;
    }
    if (featureId === "bednet_hanging_reminder") {
      showBednetReminder();
      return;
    }
    if (featureId === "dehydration_visual_guide") {
      showDehydrationGuide();
      return;
    }
    if (featureId === "complementary_feeding_card") {
      showComplementaryFeedingCard();
      return;
    }
    if (featureId === "chlorine_dose_helper") {
      showChlorineDoseHelper();
      return;
    }
    if (featureId === "sanitation_checklist") {
      showSanitationChecklist();
      return;
    }
    if (featureId === "channel_twins_preview") {
      showChannelTwinsPreview();
      return;
    }
    if (featureId === "referral_followup_queue") {
      showReferralFollowupQueue();
      return;
    }
    if (featureId === "shared_phone_privacy_mode") {
      showSharedPhonePrivacyMode();
      return;
    }
    if (featureId === "partner_service_dashboard") {
      showPartnerServiceDashboard();
      return;
    }
    if (featureId === "chlorine_contact_timer") {
      showChlorineContactTimer();
      return;
    }
    if (featureId === "boil_water_timer") {
      showBoilWaterTimer();
      return;
    }
    if (featureId === "cholera_hotspot_alert") {
      showCholeraHotspotAlert();
      return;
    }
    if (featureId === "handwashing_timer") {
      showHandwashingCoach();
      return;
    }
    var card = cardByFeature(featureId);
    var feature = byId(catalog.features, featureId);
    if (!card) {
      showPrototypeCard(feature ? t(feature.titleSlug) : featureId, prototypeUnavailableBody(), tx("tx.prototype.unavailable.visual", "This activity is not available in the current prototype build."), featureId, "Missing tool card for " + featureId);
      return;
    }
    activeSlides = [];
    showPanel("slideshow");
    $("slidetitle").textContent = t(card.titleSlug);
    $("slideimage").innerHTML = renderVisual(featureId, card.imageDesc);
    var metric = "";
    if (card.durationSeconds) metric = " Timer target: " + card.durationSeconds + " seconds.";
    if (card.durationMinutes) metric = " Timer target: " + card.durationMinutes + " minute" + (card.durationMinutes === 1 ? "" : "s") + ".";
    if (card.courseDays) metric = " Course tracker: " + card.courseDays + "-day check-off.";
    if (card.kind === "console") metric = qualitySummary();
    setSlideText(t(card.bodySlug) + metric);
    $("slidecache").innerHTML = reviewerDetails(card.cacheNote + " " + card.governanceStatus + "." + provenanceSummary(featureId) + assetSummary(featureId) + contractSummary(featureId));
  }
  function showStoryCard(featureId) {
    var card = storyByFeature(featureId);
    var feature = byId(catalog.features, featureId);
    if (!card) {
      showPrototypeCard(feature ? t(feature.titleSlug) : featureId, prototypeUnavailableBody(), tx("tx.prototype.unavailable.visual", "This activity is not available in the current prototype build."), featureId, "Missing story card for " + featureId);
      return;
    }
    showSlides(storyCardToSlides(card));
  }
  // Kept as the registry's named entry point; the screen itself is template T3 data now.
  function renderKohlLeadChecklist() {
    renderRegistryChecklistScreen("kohl_lead.main");
  }
  function showKohlLeadChecklist() {
    activeSlides = [];
    showPanel("slideshow");
    var card = screenByFeature("kohl_lead_screen");
    $("slidetitle").textContent = t("tx.feature_kohl_lead_screen");
    $("slideimage").innerHTML = renderVisual("kohl_lead_screen", card ? card.imageDesc : "Kohl or kajal container marked as a possible lead-risk item, away from children.");
    setSlideText(tx("tx.screen_kohl_body", "Some kohl, kajal, surma, or similar eye products may contain lead. This exposure checklist supports stopping use, keeping products away from children, and asking about blood lead testing."));
    renderKohlLeadChecklist();
  }
  // Registry entry point; the screen is template T3 data now.
  function renderChildVisionChecklist(checkedIds) {
    renderRegistryChecklistScreen("child_vision.main", checkedIds);
  }
  function showChildVisionChecklist() {
    activeSlides = [];
    // The template owns the selection state, so opening the screen clears it.
    resetRegistryChecklist("child_vision.main");
    showPanel("slideshow");
    var card = screenByFeature("child_vision_screen");
    $("slidetitle").textContent = t("tx.feature_child_vision_screen");
    $("slideimage").innerHTML = renderVisual("child_vision_screen", card ? card.imageDesc : "School-age child looking at a board with eye-check and clinic icons.");
    setSlideText(tx("tx.screen_vision_body", "About the child\'s eyes and sight."));
    renderChildVisionChecklist();
  }
  // Registry entry point; the screen is template T3 data now.
  function renderChildHearingChecklist(checkedIds) {
    renderRegistryChecklistScreen("child_hearing.main", checkedIds);
  }
  function showChildHearingChecklist() {
    activeSlides = [];
    // The template owns the selection state, so opening the screen clears it.
    resetRegistryChecklist("child_hearing.main");
    showPanel("slideshow");
    var card = screenByFeature("child_hearing_screen");
    $("slidetitle").textContent = t("tx.feature_child_hearing_screen");
    $("slideimage").innerHTML = renderVisual("child_hearing_screen", card ? card.imageDesc : "Child listening to a soft sound with hearing-screen and specialist icons.");
    setSlideText(tx("tx.screen_hearing_body", "About the child\'s hearing and speech."));
    renderChildHearingChecklist();
  }
  // Kept as the registry's named entry point; the screen itself is template T3 data now.
  function renderPregnancyUrgentIntake(person) {
    renderRegistryChecklistScreen("pregnancy.urgent", null, { person: person });
  }
  function showPregnancyUrgentIntake(person) {
    activeSlides = [];
    resetRegistryChecklist("pregnancy.urgent");
    activeShellTitle = tx("tx.urgent_pregnancy.title", "Pregnancy urgent check");
    showPanel("slideshow");
    $("slidetitle").textContent = activeShellTitle;
    $("slideimage").innerHTML = renderVisual("anc_triage", "Pregnant person with clinic card, transport plan, contraction timer, and separate warning-sign icons without implying diagnosis.");
    setSlideText(tx("tx.urgent_pregnancy.intro", "What is happening to {personName} right now?", { personName: person ? person.name : "the pregnant person" }));
    renderPregnancyUrgentIntake(person);
  }
  // Kept as the registry's named entry point; the screen itself is template T3 data now.
  function renderPregnancyDangerChecklist() {
    renderRegistryChecklistScreen("pregnancy.catalog");
  }
  function showPregnancyDangerChecklist() {
    activeSlides = [];
    resetRegistryChecklist("pregnancy.catalog");
    showPanel("slideshow");
    var card = screenByFeature("anc_triage");
    $("slidetitle").textContent = t("tx.feature_anc_triage");
    $("slideimage").innerHTML = renderVisual("anc_triage", card ? card.imageDesc : "Pregnant person holding a phone and clinic card with urgent warning signs.");
    setSlideText(tx("tx.screen_anc_body", "What is happening to you right now?"));
    renderPregnancyDangerChecklist();
  }
  function pncConcernNames() {
    return {
      pncacutenone: "no acute danger signs",
      pncacutemorenone: "no additional urgent signs",
      pncbleeding: "heavy bleeding or pads are soaking quickly",
      pncclots: "large blood clots came out",
      pncplacenta: "pieces of placenta or membrane came out after birth",
      pncsmelldischarge: "discharge smells bad after birth",
      pncbreathing: "trouble breathing",
      pncchestpain: "chest pain",
      pncfastheart: "heartbeat feels very fast or pounding",
      pncdizzyfaint: "dizziness or fainting",
      pncheadvision: "severe headache or vision changes",
      pncbellypain: "severe belly pain",
      pncswelling: "severe swelling of the face, hands, or legs",
      pncfeverbreast: "fever, weakness, or breast red/pain with feeling ill",
      pncbabyfeeding: "baby is feeding poorly or not feeding",
      pncbabywake: "caregiver cannot wake the baby for feeding",
      pncprivate: "private-parts, discharge, wound, or urination concern",
      pnccoughfeverdiarrhea: "cough, fever, diarrhoea, vomiting, or getting weaker",
      pncharm: "thoughts of harm or feeling unsafe",
      pncother: "something else worries me",
      pncnone: "none of these"
    };
  }
  function pncAcuteIds() {
    return ["pncbleeding", "pncclots", "pncplacenta", "pncsmelldischarge", "pncbreathing", "pncchestpain", "pncfastheart", "pncdizzyfaint", "pncheadvision", "pncbellypain", "pncswelling", "pncother"];
  }
  function pncImmediateIds() {
    return ["pncbleeding", "pncclots", "pncplacenta", "pncbreathing", "pncchestpain", "pncdizzyfaint", "pncother"];
  }
  function pncAdditionalAcuteIds() {
    return ["pncsmelldischarge", "pncfastheart", "pncheadvision", "pncbellypain", "pncswelling", "pncother"];
  }
  function pncAcuteDangerIds() {
    return ["pncbleeding", "pncclots", "pncplacenta", "pncsmelldischarge", "pncbreathing", "pncchestpain", "pncfastheart", "pncdizzyfaint", "pncheadvision", "pncbellypain", "pncswelling"];
  }
  function pncAcuteAnswered() {
    return !!(pncAnsweredViews.acute && pncAnsweredViews.acute_more);
  }
  function pncCurrentViewAnswered() {
    var screen = clinicalScreen("postpartum." + pncView);
    return !!pncAnsweredViews[pncView] &&
      screen.options.some(function (option) { return !!pncSelections[option.stateId || option.id]; });
  }
  function updatePncAcuteGate() {
    var answered = pncAcuteAnswered();
    ["breast", "private", "illness", "mood", "other"].forEach(function (view) {
      var nav = $("pncnav_" + view);
      if (nav) nav.disabled = !answered;
    });
  }
  function pncResultTitle() {
    if (pncSelections.pncharm) return tx("tx.screen_pnc.title_safety", "Safety support now");
    if (pncSelections.pncbabyfeeding || pncSelections.pncbabywake) return tx("tx.screen_pnc.title_newborn_feeding", "Urgent newborn feeding help");
    if (pncSelections.pncprivate) return tx("tx.screen_pnc.title_private", "Private-parts or discharge concern");
    if (pncSelections.pncbleeding || pncSelections.pncclots || pncSelections.pncplacenta || pncSelections.pncsmelldischarge) return tx("tx.screen_pnc.title_bleeding", "Bleeding or discharge after birth");
    if (pncSelections.pncbreathing || pncSelections.pncchestpain || pncSelections.pncfastheart || pncSelections.pncdizzyfaint) return tx("tx.screen_pnc.title_breathing", "Breathing or chest concern");
    if (pncSelections.pncheadvision || pncSelections.pncbellypain || pncSelections.pncswelling) return tx("tx.screen_pnc.title_headvision", "Headache, vision, pain, or swelling");
    if (pncSelections.pncfeverbreast) return tx("tx.screen_pnc.title_breast", "Breast pain or fever concern");
    if (pncSelections.pnccoughfeverdiarrhea) return tx("tx.screen_pnc.title_illness", "Illness concern after birth");
    if (pncSelections.pncother) return tx("tx.screen_pnc.title_other", "Other concern after birth");
    return tx("tx.screen_pnc.title_default", "Concern check after birth");
  }
  function pncReviewSelection(ids) {
    var names = pncConcernNames();
    var checked = Object.keys(pncSelections).filter(function (id) { return !!pncSelections[id]; });
    var decisionChecked = checked.filter(function (id) { return id !== "pncnone" && id !== "pncacutenone" && id !== "pncacutemorenone"; });
    var decision = screenDecision("pnc_lactation", decisionChecked);
    var nonNoneChecked = checked.filter(function (id) { return id !== "pncnone" && id !== "pncacutenone" && id !== "pncacutemorenone"; });
    var selectedNames = nonNoneChecked.map(function (id) { return names[id]; }).join(", ") || "no danger sign selected";
    if (pncSelections.pncharm) {
      setSlideResult({
        kind: "refer",
        careRoute: "postpartum_clinic",
        severity: decision.severity,
        title: pncResultTitle(),
        paragraphs: [tx("tx.screen_pnc.harm", "Seek trusted emergency or crisis support now for thoughts of harm or feeling unsafe. Keep the mother and baby with a trusted helper if possible.")],
        nextAction: tx("tx.result.action_postpartum_safety", "Get trusted emergency, crisis, or urgent after-birth support now.")
      });
    } else if (pncSelections.pncbabyfeeding || pncSelections.pncbabywake) {
      setSlideResult({
        kind: "refer",
        careRoute: "newborn_clinic",
        severity: decision.severity,
        title: pncResultTitle(),
        paragraphs: [tx("tx.screen_pnc.newborn_feeding", "Get urgent newborn care now if you see any of these:\n- The baby feeds poorly.\n- The baby does not feed.\n- You cannot wake the baby to feed.\nBring the mother and baby together if you can.\nSay that the baby is newborn, and that the mother gave birth recently.")]
      });
    } else if (pncSelections.pncother && nonNoneChecked.length === 1) {
      setSlideResult({
        kind: "home",
        careRoute: "professional",
        title: pncResultTitle(),
        paragraphs: [friendlyOtherMessage()]
      });
    } else if (nonNoneChecked.length) {
      setSlideResult({
        kind: "refer",
        careRoute: "postpartum_clinic",
        severity: decision.severity,
        title: pncResultTitle(),
        paragraphs: (pncSelections.pncother ? [friendlyOtherMessage()] : []).concat([tx("tx.screen_pnc.urgent", "Selected signs: {selectedSigns}. Seek urgent care now. When asking for help, say that the person recently gave birth.", { selectedSigns: selectedNames })])
      });
    } else if (pncSelections.pncnone) {
      setSlideResult({
        kind: "home",
        title: tx("tx.screen_pnc.title_none", "No listed danger sign after birth"),
        paragraphs: [tx("tx.screen_pnc.none_checked", "None of these selected. Keep the mother and baby visit plan visible and seek care if anything changes or you remain concerned.")],
        nextAction: tx("tx.result.action_watch_safety", "Keep watching and seek help if a danger sign appears.")
      });
    } else {
      setSlideResult({
        kind: "home",
        title: tx("tx.screen_pnc.title_default", "Concern check after birth"),
        paragraphs: [tx("tx.screen_pnc.no_urgent", "You chose no danger sign for the mother after birth.\nKeep the feeding help and the local after-birth plan nearby.\nGet care quickly if you see any of these:\n- Heavy bleeding.\n- Discharge that smells bad.\n- Trouble breathing, or chest pain.\n- Bad headache, or a change in her sight.\n- Fever.\n- A red or painful breast, with feeling ill.\n- The baby feeds poorly.\n- You cannot wake the baby to feed.\n- She feels unsafe.")],
        nextAction: tx("tx.result.action_watch_safety", "Keep watching and seek help if a danger sign appears.")
      });
    }
    $("slideimage").classList.add("hidden");
    $("slidecache").innerHTML =
      '<div class="slidecontrols"><button id="pncdangerreviewagain" type="button">Review postpartum concerns again</button></div>' +
      traceDetails("Review details", "Postpartum danger-check result. The app replaces the submitted choices with the result so the caregiver does not mistake a rebuilt checklist for feedback. " + provenanceSummary("pnc_lactation") + assetSummary("pnc_lactation") + contractSummary("pnc_lactation"));
    var again = $("pncdangerreviewagain");
    bindWorkReviewAgain(again, function () {
      $("slideimage").classList.remove("hidden");
      pncView = "acute";
      pncSelections = {};
      pncAnsweredViews = {};
      setSlideText(tx("tx.screen_pnc_lactation_body", "Choose the concern area below. The app will ask focused urgent questions."));
      renderPncLactationDangerChecklist();
      moveToNextStep("slidecache");
    }, "pncdanger");
    moveToNextStep("slidetext");
  }
  function renderPncLactationDangerChecklist() {
    var reviewText = "Postpartum and lactation danger checklist - conservative referral support only. No diagnosis, no medicine advice, no mastitis treatment, and no breastfeeding replacement decision. CODEX Decision - needs approval." + provenanceSummary("pnc_lactation") + assetSummary("pnc_lactation") + contractSummary("pnc_lactation");
    var surfaceId = "postpartum." + pncView;
    // Slugs written out rather than assembled from the view name. A computed slug cannot be resolved
    // by tools/validate.mjs, so building one here would add a third family the check has to be told
    // to ignore - trading a checked reference for an unchecked one to save five lines.
    var categoryButtons = [
      ["breast", "tx.postpartum.nav_breast"],
      ["private", "tx.postpartum.nav_private"],
      ["illness", "tx.postpartum.nav_illness"],
      ["mood", "tx.postpartum.nav_mood"],
      ["other", "tx.postpartum.nav_other"]
    ].map(function (pair) {
      return '<button class="ghost pnc-nav" id="pncnav_' + pair[0] + '" type="button">' + esc(tx(pair[1])) + '</button>';
    }).join("");
    $("slidecache").innerHTML = renderClinicalChecklist(surfaceId, {
      selected: pncSelections,
      beforeFieldsHtml: pncView !== "acute" && pncView !== "acute_more" ? '<button class="ghost" id="pncnav_acute" type="button">' + esc(tx("tx.postpartum_private.back_to_acute_signs")) + '</button>' : "",
      afterFieldsHtml: pncView === "acute_more" ? '<div class="segmented pnc-categories">' + categoryButtons + "</div>" : ""
    }) +
      traceDetails("Review details", reviewText);
    var ids = bindClinicalChecklist(surfaceId, {
      state: pncSelections,
      onChange: function () {
        pncAnsweredViews[pncView] = true;
        updatePncAcuteGate();
      }
    }).ids;
    ["acute", "breast", "private", "illness", "mood", "other"].forEach(function (view) {
      var nav = $("pncnav_" + view);
      if (nav && !nav.dataset.bound) {
        nav.dataset.bound = "pncdanger";
        nav.addEventListener("click", function () {
          if (!pncAcuteAnswered() && view !== "acute") { updatePncAcuteGate(); return; }
          if (view === "breast") { showBreastfeedingAidTriage("triage"); return; }
          pncView = view;
          renderPncLactationDangerChecklist();
        });
      }
    });
    var review = $(clinicalScreen(surfaceId).actionId);
    if (review && !review.dataset.bound) {
      review.dataset.bound = "pncdanger";
      review.addEventListener("click", function () {
        if (!pncCurrentViewAnswered()) { updatePncAcuteGate(); return; }
        if (pncView === "acute") {
          var immediateConcern = pncImmediateIds().some(function (id) { return !!pncSelections[id]; });
          if (immediateConcern) { pncReviewSelection(ids); return; }
          pncView = "acute_more";
          renderPncLactationDangerChecklist();
          moveToNextStep("slidecache");
          return;
        }
        pncReviewSelection(ids);
      });
    }
    updatePncAcuteGate();
  }
  function showPncLactationDangerChecklist() {
    activeSlides = [];
    activeShellTitle = tx("tx.screen_pnc.main_title", "Urgent checks after birth, for mother and baby");
    showPanel("slideshow");
    var card = screenByFeature("pnc_lactation");
    pncView = "acute";
    pncSelections = {};
    pncAnsweredViews = {};
    $("slidetitle").textContent = activeShellTitle;
    $("slideimage").innerHTML = renderVisual("pnc_lactation", card ? card.imageDesc : "Postpartum parent and newborn with breastfeeding support and urgent warning signs.");
    setSlideText(tx("tx.screen_pnc_lactation_body", "Choose the concern area below. The app will ask focused urgent questions."));
    renderPncLactationDangerChecklist();
  }
  function renderNewbornDangerChecklist() {
    var reviewText = "Newborn danger checklist - conservative referral support only. No diagnosis, no medicine advice, no temperature diagnosis, and no home-treatment delay. CODEX Decision - needs approval. Source: WHO/UNICEF newborn danger-sign guidance. " + provenanceSummary("newborn_triage") + assetSummary("newborn_triage") + contractSummary("newborn_triage");
    $("slidecache").innerHTML = renderClinicalChecklist("newborn.main") + traceDetails("Review details", reviewText);
    var ids = bindClinicalChecklist("newborn.main").ids;
    var review = $("newbornreview");
    if (review && !review.dataset.bound) {
      review.dataset.bound = "newborndanger";
      review.addEventListener("click", function () {
        var dangerIds = ["newbornfeeding", "newbornbreathing", "newborntemp", "newbornmovement", "newbornjaundice"];
        var checked = ids.filter(function (id) { return !!$(id).checked; });
        if (!checked.length) return;
        var decision = screenDecision("newborn_triage", checked);
        var urgent = dangerIds.filter(function (id) { return !!$(id).checked; });
        // Governed and translated 2026-08-28. "chest indrawing", "convulsions" and "jaundice" were
        // bare English here; the newborn question asks about "fits" and "chest pulls in", so the
        // result now echoes those rather than naming the clinical terms back at the caregiver.
        var names = {
          newbornfeeding: tx("tx.why.newborn.feeding", null),
          newbornbreathing: tx("tx.why.newborn.breathing", null),
          newborntemp: tx("tx.why.newborn.temp", null),
          newbornmovement: tx("tx.why.newborn.movement", null),
          newbornjaundice: tx("tx.why.newborn.jaundice", null),
          newbornsmall: tx("tx.why.newborn.small", null),
          newbornother: tx("tx.why.newborn.other", null),
          newbornnone: tx("tx.why.newborn.none", null)
        };
        var selectedNames = urgent.map(function (id) { return names[id]; }).join(", ") || tx("tx.why.newborn.no_urgent", null);
        if (decision.severity === "emergency") {
          setSlideResult({
            kind: "refer",
            careRoute: "newborn_clinic",
            severity: decision.severity,
            title: tx("tx.screen_newborn.urgent_title", "Urgent newborn care now"),
            bodyHtml: '<p><strong>' + esc(tx("tx.result.because_checked", "Because you checked")) + ':</strong> ' + esc(selectedNames) + '.</p>',
            paragraphs: [tx("tx.screen_newborn.urgent", "Get urgent newborn care now. Keep the baby warm on the way if possible. Tell the clinic or health worker the baby is newborn.")]
          });
        } else if ($("newbornsmall").checked) {
          setSlideResult({
            kind: "refer",
            careRoute: "newborn_clinic",
            severity: decision.severity,
            title: tx("tx.screen_newborn.small_title", "Health worker today"),
            paragraphs: [tx("tx.screen_newborn.small", "Ask a health worker to check a small or early baby today, even when you see no urgent sign. Keep the baby warm and follow the local feeding/postnatal plan. If any urgent sign appears, go for urgent newborn care now.")]
          });
        } else if ($("newbornother").checked) {
          setSlideResult({
            kind: "home",
            careRoute: "professional",
            title: tx("tx.screen_newborn.other_title", "Ask a health worker"),
            paragraphs: [tx("tx.screen_newborn.other", "I do not know about that newborn concern.\nContact a health worker or clinic.\nGo sooner if the baby is changing, feeding differently, seems unwell, or you are still worried.")]
          });
        } else {
          setSlideResult({
            kind: "home",
            title: tx("tx.screen_newborn.no_urgent_title", "Keep watching"),
            paragraphs: [tx("tx.danger_checklist.none_result", "None of these selected. Keep watching and seek care if anything changes or you remain concerned.")],
            nextAction: tx("tx.result.action_watch_safety", "Keep watching and seek help if a danger sign appears.")
          });
        }
        $("slideimage").classList.add("hidden");
        $("slidecache").innerHTML = '<div class="slidecontrols"><button id="newborncheckagain" type="button">Check newborn signs again</button></div>' +
          traceDetails("Review details", "Newborn danger-check result. The app replaces the submitted choices with the result so another checklist does not follow the urgent instructions. " + provenanceSummary("newborn_triage") + assetSummary("newborn_triage") + contractSummary("newborn_triage"));
        $("newborncheckagain").addEventListener("click", function () {
          $("slideimage").classList.remove("hidden");
          setSlideText(tx("tx.screen_newborn_body", "Check newborn signs."));
          renderNewbornDangerChecklist();
          moveToNextStep("slidecache");
        });
        moveToNextStep("slidetext");
      });
    }
  }
  function showNewbornDangerChecklist() {
    activeSlides = [];
    activeShellTitle = t("tx.feature_newborn_triage");
    showPanel("slideshow");
    var card = screenByFeature("newborn_triage");
    $("slidetitle").textContent = activeShellTitle;
    $("slideimage").innerHTML = renderVisual("newborn_triage", card ? card.imageDesc : "Newborn wrapped beside caregiver and health worker with feeding, breathing, temperature, movement, and jaundice symbols.");
    setSlideText(tx("tx.screen_newborn_body", "Check newborn signs."));
    renderNewbornDangerChecklist();
  }
  // Template T3: a registry-driven clinical checklist screen.
  //
  // Nine screens were written as separate render functions with an identical skeleton - restore
  // selection, draw the shared checklist, bind it, collect what was checked, ask the decision
  // engine, branch on severity, show a result, offer "check again". Only the data differed: which
  // screen, what each option is called in a sentence, and which result each severity produces.
  // That data now lives in the registry beside the options it describes, and this function is the
  // only code path. See docs/design/SCREEN-SHELL-AND-TEMPLATES.md section 5.
  //
  // Result rules are first-match-wins, in registry order, matching the hit policy the rule tables
  // already use. Order is load-bearing: an "other concern" rule placed after routine_clinic means a
  // routine_clinic severity wins even when Other is also ticked, which is what the hand-written
  // screens did and must keep doing.
  function registryChecklistState(screenId) {
    if (!registryChecklistSelections[screenId]) registryChecklistSelections[screenId] = {};
    return registryChecklistSelections[screenId];
  }
  // Opening a screen starts from nothing ticked. The hand-written screens each cleared their own
  // selection variable on show; the template owns that state now, so it has to be cleared here or
  // a previous visit's answers come back pre-ticked and the action is live before anything is
  // asked - which is exactly what the registry audit caught.
  function resetRegistryChecklist(screenId) {
    registryChecklistSelections[screenId] = {};
  }
  function registryResultParagraph(rule, selectedNames, contextVars) {
    if (rule.bodyFrom === "friendlyOther") return friendlyOtherMessage();
    if (rule.bodyFrom === "pregnancyOther") return pregnancyOtherMessage();
    if (!rule.bodySlug) return "";
    // Screens name the same substitution differently; supply both so a slug written either way
    // resolves rather than printing its own placeholder at a caregiver.
    var vars = { selectedSigns: selectedNames, selectedNames: selectedNames };
    for (var key in (contextVars || {})) vars[key] = contextVars[key];
    return tx(rule.bodySlug, t(rule.bodySlug), vars);
  }
  function registryPlanContext(plan, context) {
    // Screens that address a named person need that name in their result text. The plan says which
    // placeholder it wants; the template does not guess at people.
    var vars = {};
    if (plan.personNamePlaceholder) {
      var person = context && context.person;
      vars[plan.personNamePlaceholder] = person && person.name
        ? person.name
        : tx(plan.personFallbackSlug || "tx.person.pregnant_person", "the pregnant person");
    }
    return vars;
  }
  function registryRuleMatches(rule, decision, decisionChecked) {
    var isChecked = function (id) { return !!($(id) && $(id).checked); };
    if (rule.whenSeverity && decision.severity !== rule.whenSeverity) return false;
    if (rule.whenSeverityIn && rule.whenSeverityIn.indexOf(decision.severity) < 0) return false;
    if (rule.whenChecked && !isChecked(rule.whenChecked)) return false;
    if (rule.whenAllChecked && !rule.whenAllChecked.every(isChecked)) return false;
    if (rule.whenAnyChecked && !rule.whenAnyChecked.some(isChecked)) return false;
    // "Only this one was ticked" - a bare Other concern alone reads differently from Other
    // alongside a real finding.
    if (rule.whenOnlyChecked && !(isChecked(rule.whenOnlyChecked) && decisionChecked.length === 1)) return false;
    // "Ticked, and nothing the decision engine was asked about" - the dehydration screen's Other
    // route, where Other and None are both held back from the decision.
    if (rule.whenCheckedWithNoDecisionSigns && !(isChecked(rule.whenCheckedWithNoDecisionSigns) && decisionChecked.length === 0)) return false;
    if (rule.whenAnyDecisionSign && decisionChecked.length === 0) return false;
    return true;
  }
  function renderRegistryChecklistScreen(screenId, checkedIds, context) {
    var screen = clinicalScreen(screenId);
    var plan = screen && screen.resultPlan;
    if (!plan) return false;
    var state = registryChecklistState(screenId);
    if (checkedIds) {
      registryChecklistSelections[screenId] = {};
      state = registryChecklistState(screenId);
      checkedIds.forEach(function (id) { state[id] = true; });
    }
    // Two review-detail styles are in use. reviewDetailsHtml pulls provenance from the feature
    // record; traceDetails takes a composed string; a screen pooling two features needs the
    // combined block. Screens differ in which they use, so the plan says which rather than the
    // template picking one and silently changing what reviewers see.
    var details = plan.reviewStyle === "trace"
      ? traceDetails("Review details", plan.reviewNote + " " + provenanceSummary(screen.featureId) + assetSummary(screen.featureId) + contractSummary(screen.featureId))
      : plan.reviewStyle === "combined"
        ? combinedReviewDetailsHtml(plan.featureIds || [screen.featureId], plan.reviewNote)
        : reviewDetailsHtml(screen.featureId, plan.reviewNote);
    var checklist = renderClinicalChecklist(screenId, { selected: state });
    // One screen puts its reviewer disclosure above the questions. That is caregiver-visible
    // layout, so it is preserved rather than quietly normalised by the move onto the template.
    $("slidecache").innerHTML = plan.detailsPosition === "before" ? details + checklist : checklist + details;
    bindClinicalChecklist(screenId, { state: state });
    var action = $(screen.actionId);
    if (action) action.textContent = t(screen.actionSlug);
    if (action && !action.dataset.bound) {
      action.dataset.bound = screenId;
      action.addEventListener("click", function () {
        // Recompute at click time: a switch or a re-render can change the option list between
        // drawing and tapping, and a captured list would silently drop an answer. Read the list;
        // do not re-bind, which would attach a second set of change listeners.
        var liveIds = clinicalChecklistOptionIds(screen);
        var checked = liveIds.filter(function (id) { return $(id) && $(id).checked; });
        if (!checked.length) return;
        registryChecklistSelections[screenId] = {};
        var live = registryChecklistState(screenId);
        checked.forEach(function (id) { live[id] = true; });
        // Some screens ask the decision engine about the positive findings only, holding back the
        // explicit "none of these" and sometimes "something else". Which ones is recorded, not
        // guessed.
        var held = plan.excludeFromDecision || (plan.excludeNoneFromDecision === true ? [screen.noneId] : []);
        var decisionChecked = checked.filter(function (id) { return held.indexOf(id) < 0; });
        // Some screens name only a subset of answers in their sentence, in registry order, and
        // would print a raw DOM id at a caregiver if the template fell back to the id.
        var namedIds = plan.nameOptions
          ? liveIds.filter(function (id) { return plan.nameOptions.indexOf(id) >= 0 && decisionChecked.indexOf(id) >= 0; })
          : decisionChecked;
        var selectedNames = namedIds.map(function (id) {
          return (plan.optionNames && plan.optionNames[id]) || "";
        }).filter(Boolean).join(", ") || plan.noSelectionName || "";
        // One screen routes purely on which boxes are ticked and never consults the decision
        // engine, so it must not be handed a severity it never had.
        var decision = plan.skipDecision === true ? {} : screenDecision(screen.featureId, decisionChecked);
        var contextVars = registryPlanContext(plan, context);
        for (var i = 0; i < plan.rules.length; i++) {
          var rule = plan.rules[i];
          if (!registryRuleMatches(rule, decision, decisionChecked)) continue;
          setSlideResult({
            kind: rule.kind,
            careRoute: rule.careRoute,
            screenId: rule.screenId,
            // Some rules do not gate on severity but still report the one the engine produced, so
            // the plan says "take the decision's severity" rather than the template inferring it
            // from whether a gate happened to be written.
            severity: rule.severity || (rule.severityFrom === "decision" || rule.whenSeverity || rule.whenSeverityIn ? decision.severity : undefined),
            title: rule.titleFrom === "friendlyOther" ? friendlyOtherTitle() : t(rule.titleSlug || screen.titleSlug),
            paragraphs: [registryResultParagraph(rule, selectedNames, contextVars)],
            nextAction: rule.nextActionSlug ? t(rule.nextActionSlug) : undefined
          });
          break;
        }
        var finishOptions = {
          againId: plan.againId,
          againLabel: plan.againSlug ? t(plan.againSlug) : undefined,
          featureId: screen.featureId,
          bodyText: plan.bodySlug ? tx(plan.bodySlug, t(plan.bodySlug), contextVars) : undefined,
          render: function () { renderRegistryChecklistScreen(screenId, null, context); }
        };
        if (plan.featureIds) finishOptions.featureIds = plan.featureIds;
        // One screen deliberately finishes without a decision, so passing an empty object would
        // hand the shared finisher something it never received before.
        if (plan.skipDecision !== true) finishOptions.decision = decision;
        finishClinicalChecklistResult(finishOptions);
      });
    }
    return true;
  }
  // Kept as the registry's named entry point; the screen itself is template T3 data now.
  function renderChildEarChecklist(checkedIds) {
    renderRegistryChecklistScreen("child_ear.main", checkedIds);
  }
  function showChildEarChecklist() {
    activeSlides = [];
    resetRegistryChecklist("child_ear.main");
    showPanel("slideshow");
    var card = screenByFeature("child_ear_check");
    $("slidetitle").textContent = t("tx.feature_child_ear_check");
    $("slideimage").innerHTML = renderVisual("child_ear_check", card ? card.imageDesc : "Child holding one ear beside a caregiver with ear pain, discharge, swelling-behind-ear, and clinic-arrow cues.");
    setSlideText(tx("tx.screen_ear_body", "This is an ear pain and discharge concern screen."));
    renderChildEarChecklist();
  }
  // Kept as the registry's named entry point; the screen itself is template T3 data now.
  function renderChildMeaslesChecklist() {
    renderRegistryChecklistScreen("child_measles.main");
  }
  function showChildMeaslesChecklist() {
    activeSlides = [];
    resetRegistryChecklist("child_measles.main");
    showPanel("slideshow");
    var card = screenByFeature("child_measles_rash_check");
    $("slidetitle").textContent = t("tx.feature_child_measles_rash_check");
    $("slideimage").innerHTML = renderVisual("child_measles_rash_check", card ? card.imageDesc : "Child with fever-and-rash concern, cough/runny-eye symbols, separation cue, and clinic arrow; not a diagnostic rash image.");
    setSlideText(tx("tx.screen_measles_body", "Check fever with a spreading rash and signs needing care today."));
    renderChildMeaslesChecklist();
  }
  function renderChildMuacChecklist() {
    $("slidecache").innerHTML =
      renderClinicalChecklist("child_muac.main") +
      reviewDetailsHtml("child_muac_malnutrition_screen", "MUAC nutrition screen. Referral support only.");
    var ids = bindClinicalChecklist("child_muac.main").ids;
    var review = $("muacreview");
    if (review && !review.dataset.bound) {
      review.dataset.bound = "muaccheck";
      review.addEventListener("click", function () {
        // Read the questions that are asked now rather than the list captured when this handler was
        // bound. A deployment switch can change which questions exist between renders, and a
        // handler holding a stale list silently ignores the answers it does not know about.
        var checked = clinicalChecklistOptionIds(clinicalScreen("child_muac.main")).filter(function (id) { return !!($(id) && $(id).checked); });
        if (!checked.length) return;
        var decisionChecked = checked.filter(function (id) { return id !== "muacnone"; });
        var decision = screenDecision("child_muac_malnutrition_screen", decisionChecked);
        if (decision.severity === "emergency") {
          var reasons = [];
          if ($("muacred") && $("muacred").checked) reasons.push("the red band on the arm tape");
          if ($("muacswelling") && $("muacswelling").checked) reasons.push("swelling of both feet");
          if ($("muacsick").checked) reasons.push("illness or danger signs");
          setSlideResult({
            kind: "refer",
            careRoute: "nutrition_clinic",
            severity: decision.severity,
            title: t("tx.feature_child_muac_malnutrition_screen"),
            paragraphs: [tx("tx.screen_muac.urgent", "Seek urgent nutrition or clinic care now for {selectedSigns}. Keep feeding and fluids only as the child can safely take them while arranging care.", { selectedSigns: reasons.join(", ") })]
          });
        } else if (decision.severity === "routine_clinic") {
          var follow = ($("muacyellow") && $("muacyellow").checked) ? "the yellow band on the arm tape" : "visible thinness, weight loss, poor appetite, or your own concern";
          setSlideResult({
            kind: "refer",
            careRoute: "nutrition_clinic",
            severity: decision.severity,
            title: t("tx.feature_child_muac_malnutrition_screen"),
            paragraphs: [tx("tx.screen_muac.followup", "Plan a nutrition or clinic visit soon for {selectedSigns}. Bring the child growth card or MUAC tape result if available.", { selectedSigns: follow })]
          });
        } else if ($("muacother").checked) {
          setSlideResult({
            kind: "refer",
            careRoute: "professional",
            severity: "routine_clinic",
            title: t("tx.feature_child_muac_malnutrition_screen"),
            paragraphs: [friendlyOtherMessage()]
          });
        } else {
          setSlideResult({
            kind: "home",
            title: t("tx.feature_child_muac_malnutrition_screen"),
            paragraphs: [tx("tx.danger_checklist.none_result", "None of these selected. Keep watching and seek care if anything changes or you remain concerned.")],
            nextAction: tx("tx.result.action_watch_safety", "Keep watching and seek help if a danger sign appears.")
          });
        }
        finishClinicalChecklistResult({
          againId: "muaccheckagain",
          featureId: "child_muac_malnutrition_screen",
          decision: decision,
          bodyText: tx("tx.screen_muac_body", "MUAC nutrition screen for local MUAC tape color, swelling of both feet, visible wasting, and illness concerns."),
          render: renderChildMuacChecklist
        });
      });
    }
  }
  function showChildMuacChecklist() {
    activeSlides = [];
    showPanel("slideshow");
    var card = screenByFeature("child_muac_malnutrition_screen");
    $("slidetitle").textContent = t("tx.feature_child_muac_malnutrition_screen");
    $("slideimage").innerHTML = renderVisual("child_muac_malnutrition_screen", card ? card.imageDesc : "Caregiver using a MUAC tape with color bands, food bowl, and bilateral foot-swelling cue; not a diagnosis image.");
    setSlideText(tx("tx.screen_muac_body", "MUAC nutrition screen for local MUAC tape color, swelling of both feet, visible wasting, and illness concerns."));
    renderChildMuacChecklist();
  }
  // Kept as the registry's named entry point; the screen itself is template T3 data now.
  function renderChildInjuryChecklist() {
    renderRegistryChecklistScreen("child_injury.main");
  }
  function showChildInjuryChecklist() {
    activeSlides = [];
    resetRegistryChecklist("child_injury.main");
    showPanel("slideshow");
    var card = screenByFeature("child_injury_first_aid_check");
    $("slidetitle").textContent = t("tx.feature_child_injury_first_aid_check");
    $("slideimage").innerHTML = renderVisual("child_injury_first_aid_check", card ? card.imageDesc : "Caregiver beside a child with first-aid kit, bandage, burn/bleeding symbols, and urgent-care arrow without gore.");
    setSlideText(tx("tx.screen_injury_body", "Injury first-aid check for emergency warning signs after a child injury."));
    renderChildInjuryChecklist();
  }
  function showScreenCard(featureId) {
    if (featureId === "newborn_triage") {
      showNewbornDangerChecklist();
      return;
    }
    if (featureId === "anc_triage") {
      showPregnancyDangerChecklist();
      return;
    }
    if (featureId === "pnc_lactation") {
      showPncLactationDangerChecklist();
      return;
    }
    if (featureId === "breastfeeding_aid_triage") {
      showBreastfeedingAidTriage(breastfeedingAidEntryMode());
      return;
    }
    if (featureId === "kohl_lead_screen") {
      showKohlLeadChecklist();
      return;
    }
    if (featureId === "child_vision_screen") {
      showChildVisionChecklist();
      return;
    }
    if (featureId === "child_hearing_screen") {
      showChildHearingChecklist();
      return;
    }
    if (featureId === "child_ear_check") {
      showChildEarChecklist();
      return;
    }
    if (featureId === "child_measles_rash_check") {
      showChildMeaslesChecklist();
      return;
    }
    if (featureId === "child_muac_malnutrition_screen") {
      showChildMuacChecklist();
      return;
    }
    if (featureId === "child_injury_first_aid_check") {
      showChildInjuryChecklist();
      return;
    }
    var card = screenByFeature(featureId);
    var feature = byId(catalog.features, featureId);
    if (!card) {
      showPrototypeCard(feature ? t(feature.titleSlug) : featureId, prototypeUnavailableBody(), tx("tx.prototype.unavailable.visual", "This activity is not available in the current prototype build."), featureId, "Missing screen card for " + featureId);
      return;
    }
    activeSlides = [];
    showPanel("slideshow");
    $("slidetitle").textContent = t(card.titleSlug);
    $("slideimage").innerHTML = renderVisual(featureId, card.imageDesc);
    var signs = (card.signSlugs || []).map(function (slug) { return t(slug); }).join(" | ");
    setSlideText(t(card.bodySlug) + " Check: " + signs + " Action: " + t(card.actionSlug));
    $("slidecache").innerHTML = reviewerDetails("source: " + card.source + " " + card.sourceName + ". " + card.governanceStatus + "." + provenanceSummary(featureId) + assetSummary(featureId) + contractSummary(featureId));
  }
  function qualitySummary() {
    var statuses = {};
    for (var i = 0; i < catalog.features.length; i++) statuses[catalog.features[i].status] = (statuses[catalog.features[i].status] || 0) + 1;
    var approved = 0, needs = 0;
    for (var j = 0; j < catalog.features.length; j++) {
      if ((catalog.features[j].governanceStatus || "").indexOf("CODEX Decision") >= 0) needs++;
      else approved++;
    }
    var spend = typeof assetManifest.budget.usdCommitted === "number" ? assetManifest.budget.usdCommitted : 0;
    var ceiling = typeof assetManifest.budget.usdCeiling === "number" ? assetManifest.budget.usdCeiling : 20;
    var publishers = {};
    for (var k = 0; k < guidanceComparisons.sources.length; k++) {
      var pub = guidanceComparisons.sources[k].publisher || "Unknown";
      publishers[pub.split(" ")[0]] = true;
    }
    var publisherKeys = Object.keys(publishers).sort();
    var priorityPublishers = ["WHO", "UNICEF", "CDC"];
    var orderedPublishers = [];
    for (var priorityIndex = 0; priorityIndex < priorityPublishers.length; priorityIndex++) {
      if (publishers[priorityPublishers[priorityIndex]]) orderedPublishers.push(priorityPublishers[priorityIndex]);
    }
    for (var publisherIndex = 0; publisherIndex < publisherKeys.length; publisherIndex++) {
      if (orderedPublishers.indexOf(publisherKeys[publisherIndex]) < 0) orderedPublishers.push(publisherKeys[publisherIndex]);
    }
    var publisherNames = orderedPublishers.slice(0, 6).join(", ") || "none loaded";
    var approvalQueue = guidanceComparisons.comparisons.filter(function (c) {
      return ((c.codexDecision || "") + " " + (c.status || "")).toLowerCase().indexOf("need") >= 0 || ((c.codexDecision || "") + " " + (c.status || "")).toLowerCase().indexOf("review") >= 0;
    }).slice(0, 4).map(function (c) { return c.featureId; }).join(", ");
    var sourceTypes = {}, reviewStatuses = {};
    for (var m = 0; m < assetManifest.assets.length; m++) {
      var asset = assetManifest.assets[m];
      var sourceType = asset.sourceType || "unknown_source";
      var reviewStatus = asset.clinicalReviewStatus || asset.localReviewStatus || asset.approvalStatus || "Review Needed";
      sourceTypes[sourceType] = (sourceTypes[sourceType] || 0) + 1;
      reviewStatuses[reviewStatus] = (reviewStatuses[reviewStatus] || 0) + 1;
    }
    var sourceQueue = Object.keys(sourceTypes).sort().slice(0, 5).map(function (key) { return key + "=" + sourceTypes[key]; }).join(", ") || "none";
    var reviewQueue = Object.keys(reviewStatuses).sort().slice(0, 5).map(function (key) { return key + "=" + reviewStatuses[key]; }).join(", ") || "none";
    var approvalStates = assetApprovalRegister.approvalStates || {};
    var approvalCount = Array.isArray(approvalStates.approved) ? approvalStates.approved.length : 0;
    var notApprovedCount = Array.isArray(approvalStates.notApproved) ? approvalStates.notApproved.length : 0;
    var graphicsNeededCount = Array.isArray(approvalStates.graphicsNeeded) ? approvalStates.graphicsNeeded.length : 0;
    var noGraphicsCount = Array.isArray(approvalStates.noGraphicsNeeded) ? approvalStates.noGraphicsNeeded.length : 0;
    var standardsSource = chwQualityStandards.source && chwQualityStandards.source.title ? chwQualityStandards.source.title : "CHW quality standards";
    var standardLabels = chwQualityStandards.components.slice(0, 6).map(function (c) { return c.label ? c.label.toLowerCase() : c.id; }).join(", ") || "none loaded";
    var phraseSlugs = Object.keys(phraseBank.phrases || {});
    var bnReady = 0;
    for (var n = 0; n < phraseSlugs.length; n++) {
      var item = phraseBank.phrases[phraseSlugs[n]] || {};
      if (item["bn-BD"] && item["bn-BD"].text) bnReady++;
    }
    var bnPending = Math.max(0, phraseSlugs.length - bnReady);
    var fhirSeen = {};
    for (var q = 0; q < moduleContracts.contracts.length; q++) {
      var resources = moduleContracts.contracts[q].fhirResources || [];
      for (var r = 0; r < resources.length; r++) fhirSeen[resources[r]] = true;
    }
    var fhirNames = Object.keys(fhirSeen).sort().join(", ") || "none declared";
    var contractPosture = moduleContracts.securityPosture || "prototype posture not declared";
    return " Catalog: " + catalog.features.length + " features; runnable or source-backed items: " + ((statuses.prototype || 0) + (statuses.source_identified || 0) + (statuses.implemented || 0)) + "; items still needing approval: " + needs + "; draft-verified or other status: " + approved + "; media: " + assetManifest.assets.length + " candidates; $" + spend + " image spend of $" + ceiling + " ceiling. Source coverage: " + guidanceComparisons.sources.length + " sources from " + publisherNames + "; " + guidanceComparisons.comparisons.length + " comparisons. Approval queue: " + (approvalQueue || "none") + " needs approval. Media queue: sources " + sourceQueue + "; reviews " + reviewQueue + ". Media approval register: " + approvalCount + " approved, " + notApprovedCount + " not approved, " + graphicsNeededCount + " graphics/audio needed, " + noGraphicsCount + " text-only items; approval tracking is separate from draft iteration. CHW AIM quality standards: " + chwQualityStandards.components.length + " checks from " + standardsSource + "; mapped features " + chwQualityStandards.featureMappings.length + "; includes " + standardLabels + ". Localization: English fallback loaded; Bangla " + bnReady + "/" + phraseSlugs.length + " phrases translated, " + bnPending + " pending sign-off. Module review records: " + moduleContracts.contracts.length + " features; health-record resource types " + fhirNames + "; security posture " + contractPosture + ".";
  }
  if ($("search")) $("search").addEventListener("input", function () {
    search = String($("search").value || "").toLowerCase();
    featureLimit = FEATURE_PAGE_SIZE;
    renderFeatureList();
    applyShellVisibility();
  });
  if ($("todaybrush")) $("todaybrush").addEventListener("click", function () { openLaunch("dental.brushing", "Toothbrushing coach"); });
  if ($("homecare")) $("homecare").addEventListener("click", function () { showCatalogScreen("people", null, null, true); });
  if ($("homelearn")) $("homelearn").addEventListener("click", function () { showCatalogScreen("learn"); });
  if ($("hometools")) $("hometools").addEventListener("click", function () { showCatalogScreen("tools"); });
  if ($("navhome")) $("navhome").addEventListener("click", goHome);
  if ($("navpeople")) $("navpeople").addEventListener("click", function () { showCatalogScreen("people"); });
  if ($("navlearn")) $("navlearn").addEventListener("click", function () { showCatalogScreen("learn"); });
  if ($("navtools")) $("navtools").addEventListener("click", function () { showCatalogScreen("tools"); });
  if ($("navurgent")) $("navurgent").addEventListener("click", beginDangerFlow);
  if ($("screenback")) $("screenback").addEventListener("click", function () {
    if (activeShellScreen === "urgent-check") returnToPreviousUnder5Step();
    else returnFromWork();
  });
  // Top-chrome disclosure panels, managed in one place.
  //
  // Settings used to toggle independently of How to use, neither button showed a pressed state,
  // and opening one left the other on screen. External review (mgilkey A2, A4) lost several
  // minutes to exactly that: "I clicked How to use and was shown Settings, which is not what I
  // asked for", followed by "the How to use button does not seem to work". It worked; it just did
  // not close the panel already open, and nothing on screen said Settings was still open.
  //
  // Opening one chrome panel now closes the others and every chrome button reports aria-pressed.
  var CHROME_PANELS = [
    { buttonId: "showprefs", panelId: "localprefs" },
    { buttonId: "howtobutton", panelId: "howtopanel" }
  ];
  function syncChromeButtons() {
    for (var i = 0; i < CHROME_PANELS.length; i++) {
      var entry = CHROME_PANELS[i];
      var button = $(entry.buttonId), panel = $(entry.panelId);
      if (!button || !panel) continue;
      var open = !panel.classList.contains("hidden");
      button.setAttribute("aria-pressed", open ? "true" : "false");
      if (open) button.classList.add("chrome-open"); else button.classList.remove("chrome-open");
    }
  }
  function closeChromePanels(exceptPanelId) {
    for (var i = 0; i < CHROME_PANELS.length; i++) {
      var entry = CHROME_PANELS[i];
      if (entry.panelId === exceptPanelId) continue;
      if ($(entry.panelId)) $(entry.panelId).classList.add("hidden");
    }
    syncChromeButtons();
  }
  function toggleChromePanel(panelId) {
    var panel = $(panelId);
    if (!panel) return false;
    var willOpen = panel.classList.contains("hidden");
    closeChromePanels(panelId);
    if (willOpen) panel.classList.remove("hidden"); else panel.classList.add("hidden");
    syncChromeButtons();
    if (willOpen) moveToNextStep(panelId);
    return willOpen;
  }
  if ($("showprefs")) $("showprefs").addEventListener("click", function () {
    toggleChromePanel("localprefs");
  });
  // Deployment switch, exposed in the reviewer panel so a deployment can be tried without a
  // rebuild. It is not a caregiver preference and must never appear in caregiver settings
  // (UI-STANDARDS section 18). Its committed default is config/switches.json.
  if ($("muactapedistributed")) {
    $("muactapedistributed").checked = deployerSwitch("muacTapeDistributed");
    $("muactapedistributed").addEventListener("change", function () {
      setDeployerSwitch("muacTapeDistributed", !!$("muactapedistributed").checked);
      renderCatalog();
    });
  }
  var howToStep = 0;
  var howToSlides = [
    // The tour never said what the app is for (external caregiver review 2026-08-17, NA-19).
    { titleSlug: "tx.howto.purpose_title", titleFallback: "What this app is for", textSlug: "tx.howto_purpose_body", textFallback: "This app helps you check a sick child at home, and tells you when to go to a clinic and how fast." },
    { titleSlug: "tx.howto.hear_title", titleFallback: "Hear this screen", textSlug: "tx.howto.hear_body", textFallback: "Tap the Listen button at the top of the screen to hear the important words and choices. A yellow outline shows what the app is reading. Tap Stop at any time." },
    { titleSlug: "tx.howto_questions_title", titleFallback: "Answer one step at a time", textSlug: "tx.howto.questions_body", textFallback: "When a screen asks one question, choose the answer that is true now. Then use the named button to continue." },
    { titleSlug: "tx.howto_lists_title", titleFallback: "Choose all that apply", textSlug: "tx.howto.lists_body", textFallback: "If a screen says 'Choose all that apply,' choose every item that is true. You can choose more than one." }
  ];
  function renderHowTo() {
    var slide = howToSlides[howToStep];
    // External review mgilkey A5: "I have no idea why Hear this screen is Step 1 of 3." It is a
    // three-tip tour, but nothing said so, and the reviewer had arrived here unexpectedly because
    // of the panel bug above. Name what is being counted.
    $("howtoprogress").textContent = tx("tx.howto.tour_step", "Tip {current} of {total}", { current: howToStep + 1, total: howToSlides.length });
    $("howtotitle").textContent = tx(slide.titleSlug, slide.titleFallback);
    $("howtotext").textContent = tx(slide.textSlug, slide.textFallback);
    $("howtoprev").disabled = howToStep === 0;
    $("howtonext").disabled = howToStep === howToSlides.length - 1;
  }
  function closeHowTo() {
    if ($("howtopanel")) $("howtopanel").classList.add("hidden");
    syncChromeButtons();
  }
  function showHowTo() {
    stopGuidedReading();
    howToStep = 0;
    closeChromePanels("howtopanel");
    $("howtopanel").classList.remove("hidden");
    syncChromeButtons();
    renderHowTo();
    moveToNextStep("howtopanel");
  }
  function enhanceMultiSelect(root) {
    if (!root || !root.querySelectorAll) return;
    var groups = root.querySelectorAll(".slidecontrols, .symptom-group, fieldset");
    Array.prototype.forEach.call(groups, function (group) {
      if (!group.querySelectorAll || group.querySelectorAll('input[type="checkbox"]').length < 2) return;
      if (group.closest && group.closest(".clinical-checklist")) return;
      if ((group.dataset && group.dataset.multiselectInstruction === "false") ||
          (group.classList && group.classList.contains("confirmation-steps"))) return;
      // A staged wrapper (for example, diarrhoea) can contain later hidden clinical
      // checklists. It is not itself a checklist and must not receive their generic
      // multi-select instruction.
      if (group.querySelector && group.querySelector(".clinical-checklist")) return;
      var nestedGroups = group.children ? Array.prototype.filter.call(group.children, function (child) {
        return child.matches && child.matches(".symptom-group, fieldset") &&
          child.querySelectorAll && child.querySelectorAll('input[type="checkbox"]').length >= 2;
      }) : [];
      if (nestedGroups.length) return;
      if (group.querySelector && group.querySelector(".multi-select-instruction")) return;
      var note = document.createElement ? document.createElement("p") : null;
      if (!note) return;
      note.className = "multi-select-instruction";
      note.textContent = tx("tx.multi_select_instruction", "Choose every item that is true. You can choose more than one.");
      group.insertBefore(note, group.firstChild);
    });
  }
  function syncDuplicateWorkTitle() {
    var shellTitle = $("screenlabel");
    var contentTitle = $("slidetitle");
    if (!shellTitle || !contentTitle) return;
    var shellText = String(shellTitle.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    var contentText = String(contentTitle.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    var duplicate = !!shellText && shellText === contentText;
    contentTitle.classList.toggle("duplicate-shell-title", duplicate);
    if (duplicate) contentTitle.setAttribute("aria-hidden", "true");
    else contentTitle.removeAttribute("aria-hidden");
  }
  if (typeof MutationObserver !== "undefined" && $("appmain")) {
    var multiSelectObserver = new MutationObserver(function () { enhanceMultiSelect($("appmain")); });
    multiSelectObserver.observe($("appmain"), { childList: true, subtree: true });
    enhanceMultiSelect($("appmain"));
    var workTitleObserver = new MutationObserver(syncDuplicateWorkTitle);
    if ($("screenlabel")) workTitleObserver.observe($("screenlabel"), { childList: true, characterData: true, subtree: true });
    if ($("slidetitle")) workTitleObserver.observe($("slidetitle"), { childList: true, characterData: true, subtree: true });
    syncDuplicateWorkTitle();
  }
  if ($("listenbutton")) $("listenbutton").addEventListener("click", function () { guidedSpeechActive ? stopGuidedReading() : startGuidedReading(); });
  if ($("howtobutton")) $("howtobutton").addEventListener("click", showHowTo);
  if ($("howtoprev")) $("howtoprev").addEventListener("click", function () { howToStep = Math.max(0, howToStep - 1); renderHowTo(); });
  if ($("howtonext")) $("howtonext").addEventListener("click", function () { howToStep = Math.min(howToSlides.length - 1, howToStep + 1); renderHowTo(); });
  if ($("howtodone")) $("howtodone").addEventListener("click", closeHowTo);
  if (typeof window !== "undefined" && window.location && /(?:\?|&)review=1(?:&|$)/.test(window.location.search || "") && $("reviewersettings")) {
    $("reviewersettings").classList.remove("hidden");
    if (document.body && document.body.classList) document.body.classList.add("reviewer-mode");
  }
  if ($("closeprefs")) $("closeprefs").addEventListener("click", function () {
    if ($("localprefs")) $("localprefs").classList.add("hidden");
  });
  // External review mgilkey A9: the settings summary "seems largely redundant with the info above
  // it", and it silently omitted Demo shortcuts, so it was both reading load and a second thing to
  // keep in sync. It is now feedback about the setting that just changed, which is the only job it
  // was doing that the controls above it were not already doing.
  function updatePreferenceSummary(changed) {
    if (!$("prefsummary")) return;
    var locale = $("preflanguage") ? $("preflanguage").value : "en";
    var languageNames = { en: "English", fr: "Fran\u00e7ais", "hi-IN": "\u0939\u093f\u0928\u094d\u0926\u0940 (\u092e\u0938\u094c\u0926\u093e)", "bn-BD": "Bangla pending review" };
    if (changed === "privacy") {
      $("prefsummary").textContent = $("prefprivacy") && $("prefprivacy").checked
        ? tx("tx.prefs.privacy_extra", "Extra care on a shared phone is on. Reminders say only that the app needs you.")
        : tx("tx.prefs.privacy_standard", "Extra care on a shared phone is off. Reminders can name the activity.");
      return;
    }
    if (changed === "reminders") {
      $("prefsummary").textContent = $("prefgeneric") && $("prefgeneric").checked
        ? tx("tx.prefs.reminders_generic", "Reminders use general wording.")
        : tx("tx.prefs.reminders_specific", "Reminders name the activity.");
      return;
    }
    if (changed === "quiet") {
      var qs = $("prefquiet") && $("prefquiet").value ? $("prefquiet").value : "21:00";
      var qe = $("prefquietend") && $("prefquietend").value ? $("prefquietend").value : "07:00";
      $("prefsummary").textContent = tx("tx.prefs.quiet_range", "Quiet time runs from {start} to {end}. The app holds reminders that are not urgent until it ends.", { start: qs, end: qe });
      return;
    }
    $("prefsummary").textContent = tx("tx.prefs.language_now", "Language is now {language}.", { language: languageNames[locale] || "English" });
  }
  if ($("preflanguage")) $("preflanguage").addEventListener("change", function () {
    var locale = $("preflanguage").value;
    if (engine.setLocale) engine.setLocale(locale);
    if (document.documentElement) document.documentElement.lang = locale;
    localizeCaregiverChrome();
    renderHowTo();
    updatePreferenceSummary();
    applyShellVisibility();
    refreshVisibleUnder5TriageForLocale();
    $("status").textContent = tx("tx.language.changed", "Language changed. This screen and newly opened activities use the selected language when a draft is available.");
  });
  // Each control reports its own change, so the feedback line names what the caregiver just did
  // instead of restating every setting on the screen above it.
  [
    { id: "preflanguage", kind: "language" },
    { id: "prefquiet", kind: "quiet" },
    { id: "prefquietend", kind: "quiet" },
    { id: "prefprivacy", kind: "privacy" },
    { id: "prefgeneric", kind: "reminders" }
  ].forEach(function (entry) {
    if ($(entry.id)) $(entry.id).addEventListener("change", function () { updatePreferenceSummary(entry.kind); });
  });
  if ($("addperson")) $("addperson").addEventListener("click", function () {
    var name = ($("personname").value || "").trim() || "New person";
    var subject = $("personrole").value || "child_under5";
    var birthDate = $("persondob") && $("persondob").value ? $("persondob").value : "";
    if (isFutureBirthDate(birthDate)) {
      $("status").textContent = "Date of birth cannot be in the future.";
      $("status").style.color = "#b3261e";
      return;
    }
    if (editingPersonId) {
      var editedPerson = personById(editingPersonId);
      if (!editedPerson) {
        clearPersonEditor(true, false);
        return;
      }
      editedPerson.name = name;
      editedPerson.subject = subject;
      editedPerson.birthDate = birthDate;
      editedPerson.note = editedPerson.note || "edited in prototype";
      if (activePersonId === editedPerson.id || dangerPersonId === editedPerson.id) activeSubject = subject;
      renderPeople();
      clearPersonEditor(false, false);
      renderCatalog();
      confirmPersonChange("Saved changes for " + name + ".");
      return;
    }
    var personId = "person_" + people.length;
    people.push({ id: personId, name: name, subject: subject, note: "added in prototype", birthDate: birthDate });
    clearPersonEditor(false, false);
    renderPeople();
    mode = "subject"; selected = subject; activeSubject = subject; activePersonId = personId; dangerPersonId = null; renderCatalog();
    confirmPersonChange("Added " + name + ".");
  });
  if ($("cancelperson")) $("cancelperson").addEventListener("click", function () {
    clearPersonEditor(true, true);
    if ($("status")) $("status").textContent = "Editing cancelled.";
    moveToNextStep("personeditlabel");
  });
  if ($("memoryprofile")) $("memoryprofile").addEventListener("change", renderCatalog);
  if ($("hotspotmode")) $("hotspotmode").addEventListener("change", function () { hotspot = !!$("hotspotmode").checked; renderCatalog(); });
  if ($("demomodeon")) $("demomodeon").addEventListener("change", renderCatalog);
  if ($("showtriage")) $("showtriage").addEventListener("click", beginDangerFlow);
  if ($("resetdemo")) $("resetdemo").addEventListener("click", resetDemoState);
  if ($("slideread")) $("slideread").addEventListener("click", function () {
    playPrototypeSpeech(currentScreenReadAloudText());
  });
  if ($("slidepauseaudio")) $("slidepauseaudio").addEventListener("click", pausePrototypeSpeech);
  if ($("sliderestartaudio")) $("sliderestartaudio").addEventListener("click", function () {
    restartPrototypeSpeech(currentScreenReadAloudText());
  });
  if ($("slideprev")) $("slideprev").addEventListener("click", function () { moveSlide(-1); });
  if ($("slidenext")) $("slidenext").addEventListener("click", moveToNextSlideOrCare);
  if (typeof globalThis !== "undefined") {
    globalThis.__MAMMA_CLINICAL_SCREENS = clinicalScreens;
    // The registry declares every question that could be asked; deployment switches decide which
    // are asked here. Audits comparing rendered controls against the registry need the same view.
    globalThis.__MAMMA_DEPLOYER_SWITCH = deployerSwitch;
    // Which triage answers can be named in "Why this result" is a property of the whole category,
    // so an audit needs to ask the app rather than re-implement the lookup and agree with itself.
    globalThis.__checkedInputLabelsForQA = function (inputs) { return checkedInputLabels(inputs || {}); };
    // Open a catalogue feature the way its card does, and return home, so an audit walks the same
    // path a caregiver walks instead of reaching past the navigation into render functions.
    globalThis.__openLaunchForQA = function (launch, title) { openLaunch(launch, title || launch); };
    globalThis.__auditGoHome = function () { goHome(); };
    // The diagram's numbers, so an audit can compare the picture against the catalog row rather
    // than re-deriving the arithmetic and agreeing with itself.
    // Task #18: what the app resolved the sachet volume to, and whether it was told or assumed.
    globalThis.__orsSachetStateForQA = function (setId) {
      if (typeof setId === "string") { orsSachetId = setId; orsDeckContainerId = ""; }
      return {
        id: orsSachetId,
        volumeMl: orsSachetVolumeMl(),
        assumed: orsSachetWasAssumed(),
        stocked: sachetCatalogRows().map(function (row) { return row.id; }),
      };
    };
    globalThis.__orsArithmeticFactsForQA = function (containerId) {
      var container = containerById(containerId);
      return orsArithmeticFacts(container, container ? exactOrsMeasurementMethod(container) : null, orsSachetVolumeMl());
    };
    globalThis.__openClinicalSurfaceForQA = function (surfaceId) {
      var screen = clinicalScreen(surfaceId);
      if (screen.entry.kind === "under5_urgent") {
        prepareChildTriage(defaultChildPerson());
        showPanel("triagepanel");
        showUnder5Stage(screen.entry.view || "danger");
      } else if (screen.entry.kind === "person_urgent") {
        showPregnancyUrgentIntake(people.filter(function (person) { return person.subject === "pregnancy"; })[0] || null);
      } else if (screen.entry.kind === "progressive") {
        if (screen.featureId === "breastfeeding_aid_triage") {
          showBreastfeedingAidTriage("triage", screen.entry.view);
        } else {
          showPncLactationDangerChecklist();
          if (screen.entry.view !== "acute") {
            pncSelections.pncacutenone = true;
            pncAnsweredViews.acute = true;
            pncView = screen.entry.view;
            renderPncLactationDangerChecklist();
          }
        }
      } else {
        var previousMode = mode;
        if (screen.entry.intent === "urgent_check") mode = "danger";
        openLaunch(screen.entry.launch, "");
        mode = previousMode;
      }
      return surfaceId;
    };
  }
  applyBirthDateBounds();
  renderRoleSelect();
  renderPeople();
  renderCatalog();
  updatePreferenceSummary();

  var uncheck = function (list) { list.forEach(function (q) { var e = $("s_" + q.id); if (e) e.checked = false; }); };
  function under5StageTitle() {
    var person = personById(activePersonId);
    var name = person && person.subject === "child_under5" ? person.name : tx("tx.triage.chrome.child_default", "Child");
    // The progress strip and question name the step. The shell keeps only the subject
    // visible, rather than echoing the step two more times.
    return tx("tx.triage.chrome.child_check_subject", "Checking {name}", { name: name });
  }
  function hideUnder5StageRegions() {
    [
      "triagechildgroup", "dangergroup", "complaintgroup", "coughgroup", "rrsection",
      "diargroup", "diarrhoeadurationfields", "diarrhoeastoolfields", "diarrhoeadehydrationsigns", "fevergroup",
      "fevercoursefields", "fevermeasurementfields", "eargroup", "dentalgroup", "measlesgroup", "out"
    ].forEach(function (id) {
      if ($(id)) $(id).classList.add("hidden");
    });
  }
  function renderUnder5RegistryGate(surfaceId, targetId, onContinue, opts) {
    var target = $(targetId);
    if (!target) return;
    target.innerHTML = renderClinicalChecklist(surfaceId, opts || {});
    var binding = bindClinicalChecklist(surfaceId, opts || {});
    var action = $(binding.screen.actionId);
    if (action && !action.dataset.bound) {
      action.dataset.bound = surfaceId;
      action.addEventListener("click", function () {
        stopPrototypeMusicForContext(surfaceId);
        if (typeof onContinue === "function") onContinue();
      });
    }
  }
  function renderUnder5DangerGate() {
    var dangerOptions = DANGER.map(function (q) {
      return { id: "s_" + q.id, label: t("tx.q_" + q.id), kind: "positive" };
    });
    dangerOptions.push({
      id: "s_no_danger_signs",
      label: tx("tx.clinical_screen.under5.none", "No danger signs"),
      kind: "none"
    });
    var dangerGroups = [{
      id: "under5_danger_signs",
      legend: tx("tx.clinical_screen.under5.legend", "Choose every danger sign that is happening"),
      optionIds: dangerOptions.map(function (option) { return option.id; })
    }];
    $("dangersigns").innerHTML = renderClinicalChecklist("under5.general_danger", {
      groups: dangerGroups,
      options: dangerOptions,
      showRequiredFeedback: false
    });
    under5DangerGateUpdate = bindClinicalChecklist("under5.general_danger", {
      options: dangerOptions,
      showRequiredFeedback: false,
      onChange: function () {
        if (activeShellScreen === "urgent-check") applyShellVisibility();
      }
    }).update;
    var action = $("triagedangercontinue");
    if (action && !action.dataset.bound) {
      action.dataset.bound = "under5-danger";
      action.addEventListener("click", function () {
        var dangerSelected = DANGER.some(function (q) { return !!($("s_" + q.id) && $("s_" + q.id).checked); });
        if (dangerSelected) finishUnder5Triage();
        else showUnder5Stage("complaints");
      });
    }
  }
  function renderUnder5ComplaintGate() {
    renderUnder5RegistryGate("under5.presenting_complaints", "mainsigns", function () {
      under5BranchQueue = [];
      if ($("s_cough").checked) under5BranchQueue.push("cough_chest", "cough_sound");
      if ($("s_diarrhoea").checked) under5BranchQueue.push(DIARRHOEA_DURATION_STAGE, "diarrhoea_stool", "diarrhoea_dehydration");
      if ($("s_fever").checked) under5BranchQueue.push("fever_course", "fever_measurement");
      if ($("s_ear_problem").checked) under5BranchQueue.push("ear");
      if ($("s_tooth_mouth").checked) under5BranchQueue.push("tooth_mouth");
      under5BranchIndex = 0;
      if (under5BranchQueue.length) showUnder5Stage(under5BranchQueue[0]);
      else finishUnder5Triage();
    });
  }
  function advanceUnder5Branch() {
    under5BranchIndex += 1;
    if (under5BranchIndex < under5BranchQueue.length) showUnder5Stage(under5BranchQueue[under5BranchIndex]);
    else {
      stopPrototypeMusicForContext("under5.followup.cough_sound");
      finishUnder5Triage();
    }
  }
  function renderUnder5CoughChestGate() {
    renderUnder5RegistryGate("under5.followup.cough_chest", "coughsigns", advanceUnder5Branch, {
      beforeFieldsHtml: chestIndrawingComparisonHtml(),
      singleSelect: true,
      state: coughChoiceState,
      requiredFallback: tx("tx.cough.answer_required", "Choose one answer to continue.")
    });
    bindChestIndrawingComparison();
  }
  function renderUnder5CoughSoundGate() {
    renderUnder5RegistryGate("under5.followup.cough_sound", "coughsigns", advanceUnder5Branch, {
      beforeFieldsHtml: stridorSoundExampleHtml(),
      singleSelect: true,
      state: coughChoiceState,
      requiredFallback: tx("tx.cough.answer_required", "Choose one answer to continue.")
    });
    var play = $("stridorsoundplay");
    if (play && !play.dataset.bound) {
      play.dataset.bound = "stridor-example";
      play.addEventListener("click", function () {
        stopReadAloudForContextChange(tx("tx.stridor_sound.status.stopped", "Sound example stopped."));
        var playing = togglePrototypeMusic("audio.clinical.stridor_example_cc_by_sa_3", "stridorsoundstatus", false, {
          context: "under5.followup.cough_sound",
          unavailable: tx("tx.stridor_sound.status.ready", "Sound example ready; playback is unavailable in this browser."),
          playing: tx("tx.stridor_sound.status.playing", "Sound example playing."),
          complete: tx("tx.stridor_sound.status.complete", "Sound example complete."),
          stopped: tx("tx.stridor_sound.status.stopped", "Sound example stopped."),
          failed: tx("tx.stridor_sound.status.failed", "Sound example could not load. If you are worried about breathing, seek urgent care."),
          blocked: tx("tx.stridor_sound.status.failed", "Sound example could not load. If you are worried about breathing, seek urgent care.")
        });
        if ($("stridorsoundstop")) $("stridorsoundstop").disabled = !playing;
      });
    }
    var stop = $("stridorsoundstop");
    if (stop && !stop.dataset.bound) {
      stop.dataset.bound = "stridor-example";
      stop.addEventListener("click", function () {
        if (currentPrototypeMusic && currentPrototypeMusic.assetId === "audio.clinical.stridor_example_cc_by_sa_3") {
          stopPrototypeMusic("stridorsoundstatus", tx("tx.stridor_sound.status.stopped", "Sound example stopped."));
        }
        stop.disabled = true;
      });
    }
  }
  function bindDiarrhoeaDurationGate() {
    var input = $("diarrhoeadays"), notSure = $("diarrhoeadaysnotsure"), action = $("triagediarrhoeadayscontinue"), feedback = $("diarrhoeadaysfeedback");
    function update() {
      // At least one day, checked here rather than trusted to the min attribute: "0" is a value the
      // field accepts and the caregiver can type (external caregiver review 2026-08-17, NA-34).
      var entered = !!(input && String(input.value || "") !== "" && Number(input.value) >= 1);
      var unsure = !!(input && input.dataset.notSure === "true");
      if (action) action.disabled = !(entered || unsure);
      if (feedback) feedback.textContent = entered || unsure ? "" : tx("tx.diarrhoea_duration.answer_required", "Enter the number of days or choose Not sure.");
    }
    if (input && !input.dataset.durationBound) {
      input.dataset.durationBound = "true";
      input.addEventListener("input", function () { delete input.dataset.notSure; update(); });
      input.addEventListener("change", function () { delete input.dataset.notSure; update(); });
    }
    if (notSure && !notSure.dataset.durationBound) {
      notSure.dataset.durationBound = "true";
      notSure.addEventListener("click", function () { if (input) { input.value = ""; input.dataset.notSure = "true"; } update(); });
    }
    if (action && !action.dataset.durationBound) {
      action.dataset.durationBound = "true";
      action.addEventListener("click", advanceUnder5Branch);
    }
    update();
  }
  function renderUnder5DiarrhoeaStoolGate() {
    renderUnder5RegistryGate("under5.followup.diarrhoea_stool", "diarrhoeastoolsigns", function () {
      // Blood in the stool already determines the urgent dysentery route. Do not
      // make a caregiver answer lower-priority dehydration questions before showing it.
      if ($("s_bloody_stool") && $("s_bloody_stool").checked) finishUnder5Triage();
      else advanceUnder5Branch();
    }, {
      optionHelpHtml: function (option) { return option.id === "s_bloody_stool" ? signExampleHtml("bloody_stool") : ""; }
    });
  }
  function renderUnder5DiarrhoeaDehydrationGate() {
    renderUnder5RegistryGate("under5.followup.diarrhoea_dehydration", "diarrhoeadehydrationsigns", advanceUnder5Branch, {
      optionHelpHtml: function (option) {
        var id = option.id.replace(/^s_/, "");
        return id === "sunken_eyes" || id === "skin_pinch_slow" ? signExampleHtml(id) : "";
      }
    });
  }
  function renderUnder5FeverCourseGate() {
    renderUnder5RegistryGate("under5.followup.fever_course", "fevercoursesigns", function () {
      var measlesIndex = under5BranchQueue.indexOf("measles");
      if ($("s_measles_rash") && $("s_measles_rash").checked) {
        if (measlesIndex < 0) {
          var measurementIndex = under5BranchQueue.indexOf("fever_measurement", under5BranchIndex + 1);
          under5BranchQueue.splice(measurementIndex >= 0 ? measurementIndex + 1 : under5BranchIndex + 1, 0, "measles");
        }
      } else if (measlesIndex > under5BranchIndex) {
        under5BranchQueue.splice(measlesIndex, 1);
      }
      advanceUnder5Branch();
    });
  }
  function renderUnder5FeverMeasurementGate() {
    renderUnder5RegistryGate("under5.followup.fever_measurement", "fevermeasurementsigns", advanceUnder5Branch);
  }
  function renderUnder5EarGate() {
    renderUnder5RegistryGate("under5.followup.ear", "earsigns", advanceUnder5Branch);
  }
  function renderUnder5ToothMouthGate() {
    renderUnder5RegistryGate("under5.followup.tooth_mouth", "dentalsigns", advanceUnder5Branch);
  }
  function renderUnder5MeaslesGate() {
    renderUnder5RegistryGate("under5.followup.measles", "measlessigns", advanceUnder5Branch);
  }
  function showUnder5Stage(stage) {
    if (stage !== "cough_sound") stopPrototypeMusicForContext("under5.followup.cough_sound");
    under5Stage = stage;
    if (stage === "complaints") under5VisitedSymptoms = true;
    else if (stage !== "danger" && stage !== "result") under5VisitedDetails = true;
    hideUnder5StageRegions();
    if (stage === "danger") {
      // The same danger gate opens the sick-child check and the diarrhoea supply journey, and used
      // to render byte-identical in both. A caregiver who backed out of one and opened the other
      // could not tell she had moved; it read as a failed Back button. One line says which journey
      // this gate is gating, before the heading and before the instruction, so it orients rather
      // than adding a second instruction.
      var journey = $("dangerjourney");
      if (journey) journey.textContent = under5Journey === "ors_supply"
        ? tx("tx.triage.chrome.journey_ors", "First the danger signs, then help for diarrhoea.")
        : tx("tx.triage.chrome.journey_sick_child", "First the danger signs, then what is wrong today.");
      renderUnder5DangerGate();
      $("triagechildgroup").classList.remove("hidden");
      $("dangergroup").classList.remove("hidden");
      moveToNextStep("dangergroup");
    } else if (stage === "complaints") {
      renderUnder5ComplaintGate();
      $("complaintgroup").classList.remove("hidden");
      moveToNextStep("complaintgroup");
    } else if (stage === "cough_chest") {
      renderUnder5CoughChestGate();
      $("coughgroup").classList.remove("hidden");
      moveToNextStep("coughgroup");
    } else if (stage === "cough_sound") {
      renderUnder5CoughSoundGate();
      $("coughgroup").classList.remove("hidden");
      moveToNextStep("coughgroup");
    } else if (stage === DIARRHOEA_DURATION_STAGE) {
      $("diargroup").classList.remove("hidden");
      $("diarrhoeadurationfields").classList.remove("hidden");
      bindDiarrhoeaDurationGate();
      moveToNextStep("diargroup");
    } else if (stage === "diarrhoea_stool") {
      renderUnder5DiarrhoeaStoolGate();
      $("diargroup").classList.remove("hidden");
      $("diarrhoeastoolfields").classList.remove("hidden");
      moveToNextStep("diargroup");
    } else if (stage === "diarrhoea_dehydration") {
      renderUnder5DiarrhoeaDehydrationGate();
      $("diargroup").classList.remove("hidden");
      $("diarrhoeadehydrationsigns").classList.remove("hidden");
      moveToNextStep("diargroup");
    } else if (stage === "fever_course") {
      renderUnder5FeverCourseGate();
      $("fevergroup").classList.remove("hidden");
      $("fevercoursefields").classList.remove("hidden");
      moveToNextStep("fevergroup");
    } else if (stage === "fever_measurement") {
      renderUnder5FeverMeasurementGate();
      $("fevergroup").classList.remove("hidden");
      $("fevermeasurementfields").classList.remove("hidden");
      moveToNextStep("fevergroup");
    } else if (stage === "ear") {
      renderUnder5EarGate();
      $("eargroup").classList.remove("hidden");
      moveToNextStep("eargroup");
    } else if (stage === "tooth_mouth") {
      renderUnder5ToothMouthGate();
      $("dentalgroup").classList.remove("hidden");
      moveToNextStep("dentalgroup");
    } else if (stage === "measles") {
      renderUnder5MeaslesGate();
      $("measlesgroup").classList.remove("hidden");
      moveToNextStep("measlesgroup");
    }
    applyShellVisibility();
  }
  function returnToPreviousUnder5Step() {
    if (under5Stage === "danger") { returnFromWork(); return; }
    if (under5ShowingSupport) { restoreUnder5Result(); return; }
    if (under5Stage === "result") {
      if (under5BranchQueue.length && under5BranchQueue[under5BranchIndex]) showUnder5Stage(under5BranchQueue[under5BranchIndex]);
      else showUnder5Stage("complaints");
      return;
    }
    if (under5Stage === "complaints") {
      under5Stage = "danger";
      hideUnder5StageRegions();
      $("triagechildgroup").classList.remove("hidden");
      $("dangergroup").classList.remove("hidden");
      moveToNextStep("dangergroup");
      applyShellVisibility();
      return;
    }
    if (under5BranchIndex > 0) {
      under5BranchIndex -= 1;
      showUnder5Stage(under5BranchQueue[under5BranchIndex]);
      return;
    }
    under5Stage = "complaints";
    hideUnder5StageRegions();
    $("complaintgroup").classList.remove("hidden");
    moveToNextStep("complaintgroup");
    applyShellVisibility();
  }
  function snapshotUnder5Inputs() {
    var snapshot = {};
    var panel = $("triagepanel");
    if (!panel || !panel.querySelectorAll) return snapshot;
    var fields = panel.querySelectorAll("input, select");
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (!field.id) continue;
      snapshot[field.id] = { value: field.value, checked: !!field.checked };
    }
    return snapshot;
  }
  function restoreUnder5Inputs(snapshot) {
    Object.keys(snapshot || {}).forEach(function (id) {
      var field = $(id);
      if (!field) return;
      if (Object.prototype.hasOwnProperty.call(snapshot[id], "value")) field.value = snapshot[id].value;
      if (Object.prototype.hasOwnProperty.call(snapshot[id], "checked")) field.checked = snapshot[id].checked;
    });
  }
  function refreshVisibleUnder5TriageForLocale() {
    var panel = $("triagepanel");
    var snapshot = snapshotUnder5Inputs();
    renderChildSelect(snapshot.triagechildselect ? snapshot.triagechildselect.value : "");
    if (!panel || panel.classList.contains("hidden")) {
      updateAgeFromDob();
      return;
    }
    if (under5Stage === "result") {
      finishUnder5Triage();
      return;
    }
    var stage = under5Stage;
    showUnder5Stage(stage);
    restoreUnder5Inputs(snapshot);
    updateAgeFromDob();
    if (stage === "danger") updateDangerGate();
  }
  function showUnder5ResultStage(showBreathing) {
    under5Stage = "result";
    hideUnder5StageRegions();
    $("out").classList.remove("hidden");
    if (showBreathing) $("rrsection").classList.remove("hidden");
    applyShellVisibility();
    moveToNextStep("out");
  }
  function bindUnder5ResultActions() {
    var out = $("out");
    bindUnder5Back(out);
    var reassess = $("triagereassess");
    // Nothing to advance to until the count exists, and a button that re-renders the same card is
    // indistinguishable from a broken one.
    syncBreathingNextAction();
    if (reassess && !reassess.dataset.bound) {
      reassess.dataset.bound = "under5-reassess";
      reassess.addEventListener("click", function () { if (!reassess.disabled) finishUnder5Triage(); });
    }
    var durationReassess = $("triagediarrhoeadurationreassess");
    var durationInput = $("diarrhoeadaysmissing");
    if (durationReassess && durationInput && !durationReassess.dataset.bound) {
      durationReassess.dataset.bound = "under5-diarrhoea-duration-reassess";
      // Same floor as the in-flow field: one day at least. The review of the 2026-08-18 repairs
      // found the floor held there but not on this twin, which still gated on non-empty only.
      var durationAnswered = function () { var v = String(durationInput.value || "").trim(); return v !== "" && Number(v) >= 1; };
      var updateDurationReassess = function () { durationReassess.disabled = !durationAnswered(); };
      durationInput.addEventListener("input", updateDurationReassess);
      durationReassess.addEventListener("click", function () {
        if (!durationAnswered()) {
          updateDurationReassess();
          durationInput.focus();
          return;
        }
        if ($("diarrhoeadays")) {
          $("diarrhoeadays").value = durationInput.value;
          delete $("diarrhoeadays").dataset.notSure;
        }
        finishUnder5Triage();
      });
      updateDurationReassess();
    }
    var openOrs = $("openorscard");
    if (openOrs && !openOrs.dataset.bound) {
      openOrs.dataset.bound = "under5-ors-card";
      openOrs.addEventListener("click", showUnder5OrsRequestCard);
    }
  }
  function restoreUnder5Result() {
    if (!under5ResultMarkup) { returnToPreviousUnder5Step(); return; }
    under5ShowingSupport = false;
    $("out").innerHTML = under5ResultMarkup;
    showUnder5ResultStage(under5ResultShowsBreathing);
    bindUnder5ResultActions();
  }
  function showResolvedUnder5Result(markup, showBreathing) {
    under5ResultShowsBreathing = !!showBreathing;
    under5ResultMarkup = markup + backToUnder5QuestionsHtml();
    restoreUnder5Result();
  }
  function finishUnder5Triage() {
    var action = $("assess");
    if (action && action.click) action.click();
    else if (action && action._fire) action._fire("click");
  }

  renderUnder5DangerGate();
  showUnder5Stage("danger");
  renderChildSelect(defaultChildPerson() ? defaultChildPerson().id : "");
  if ($("triagechildselect")) $("triagechildselect").addEventListener("change", function () {
    var select = $("triagechildselect");
    var person = select && select.value ? personById(select.value) : null;
    if (person) {
      activePersonId = person.id;
      dangerPersonId = person.id;
      activeSubject = "child_under5";
      applyKnownDob(person);
    } else {
      activePersonId = null;
      dangerPersonId = null;
      if ($("dob")) $("dob").value = "";
      updateAgeFromDob();
    }
    under5Stage = "danger";
    under5BranchQueue = [];
    under5BranchIndex = 0;
    resetUnder5TriageSession();
    showUnder5Stage("danger");
  });
  var rr = null, taps = 0, timer = null, rrWindowSeconds = 60, rrSecondsLeft = 60, rrCounting = false;
  // A rate below the pack floor means the count failed - the caregiver looked away, or the
  // screen slept - not that the child is breathing that slowly.  Recording it as a reading
  // would let an unmeasured child pass the "do we have a rate?" gate.  There is deliberately
  // no upper bound: refusing a high count would hide the fast-breathing sign.
  function rrMinPlausibleBpm() {
    var v = engine.gd && engine.gd.get ? Number(engine.gd.get("ari.respiratoryRate.minPlausibleBpm")) : NaN;
    // Fail loud, as the generated engine does for every missing guideline value. A literal here
    // would be the one clinical number in this file that a pack could not govern.
    if (!(isFinite(v) && v > 0)) throw new Error("guideline pack lacks ari.respiratoryRate.minPlausibleBpm; the breathing counter cannot judge a count");
    return v;
  }
  function updateRRCountingUi() {
    var left = Math.max(0, Math.round(rrSecondsLeft));
    var percent = rrWindowSeconds > 0 ? Math.max(0, Math.min(100, (left / rrWindowSeconds) * 100)) : 0;
    if ($("rrclock")) $("rrclock").textContent = left + "s";
    if ($("rrbar")) $("rrbar").style.width = percent + "%";
    if ($("rrprogress")) {
      $("rrprogress").setAttribute("aria-valuemax", String(rrWindowSeconds));
      $("rrprogress").setAttribute("aria-valuenow", String(left));
    }
    if ($("rrleft")) $("rrleft").textContent = tx("tx.rr.counting_left", "{seconds}s left. Tap once for each breath in or chest rise.", { seconds: left });
    if ($("rrundo")) $("rrundo").disabled = taps <= 0;
  }
  function setRRReady(message, keepResult) {
    clearInterval(timer);
    timer = null;
    rrCounting = false;
    taps = 0;
    if (!keepResult) rr = null;
    $("rridle").classList.remove("hidden");
    $("rrcounting").classList.add("hidden");
    $("rrstart").classList.remove("hidden");
    $("rragain").classList.add("hidden");
    $("rrcancel").classList.toggle("hidden", !keepResult);
    $("tapnum").textContent = tx("tx.rr.breath_count", "{count} breaths", { count: 0 });
    rrSecondsLeft = rrWindowSeconds;
    updateRRCountingUi();
    $("rrleft").textContent = tx("tx.triage.chrome.tap_instruction", "Tap once each time the child breathes in or the chest rises.");
    $("rrout").textContent = message || tx("tx.rr.not_measured", "not measured. When counting starts, tap once for each breath you see.");
    // Whatever brought the counter back to Ready - Stop, Time again, or a failed count - the action
    // that shows the result must follow the rate, which may now be null (review 2026-09-02, finding 4).
    syncBreathingNextAction();
  }
  function setRRMeasured() {
    $("rridle").classList.remove("hidden");
    $("rrcounting").classList.add("hidden");
    $("rrstart").classList.add("hidden");
    $("rragain").classList.remove("hidden");
    $("rrcancel").classList.add("hidden");
    $("rrout").textContent = tx("tx.rr.measured", "breathing rate: {rate} per minute. Tap Time again if you want to repeat the count.", { rate: rr });
    syncBreathingNextAction();
  }
  // The result cannot be shown before the breathing is counted, so the action that shows it stays
  // dim and says why. Counting is the live task meanwhile, so Start carries the emphasis.
  function syncBreathingNextAction() {
    var next = $("triagereassess");
    if (!next) return;
    var measured = typeof rr === "number" && rr > 0;
    next.disabled = !measured;
    next.classList.toggle("ghost", !measured);
    next.textContent = measured
      ? tx("tx.u5.measure_breathing.next", "Next")
      : tx("tx.u5.measure_breathing.next_waiting", "Count the breathing first");
    var start = $("rrstart");
    if (start) start.classList.toggle("ghost", measured);
  }
  function finishRRCount(counted) {
    if (!isFinite(counted) || counted < rrMinPlausibleBpm()) {
      rr = null;
      setRRReady(tx("tx.rr.too_few_taps", "The count recorded too few breaths, so the app kept no reading. Watch the child's chest and tap once for every breath. Tap Start to count again."), false);
      return;
    }
    rr = counted;
    setRRMeasured();
  }
  function resetRR() { setRRReady(t("tx.rr.not_measured"), false); syncBreathingNextAction(); }
  $("rrstart").addEventListener("click", function () {
    taps = 0; rr = null; rrCounting = true;
    rrWindowSeconds = (typeof window !== "undefined" && window.__MAMMA_RR_TIMER_SECONDS) ? Number(window.__MAMMA_RR_TIMER_SECONDS) : 60;
    if (!isFinite(rrWindowSeconds) || rrWindowSeconds <= 0) rrWindowSeconds = 60;
    rrSecondsLeft = Math.round(rrWindowSeconds);
    $("rridle").classList.add("hidden"); $("rrcounting").classList.remove("hidden"); $("tapnum").textContent = tx("tx.rr.breath_count", "{count} breaths", { count: 0 });
    updateRRCountingUi();
    clearInterval(timer);
    timer = setInterval(function () { rrSecondsLeft--; updateRRCountingUi(); if (rrSecondsLeft <= 0) { clearInterval(timer); timer = null; rrCounting = false; finishRRCount(Math.round((taps * 60) / rrWindowSeconds)); } }, 1000);
    if (timer && timer.unref) timer.unref();
  });
  $("rragain").addEventListener("click", function () {
    var previous = rr;
    setRRReady(tx("tx.rr.ready_again", "Ready to time again. Previous result: {rate} per minute. Tap Start to begin, or Cancel to keep the previous result.", { rate: previous }), true);
  });
  $("rrcancel").addEventListener("click", function () {
    if (rr !== null) setRRMeasured();
    else resetRR();
  });
  $("rrtapbtn").addEventListener("click", function () { if (!rrCounting) return; taps++; $("tapnum").textContent = tx("tx.rr.breath_count", "{count} breaths", { count: taps }); updateRRCountingUi(); });
  $("rrundo").addEventListener("click", function () { if (!rrCounting || taps <= 0) return; taps--; $("tapnum").textContent = tx("tx.rr.breath_count", "{count} breaths", { count: taps }); updateRRCountingUi(); });
  $("rrstop").addEventListener("click", function () { setRRReady(tx("tx.rr.stopped", "Count stopped. Start again when you are ready."), false); });

  $("dob").addEventListener("change", updateAgeFromDob);

  // Every sign the "Why this result?" line can name, as a phrase-bank slug rather than an English
  // literal. These used to be a bare object of English strings, which meant two things: no
  // plain-language check in the repo could see them, so `chest indrawing`, `stridor`, `lethargic`
  // and `jaundice` shipped on caregiver screens while BANNED_JARGON listed all four; and they never
  // reached tx(), so a French or Hindi caregiver read them in English at the moment of escalation.
  //
  // David, 2026-08-28: "Explain chest indrawing, lethargic, stridor, jaundice if the words remain,
  // or replace the words. then translate." The wording now matches the question the caregiver
  // answered - the result echoes the words she read, instead of swapping in the clinical term she
  // did not.
  var WHY_SIGN_SLUGS = {
    cough: "tx.why.sign.cough",
    diarrhoea: "tx.why.sign.diarrhoea",
    fever: "tx.why.sign.fever",
    measles_rash: "tx.why.sign.measles_rash",
    ear_problem: "tx.why.sign.ear_problem",
    tooth_mouth: "tx.why.sign.tooth_mouth",
    other_problem: "tx.why.sign.other_problem",
    bloody_stool: "tx.why.sign.bloody_stool",
    unable_to_drink: "tx.why.sign.unable_to_drink",
    vomits_everything: "tx.why.sign.vomits_everything",
    convulsions: "tx.why.sign.convulsions",
    lethargic_unconscious: "tx.why.sign.lethargic_unconscious",
    chest_indrawing: "tx.why.sign.chest_indrawing",
    stridor_calm: "tx.why.sign.stridor_calm",
    sunken_eyes: "tx.why.sign.sunken_eyes",
    skin_pinch_slow: "tx.why.sign.skin_pinch_slow",
    restless_irritable: "tx.why.sign.restless_irritable",
    drinks_eagerly: "tx.why.sign.drinks_eagerly",
    ear_discharge: "tx.why.sign.ear_discharge",
    ear_swelling_behind: "tx.why.sign.ear_swelling_behind",
    tooth_severe_pain: "tx.why.sign.tooth_severe_pain",
    mouth_face_swelling: "tx.why.sign.mouth_face_swelling",
    mouth_injury_bleeding: "tx.why.sign.mouth_injury_bleeding",
    mouth_breathing_swallowing: "tx.why.sign.mouth_breathing_swallowing",
    measles_cough: "tx.why.sign.measles_cough",
    measles_eyes: "tx.why.sign.measles_eyes",
    measles_mouth: "tx.why.sign.measles_mouth",
    measles_breathing: "tx.why.sign.measles_breathing",
    fever_not_improving: "tx.why.sign.fever_not_improving"
  };
  function whySignLabel(key) {
    return WHY_SIGN_SLUGS[key] ? tx(WHY_SIGN_SLUGS[key], null) : null;
  }
  function checkedInputLabels(inputs) {
    var labels = {};
    Object.keys(WHY_SIGN_SLUGS).forEach(function (key) { labels[key] = whySignLabel(key); });
    // The map above is caregiver phrasing, not the list of things a caregiver can tick. Which
    // inputs must appear here is derived from the triage IR by role, so a sign added to the IR
    // shows up in "Why this result" whether or not anyone remembered to add a line above.
    //
    // fever_not_improving is why this is derived now. It is a clinical_finding the caregiver ticks,
    // it drives R8b_fever_persistent_not_improving to routine_clinic, and it was absent from the
    // map - so the one answer that sent the child to a clinic could never be named as the reason.
    // That is the same shape as the four-ancestor CSS allowlist and the booleans-only rationale:
    // a fix that reached the instances someone listed rather than the category.
    var out = [];
    Object.keys(labels).forEach(function (key) { if (inputs[key] === true) out.push(labels[key]); });
    Object.keys(caregiverVisibleTriageInputs()).forEach(function (key) {
      if (labels[key] || inputs[key] !== true) return;
      out.push(caregiverVisibleTriageInputs()[key]);
    });
    return out;
  }
  // A boolean the caregiver answers about the child: a presenting symptom, a general danger sign,
  // or a clinical finding. Gates, config switches, and derived values are excluded by their role,
  // not by being left off a list.
  var CAREGIVER_INPUT_ROLES = ["presenting_symptom", "general_danger_sign", "clinical_finding"];
  function caregiverVisibleTriageInputs() {
    var table = (triagePredicateTable && triagePredicateTable.inputs) || {};
    var out = {};
    Object.keys(table).forEach(function (id) {
      var input = table[id];
      if (input.type !== "boolean") return;
      var roles = input.clinicalVariableRoles || [];
      var visible = CAREGIVER_INPUT_ROLES.some(function (role) { return roles.indexOf(role) >= 0; });
      if (!visible) return;
      out[id] = String((input.label && input.label.en) || id).toLowerCase();
    });
    return out;
  }
  // "Why this result" listed ticked boxes and nothing else, because checkedInputLabels only ever
  // looked at booleans. So a pneumonia result driven by a counted respiratory rate explained itself
  // as "cough". David, 2026-08-25: "why this result = 'cough' but that is nnot enough for urgent.
  // I said 52 breaths; I think that was the reason. Make sure 'Why this result' always has the
  // right answer!"
  //
  // A measured value the caregiver actually gave is part of the answer wherever it exists, not only
  // on the diarrhoea branch that happened to get this treatment first. Age is included when a count
  // is present because the fast-breathing threshold is age-banded: the number alone does not
  // explain the result without the band it was compared against.
  function measuredInputLabels(inputs) {
    var out = [];
    if (inputs.cough === true && Number(inputs.respiratory_rate) > 0) {
      out.push(tx("tx.result.measured_breaths", "breathing {count} breaths a minute", { count: Number(inputs.respiratory_rate) }));
    }
    if (inputs.fever === true && inputs.fever_duration_known === true && Number(inputs.fever_days) > 0) {
      out.push(tx("tx.result.measured_fever_days", "fever for {days} days", { days: Number(inputs.fever_days) }));
    }
    if (inputs.temp_c_axillary_valid === true && Number(inputs.temp_c_axillary) > 0) {
      out.push(tx("tx.result.measured_temp", "armpit temperature {value} C", { value: Number(inputs.temp_c_axillary) }));
    }
    if (inputs.diarrhoea === true && inputs.diarrhoea_duration_known === true && Number(inputs.diarrhoea_days) > 0) {
      out.push(tx("tx.result.diarrhoea_days", "diarrhoea for {days} days", { days: Number(inputs.diarrhoea_days) }));
    }
    if (out.length && inputs.key_data_missing !== true && Number(inputs.age_mo) >= 0) {
      out.push(tx("tx.result.measured_age", "age {months} months", { months: Number(inputs.age_mo) }));
    }
    return out;
  }
  // The same five signs, named the same way. They were a second hand-kept copy of the wording, so
  // "convulsions" was glossed in one list and bare in the other.
  var ABSENT_SAFETY_KEYS = ["bloody_stool", "unable_to_drink", "vomits_everything", "convulsions", "lethargic_unconscious"];
  function absentSafetyLabels(inputs) {
    return ABSENT_SAFETY_KEYS
      .filter(function (key) { return inputs[key] !== true; })
      .map(function (key) { return whySignLabel(key); });
  }
  function absentDiarrhoeaSafetySummary(inputs) {
    // Compare by input key, not by rendered text. Matching on the English string meant this
    // collapsed to the short summary only while the labels happened to be written in English -
    // in French or Hindi every comparison failed and the caregiver got the long list instead.
    var absentKeys = ABSENT_SAFETY_KEYS.filter(function (key) { return inputs[key] !== true; });
    if (absentKeys.length === ABSENT_SAFETY_KEYS.length) return tx("tx.why.absent.none_of_the_danger_signs", null);
    return absentKeys.map(function (key) { return whySignLabel(key); }).join(", ");
  }
  function homeCareSafetyHtml(kind) {
    var triggers = tx("tx.u5.safety.general", "Take the child to the clinic if you see any of these:\n- Gets worse.\n- Cannot drink.\n- Vomits everything.\n- Convulsions (a fit - body shaking or gone stiff).\n- Very sleepy, or hard to wake.\n- You are worried.");
    if (kind === "diarrhoea") {
      triggers = tx("tx.u5.safety.diarrhoea", "Take the child to the clinic if you see any of these:\n- Diarrhoea gets worse.\n- Blood in the stool.\n- Drinks poorly.\n- Vomits everything.\n- Fever.\n- Losing too much water.\n- No better after 2 days.\n- You are worried.");
    } else if (kind === "cough") {
      triggers = tx("tx.u5.safety.cough", "Take the child to the clinic if you see any of these:\n- Fast or hard breathing.\n- The lower chest pulls in.\n- Cannot drink.\n- Fever starts, or stays.\n- The cough is no better.\n- Any danger sign.\n- You are worried.");
    } else if (kind === "fever") {
      triggers = tx("tx.u5.safety.fever", "Take the child to the clinic if you see any of these:\n- Fever lasts 7 days or more.\n- Fever is no better.\n- A rash.\n- A stiff neck.\n- Trouble breathing.\n- Any danger sign.\n- The child seems worse.\n- You are worried.");
    }
    return plainListHtml(triggers);
  }
  function childModuleConcerns(inputs) {
    var concerns = [];
    var dentalSelected = [];
    if (inputs.mouth_breathing_swallowing) dentalSelected.push("dentalbreathing");
    if (inputs.mouth_face_swelling) dentalSelected.push("dentalswelling");
    if (inputs.mouth_injury_bleeding) {
      dentalSelected.push("dentalinjury");
      dentalSelected.push("dentalbleeding");
    }
    if (inputs.tooth_severe_pain) dentalSelected.push("dentalpain");
    var dentalDecision = inputs.tooth_mouth || dentalSelected.length ? screenDecision("dental_triage", dentalSelected) : null;
    if (dentalDecision && dentalDecision.severity === "emergency") {
      concerns.push({ source: "dental_triage", result: dentalDecision, resultScreen: "triage.result.tooth_mouth_emergency", html: resultActionCardHtml({
        kind: "refer",
        careRoute: "dental_or_clinic",
        severity: dentalDecision.severity,
        screenId: "triage.result.tooth_mouth_emergency",
        title: tx("tx.u5.mouth_face_emergency.title", "Mouth or face emergency concern"),
        paragraphs: [tx("tx.u5.mouth_face_emergency.body", "You checked trouble breathing or swallowing with a tooth, mouth, or face problem.\nGet urgent medical or dental care now.")]
      }) + screenDecisionTraceHtml("dental_triage", dentalDecision) });
    } else if (dentalDecision && dentalDecision.severity === "routine_clinic") {
      var dentalReasons = [];
      if (inputs.tooth_severe_pain) dentalReasons.push("severe or worsening tooth or mouth pain");
      if (inputs.mouth_face_swelling) dentalReasons.push("mouth, gum, or face swelling");
      if (inputs.mouth_injury_bleeding) dentalReasons.push("mouth injury, broken tooth, or bleeding");
      concerns.push({ source: "dental_triage", result: dentalDecision, resultScreen: "triage.result.tooth_mouth_clinic", html: resultActionCardHtml({
        kind: "refer",
        careRoute: "dental_or_clinic",
        severity: dentalDecision.severity,
        screenId: "triage.result.tooth_mouth_clinic",
        title: tx("tx.u5.tooth_mouth_concern.title", "Tooth or mouth concern"),
        paragraphs: [tx("tx.u5.tooth_mouth_concern.body", "Because you checked tooth or mouth concern{reasons}, arrange dental or clinic review. Go today for swelling, fever, injury, bleeding, worsening pain, or trouble eating or sleeping.", { reasons: dentalReasons.length ? " with " + dentalReasons.join(", ") : "" })]
      }) + screenDecisionTraceHtml("dental_triage", dentalDecision) });
    } else if (dentalDecision && dentalDecision.severity === "home_care") {
      concerns.push({ source: "dental_triage", result: dentalDecision, resultScreen: "triage.result.tooth_mouth_home", html: resultActionCardHtml({
        kind: "home",
        careRoute: "home_watch",
        severity: dentalDecision.severity,
        screenId: "triage.result.tooth_mouth_home",
        title: tx("tx.u5.tooth_mouth_concern.title", "Tooth or mouth concern"),
        paragraphs: [tx("tx.dental_triage.no_urgent", "No urgent dental sign selected.\nKeep the brushing guidance where you can see it.\nAvoid sugary snacks and drinks when you can.\nAsk a dentist or health worker if pain, swelling, injury, fever, or bleeding starts.")],
        extraHtml: homeCareSafetyHtml("")
      }) + screenDecisionTraceHtml("dental_triage", dentalDecision) });
    }
    var earSelected = [];
    if (inputs.ear_discharge) earSelected.push("eardischarge");
    if (inputs.ear_swelling_behind) earSelected.push("earbehind");
    var earDecision = inputs.ear_problem || earSelected.length ? screenDecision("child_ear_check", earSelected) : null;
    if (earDecision && earDecision.severity === "emergency") {
      concerns.push({ source: "child_ear_check", result: earDecision, resultScreen: "triage.result.ear_emergency", html: resultActionCardHtml({
        kind: "refer",
        careRoute: "child_clinic",
        severity: earDecision.severity,
        screenId: "triage.result.ear_emergency",
        title: tx("tx.u5.ear_danger.title", "Urgent ear concern"),
        paragraphs: [tx("tx.u5.ear_danger.body", "Tender swelling behind the ear can be serious. Do not wait for home care.")]
      }) + screenDecisionTraceHtml("child_ear_check", earDecision) });
    } else if (earDecision && earDecision.severity === "routine_clinic") {
      var earReasons = [];
      if (inputs.ear_discharge) earReasons.push("ear discharge");
      concerns.push({ source: "child_ear_check", result: earDecision, resultScreen: "triage.result.ear_clinic", html: resultActionCardHtml({
        kind: "refer",
        careRoute: "child_clinic",
        severity: earDecision.severity,
        screenId: "triage.result.ear_clinic",
        title: tx("tx.u5.ear_concern.title", "Ear concern"),
        paragraphs: [tx("tx.u5.ear_concern.body", "Because you checked ear pain or discharge{reasons}, arrange clinic or health-worker care today.", { reasons: earReasons.length ? " with " + earReasons.join(", ") : "" })]
      }) + screenDecisionTraceHtml("child_ear_check", earDecision) });
    } else if (earDecision && earDecision.severity === "home_care") {
      concerns.push({ source: "child_ear_check", result: earDecision, resultScreen: "triage.result.ear_home", html: resultActionCardHtml({
        kind: "home",
        careRoute: "home_watch",
        severity: earDecision.severity,
        screenId: "triage.result.ear_home",
        title: tx("tx.screen_ear.no_urgent_title", "Keep watching"),
        paragraphs: [tx("tx.screen_ear.no_urgent", "No ear danger item selected.\nKeep routine child care in view.\nGet care if you see ear pain, discharge, fever, swelling behind the ear, or anything that worries you.")],
        extraHtml: homeCareSafetyHtml("")
      }) + screenDecisionTraceHtml("child_ear_check", earDecision) });
    }
    var measlesSelected = [];
    if (inputs.measles_rash) measlesSelected.push("measlesrash");
    if (inputs.measles_cough) measlesSelected.push("measlescough");
    if (inputs.measles_eyes) measlesSelected.push("measleseyes");
    if (inputs.measles_mouth) measlesSelected.push("measlesmouth");
    if (inputs.measles_breathing) measlesSelected.push("measlesbreathing");
    var measlesDecision = inputs.measles_rash || measlesSelected.length ? screenDecision("child_measles_rash_check", measlesSelected) : null;
    if (measlesDecision && measlesDecision.severity === "emergency") {
      concerns.push({ source: "child_measles_rash_check", result: measlesDecision, resultScreen: "triage.result.measles_emergency", html: resultActionCardHtml({
        kind: "refer",
        careRoute: "child_clinic",
        severity: measlesDecision.severity,
        screenId: "triage.result.measles_emergency",
        title: tx("tx.feature_child_measles_rash_check", "Fever and spreading rash concern"),
        paragraphs: [tx("tx.screen_measles.urgent", "Go for urgent care now if the child has any of these:\n- Trouble breathing.\n- Cannot drink or eat.\n- A serious eye problem, or mouth sores.\n- Looks very ill.\nIf you can, tell the clinic before you arrive that the child has fever and a spreading rash.")]
      }) + screenDecisionTraceHtml("child_measles_rash_check", measlesDecision) });
    } else if (measlesDecision) {
      var measlesFollowup = inputs.measles_cough || inputs.measles_eyes
        ? tx("tx.screen_measles.same_day", "Contact a clinic or health worker today if the child has fever and a spreading rash, plus any of these:\n- Cough.\n- A runny nose.\n- Red or watery eyes.\nKeep the child away from other people while you arrange care.\nContact the clinic before you go, so staff can tell you how to arrive safely.")
        : tx("tx.screen_measles.rash_only", "You chose a spreading rash.\nContact a clinic or health worker today if the child also has any of these:\n- Fever.\n- Cough.\n- A runny nose.\n- Red eyes.\n- Possible contact with measles.\n- Seems unwell.\nKeep the child away from other people while you arrange care.\nContact the clinic before you go.");
      concerns.push({ source: "child_measles_rash_check", result: measlesDecision, resultScreen: "triage.result.measles_clinic", html: resultActionCardHtml({
        kind: "refer",
        careRoute: "child_clinic",
        severity: measlesDecision.severity,
        screenId: "triage.result.measles_clinic",
        title: tx("tx.feature_child_measles_rash_check", "Fever and spreading rash concern"),
        paragraphs: [measlesFollowup]
      }) + screenDecisionTraceHtml("child_measles_rash_check", measlesDecision) });
    }
    if (inputs.other_problem) {
      concerns.push({
        source: "other_problem",
        result: { severity: "routine_clinic", action: "REFER", classification: "other_child_concern" },
        resultScreen: "triage.result.other_concern",
        html: resultActionCardHtml({
          kind: "refer",
          careRoute: "professional",
          severity: "routine_clinic",
          screenId: "triage.result.other_concern",
          title: tx("tx.u5.other_concern.title", "Other child concern"),
          paragraphs: [friendlyOtherMessage()]
        })
      });
    }
    return concerns;
  }
  function triageResultWhyHtml(r, inputs) {
    // One shape for every result. The diarrhoea branch used to be the only one that named a
    // measured value or said what was NOT found, which is why other results explained themselves
    // with a bare complaint word.
    var checked = checkedInputLabels(inputs).concat(measuredInputLabels(inputs));
    var absent = String(r.classification || "").indexOf("diarrhoea") >= 0
      ? absentDiarrhoeaSafetySummary(inputs)
      : absentSafetyLabels(inputs).join(", ");
    if (!checked.length && !absent) return "";
    var html = '<details class="result-why" data-result-why="true"><summary>' + esc(tx("tx.result.show_why", "Why this result?")) + "</summary>";
    if (checked.length) {
      html += '<p><strong>' + esc(tx("tx.result.because_checked", "Because you checked")) + ':</strong> ' + esc(checked.join("; ")) + ".</p>";
    }
    if (absent) {
      html += '<p><strong>' + esc(tx("tx.result.because_not_checked", "Because you did not check")) + ':</strong> ' + esc(absent) + ".</p>";
    }
    return html + "</details>";
  }
  function triageResultHtml(r, inputs, screenId) {
    var isHome = r.action === "HOME_CARE_ORS_ZINC" || r.action === "HOME_CARE_ADVICE";
    var whyHtml = triageResultWhyHtml(r, inputs);
    if (r.classification === "incomplete_assessment") {
      return resultActionCardHtml({
        kind: "refer",
        careRoute: "child_clinic",
        severity: r.severity,
        screenId: screenId,
        title: tx("tx.u5.result.incomplete.title", "Age needed for this check"),
        paragraphs: [tx("tx.u5.result.incomplete.body", "We need the child's age or date of birth to finish this sick-child check. If you cannot enter it, arrange clinic or health-worker assessment. If the child seems very ill or has any danger sign, go urgently.")]
      });
    }
    if (r.classification === "diarrhoea_no_dehydration") {
      return resultActionCardHtml({
        kind: "home",
        careRoute: "home_watch",
        screenId: screenId,
        title: tx("tx.u5.result.diarrhoea_no_dehydration.title", "Diarrhoea home-care check"),
        paragraphs: [tx("tx.u5.result.diarrhoea_no_dehydration.plan", "Keep watching for the danger signs below.")],
        nextAction: tx("tx.result.action_home_ors_watch", "Give fluids now. Get ORS and zinc."),
        nextButtonId: "openorscard",
        nextButtonLabel: tx("tx.ors.request_card.open_button", "Get ORS and zinc"),
        extraHtml: homeCareSafetyHtml("diarrhoea") + whyHtml
      });
    }
    if (r.classification === "diarrhoea_some_dehydration") {
      return resultActionCardHtml({
        kind: "refer",
        careRoute: "child_clinic",
        severity: r.severity,
        screenId: screenId,
        title: tx("tx.u5.result.diarrhoea_some_dehydration.title", "The child is losing too much water"),
        paragraphs: [tx("tx.u5.result.diarrhoea_some_dehydration.plan", "The child has diarrhoea and is losing too much water. A health worker needs to see the child today."), t(r.slug)],
        extraHtml: homeCareSafetyHtml("diarrhoea") + whyHtml
      });
    }
    var kind = r.classification.indexOf("cough") >= 0 ? "cough" : r.classification.indexOf("fever") >= 0 ? "fever" : "";
    var caregiverTitles = {
      very_severe: ["tx.u5.result.title.very_severe", "Danger signs found"],
      dysentery: ["tx.u5.result.title.dysentery", "Blood in the stool - clinic care now"],
      pneumonia: ["tx.u5.result.title.pneumonia", "Breathing concern - clinic care now"],
      cough_or_cold: ["tx.u5.result.title.cough_home", "Cough home care"],
      fever_malaria_test_needed: ["tx.u5.result.title.fever_test", "Fever - ask about a malaria test"],
      fever_malaria_positive: ["tx.u5.result.title.fever_positive", "Positive malaria test - clinic care"],
      fever_prolonged: ["tx.u5.result.title.fever_prolonged", "Fever for 7 days or more"],
      fever_persistent_not_improving: ["tx.u5.result.title.fever_not_improving", "Fever is not improving"],
      fever_no_malaria: ["tx.u5.result.title.fever_home", "Fever home care"],
      unclassified: ["tx.u5.result.title.next", "What to do next"]
    };
    var caregiverTitle = caregiverTitles[r.classification] || caregiverTitles.unclassified;
    return resultActionCardHtml({
      kind: isHome ? "home" : "refer",
      careRoute: isHome ? "home_watch" : "child_clinic",
      severity: r.severity,
      screenId: screenId,
      title: tx(caregiverTitle[0], caregiverTitle[1]),
      // For the all-danger short circuit, the route band and primary action already say
      // to go now. Avoid repeating that command a third time; the rule reason stays in
      // the caregiver-controlled "Why this result?" disclosure.
      paragraphs: r.classification === "very_severe" ? [] : [t(r.slug)],
      extraHtml: (isHome ? homeCareSafetyHtml(kind) : "") + whyHtml
    });
  }
  // Returns 0 when the sachet volume is unknown. There is deliberately no default.
  //
  // This used to return 1000 whenever the pack value was missing or unreadable, which meant the app
  // would happily compute a mixing ratio against a sachet nobody had confirmed. Nothing triggered
  // it, because the pack does hold 1000 - and a dormant fallback is exactly the kind that becomes
  // live the moment the value moves, which is what the sachet-resolution work will do
  // (docs/design/MEMO_ORS_SACHET_RESOLUTION.md, section 3).
  //
  // Getting the concentration wrong is not symmetric: too little water raises the sodium load and
  // carries a hypernatraemia risk, while too much water is merely less effective. So the app
  // refuses to guess. Callers must treat 0 as "no ratio can be shown" and fall back to the packet
  // instruction, exactly as they already do when no exact measuring method matches.
  // Task #18, MEMO_ORS_SACHET_RESOLUTION. The volume the app will state a ratio against, resolved
  // in this order:
  //
  //   1. what the caregiver told us her packet says, this session;
  //   2. the only volume the deployment stocks, if it stocks exactly one;
  //   3. the guideline pack;
  //   4. nothing - and then no ratio is shown at all.
  //
  // Step 2 is the reason most caregivers answer nothing: a deployment with one SKU resolves without
  // a question. It still shows one correctable line, because a deployment can stock one SKU while
  // the caregiver holds a packet from a different shop. Step 4 stays a real outcome; the packet's
  // own instruction is always correct and never stale, which is why it is offered first rather than
  // last (David, 2026-08-20: "offer packet first and only do fancy stuff if they need help").
  function sachetCatalogRows() {
    return catalogRows(engine.sachetCatalog);
  }
  function sachetById(id) {
    return sachetRowById(engine.sachetCatalog, id);
  }
  // Everything these decisions read, handed over explicitly. The module they call cannot reach into
  // this closure, which is the point of moving them out of it.
  function sachetResolutionInputs() {
    return {
      sachetCatalog: engine.sachetCatalog,
      chosenSachetId: orsSachetId,
      guidelineVolumeMl: engine.gd && engine.gd.get ? Number(engine.gd.get("diarrhoea.ors.sachetVolumeMl")) : 0
    };
  }
  function orsSachetVolumeMl() {
    return resolveSachetVolumeMl(sachetResolutionInputs());
  }
  // True when the app picked the volume for her rather than being told. The line it produces is
  // correctable, never silent.
  function orsSachetWasAssumed() {
    return sachetVolumeWasAssumed(sachetResolutionInputs());
  }
  function orsSachetAmountLabel() {
    var ml = orsSachetVolumeMl();
    if (!ml) return "";
    var row = sachetById(orsSachetId) || (sachetCatalogRows().length === 1 ? sachetCatalogRows()[0] : null);
    if (row && row.slug) return tx(row.slug, row.labels && row.labels.en ? row.labels.en : ml + " mL");
    return ml + " mL";
  }
  function orsMeasurementInstruction(container, method) {
    var sachetMl = orsSachetVolumeMl();
    // Sachet volume unknown: say what the packet says, and do not name a volume the app cannot
    // confirm. The old copy here asserted "1 litre (1000 mL)" even in the case where the app had no
    // idea what the sachet held, which is the same 1 L assumption in prose that section 3 of the
    // memo removes from the code.
    if (!sachetMl) {
      return tx("tx.ors_mix_generic_packet", "Mix the whole packet into the amount of clean water printed on the packet. If you cannot read it, ask a health worker or pharmacy - do not guess.");
    }
    if (!container || !method || Number(method.targetVolumeMl) !== sachetMl) {
      return tx("tx.seq_ors_step2_need_container", "First choose an exact way to measure 1 litre (1000 mL) of clean water.");
    }
    if (method.kind === "whole_fills") {
      return tx(method.instructionSlug, "This container holds {volumeMl} mL.\nFill it {fills} times. Pour each fill into a clean mixing container.\nThat gives you {sachetMl} mL of clean water.\nCount carefully. If you cannot measure exactly, ask a health worker, pharmacy, or clinic.", {
        volumeMl: Number(method.fillVolumeMl),
        fills: Number(method.fillCount),
        sachetMl: sachetMl
      });
    }
    if (method.kind === "supplied_measure") {
      return tx(method.instructionSlug, "Use the {volumeMl} mL measure that came with it, {fills} times.\nPour each fill into a clean mixing container.\nThat gives you {sachetMl} mL of clean water.", {
        volumeMl: Number(method.measureVolumeMl),
        fills: Number(method.fillCount),
        sachetMl: sachetMl
      });
    }
    if (method.kind === "marked_line") {
      return tx(method.instructionSlug, method.useMode === "fill_and_mix_in_same_container"
        ? "Fill this container to the clear {sachetMl} mL mark. Keep the water in this container. If the mark is missing or hard to see, do not guess."
        : "Fill this container exactly to the clear {sachetMl} mL mark.\nPour the water into a clean mixing container.\nIf the mark is missing or hard to see, do not guess.", { sachetMl: sachetMl });
    }
    return tx("tx.seq_ors_step2_need_container", "First choose an exact way to measure 1 litre (1000 mL) of clean water.");
  }
  function requestCardHtml() {
    // This card is read by the person behind the counter, off the caregiver's phone. The message to
    // them fills most of the screen (see .seller-card), and the picture of a jug that used to sit
    // above it is gone: it illustrated mixing, which is the deck's job, and it pushed the message
    // below the fold. David, 2026-09-02: "The PLEASE PROVIDE message has to fill almost all of one
    // screen to make it easy for the provider to see."
    return '<div class="result home request-card" id="orsrequestcard" data-screen-id="support.ors_request_card"><h2>' + esc(tx("tx.ors.request_card.title", "Get ORS and zinc")) + '</h2><p class="request-instruction">' + esc(tx("tx.ors.request_card.body", "Show this message wherever you get medicines: a pharmacy, clinic, medicine shop, or community health worker.")) + '</p><div class="seller-card"><strong>' + esc(tx("tx.ors.request_card.seller_label", "Please provide")) + ':</strong><p>' + esc(t("tx.voucher_ors_zinc")) + '</p></div><p class="muted public-distribution-note">' + esc(tx("tx.ors.request_card.public_distribution_note", "ORS may be free at a clinic or from a community health worker.")) + '</p><p class="muted availability-note">' + esc(tx("tx.ors.request_card.fineprint", "If they are not available here, ask where you can get them today.")) + '</p><div class="slidecontrols wrap-controls"><button id="openorsgiving" type="button">How much ORS to give</button><button id="openorsdirections" type="button">' + esc(t("tx.feature_ors_slideshow")) + '</button><button class="ghost" id="openzincsupport" type="button">' + esc(tx("tx.ors.open_zinc", "How to give zinc")) + '</button></div></div>';
  }
  function orsGivingGuideCardHtml() {
    return '<div class="result home request-card" data-screen-id="support.ors_giving"><h2>How much ORS to give</h2>' + orsZincCareGuideHtml() + '<div class="slidecontrols wrap-controls"><button id="backtoorsrequest" type="button">' + esc(tx("tx.nav.back_to_ors_card", "Back to Get ORS and zinc")) + '</button><button id="openorsdirections" type="button">' + esc(t("tx.feature_ors_slideshow")) + '</button><button class="ghost" id="openzincsupport" type="button">' + esc(tx("tx.ors.open_zinc", "How to give zinc")) + '</button></div></div>';
  }
  function showUnder5OrsRequestCard() {
    var out = $("out");
    if (!out) return;
    under5ShowingSupport = true;
    out.innerHTML = requestCardHtml() + backToUnder5ResultHtml();
    bindUnder5Back(out);
    bindRequestCardActions();
    applyShellVisibility();
    moveToNextStep("out");
  }
  function bindRequestCardActions() {
    var giving = $("openorsgiving");
    if (giving && !giving.dataset.bound) {
      giving.dataset.bound = "orsgiving";
      giving.addEventListener("click", function () {
        var out = $("out");
        out.innerHTML = orsGivingGuideCardHtml() + backToUnder5ResultHtml();
        bindUnder5Back(out);
        bindRequestCardActions();
        var back = $("backtoorsrequest");
        if (back && !back.dataset.bound) {
          back.dataset.bound = "orsrequest";
          back.addEventListener("click", showUnder5OrsRequestCard);
        }
        applyShellVisibility();
        moveToNextStep("out");
      });
    }
    var directions = $("openorsdirections");
    if (directions && !directions.dataset.bound) {
      directions.dataset.bound = "orsdirections";
      directions.addEventListener("click", function () { openLaunch("seq.ors_mixing", t("tx.feature_ors_slideshow")); });
    }
    var zinc = $("openzincsupport");
    if (zinc && !zinc.dataset.bound) {
      zinc.dataset.bound = "zincsupport";
      zinc.addEventListener("click", function () { openLaunch("tool.zinc_tracker", t("tx.feature_zinc_tracker")); });
    }
  }

  // The caregiver default view says only that the app is ready. The guideline pack version is
  // reviewer information and belongs in the collapsed review disclosure, not on the home screen
  // of a site testers open. Register row R-13 / decision B-7, David 2026-08-19.
  $("status").textContent = engine.malariaRegion
    ? tx("tx.shell.ready_malaria", "Ready. Set up for an area where malaria is common.")
    : tx("tx.shell.ready", "Ready.");
  if ($("shellprovenancebody")) {
    $("shellprovenancebody").textContent = "Guideline pack " + engine.gd.version
      + (engine.malariaRegion ? "; malaria-endemic switch on" : "; malaria-endemic switch off") + ".";
  }
  if ($("shellprovenance")) $("shellprovenance").hidden = false;
  $("status").classList.add("status-ready");
  $("status").style.color = "#0b6b5b";
  // Until the full runtime has mounted, the static HTML is intentionally non-interactive.
  // Reveal the caregiver shell only after seeded people and all event handlers exist.
  if (document.body && document.body.classList) {
    document.body.classList.remove("app-loading");
    document.body.classList.add("app-ready");
  }
  updateDangerGate();

  $("assess").addEventListener("click", function () {
    var out = $("out");
    var b = function (id) { var e = $("s_" + id); return !!(e && e.checked); };
    if (!dangerAcknowledged()) {
      out.innerHTML = '<div class="result refer"><h2>' + esc(tx("tx.u5.danger_required.title", "Answer danger signs first")) + '</h2><p>' + esc(tx("tx.u5.danger_required.body", "Check any general danger sign that is happening now. If none are happening, check No danger signs before continuing.")) + '</p></div>';
      updateDangerGate();
      applyShellVisibility();
      return;
    }
    var dobValue = $("dob").value || defaultChildDob();
    if (!$("dob").value && dobValue) { $("dob").value = dobValue; updateAgeFromDob(); }
    var ageKnown = !!dobValue, age_mo = 0, age_days_completed = 0;
    if (ageKnown) {
      try {
        var derivedAge = engine.derive({ birth_date: dobValue, now: new Date().toISOString(), temp_entered_value: 0 }, engine.gd);
        age_mo = derivedAge.age_mo;
        age_days_completed = derivedAge.age_days_completed;
      } catch (e) {
        // A date we cannot read is missing data, not an age of zero.  Swallowing this left
        // age_mo at 0, which routed the child as out of scope and blamed the child's age for
        // what was really an unreadable date.  Report it as missing key data instead.
        ageKnown = false;
        age_mo = 0;
        age_days_completed = 0;
        if (typeof console !== "undefined" && console.warn) console.warn("triage: could not derive age from date of birth", e && e.message);
      }
    }
    var diarrhoeaDurationRaw = $("diarrhoeadays") ? String($("diarrhoeadays").value || "") : "";
    var feverDurationRaw = $("feverdays") ? String($("feverdays").value || "") : "";
    // "0 days" used to satisfy fever_duration_known and route the child to fever home care rather
    // than routine clinic - worse than leaving the field blank. Under a day is not yet answered.
    var feverDurationDays = feverDurationRaw === "" ? null : Number(feverDurationRaw);
    var feverDurationAnswered = feverDurationDays !== null && isFinite(feverDurationDays) && feverDurationDays >= 1;
    var feverDurationKnown = !b("fever") || feverDurationAnswered;
    var feverTempRaw = $("fevertempvalue") ? String($("fevertempvalue").value || "") : "";
    var feverTempValue = Number(feverTempRaw);
    var feverTempUnit = $("fevertempunit") ? $("fevertempunit").value : "unknown";
    var feverTempSite = $("fevertempsite") ? $("fevertempsite").value : "unknown";
    var feverTempValid = feverTempRaw !== "" && isFinite(feverTempValue) && feverTempSite === "axillary" && (feverTempUnit === "C" || feverTempUnit === "F");
    var feverTempC = feverTempValid && feverTempUnit === "F"
      ? engine.derive({ birth_date: dobValue || new Date().toISOString(), now: new Date().toISOString(), temp_entered_value: feverTempValue }, engine.gd).temp_c_from_f
      : (feverTempValid ? feverTempValue : 0);
    var inputs = {
      age_mo: age_mo, respiratory_rate: rr == null ? 0 : rr, key_data_missing: !ageKnown,
      age_days_completed: age_days_completed,
      malaria_region: !!engine.malariaRegion,
      diarrhoea_days: diarrhoeaDurationRaw !== "" ? Number(diarrhoeaDurationRaw) || 0 : 0,
      diarrhoea_duration_known: !b("diarrhoea") || diarrhoeaDurationRaw !== "",
      fever_days: feverDurationAnswered ? feverDurationDays : 0,
      fever_duration_known: feverDurationKnown,
      fever_not_improving: !!($("fevernotimproving") && $("fevernotimproving").checked),
      rdt_state: $("feverrdt") ? $("feverrdt").value : "not_done",
      temp_c_axillary: feverTempC,
      temp_c_axillary_valid: feverTempValid,
      cough: b("cough"), diarrhoea: b("diarrhoea"), fever: b("fever"), bloody_stool: b("bloody_stool"),
      unable_to_drink: b("unable_to_drink"), vomits_everything: b("vomits_everything"), convulsions: b("convulsions"),
      lethargic_unconscious: b("lethargic_unconscious"), chest_indrawing: b("chest_indrawing") || !!coughChoiceState.s_chest_indrawing, stridor_calm: b("stridor_calm") || !!coughChoiceState.s_stridor_calm,
      sunken_eyes: b("sunken_eyes"), skin_pinch_slow: b("skin_pinch_slow"), restless_irritable: b("restless_irritable"), drinks_eagerly: b("drinks_eagerly"),
      ear_problem: b("ear_problem"), ear_discharge: b("ear_discharge"), ear_swelling_behind: b("ear_swelling_behind"),
      tooth_mouth: b("tooth_mouth"), tooth_severe_pain: b("tooth_severe_pain"), mouth_face_swelling: b("mouth_face_swelling"), mouth_injury_bleeding: b("mouth_injury_bleeding"), mouth_breathing_swallowing: b("mouth_breathing_swallowing"),
      measles_rash: b("measles_rash"), measles_cough: b("measles_cough"), measles_eyes: b("measles_eyes"), measles_mouth: b("measles_mouth"), measles_breathing: b("measles_breathing"),
      other_problem: b("other_problem") || b("cough_chest_unsure") || b("cough_sound_unsure") || !!coughChoiceState.s_cough_chest_unsure || !!coughChoiceState.s_cough_sound_unsure || b("diarrhoea_dehydration_other") ||
        b("fever_other") || b("fever_measurement_other") ||
        b("ear_other") || b("tooth_mouth_other") || b("measles_other")
    };
    var r = engine.triageEval(inputs, engine.gd);
    var presentations = ["cough", "diarrhoea", "fever", "tooth_mouth", "ear_problem", "measles_rash", "other_problem"].filter(function (id) { return inputs[id] === true; });
    var supplemental = childModuleConcerns(inputs);
    var journey = engine.resolveTriageJourney({
      presentations: presentations,
      coreResult: r,
      supplementalResults: supplemental,
      needsRespiratoryRate: inputs.cough && rr == null,
      needsDiarrhoeaDuration: inputs.diarrhoea && diarrhoeaDurationRaw === ""
    });
    var html = "";
    if (journey.primary.source === "core") {
      html = triageResultHtml(r, inputs, journey.resultScreen);
    } else if (journey.primary.source === "measure_breathing") {
      html = resultActionCardHtml({
        kind: "refer",
        careRoute: "child_clinic",
        severity: "ask_more",
        screenId: journey.resultScreen,
        title: tx("tx.u5.measure_breathing.title", "Measure breathing first"),
        // While she is still trying to count, she has the same return triggers as the cough result she
        // would otherwise see. A failed count used to leave this card with no safety net at all.
        paragraphs: [tx("tx.u5.measure_breathing.body", "There is cough, so count the breathing. Tap Start 60-second count, then tap Next."), tx("tx.u5.safety.cough", "Take the child to the clinic if you see any of these:\n- Fast or hard breathing.\n- The lower chest pulls in.\n- Cannot drink.\n- Fever starts, or stays.\n- The cough is no better.\n- Any danger sign.\n- You are worried.")],
        nextAction: tx("tx.result.action_measure_breathing", "Tap Start 60-second count. Next turns on after you finish the count."),
        nextButtonId: "triagereassess",
        nextButtonLabel: tx("tx.u5.measure_breathing.next", "Next")
      });
    } else if (journey.primary.source === "diarrhoea_duration") {
      html = resultActionCardHtml({
        kind: "refer",
        careRoute: "professional",
        severity: "ask_more",
        screenId: journey.resultScreen,
        title: tx("tx.u5.diarrhoea_duration_required.title", "Tell us how long the diarrhoea has lasted"),
        nextAction: tx("tx.u5.diarrhoea_duration_required.body", "Enter the number of days the child has had loose or watery stools, then assess again. If you are not sure, contact a clinic or health worker."),
        bodyHtml: '<div class="field"><label class="sr-only" for="diarrhoeadaysmissing">' + esc(tx("tx.u5.diarrhoea_duration_required.title", "Tell us how long the diarrhoea has lasted")) + '</label><input type="number" id="diarrhoeadaysmissing" min="1" max="60" inputmode="numeric" /></div>',
        nextButtonId: "triagediarrhoeadurationreassess",
        nextButtonLabel: tx("tx.u5.measure_breathing.next", "Next")
      });
    } else {
      html = journey.primary.html || "";
    }
    var preds = Object.entries(r.predicates).filter(function (kv) { return kv[1]; }).map(function (kv) { return "p." + kv[0]; }).join(", ") || "(none true)";
    html += traceDetails("Prototype rule trace", "severity: " + r.severity + "   rule: " + r.firedRuleId + "   matched: " + r.matchedRules.join(",") + "\naction: " + r.action + "   pack: " + r.guidelineVersion + "\npredicates true: " + preds);
    showResolvedUnder5Result(html, journey.primary.source === "measure_breathing");
  });
}
