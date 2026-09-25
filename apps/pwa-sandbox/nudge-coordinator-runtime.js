




































































































const URGENCY_RANK                                   = {
  clinical_safety: 0,
  adherence_habit: 1,
  informational_encouragement: 2,
};

export function createNudgeCoordinator(
  ctx                                                                                         ,
  options                          = {},
)                   {
  const dailyNonClinicalBudget = options.dailyNonClinicalBudget ?? 3;
  const ignoredBackoffThreshold = options.ignoredBackoffThreshold ?? 3;
  const preferences = options.preferences ?? {};
  const seenRequestIds = new Set        (options.initialState?.seenRequestIds || []);
  const scheduledNonClinicalByDay = new Map                (options.initialState?.scheduledNonClinicalByDay || []);
  const ignoredByType = new Map                (options.initialState?.ignoredByType || []);

  async function audit(type        , moduleId        , detail                          ) {
    await ctx.audit.log({ type, moduleId, detail });
  }

  async function recordFeedback(feedback               )                {
    await audit("nudge." + feedback.event, feedback.moduleId, {
      requestId: feedback.requestId,
      topic: feedback.topic,
      occurredAt: feedback.occurredAt,
    });
    if (feedback.event === "ignored" || feedback.event === "dismissed") {
      const key = backoffKey(feedback.moduleId, feedback.topic);
      ignoredByType.set(key, (ignoredByType.get(key) || 0) + 1);
    }
    if (feedback.event === "opened" || feedback.event === "completed") {
      ignoredByType.delete(backoffKey(feedback.moduleId, feedback.topic));
    }
  }

  async function onSignal(name        , value                  )                           {
    if (name !== "nudge.requested" || typeof value !== "string") return [];
    return scheduleRequests([decodeNudgeRequestSignal(value)]);
  }

  async function scheduleRequests(requests                )                           {
    const now = new Date(ctx.clock.now());
    const decisions                  = [];
    const candidates              = [];

    for (const request of requests) {
      if (seenRequestIds.has(request.requestId)) {
        await audit("nudge.duplicate", request.moduleId, { requestId: request.requestId });
        decisions.push({ requestIds: [request.requestId], action: "duplicate", reason: "requestId already processed" });
        continue;
      }
      seenRequestIds.add(request.requestId);

      if (new Date(request.expiresAt) <= now) {
        await audit("nudge.dropped_expired", request.moduleId, { requestId: request.requestId, topic: request.topic });
        decisions.push({ requestIds: [request.requestId], action: "dropped_expired", reason: "request expired" });
        continue;
      }

      if (shouldBackoff(request)) {
        await audit("nudge.dropped_backoff", request.moduleId, { requestId: request.requestId, topic: request.topic });
        decisions.push({ requestIds: [request.requestId], action: "dropped_backoff", reason: "ignored cooldown active" });
        continue;
      }

      const timing = chooseFireAt(request, preferences);
      if (!timing) {
        await audit("nudge.dropped_expired", request.moduleId, { requestId: request.requestId, topic: request.topic });
        decisions.push({ requestIds: [request.requestId], action: "dropped_expired", reason: "no usable delivery time" });
        continue;
      }
      candidates.push({ request, fireAt: timing.fireAt, deferred: timing.deferred });
    }

    const ranked = candidates.sort(compareCandidates);
    const accepted = applyDailyBudget(buildBundles(ranked), dailyNonClinicalBudget, scheduledNonClinicalByDay, preferences, decisions);
    for (const decision of decisions.filter((d) => d.action === "dropped_budget")) {
      const request = requests.find((r) => r.requestId === decision.requestIds[0]);
      if (request) await audit("nudge.dropped_budget", request.moduleId, { requestId: request.requestId, topic: request.topic });
    }

    for (const bundle of accepted) {
      if (bundle.deferred) {
        for (const request of bundle.requests) {
          await audit("nudge.deferred", request.moduleId, {
            requestId: request.requestId,
            fireAt: bundle.fireAt.toISOString(),
            reason: "quiet_hours",
          });
        }
      }
      const handle = await scheduleBundle(ctx, bundle, preferences);
      const action = bundle.requests.length > 1 ? "bundled" : "scheduled";
      decisions.push({
        requestIds: bundle.requests.map((request) => request.requestId),
        action,
        fireAt: bundle.fireAt.toISOString(),
        handle,
      });
      for (const request of bundle.requests) {
        await audit(action === "bundled" ? "nudge.bundled" : "nudge.scheduled", request.moduleId, {
          requestId: request.requestId,
          requestIds: bundle.requests.map((item) => item.requestId),
          fireAt: bundle.fireAt.toISOString(),
        });
      }
    }

    return decisions;
  }

  function shouldBackoff(request              )          {
    return request.urgencyTier !== "clinical_safety"
      && (ignoredByType.get(backoffKey(request.moduleId, request.topic)) || 0) >= ignoredBackoffThreshold;
  }

  function exportState()                        {
    return {
      seenRequestIds: [...seenRequestIds],
      scheduledNonClinicalByDay: [...scheduledNonClinicalByDay.entries()],
      ignoredByType: [...ignoredByType.entries()],
    };
  }

  return { scheduleRequests, onSignal, recordFeedback, exportState };
}

