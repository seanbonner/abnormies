// Canonical JavaScript port of the on-chain Abnormies renderer.
//
// Mirror of contracts/src/AbnormiesRenderer.sol, deployed at
// 0x687267C8207C1b955D79D10b19254d482E97c5d9 on mainnet. Given the same state
// the on-chain renderer reads, renderCanvas reproduces computeCanvas(abnormieId)
// byte for byte. It additionally accepts a partial-state cursor so the detail
// page animation can draw any intermediate frame along an Abnormie's history,
// from all-Sky up to the current canvas. The on-chain renderer only computes the
// final canvas; the cursor is the reason this port exists.
//
// Pure functions. No contract calls, no side effects. The caller resolves state
// from the contract and passes it in:
//   getAbnormieState(tokenId)  -> seedNormieId, pairedAtCascadeIndex, staticAt,
//                                 staticAtCascadeIndex, and the freeze snapshots.
//   getSeedState(seedNormieId) -> cirrus, customized, burned, awakened (live).
//   getAllCascades()           -> the full global Cascade[] (fetch once, cache).
// Active Abnormies (staticAt == 0) pass live seed values for cirrusCount and
// seedCustomized; Static Abnormies pass the freeze snapshots cirrusCountAtFreeze
// and seedCustomizedAtFreeze. This matches the live-vs-snapshot branch in
// AbnormiesRenderer._render. `aligned` is supplied by the caller (it depends on
// live ownership and is not derivable from a single getAbnormieState read).

import { keccak256, encodeAbiParameters } from "viem";

// Color indices, matching the on-chain uint8 canvas encoding.
export const SKY = 0;
export const CIRRUS = 1;
export const ALTOCUMULUS = 2;
export const NIMBOSTRATUS = 3;

// Palette, matching the spec and the AbnormiesRenderer COLOR_* constants.
// Indexed by color so COLOR_HEX[CIRRUS] is the Cirrus hex.
export const COLOR_HEX = ["e3e5e4", "b0b1b0", "7c7d7e", "48494b"];

const CANVAS_SIZE = 1600;
const CANVAS_WIDTH = 40;

// abi.encode parameter shapes. These widths must match Solidity exactly or every
// derived position diverges. Confirmed field by field against AbnormiesRenderer:
//   _paintCirrus:            abi.encode(uint16 seedNormieId, string, uint256, uint256)
//   _paintSourceNimbostratus:abi.encode(uint16 seedNormieId, string, uint256)
//   lightning / thunder-count:abi.encode(uint64, uint16, uint16, string, uint256)
//   thunder-pos:             abi.encode(uint64, uint16, uint16, string, uint256, uint256)
const CIRRUS_PARAMS = [{ type: "uint16" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }];
const SOURCE_NIM_PARAMS = [{ type: "uint16" }, { type: "string" }, { type: "uint256" }];
const CASCADE_PARAMS = [
  { type: "uint64" },
  { type: "uint16" },
  { type: "uint16" },
  { type: "string" },
  { type: "uint256" }
];
const THUNDER_POS_PARAMS = [
  { type: "uint64" },
  { type: "uint16" },
  { type: "uint16" },
  { type: "string" },
  { type: "uint256" },
  { type: "uint256" }
];

// keccak256(abi.encode(...)) -> cell in [0, 1599], matching the on-chain
// uint16(uint256(hash) % CANVAS_SIZE).
function hashToCell(encoded) {
  return Number(BigInt(keccak256(encoded)) % BigInt(CANVAS_SIZE));
}

function cirrusCell(seedNormieId, e, j) {
  return hashToCell(encodeAbiParameters(CIRRUS_PARAMS, [seedNormieId, "cirrus", e, j]));
}

function sourceNimCell(seedNormieId, j) {
  return hashToCell(encodeAbiParameters(SOURCE_NIM_PARAMS, [seedNormieId, "nimbostratus-source", j]));
}

function lightningCell(cascade, abnormieId) {
  return hashToCell(
    encodeAbiParameters(CASCADE_PARAMS, [
      cascade.blockNumber,
      cascade.burnedTokenId,
      cascade.freezeTargetTokenId,
      "lightning",
      abnormieId
    ])
  );
}

// N = 5 + (countSeed % 6), where countSeed is the keccak of the same cascade
// tuple salted with "thunder-count". Returns an integer in [5, 10].
function thunderPixelCount(cascade, abnormieId) {
  const seed = BigInt(
    keccak256(
      encodeAbiParameters(CASCADE_PARAMS, [
        cascade.blockNumber,
        cascade.burnedTokenId,
        cascade.freezeTargetTokenId,
        "thunder-count",
        abnormieId
      ])
    )
  );
  return 5 + Number(seed % 6n);
}

