// apps/pwa-sandbox/picture-assembler.js - show one picture built from a few stacked pieces.
//
// Why pieces at all. David, 2026-11-11: "I do NOT need one-off images, as those will overflow
// memory on an old Android phone", and: "It can be 100% assembled ahead of time, 100% on device, a
// hybrid with backgrounds and foregrounds are all that are assembled on device ... We should have
// code that reads the manifest and assembles." A thousand finished pictures repeat the same room
// and the same seated mother a thousand times. Stored once and stacked on the phone, they are
// paid for once. See ADR-074 for the sizes this was decided on.
//
// What a picture is made of, back to front:
//   a room     - one opaque background, shared by every picture set in that room
//   a group    - everyone who is touching, drawn together as ONE piece, because a hand on a
//                shoulder cut into two pieces is where earlier attempts fell apart
//   swaps      - small patches that replace part of the group: a face, a cup, a pointer
//
// How the phone draws it: ordinary <img> elements, one on top of the other, sized in percent.
// No canvas and no script in the drawing itself, so the browser does the scaling and there is
// nothing here that can run out of memory in a loop.
//
// This file does not decide WHICH pictures are stacked. tools/pictures/plan-pack.mjs does that
// ahead of time, picture by picture, and writes pack-plan.json: a picture whose pieces nobody
// else uses is cheaper as one finished file, and is shipped that way.
//
// Fail closed. A picture with a piece missing is not shown at all. A mother pouring from a jug
// that did not load is a picture of something else, and the caregiver cannot tell.

/** Everything a placement may say. The build-time flattener (tools/assemble-image.py) can also
 *  rotate, flip, fade and mask; the phone cannot be trusted to do those identically on a
 *  2016 WebView, so a picture that needs one is refused here and shipped as a finished file. */
export const PLACEMENT_KEYS = ["assetId", "x", "y", "width", "height", "zIndex"];

const PICTURE_FILE = /\.(webp|png|svg|jpe?g)$/i;

// A piece is transparent wherever the piece behind it should show. The app's own style sheet
// gives pictures inside some cards a cream background and rounded corners
// (.questionasset img, .dosecard img); on a piece that would paint a cream block over the room.
const PIECE_RESET = "background:none;border:0;border-radius:0;margin:0;padding:0;max-width:none;max-height:none";

function refuse(reason) {
  return { ok: false, reason };
}

function percent(fraction) {
  // Four decimals is a fortieth of a pixel on a 4000-pixel screen. Rounding keeps the HTML the
  // same on every machine, which the determinism rule in CODE-STANDARDS.md asks for.
  return String(Math.round(fraction * 1000000) / 10000);
}

/**
 * The pieces of one picture, back to front, placed in percent of the picture's own box.
 * Returns { ok: true, layers, heightOverWidth } or { ok: false, reason }.
 */
export function pictureLayers(pack, sceneId) {
  const scene = pack && pack.scenes && Object.prototype.hasOwnProperty.call(pack.scenes, sceneId)
    ? pack.scenes[sceneId] : null;
  if (!scene) return refuse("the pack has no picture called " + sceneId);
  if (!Array.isArray(scene.placements) || scene.placements.length === 0) {
    return refuse(sceneId + " lists no pieces");
  }
  // The shape of the picture is never assumed. A pack with no canvas used to be drawn square,
  // which stretched every piece of a picture that was not.
  const canvas = pack.canvas;
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) {
    return refuse("the pack does not say what shape its pictures are (canvas.width and canvas.height)");
  }
  // What shows where no piece covers the picture. The finished files have it painted in, so the
  // stacked picture must paint the same colour or the two are different pictures.
  if (canvas.background !== undefined && !/^#[0-9a-f]{6}$/i.test(canvas.background)) {
    return refuse("the pack's canvas colour is not a six-digit colour like #faf5e9");
  }

  const pieces = new Map((pack.assets || []).map((asset) => [asset.id, asset]));
  const layers = [];
  for (let index = 0; index < scene.placements.length; index++) {
    const placement = scene.placements[index];
    if (!placement || typeof placement !== "object") return refuse(sceneId + " has a piece that is not a placement");
    const unknown = Object.keys(placement).filter((key) => !PLACEMENT_KEYS.includes(key));
    if (unknown.length) {
      return refuse(sceneId + " asks for " + unknown.join(", ") + ", which the phone does not draw");
    }
    const piece = pieces.get(placement.assetId);
    if (!piece) return refuse(sceneId + " uses " + placement.assetId + ", which is not in the pack");
    if (!PICTURE_FILE.test(piece.file || "")) {
      return refuse(placement.assetId + " has no picture file");
    }
    for (const key of ["x", "y", "width", "height"]) {
      if (typeof placement[key] !== "number" || !Number.isFinite(placement[key])) {
        return refuse(sceneId + ": " + placement.assetId + " has no number for " + key);
      }
    }
    if (placement.width <= 0 || placement.height <= 0 ||
      percent(placement.width) === "0" || percent(placement.height) === "0") {
      return refuse(sceneId + ": " + placement.assetId + " has no size");
    }
    // A piece may hang a little over the edge, as an arm does. One that is several pictures
    // away, or several pictures wide, is a mistake in the manifest and not a picture.
    if (placement.x < -1 || placement.x > 2 || placement.y < -1 || placement.y > 2 ||
      placement.width > 2 || placement.height > 2) {
      return refuse(sceneId + ": " + placement.assetId + " is placed far outside the picture");
    }
    if (placement.zIndex !== undefined && !Number.isInteger(placement.zIndex)) {
      return refuse(sceneId + ": " + placement.assetId + " has a layer number that is not whole");
    }
    layers.push({
      assetId: placement.assetId,
      file: piece.file,
      left: percent(placement.x),
      top: percent(placement.y),
      width: percent(placement.width),
      height: percent(placement.height),
      z: placement.zIndex || 0,
      listed: index,
    });
  }
  // Back to front. Two pieces on the same layer keep the order they were listed in, which is
  // what the flattener does, so the phone and the finished file cannot disagree about overlap.
  layers.sort((a, b) => a.z - b.z || a.listed - b.listed);
  return { ok: true, layers, heightOverWidth: canvas.height / canvas.width, background: canvas.background || null };
}