export function encodeNudgeRequestSignal(request              )         {
  return JSON.stringify(request);
}

export function decodeNudgeRequestSignal(value        )               {
  const parsed = JSON.parse(value);
  assertNudgeRequest(parsed);
  return parsed;
}

function assertNudgeRequest(value         )                                {
  if (!value || typeof value !== "object") throw new Error("nudge.requested payload must be an object");
  const request = value                           ;
  const required = [
    "requestId", "moduleId", "topic", "urgencyTier", "windowStart", "windowEnd",
    "phraseFamily", "privacyClass", "channelsAllowed", "expiresAt",
  ];
  for (const key of required) {
    if (!(key in request)) throw new Error("nudge.requested missing " + key);
  }
  if (!Array.isArray(request.channelsAllowed)) throw new Error("nudge.requested channelsAllowed must be an array");
}

function compareCandidates(a           , b           )         {
  const urgency = URGENCY_RANK[a.request.urgencyTier] - URGENCY_RANK[b.request.urgencyTier];
  if (urgency !== 0) return urgency;
  const expiry = new Date(a.request.expiresAt).getTime() - new Date(b.request.expiresAt).getTime();
  if (expiry !== 0) return expiry;
  return a.fireAt.getTime() - b.fireAt.getTime();
}

function applyDailyBudget(
  bundles          ,
  dailyBudget        ,
  scheduledByDay                     ,
  preferences                      ,
  decisions                 ,
)           {
  const accepted           = [];
  for (const bundle of bundles) {
    if (bundle.requests.some((request) => request.urgencyTier === "clinical_safety")) {
      accepted.push(bundle);
      continue;
    }
    const day = localDay(bundle.fireAt, preferences.timezoneOffsetMinutes || 0);
    const used = scheduledByDay.get(day) || 0;
    if (used >= dailyBudget) {
      for (const request of bundle.requests) {
        decisions.push({
          requestIds: [request.requestId],
          action: "dropped_budget",
          reason: "daily non-clinical budget exhausted",
        });
      }
      continue;
    }
    scheduledByDay.set(day, used + 1);
    accepted.push(bundle);
  }
  return accepted;
}

function buildBundles(candidates             )           {
  const bundles           = [];
  const grouped = new Set           ();
  for (const candidate of candidates) {
    if (grouped.has(candidate)) continue;
    if (candidate.request.urgencyTier === "clinical_safety") {
      bundles.push({ requests: [candidate.request], fireAt: candidate.fireAt, deferred: candidate.deferred });
      grouped.add(candidate);
      continue;
    }
    const matches = candidates.filter((other) =>
      !grouped.has(other)
      && other.request.urgencyTier !== "clinical_safety"
      && sameBundleWindow(candidate, other)
    );
    for (const match of matches) grouped.add(match);
    bundles.push({
      requests: matches.map((match) => match.request),
      fireAt: new Date(Math.min(...matches.map((match) => match.fireAt.getTime()))),
      deferred: matches.some((match) => match.deferred),
    });
  }
  return bundles;
}