function thunderPosCell(cascade, abnormieId, j) {
  return hashToCell(
    encodeAbiParameters(THUNDER_POS_PARAMS, [
      cascade.blockNumber,
      cascade.burnedTokenId,
      cascade.freezeTargetTokenId,
      "thunder-pos",
      abnormieId,
      j
    ])
  );
}

// XOR cancellation: Sky + color -> color, non-Sky + anything -> Sky. Matches the
// on-chain _paint.
function paint(grid, pos, color) {
  grid[pos] = grid[pos] === SKY ? color : SKY;
}

// Sky <-> Nimbostratus and Cirrus <-> Altocumulus across the whole canvas.
// Matches the on-chain _invertCanvas.
function invert(grid) {
  for (let k = 0; k < grid.length; k++) {
    const c = grid[k];
    grid[k] = c === SKY ? NIMBOSTRATUS : c === NIMBOSTRATUS ? SKY : c === CIRRUS ? ALTOCUMULUS : CIRRUS;
  }
}

// Filter the global cascade log to the cascades that affect this Abnormie, split
// by color and preserved in log order within each color. Mirrors the on-chain
// _isEligible plus the two-pass split (Lightning action == 2 first, then Thunder
// action == 1). The returned cascades are normalized to BigInt fields so they can
// be fed straight into the abi.encode helpers.
//
// Eligibility for the cascade at global index i:
//   pairedAtCascadeIndex <= i
//   && (staticAt == 0 || staticAtCascadeIndex > i)
//   && abnormieId != burnedTokenId
//   && abnormieId != freezeTargetTokenId
export function computeEligibleCascades({
  abnormieId,
  pairedAtCascadeIndex,
  staticAt,
  staticAtCascadeIndex,
  cascadeLog
}) {
  const id = BigInt(abnormieId);
  const paired = BigInt(pairedAtCascadeIndex ?? 0);
  const isStatic = BigInt(staticAt ?? 0) !== 0n;
  const frozenIndex = BigInt(staticAtCascadeIndex ?? 0);

  const lightning = [];
  const thunder = [];
  const log = cascadeLog ?? [];
  for (let i = 0; i < log.length; i++) {
    const idx = BigInt(i);
    if (paired > idx) continue;
    if (isStatic && frozenIndex <= idx) continue;

    const raw = log[i];
    const burnedTokenId = BigInt(raw.burnedTokenId);
    const freezeTargetTokenId = BigInt(raw.freezeTargetTokenId);
    if (burnedTokenId === id) continue;
    if (freezeTargetTokenId === id) continue;

    const cascade = {
      blockNumber: BigInt(raw.blockNumber),
      burnedTokenId,
      freezeTargetTokenId,
      action: Number(raw.action)
    };
    if (cascade.action === 2) {
      lightning.push(cascade);
    } else if (cascade.action === 1) {
      thunder.push(cascade);
    }
  }
  return { lightning, thunder };
}

// Translate a step descriptor into how many of each layer to apply.
//   'final' (or undefined): everything.
//   { layer: 'cirrus',    index: K }: first K Cirrus events, nothing after.
//   { layer: 'sourceNim', index: 0|1 }: all Cirrus + (0 or 1) Source Nimbostratus.
//   { layer: 'lightning', index: K }: all Cirrus + Source Nim + first K Lightning.
//   { layer: 'thunder',   index: K }: all Cirrus + Source Nim + all Lightning + first K Thunder.
function resolveCursor(step, totals) {
  const clamp = (value, max) => Math.max(0, Math.min(Number(value), max));
  if (!step || step === "final") {
    return {
      cirrusN: totals.cirrus,
      sourceNimN: totals.sourceNim,
      lightningN: totals.lightning,
      thunderN: totals.thunder
    };
  }
  switch (step.layer) {
    case "cirrus":
      return { cirrusN: clamp(step.index, totals.cirrus), sourceNimN: 0, lightningN: 0, thunderN: 0 };
    case "sourceNim":
      return { cirrusN: totals.cirrus, sourceNimN: clamp(step.index, totals.sourceNim), lightningN: 0, thunderN: 0 };
    case "lightning":
      return {
        cirrusN: totals.cirrus,
        sourceNimN: totals.sourceNim,
        lightningN: clamp(step.index, totals.lightning),
        thunderN: 0
      };
    case "thunder":
      return {
        cirrusN: totals.cirrus,
        sourceNimN: totals.sourceNim,
        lightningN: totals.lightning,
        thunderN: clamp(step.index, totals.thunder)
      };
    default:
      throw new Error(`renderCanvas: unknown step layer "${step.layer}"`);
  }
}