/** How this picture is shipped: "pieces" (stacked on the phone) or "flat" (one finished file).
 *  With no plan every picture is flat, because a finished file is the one that cannot go wrong. */
export function pictureMode(plan, sceneId) {
  const mode = plan && plan.scenes ? plan.scenes[sceneId] : null;
  return mode === "pieces" ? "pieces" : "flat";
}

/** Every file one picture needs, so a build embeds or pre-caches exactly these. */
export function pictureFiles(pack, plan, sceneId) {
  if (pictureMode(plan, sceneId) === "flat") {
    const scene = pack && pack.scenes ? pack.scenes[sceneId] : null;
    return scene && PICTURE_FILE.test(scene.output || "") ? [scene.output] : [];
  }
  const built = pictureLayers(pack, sceneId);
  return built.ok ? [...new Set(built.layers.map((layer) => layer.file))] : [];
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The HTML for one picture, or "" when it cannot be shown correctly.
 *
 * `alt` is the caregiver's description of the whole picture and is required: the pieces carry
 * none of their own, so a screen reader hears one picture, not "kitchen, mother, cup".
 * `urlFor(file)` turns a pack file into something an <img> can load.
 */
export function pictureHtml(pack, sceneId, { alt, urlFor, plan } = {}) {
  if (!alt || typeof urlFor !== "function") return "";
  const scene = pack && pack.scenes ? pack.scenes[sceneId] : null;
  if (!scene) return "";
  const label = escapeHtml(alt);
  const id = escapeHtml(sceneId);

  if (pictureMode(plan, sceneId) === "flat") {
    if (!PICTURE_FILE.test(scene.output || "")) return "";
    return '<img class="picture picture-flat" data-picture="' + id + '" data-picture-mode="flat" src="' +
      escapeHtml(urlFor(scene.output)) + '" alt="' + label + '" decoding="async">';
  }

  const built = pictureLayers(pack, sceneId);
  if (!built.ok) return "";
  // padding-top, not aspect-ratio: the WebView on an Android 6 phone that has never been online
  // predates aspect-ratio, and a box with no height shows nothing.
  const box = "display:block;position:relative;overflow:hidden;width:100%;padding-top:" +
    percent(built.heightOverWidth) + "%" + (built.background ? ";background-color:" + built.background : "");
  // Hidden until every piece has arrived (showPicturesWhenWhole below), so a slow phone never
  // shows a room with nobody in it, or a child floating with no lap under her.
  return '<span class="picture picture-pieces" role="img" aria-label="' + label + '" data-picture="' + id +
    '" data-picture-mode="pieces" style="' + box + ';visibility:hidden">' +
    built.layers.map((layer) =>
      '<img class="picture-piece" alt="" data-piece="' + escapeHtml(layer.assetId) + '" src="' +
      escapeHtml(urlFor(layer.file)) + '" style="position:absolute;left:' + layer.left + "%;top:" +
      layer.top + "%;width:" + layer.width + "%;height:" + layer.height + "%;" + PIECE_RESET +
      '" decoding="async">').join("") +
    "</span>";
}

/**
 * Call once after pictureHtml() output is in the page. Each stacked picture appears only when
 * all of its pieces have loaded, and is removed from view if any one of them fails.
 * Returns how many pictures it is watching.
 */
export function showPicturesWhenWhole(root) {
  const pictures = root.querySelectorAll(".picture-pieces:not([data-picture-watched])");
  for (const picture of pictures) {
    picture.setAttribute("data-picture-watched", "true");
    const pieces = Array.from(picture.querySelectorAll("img.picture-piece"));
    let waiting = pieces.length;
    let failed = false;
    const arrived = () => {
      waiting -= 1;
      if (waiting === 0 && !failed) {
        picture.style.visibility = "visible";
        picture.setAttribute("data-picture-state", "whole");
      }
    };
    const broke = () => {
      // Not a recovery: the picture is withdrawn, and the card's words carry the step alone,
      // exactly as they do for a card that has no picture. display is set as well as hidden,
      // because the box's own display:block outranks a page that has no rule for [hidden].
      failed = true;
      picture.hidden = true;
      picture.style.display = "none";
      picture.setAttribute("data-picture-state", "withdrawn");
    };
    const settle = (piece) => {
      if (!(piece.naturalWidth > 0)) { broke(); return; }
      // Loaded is not yet ready to paint. Where the browser can say when a piece is decoded,
      // wait for that, so every piece appears in the same frame.
      if (typeof piece.decode === "function") piece.decode().then(arrived, broke);
      else arrived();
    };
    if (pieces.length === 0) broke();
    for (const piece of pieces) {
      if (piece.complete) {
        settle(piece);
      } else {
        piece.addEventListener("load", () => settle(piece), { once: true });
        piece.addEventListener("error", broke, { once: true });
      }
    }
  }
  return pictures.length;
}
