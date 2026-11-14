// Which picture set the served app shows (ADR-076).
//
// A build can carry the pictures in two sizes: the big set, and a small-phone set no wider than
// 512 pixels (tools/build-small-pictures.mjs writes it and registers each small picture in the
// asset manifest). A build that carries both is the developer build, and this file is its switch:
// add ?pictures=small to the address and every picture that has a small rendition is shown in it;
// leave it off, or say ?pictures=big, and the app is exactly as it was.
//
// The switch is in the address and nowhere else. It is not a caregiver setting, it stores nothing
// on the phone, and it lasts until the page is opened again without it. A caregiver never sees a
// choice here: which pictures her phone gets is decided when her app is built.
//
// It does one thing: before the app starts, it rewrites picture paths in the documents the app
// was handed. No screen knows which set it is drawing. Which small pictures exist is read from
// the asset manifest itself, so a build that carries no small set names none, nothing is
// rewritten, and asking for a set the build does not have shows the big pictures, not broken ones.

export const SMALL_PICTURE_SUFFIX = "-small.webp";
const BIG_PICTURE_SUFFIX = "-display.webp";

// The two keys the app draws a picture from: an asset's file in the asset manifest, and a
// container's photo in the container list. Nothing else is rewritten. A record of where a picture
// came from (derivedFromTargetPath) names a file too, and must go on naming the master.
const PICTURE_KEYS = new Set(["targetPath", "iconPath"]);

const PICTURE_PATH = /^(\.\/)?(assets\/[^?#]+)\.(png|jpe?g|webp)$/i;

/**
 * The set the address asks for: "small" for ?pictures=small, otherwise "big".
 *
 * Anything else, including a misspelling, is the big set. The big set is what the app shows
 * without this file, so an address this function does not understand changes nothing.
 */
export function requestedPictureSet(search) {
  const match = /(?:\?|&)pictures=([^&#]*)/.exec(String(search || ""));
  return match && match[1] === "small" ? "small" : "big";
}

/**
 * The small-phone file that would stand in for a picture path, by name alone.
 *
 * It answers for a master ("assets/x.png") and for its display derivative ("assets/x-display.webp")
 * alike, because the same manifest names the first when served from the repository and the second
 * in a built package. Returns "" for anything that is not a picture path under assets/, and for a
 * path that is already a small picture.
 */
export function smallPicturePathFor(path) {
  const text = String(path || "");
  const match = PICTURE_PATH.exec(text);
  if (!match || text.endsWith(SMALL_PICTURE_SUFFIX)) return "";
  const whole = match[2] + "." + match[3];
  const stem = whole.endsWith(BIG_PICTURE_SUFFIX) ? whole.slice(0, -BIG_PICTURE_SUFFIX.length) : match[2];
  return (match[1] || "") + stem + SMALL_PICTURE_SUFFIX;
}

/**
 * The small pictures a build carries: the files its asset manifest registers as small pictures,
 * as a set of paths without a leading "./".
 *
 * A manifest that is missing, or is not the expected shape, names none. That is deliberate: the
 * caller then rewrites nothing and the big pictures stay.
 */
export function smallPicturesIn(assetManifest) {
  const named = new Set();
  if (!assetManifest || !Array.isArray(assetManifest.assets)) return named;
  for (const asset of assetManifest.assets) {
    const path = asset && typeof asset.targetPath === "string" ? asset.targetPath.replace(/^\.\//, "") : "";
    if (PICTURE_PATH.test(path) && path.endsWith(SMALL_PICTURE_SUFFIX) && !path.includes("..")) named.add(path);
  }
  return named;
}

/**
 * Point every picture that has a small rendition at it, in place.
 *
 * `assetManifest` says which small pictures this build carries and is itself rewritten;
 * `otherDocuments` are the other parsed files that carry picture paths (the container list).
 * Only a value under a key the app draws from is touched, only when it is exactly a picture path
 * under assets/, and only when the manifest registers its small file. So a sound, a drawing in
 * SVG, a picture already inlined as data, and the record of which master a picture came from are
 * all left alone.
 *
 * Returns how many small pictures the build carries and how many paths were changed. A build
 * with none changes none. A small-phone build carries them and changes none either, because its
 * paths are already small.
 */
export function useSmallPictures(assetManifest, otherDocuments) {
  const named = smallPicturesIn(assetManifest);
  let changed = 0;
  if (!named.size) return { available: 0, changed };
  const seen = new Set();
  function visit(node) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "string") {
        if (!PICTURE_KEYS.has(key)) continue;
        const small = smallPicturePathFor(value);
        if (small && named.has(small.replace(/^\.\//, ""))) {
          node[key] = small;
          changed++;
        }
      } else {
        visit(value);
      }
    }
  }
  visit(assetManifest);
  for (const document of otherDocuments || []) visit(document);
  return { available: named.size, changed };
}