// Render an Abnormie canvas, optionally truncated to a partial state. Returns a
// Uint8Array(1600) of color indices. Inversion is applied AFTER the partial
// replay, for every step, so an aligned Abnormie animates inverted throughout.
export function renderCanvas(state) {
  const abnormieId = BigInt(state.abnormieId);
  const seedNormieId = BigInt(state.seedNormieId);
  const cirrusCount = Number(state.cirrusCount ?? 0);
  const seedCustomized = Boolean(state.seedCustomized);
  const aligned = Boolean(state.aligned);

  const { lightning, thunder } = computeEligibleCascades(state);
  const totals = {
    cirrus: cirrusCount,
    sourceNim: seedCustomized ? 1 : 0,
    lightning: lightning.length,
    thunder: thunder.length
  };
  const cursor = resolveCursor(state.step, totals);

  const grid = new Uint8Array(CANVAS_SIZE); // initialized to 0 == SKY

  // A. Cirrus: two pixels per event, j = 0 then j = 1.
  for (let e = 0; e < cursor.cirrusN; e++) {
    const eb = BigInt(e);
    paint(grid, cirrusCell(seedNormieId, eb, 0n), CIRRUS);
    paint(grid, cirrusCell(seedNormieId, eb, 1n), CIRRUS);
  }

  // B. Source Nimbostratus: a single atomic 12-pixel block, present or not.
  if (cursor.sourceNimN > 0) {
    for (let j = 0; j < 12; j++) {
      paint(grid, sourceNimCell(seedNormieId, BigInt(j)), NIMBOSTRATUS);
    }
  }

  // C. Lightning: one pixel per eligible cascade, in log order.
  for (let k = 0; k < cursor.lightningN; k++) {
    paint(grid, lightningCell(lightning[k], abnormieId), NIMBOSTRATUS);
  }

  // D. Thunder: N pixels (5..10) per eligible cascade, in log order.
  for (let k = 0; k < cursor.thunderN; k++) {
    const cascade = thunder[k];
    const n = thunderPixelCount(cascade, abnormieId);
    for (let j = 0; j < n; j++) {
      paint(grid, thunderPosCell(cascade, abnormieId, BigInt(j)), ALTOCUMULUS);
    }
  }

  // F. Inversion, applied last regardless of the cursor.
  if (aligned) invert(grid);

  return grid;
}

// Ordered list of step descriptors for the full replay, so the animation layer
// can iterate frames without re-deriving the layer boundaries. The implicit
// starting frame is all-Sky (no step); each descriptor adds the next increment,
// and the last descriptor reproduces the 'final' canvas. Source Nimbostratus is
// a single step (its 12 pixels are atomic on-chain).
export function enumerateSteps(state) {
  const cirrusCount = Number(state.cirrusCount ?? 0);
  const seedCustomized = Boolean(state.seedCustomized);
  const { lightning, thunder } = computeEligibleCascades(state);

  const steps = [];
  for (let c = 1; c <= cirrusCount; c++) steps.push({ layer: "cirrus", index: c });
  if (seedCustomized) steps.push({ layer: "sourceNim", index: 1 });
  for (let k = 1; k <= lightning.length; k++) steps.push({ layer: "lightning", index: k });
  for (let k = 1; k <= thunder.length; k++) steps.push({ layer: "thunder", index: k });
  return steps;
}

// Serialize a canvas to SVG, matching AbnormiesRenderer._renderSvg byte for byte:
// a 40x40 viewBox at 1000x1000 with crispEdges, a Sky background rect, then
// per-row run-length-encoded rects with Sky runs suppressed. The on-chain output
// is produced by the same loop, so the strings are identical (no whitespace or
// attribute-order differences). The on-chain tokenURI base64-wraps this SVG; the
// raw markup compared here is the decoded inner SVG.
export function toSvg(canvas) {
  let out =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 40 40" shape-rendering="crispEdges">';
  out += `<rect width="40" height="40" fill="#${COLOR_HEX[SKY]}"/>`;

  for (let y = 0; y < CANVAS_WIDTH; y++) {
    let runColor = 0;
    let runStart = 0;
    for (let x = 0; x < CANVAS_WIDTH; x++) {
      const c = canvas[y * CANVAS_WIDTH + x];
      if (c !== runColor) {
        if (runColor !== 0) out += emitRect(runStart, y, x - runStart, runColor);
        runColor = c;
        runStart = x;
      }
    }
    if (runColor !== 0) out += emitRect(runStart, y, CANVAS_WIDTH - runStart, runColor);
  }

  out += "</svg>";
  return out;
}

function emitRect(x, y, w, color) {
  return `<rect x="${x}" y="${y}" width="${w}" height="1" fill="#${COLOR_HEX[color]}"/>`;
}
