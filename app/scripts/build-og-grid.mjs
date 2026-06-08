// Generate one 40x40 Abnormie grid using the EXACT renderer that powers the
// teaser's sample canvas. Rather than re-approximating the art, this extracts
// the renderer <script> from newsite/pages/index.html and runs it verbatim, so
// the social card's preview is the same output a visitor sees. Math.random is
// replaced with a fixed-seed PRNG so regenerations are reproducible (the card
// stays byte-stable until someone intentionally bumps the seed).
//
// Output: JSON { spec, grid } to stdout, where grid is 1600 ints (0..3) indexing
// the renderer's COLORS palette. Consumed by build-og.py.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = resolve(here, "..", "newsite", "pages", "index.html");
const html = readFileSync(indexHtml, "utf8");

// Pull the renderer script (the one that defines buildGrid). The teaser keeps it
// in a single inline <script>; if that ever changes, fail loudly rather than
// silently drift to a different visual.
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const rendererSrc = scripts.find((s) => s.includes("function buildGrid"));
if (!rendererSrc) {
  throw new Error("Could not find the buildGrid renderer script in index.html");
}

// Minimal DOM stubs so the renderer's top-level canvas/ctx/listener lines run
// without a browser. drawGrid paints into this no-op ctx; we read the grid array
// directly instead.
const fakeCtx = { fillRect() {}, fillStyle: "" };
const fakeEl = {
  addEventListener() {},
  getContext() {
    return fakeCtx;
  },
  set innerHTML(_v) {},
  width: 0,
  height: 0
};
globalThis.document = { getElementById: () => fakeEl };

// Deterministic Math.random (mulberry32 on a fixed seed). Bump SEED (or set
// OG_SEED in the environment) to pick a different-but-still-reproducible preview.
const SEED = (process.env.OG_SEED ? Number(process.env.OG_SEED) : 11) >>> 0;
let _t = SEED >>> 0;
globalThis.Math.random = function () {
  _t = (_t + 0x6d2b79f5) >>> 0;
  let r = _t;
  r = Math.imul(r ^ (r >>> 15), r | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
};

// Run the renderer verbatim, then call its own functions to emit a grid. The
// appended code shares the eval scope, so it can see generateRandom/buildGrid.
const harness = `${rendererSrc}
;globalThis.__OG = (function () {
  const spec = generateRandom();
  const grid = buildGrid(
    spec.normieId, spec.transfers, spec.customizations,
    spec.lightnings, spec.thunders, spec.inverted
  );
  return { spec, grid: Array.from(grid) };
})();`;

// eval is intentional and safe here: `harness` is first-party renderer code read
// from our own repo (index.html) at build time, never untrusted input. Running it
// verbatim is the whole point, so the card matches the live renderer exactly.
// eslint-disable-next-line no-eval
eval(harness);

process.stdout.write(JSON.stringify(globalThis.__OG));
