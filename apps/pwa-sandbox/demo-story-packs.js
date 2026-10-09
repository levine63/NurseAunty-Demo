// Demo-only optional story-pack loader for the served canonical PWA.
//
// Policy while the project phase in config/switches.json is "prototype" (a phase, not a date):
// missing human review does not block prototype/demo use.
// Unreviewed content stays marked in the global banner and machine-readable governance
// metadata, and must remain fieldUseApproved=false. It is not repeated in every story title.
// The core standalone remains unchanged and does not embed optional story packs.

export const DEMO_STORY_PACK_DIRECTORIES = ["recovered-pr28-v0.1"];

// The unreviewed label, in one place, because it was in two and they disagreed.
//
// On 2026-08-17 this file changed its em dashes to hyphens; test/demo-story-packs.test.mjs kept
// repeating the em-dash version as a literal, and the check went red. Nothing ran it for ten days
// and 110 commits, because its workflow only fires when a story-pack path changes. Two hand-typed
// copies of the same string is the whole defect - so now there is one, and the test reads it.
export const UNREVIEWED_GOVERNANCE_STATUS = "UNREVIEWED PROTOTYPE - demo only; not approved for field use";
export const UNREVIEWED_ASSET_STATUS = "UNREVIEWED PROTOTYPE - demo only";

// Where the label actually lives, now that it is not repeated in every story title. David Levine,
// 2026-08-27, asked whether each title must carry it or the app-wide banner is enough: "banner is
// enough." That decision moves the burden onto this slug, so it is named here rather than only in
// the markup, and test/demo-story-packs.test.mjs checks it is present, governed, and translated.
export const PROTOTYPE_BANNER_SLUG = "tx.shell.prototype_banner";

function assertUnique(existing, incoming, label) {
  const seen = new Set(existing);
  for (const id of incoming) {
    if (seen.has(id)) throw new Error(`Optional story pack duplicates ${label} '${id}'`);
    seen.add(id);
  }
}

export async function installDemoStoryPacks({
  grab,
  phraseDoc,
  featureCatalog,
  storyCards,
  assetManifest,
  moduleRegistry,
}) {
  const installed = [];

  for (const directory of DEMO_STORY_PACK_DIRECTORIES) {
    const root = `../../story-packs/${directory}/`;
    const manifest = await grab(root + "manifest.json");
    // Optional packs are not part of core startup; a core-only harness may omit them.
    if (!manifest || !manifest.status) return installed;
    if (!new Set(["demo_unreviewed", "approved_optional"]).has(manifest.status)) {
      throw new Error(`${manifest.packId || directory} is not enabled for the demo (${manifest.status})`);
    }
    if (manifest.governance?.fieldUseApproved === true && manifest.status === "demo_unreviewed") {
      throw new Error(`${manifest.packId || directory} cannot be both demo_unreviewed and field-use approved`);
    }

    const bundle = await grab(root + manifest.content.bundlePath);
    const features = bundle.features || [];
    const cards = bundle.storyCards || [];
    const assets = bundle.assets || [];
    const phrases = bundle.phrases || {};

    assertUnique((featureCatalog.features || []).map((x) => x.id), features.map((x) => x.id), "feature ID");
    assertUnique((storyCards.cards || []).map((x) => x.featureId), cards.map((x) => x.featureId), "story-card feature ID");
    assertUnique((assetManifest.assets || []).map((x) => x.assetId), assets.map((x) => x.assetId), "asset ID");

    // The app-wide prototype banner and the metadata below carry review state.
    // Repeating it before every title makes the story name harder to find.
    Object.assign(phraseDoc.phrases, phrases);

    featureCatalog.features.push(...features.map((feature) => ({
      ...feature,
      audience: "caregiver",
      governanceStatus: UNREVIEWED_GOVERNANCE_STATUS,
      demoUnreviewed: manifest.status === "demo_unreviewed",
      storyPackId: manifest.packId,
      storyPackVersion: manifest.version,
    })));

    storyCards.cards.push(...cards.map((card) => ({
      ...card,
      governanceStatus: UNREVIEWED_GOVERNANCE_STATUS,
      storyPackId: manifest.packId,
      storyPackVersion: manifest.version,
    })));

    assetManifest.assets.push(...assets.map((asset) => ({
      ...asset,
      targetPath: root + asset.targetPath,
      approvalStatus: manifest.status === "demo_unreviewed"
        ? UNREVIEWED_ASSET_STATUS
        : asset.approvalStatus,
    })));

    for (const feature of features) {
      moduleRegistry.modules.push({
        featureId: feature.id,
        launch: feature.launch,
        renderer: {
          kind: "story.deck",
          featureId: feature.id,
          launch: feature.launch,
          dataSource: "story_cards",
        },
      });
    }

    installed.push({ packId: manifest.packId, version: manifest.version, status: manifest.status });
  }

  return installed;
}