function sameBundleWindow(a           , b           )          {
  if (!a.request.bundleKey || !b.request.bundleKey) return a === b;
  if (a.request.bundleKey !== b.request.bundleKey) return false;
  const aRecurrence = a.request.recurrence?.rrule || "";
  const bRecurrence = b.request.recurrence?.rrule || "";
  if (aRecurrence !== bRecurrence) return false;
  const aStart = new Date(a.request.windowStart).getTime();
  const aEnd = new Date(a.request.windowEnd).getTime();
  const bStart = new Date(b.request.windowStart).getTime();
  const bEnd = new Date(b.request.windowEnd).getTime();
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

function chooseFireAt(
  request              ,
  preferences                      ,
)                                             {
  const start = new Date(request.windowStart);
  const end = new Date(request.windowEnd);
  if (request.urgencyTier === "clinical_safety") return { fireAt: start, deferred: false };
  if (!preferences.quietHours || !isInsideQuietHours(start, preferences.quietHours, preferences.timezoneOffsetMinutes || 0)) {
    return { fireAt: start, deferred: false };
  }
  const quietEnd = nextQuietEnd(start, preferences.quietHours, preferences.timezoneOffsetMinutes || 0);
  if (quietEnd <= end) return { fireAt: quietEnd, deferred: true };
  return null;
}

async function scheduleBundle(
  ctx                                                                                         ,
  bundle        ,
  preferences                      ,
)                  {
  const first = bundle.requests[0];
  const notification = buildNotification(ctx, bundle.requests);
  const spec               = {
    id: "nudge:" + bundle.requests.map((request) => request.requestId).join("+"),
    fireAt: bundle.fireAt.toISOString(),
    recurrence: first.recurrence,
    payload: {
      kind: "nudge",
      requestIds: bundle.requests.map((request) => request.requestId),
      moduleIds: bundle.requests.map((request) => request.moduleId),
      topics: bundle.requests.map((request) => request.topic),
      urgencyTier: highestUrgency(bundle.requests),
      privacyClass: highestPrivacy(bundle.requests),
      phraseFamily: first.phraseFamily,
      notification,
    },
    channels: selectChannels(bundle.requests, preferences),
    moduleId: "nudge-coordinator",
  };
  return ctx.scheduler.schedule(spec);
}

function buildNotification(
  ctx                                    ,
  requests                ,
)                                  {
  const phraseFamily = requests[0].phraseFamily;
  const title = translate(ctx, phraseFamily + ".title", {}, "Reminder");
  if (requests.length > 1) {
    return {
      title,
      body: translate(ctx, phraseFamily + ".bundle", { count: requests.length }, requests.length + " things for today: check your plan and update your tracker."),
    };
  }
  const request = requests[0];
  return {
    title,
    body: request.privacyClass === "sensitive_topic"
      ? translate(ctx, phraseFamily + ".private", {}, "You have a care reminder.")
      : translate(ctx, phraseFamily + ".single", {}, "A small reminder is ready when you are."),
  };
}

function translate(
  ctx                                    ,
  key        ,
  vars                                 ,
  fallback        ,
)         {
  if (!ctx.i18n) return fallback;
  const value = ctx.i18n.t(key, vars);
  return value && value !== key ? value : fallback;
}

function selectChannels(requests                , preferences                      )                     {
  const clinical = requests.some((request) => request.urgencyTier === "clinical_safety");
  if (clinical) {
    const channels = new Set                  ();
    for (const request of requests) for (const channel of request.channelsAllowed) channels.add(channel);
    return [...channels];
  }
  if (highestPrivacy(requests) === "sensitive_topic") return ["local"];
  const allowed = new Set                  ();
  for (const request of requests) for (const channel of request.channelsAllowed) allowed.add(channel);
  const preferred                     = preferences.preferredChannels && preferences.preferredChannels.length ? preferences.preferredChannels : ["local"];
  const selected = preferred.filter((channel) => allowed.has(channel));
  return selected.length ? selected : ["local"];
}

function highestUrgency(requests                )                   {
  return [...requests].sort((a, b) => URGENCY_RANK[a.urgencyTier] - URGENCY_RANK[b.urgencyTier])[0].urgencyTier;
}

function highestPrivacy(requests                )                    {
  if (requests.some((request) => request.privacyClass === "clinical_safety")) return "clinical_safety";
  if (requests.some((request) => request.privacyClass === "sensitive_topic")) return "sensitive_topic";
  return "generic_ok";
}

function isInsideQuietHours(date      , quietHours                                , offsetMinutes        )          {
  const minutes = localMinutes(date, offsetMinutes);
  const start = timeToMinutes(quietHours.start);
  const end = timeToMinutes(quietHours.end);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function nextQuietEnd(date      , quietHours                                , offsetMinutes        )       {
  const endMinutes = timeToMinutes(quietHours.end);
  const shifted = new Date(date.getTime() + offsetMinutes * 60000);
  const result = new Date(shifted);
  result.setUTCHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
  result.setTime(result.getTime() - offsetMinutes * 60000);
  if (result <= date) result.setUTCDate(result.getUTCDate() + 1);
  return result;
}

function timeToMinutes(value        )         {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return hours * 60 + minutes;
}

function localMinutes(date      , offsetMinutes        )         {
  const shifted = new Date(date.getTime() + offsetMinutes * 60000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function localDay(date      , offsetMinutes        )         {
  return new Date(date.getTime() + offsetMinutes * 60000).toISOString().slice(0, 10);
}

function backoffKey(moduleId        , topic        )         {
  return moduleId + "::" + topic;
}
