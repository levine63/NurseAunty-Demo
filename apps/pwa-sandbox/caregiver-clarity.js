// apps/pwa-sandbox/caregiver-clarity.js
// T-043: bounded non-clinical clarity repairs. This module may remove redundant shell copy,
// improve English home labels, normalize speech pronunciation, and defensively stop speech on
// navigation. It must not rewrite clinical questions, results, doses, thresholds, or safety nets.

export const CAREGIVER_CLARITY_VERSION = "HL-2026-08-09-01";

export function normalizeSpokenText(text) {
  return String(text || "")
    .replace(/\bORS\b/g, "O. R. S.")
    .replace(/\s+/g, " ")
    .trim();
}

function setTextIfChanged(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

function applyIdentityClarity(doc) {
  if (!doc.querySelectorAll) return;
  // Role/useful age are already shown. Raw ISO dates are unnecessary on first-read choice
  // surfaces and make the app look like an EHR. Keep birth dates in edit/calculation controls.
  Array.prototype.forEach.call(doc.querySelectorAll(".danger-person span"), function (el) {
    var text = String(el.textContent || "");
    var cleaned = text.replace(/\s*-\s*DOB\s+(?:\d{4}-\d{2}-\d{2}|unknown)\s*$/i, "");
    setTextIfChanged(el, cleaned);
  });
  var select = doc.getElementById("triagechildselect");
  if (select && select.options) {
    Array.prototype.forEach.call(select.options, function (option) {
      if (!option || !option.value) return;
      var cleaned = String(option.textContent || "")
        .replace(/\s*-\s*Date of birth\s+\d{4}-\d{2}-\d{2}\s*$/i, "")
        .replace(/\s*-\s*DOB\s+\d{4}-\d{2}-\d{2}\s*$/i, "");
      setTextIfChanged(option, cleaned);
    });
  }
}

function applyIdleStatusClarity(doc) {
  if (!doc.querySelectorAll) return;
  var statuses = doc.querySelectorAll(".status, [aria-live], #audiostatus, #globalaudiostatus");
  Array.prototype.forEach.call(statuses, function (el) {
    var text = String(el.textContent || "").replace(/\s+/g, " ").trim();
    var isIdle = text === "Read-aloud idle." || text === "Read-aloud ready.";
    if (isIdle) {
      el.hidden = true;
      el.setAttribute("data-hl-idle-hidden", "true");
    } else if (el.getAttribute("data-hl-idle-hidden") === "true") {
      el.hidden = false;
      el.removeAttribute("data-hl-idle-hidden");
    }
  });
}

function applyOrsContainerClarity(doc) {
  if (!doc.getElementById) return;
  var containerStatus = doc.getElementById("orscontainerstatus");
  var image = doc.getElementById("slideimage");
  if (!image) return;
  if (containerStatus) {
    // The selectable household containers are the useful visual on this step. The large
    // generic teaching image above them duplicated the task and pushed choices down-screen.
    image.classList.add("hidden");
    image.setAttribute("data-hl-hidden", "ors-container-choice");
  } else if (image.getAttribute("data-hl-hidden") === "ors-container-choice") {
    image.classList.remove("hidden");
    image.removeAttribute("data-hl-hidden");
  }
}

function installSpeechPronunciation(win) {
  var synth = win && win.speechSynthesis;
  if (!synth || typeof synth.speak !== "function" || synth.__nurseAuntyClarityWrapped) return;
  var nativeSpeak = synth.speak.bind(synth);
  synth.speak = function (utterance) {
    try {
      if (utterance && typeof utterance.text === "string") {
        utterance.text = normalizeSpokenText(utterance.text);
      }
    } catch (e) {
      // Some browser utterance implementations may expose a read-only text property.
      // In that case keep visible text authoritative and fall back to native speech unchanged.
    }
    return nativeSpeak(utterance);
  };
  synth.__nurseAuntyClarityWrapped = true;
}

function installNavigationSpeechStop(doc, win) {
  if (!doc || !doc.addEventListener) return;
  doc.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target.closest("button, a") : null;
    if (!target) return;
    var isContextNavigation =
      target.id === "screenback" ||
      target.classList.contains("navitem") ||
      target.id === "navhome" ||
      target.id === "navpeople" ||
      target.id === "navlearn" ||
      target.id === "navtools" ||
      target.id === "navurgent";
    if (!isContextNavigation) return;
    if (win && win.speechSynthesis && typeof win.speechSynthesis.cancel === "function") {
      try { win.speechSynthesis.cancel(); } catch (e) { /* visible text remains authoritative */ }
    }
  }, true);
}

export function applyCaregiverClarity(doc) {
  if (!doc) return;
  applyIdentityClarity(doc);
  applyIdleStatusClarity(doc);
  applyOrsContainerClarity(doc);
}

export function installCaregiverClarity(doc, win) {
  if (!doc) return function () {};
  installSpeechPronunciation(win);
  installNavigationSpeechStop(doc, win);
  applyCaregiverClarity(doc);

  if (typeof MutationObserver === "undefined" || !doc.body) return function () {};
  var scheduled = false;
  var observer = new MutationObserver(function () {
    if (scheduled) return;
    scheduled = true;
    var run = function () {
      scheduled = false;
      applyCaregiverClarity(doc);
    };
    if (win && typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(run);
    else setTimeout(run, 0);
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
  return function () { observer.disconnect(); };
}
