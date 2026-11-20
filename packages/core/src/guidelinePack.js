// Which guideline pack an installation runs, and the one rule for loading it.
//
// A deployment file (deployments/<id>.json, ADR-055 / T-066) names its guideline pack. Every
// consumer - the served app, the standalone build, the ORS tool online and offline, the validator,
// the golden runner - loads the pack through this module, so a pack choice cannot be honoured by
// four consumers and ignored by a fifth.
//
// It fails loudly. An unknown id, a file that is not there, a pack whose version the deployment
// does not accept, and a test-only pack outside a test are each an Error with a plain message. There
// is no fallback to Bangladesh: a silent fallback would run another country's clinical thresholds
// on a caregiver's phone while every screen looked normal.
//
// This file is plain JavaScript with no imports so the browser, Node and the standalone bundler can
// all use it. The Node-side reader, the content hash and the build record are in
// tools/lib/deployment.mjs.

/** The deployment used when nothing else is chosen. A build or a test chooses another on purpose. */
export const DEFAULT_DEPLOYMENT_ID = "bd-prototype";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class GuidelinePackError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuidelinePackError";
  }
}

function assertId(kind, id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new GuidelinePackError(`${kind} id ${JSON.stringify(id)} is not valid: use lower-case letters, digits and hyphens`);
  }
  return id;
}

/** Repository-relative path of a deployment file. */
export function deploymentPath(deploymentId) {
  return `deployments/${assertId("deployment", deploymentId)}.json`;
}

/** Repository-relative path of a guideline pack. The only place that turns a pack id into a file name. */
export function guidelinePackPath(guidelinePackId) {
  return `guidelines/${assertId("guideline pack", guidelinePackId)}.json`;
}

/** Problems with the pack-choice part of a deployment file. Empty means it is usable. */
export function deploymentPackProblems(deployment) {
  const problems = [];
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    return ["the deployment file is not a JSON object"];
  }
  for (const field of ["guidelinePackId", "guidelinePackVersion"]) {
    if (typeof deployment[field] !== "string" || deployment[field].trim() === "") {
      problems.push(`deployment '${deployment.deploymentId}' has no ${field}`);
    }
  }
  if (typeof deployment.guidelinePackId === "string" && !ID_PATTERN.test(deployment.guidelinePackId)) {
    problems.push(`deployment '${deployment.deploymentId}' guidelinePackId ${JSON.stringify(deployment.guidelinePackId)} is not valid`);
  }
  return problems;
}

/**
 * Check a loaded pack against the deployment that chose it and return what consumers use.
 * `pack` is the parsed guidelines/<guidelinePackId>.json. `allowTestOnly` is passed only by tests.
 */
export function resolveGuidelinePack({ deployment, pack, allowTestOnly = false }) {
  const problems = deploymentPackProblems(deployment);
  if (problems.length) throw new GuidelinePackError(problems.join("; "));
  const id = deployment.guidelinePackId;
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    throw new GuidelinePackError(`guideline pack '${id}' (${guidelinePackPath(id)}) is not a JSON object`);
  }
  if (typeof pack.version !== "string" || pack.version === "") {
    throw new GuidelinePackError(`guideline pack '${id}' has no version`);
  }
  if (pack.version !== deployment.guidelinePackVersion) {
    throw new GuidelinePackError(
      `deployment '${deployment.deploymentId}' accepts guideline pack version '${deployment.guidelinePackVersion}' ` +
      `but ${guidelinePackPath(id)} is version '${pack.version}'`,
    );
  }
  if (pack.testOnly === true && !allowTestOnly) {
    throw new GuidelinePackError(`guideline pack '${id}' is marked testOnly and is refused outside tests`);
  }
  return { deploymentId: deployment.deploymentId, packId: id, version: pack.version, pack };
}

/**
 * Browser-side loader. `grab(path)` returns parsed JSON for a repository-relative path (it throws on
 * a missing file); the caller decides how paths map to URLs.
 */
export async function loadGuidelinePack(grab, deploymentId = DEFAULT_DEPLOYMENT_ID, { allowTestOnly = false } = {}) {
  let deployment;
  try {
    deployment = await grab(deploymentPath(deploymentId));
  } catch (error) {
    throw new GuidelinePackError(`deployment '${deploymentId}' could not be loaded (${error.message})`);
  }
  if (deployment?.deploymentId !== deploymentId) {
    throw new GuidelinePackError(`${deploymentPath(deploymentId)} names deploymentId '${deployment?.deploymentId}'`);
  }
  const problems = deploymentPackProblems(deployment);
  if (problems.length) throw new GuidelinePackError(problems.join("; "));
  let pack;
  try {
    pack = await grab(guidelinePackPath(deployment.guidelinePackId));
  } catch (error) {
    throw new GuidelinePackError(`guideline pack '${deployment.guidelinePackId}' could not be loaded (${error.message})`);
  }
  return { deployment, ...resolveGuidelinePack({ deployment, pack, allowTestOnly }) };
}
