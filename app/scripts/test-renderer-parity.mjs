// Golden parity harness for the canonical JS renderer (public/renderer.js).
//
// For a fixture set of live mainnet Abnormies it proves byte-for-byte parity
// between the JS port and the deployed on-chain renderer, at two levels:
//   1. Canvas:  renderer.computeCanvas(id) (uint8[1600]) vs renderCanvas(state).
//   2. SVG:     the decoded tokenURI SVG vs toSvg(jsCanvas).
// It also self-checks the partial-state cursor: the last enumerated step must
// reproduce the 'final' canvas, and an out-of-range step index must clamp.
//
// Fixtures are discovered from chain state at run time so the harness stays
// correct as the collection evolves. It targets the buckets in the task brief
// (active living uncustomized / customized / dead, static, aligned, zero-event,
// densest cascade history) and reports any bucket that the current chain state
// cannot fill rather than failing on it. Parity is asserted on every fixture
// actually found.
//
// Run from app/ with the deploy env loaded:
//   set -a; source .env; set +a
//   node scripts/test-renderer-parity.mjs
// Optional env: FRONTEND_RENDERER_ADDRESS, FRONTEND_NORMIES_ADDRESS,
// FIXTURE_SCAN (linear token scan depth, default 1200), MULTICALL_CHUNK
// (calls per multicall, default 100).

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

import { renderCanvas, toSvg, computeEligibleCascades, enumerateSteps } from "../public/renderer.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

const RPC_URL = process.env.FRONTEND_RPC_URL || "https://ethereum-rpc.publicnode.com";
const ABNORMIES = process.env.FRONTEND_CONTRACT_ADDRESS || "0xFa3BB476E170FF090E2b40ab266eb310Cc3E4b1d";
const RENDERER = process.env.FRONTEND_RENDERER_ADDRESS || "0x687267C8207C1b955D79D10b19254d482E97c5d9";
const NORMIES = process.env.FRONTEND_NORMIES_ADDRESS || "0x9eb6e2025b64f340691e424b7fe7022ffde12438";
const SCAN_DEPTH = Number(process.env.FIXTURE_SCAN || "1200");
const CHUNK = Number(process.env.MULTICALL_CHUNK || "100");

// computeCanvas lives on the renderer contract, not on Abnormies. ownerOf on the
// Normies contract resolves the seed owner for the aligned check.
const RENDERER_ABI = [
  {
    type: "function",
    name: "computeCanvas",
    stateMutability: "view",
    inputs: [{ name: "abnormieId", type: "uint256" }],
    outputs: [{ name: "", type: "uint8[1600]" }]
  }
];
const NORMIES_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }]
  }
];

const QUOTAS = [
  { key: "activeLivingUncust", label: "Active / Living / Uncustomized", min: 5 },
  { key: "activeLivingCust", label: "Active / Living / Customized", min: 3 },
  { key: "activeDead", label: "Active / Dead", min: 3 },
  { key: "static", label: "Static", min: 3 },
  { key: "aligned", label: "Aligned", min: 2 },
  { key: "zeroEvent", label: "Zero events", min: 1 },
  { key: "dense", label: "Densest cascade history", min: 1 }
];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function multicallAll(client, contracts) {
  const out = [];
  for (const part of chunk(contracts, CHUNK)) {
    const res = await client.multicall({ contracts: part, allowFailure: true });
    out.push(...res);
  }
  return out;
}

// getAbnormieState returns the 11-field tuple as a struct object (viem decodes
// named tuple components). Normalize the fields the renderer needs.
function normalizeState(raw) {
  return {
    seedNormieId: BigInt(raw.seedNormieId),
    staticAt: BigInt(raw.staticAt),
    pairedAtCascadeIndex: BigInt(raw.pairedAtCascadeIndex),
    staticAtCascadeIndex: BigInt(raw.staticAtCascadeIndex),
    cirrusCountAtFreeze: Number(raw.cirrusCountAtFreeze),
    seedCustomizedAtFreeze: Boolean(raw.seedCustomizedAtFreeze),
    seedDeadAtFreeze: Boolean(raw.seedDeadAtFreeze)
  };
}

function decodeTokenURISvg(uri) {
  const jsonB64 = uri.slice(uri.indexOf(",") + 1);
  const meta = JSON.parse(Buffer.from(jsonB64, "base64").toString("utf8"));
  const image = meta.image;
  const svgB64 = image.slice(image.indexOf(",") + 1);
  return Buffer.from(svgB64, "base64").toString("utf8");
}

function firstStringDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}

async function main() {
  console.log(`RPC        ${RPC_URL}`);
  console.log(`Abnormies  ${ABNORMIES}`);
  console.log(`Renderer   ${RENDERER}`);
  console.log(`Normies    ${NORMIES}`);

  const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });
  const abnormiesAbi = JSON.parse(await readFile(resolve(appRoot, "public/abi/Abnormies.json"), "utf8")).abi;

  // Global cascade log, fetched once and reused.
  const rawCascades = await client.readContract({
    address: ABNORMIES,
    abi: abnormiesAbi,
    functionName: "getAllCascades"
  });
  const cascadeLog = rawCascades.map((c) => ({
    blockNumber: BigInt(c.blockNumber),
    burnedTokenId: Number(c.burnedTokenId),
    freezeTargetTokenId: Number(c.freezeTargetTokenId),
    action: Number(c.action),
    thunderSize: Number(c.thunderSize)
  }));
  console.log(`Cascades   ${cascadeLog.length}`);

  // Candidate token ids: a linear scan from 1, plus every cascade freeze target
  // (guaranteed Static, and the richest pre-freeze histories). Burned tokens
  // (cascade burners) no longer exist, so they are not added.
  const candidateIds = new Set();
  for (let id = 1; id <= SCAN_DEPTH; id++) candidateIds.add(id);
  for (const c of cascadeLog) candidateIds.add(c.freezeTargetTokenId);
  const ids = [...candidateIds].sort((a, b) => a - b);
  console.log(`Scanning   ${ids.length} candidate tokens for fixtures...`);

  // Per-token state.
  const stateResults = await multicallAll(
    client,
    ids.map((id) => ({ address: ABNORMIES, abi: abnormiesAbi, functionName: "getAbnormieState", args: [BigInt(id)] }))
  );

  const pool = [];
  const seedIds = new Set();
  ids.forEach((id, i) => {
    const r = stateResults[i];
    if (r.status !== "success") return; // token does not exist
    const st = normalizeState(r.result);
    pool.push({ id, st });
    seedIds.add(st.seedNormieId.toString());
  });

  // Live seed state for the seeds behind the pool.
  const seedIdList = [...seedIds].map((s) => BigInt(s));
  const seedResults = await multicallAll(
    client,
    seedIdList.map((sid) => ({ address: ABNORMIES, abi: abnormiesAbi, functionName: "getSeedState", args: [sid] }))
  );
  const seedState = new Map();
  seedIdList.forEach((sid, i) => {
    const r = seedResults[i];
    if (r.status !== "success") return;
    const [lastOwner, cirrus, customized, burned, awakened] = r.result;
    seedState.set(sid.toString(), {
      cirrus: Number(cirrus),
      customized: Boolean(customized),
      burned: Boolean(burned),
      awakened: Boolean(awakened)
    });
  });

  // Classify each pool entry against the effective (live or freeze) seed values.
  for (const entry of pool) {
    const seed = seedState.get(entry.st.seedNormieId.toString());
    const isStatic = entry.st.staticAt !== 0n;
    entry.isStatic = isStatic;
    entry.effectiveCirrus = isStatic ? entry.st.cirrusCountAtFreeze : seed ? seed.cirrus : 0;
    entry.effectiveCustomized = isStatic ? entry.st.seedCustomizedAtFreeze : seed ? seed.customized : false;
    entry.dead = isStatic ? entry.st.seedDeadAtFreeze : seed ? seed.burned : false;
    entry.awakened = seed ? seed.awakened : false;
    const elig = computeEligibleCascades({
      abnormieId: entry.id,
      pairedAtCascadeIndex: entry.st.pairedAtCascadeIndex,
      staticAt: entry.st.staticAt,
      staticAtCascadeIndex: entry.st.staticAtCascadeIndex,
      cascadeLog
    });
    entry.eligLightning = elig.lightning.length;
    entry.eligThunder = elig.thunder.length;
    entry.eligTotal = entry.eligLightning + entry.eligThunder;
  }

  // Resolve aligned status: it needs live owners, so fetch them only for awakened
  // candidates. aligned = awakened && Normies.ownerOf(seed) == Abnormies.ownerOf(id).
  const awakenedPool = pool.filter((e) => e.awakened);
  if (awakenedPool.length) {
    const ownerCalls = [];
    for (const e of awakenedPool) {
      ownerCalls.push({ address: ABNORMIES, abi: abnormiesAbi, functionName: "ownerOf", args: [BigInt(e.id)] });
      ownerCalls.push({ address: NORMIES, abi: NORMIES_ABI, functionName: "ownerOf", args: [e.st.seedNormieId] });
    }
    const ownerRes = await multicallAll(client, ownerCalls);
    awakenedPool.forEach((e, i) => {
      const abnOwner = ownerRes[i * 2];
      const seedOwner = ownerRes[i * 2 + 1];
      e.aligned =
        abnOwner.status === "success" &&
        seedOwner.status === "success" &&
        String(abnOwner.result).toLowerCase() === String(seedOwner.result).toLowerCase();
    });
  }
  for (const e of pool) if (e.aligned === undefined) e.aligned = false;

  // Bucket selection. A token may satisfy several buckets; prefer distinct tokens
  // but allow reuse if a bucket would otherwise be empty.
  const matchers = {
    activeLivingUncust: (e) => !e.isStatic && !e.dead && !e.effectiveCustomized,
    activeLivingCust: (e) => !e.isStatic && !e.dead && e.effectiveCustomized,
    activeDead: (e) => !e.isStatic && e.dead,
    static: (e) => e.isStatic,
    aligned: (e) => e.aligned,
    zeroEvent: (e) => e.effectiveCirrus === 0 && !e.effectiveCustomized && e.eligTotal === 0
  };

  const chosen = new Map(); // id -> Set(bucket labels)
  const addChoice = (entry, key) => {
    if (!chosen.has(entry.id)) chosen.set(entry.id, { entry, buckets: new Set() });
    chosen.get(entry.id).buckets.add(key);
  };

  const coverage = {};
  for (const quota of QUOTAS) {
    if (quota.key === "dense") continue;
    const matcher = matchers[quota.key];
    const candidates = pool.filter(matcher);
    candidates.sort((a, b) => {
      const au = chosen.has(a.id) ? 1 : 0;
      const bu = chosen.has(b.id) ? 1 : 0;
      return au - bu; // prefer not-yet-chosen
    });
    let count = 0;
    for (const c of candidates) {
      if (count >= quota.min) break;
      addChoice(c, quota.key);
      count++;
    }
    coverage[quota.key] = count;
  }

  // Densest cascade history: the single token with the most eligible cascades.
  const dense = pool.slice().sort((a, b) => b.eligTotal - a.eligTotal)[0];
  if (dense && dense.eligTotal > 0) {
    addChoice(dense, "dense");
    coverage.dense = 1;
  } else {
    coverage.dense = 0;
  }

  console.log("\nFixture coverage:");
  for (const quota of QUOTAS) {
    const got = coverage[quota.key] || 0;
    const flag = got >= quota.min ? "ok" : "UNDERFILLED";
    console.log(`  ${quota.label.padEnd(34)} ${got}/${quota.min}  ${flag}`);
  }

  const fixtures = [...chosen.values()].sort((a, b) => a.entry.id - b.entry.id);

  // The Cirrus magnitude path only runs when a seed has a non-zero cirrus count,
  // which requires a pokeSeed to have observed a seed-Normie ownership change. If
  // no live token exercises it, the canvas parity below cannot cover it. The
  // Cirrus position derivation is then cross-checked out of band against an EVM
  // oracle (cast abi-encode + cast keccak); see the task notes.
  const anyCirrus = fixtures.some((f) => f.entry.effectiveCirrus > 0);
  if (!anyCirrus) {
    console.log("\nNote: no fixture has cirrus > 0; the Cirrus magnitude path is not chain-covered by this run.");
  }

  console.log(`\nRunning parity on ${fixtures.length} fixtures...\n`);

  let pass = 0;
  let fail = 0;
  let firstFailureShown = false;

  for (const { entry, buckets } of fixtures) {
    const id = entry.id;
    const label = [...buckets].join(", ");

    // Build the render state, mirroring the live-vs-snapshot branch on-chain.
    const state = {
      abnormieId: id,
      seedNormieId: entry.st.seedNormieId,
      pairedAtCascadeIndex: entry.st.pairedAtCascadeIndex,
      staticAt: entry.st.staticAt,
      staticAtCascadeIndex: entry.st.staticAtCascadeIndex,
      cirrusCount: entry.effectiveCirrus,
      seedCustomized: entry.effectiveCustomized,
      cascadeLog,
      aligned: entry.aligned,
      step: "final"
    };

    let onchain;
    let onchainSvg;
    try {
      [onchain, onchainSvg] = await Promise.all([
        client.readContract({ address: RENDERER, abi: RENDERER_ABI, functionName: "computeCanvas", args: [BigInt(id)] }),
        client
          .readContract({ address: ABNORMIES, abi: abnormiesAbi, functionName: "tokenURI", args: [BigInt(id)] })
          .then(decodeTokenURISvg)
      ]);
    } catch (err) {
      console.log(`FAIL  #${id}  [${label}]  on-chain read error: ${err.shortMessage || err.message}`);
      fail++;
      continue;
    }

    const expected = Array.from(onchain, (v) => Number(v));
    const js = renderCanvas(state);

    // Canvas parity.
    const cellDiffs = [];
    for (let k = 0; k < 1600; k++) {
      if (expected[k] !== js[k]) cellDiffs.push(k);
    }

    // SVG parity.
    const jsSvg = toSvg(js);
    const svgOk = jsSvg === onchainSvg;

    // Partial-state cursor self-check: the last enumerated step must reproduce
    // 'final', and an over-range index must clamp to the same canvas.
    const steps = enumerateSteps(state);
    let cursorOk = true;
    let cursorNote = "";
    if (steps.length > 0) {
      const lastStepCanvas = renderCanvas({ ...state, step: steps[steps.length - 1] });
      const overRange = renderCanvas({ ...state, step: { layer: "thunder", index: 1e9 } });
      for (let k = 0; k < 1600; k++) {
        if (lastStepCanvas[k] !== js[k] || overRange[k] !== js[k]) {
          cursorOk = false;
          cursorNote = `step replay mismatch at cell ${k}`;
          break;
        }
      }
    }

    if (cellDiffs.length === 0 && svgOk && cursorOk) {
      console.log(
        `PASS  #${id}  [${label}]  cirrus=${entry.effectiveCirrus} cust=${entry.effectiveCustomized ? 1 : 0} ` +
          `L=${entry.eligLightning} T=${entry.eligThunder} static=${entry.isStatic ? 1 : 0} aligned=${entry.aligned ? 1 : 0} ` +
          `steps=${steps.length}`
      );
      pass++;
      continue;
    }

    fail++;
    console.log(`FAIL  #${id}  [${label}]  cells=${cellDiffs.length} svg=${svgOk ? "ok" : "DIFF"} cursor=${cursorOk ? "ok" : "DIFF"}`);

    if (!firstFailureShown) {
      firstFailureShown = true;
      console.log("\n--- first failure detail ---");
      console.log(`token #${id}`);
      console.log(`state: ${JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      if (cellDiffs.length) {
        console.log(`\ncanvas cell diffs (first 20 of ${cellDiffs.length}): index expected got`);
        for (const k of cellDiffs.slice(0, 20)) {
          console.log(`  ${k}  expected=${expected[k]}  got=${js[k]}`);
        }
      }
      if (!svgOk) {
        const at = firstStringDiff(onchainSvg, jsSvg);
        const ctx = 60;
        console.log(`\nsvg first diff at offset ${at}:`);
        console.log(`  on-chain: ...${onchainSvg.slice(Math.max(0, at - ctx), at + ctx)}...`);
        console.log(`  js:       ...${jsSvg.slice(Math.max(0, at - ctx), at + ctx)}...`);
      }
      if (!cursorOk) console.log(`\ncursor: ${cursorNote}`);
      console.log("--- end detail ---\n");
    }
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed, ${fixtures.length} total.`);
  const underfilled = QUOTAS.filter((q) => (coverage[q.key] || 0) < q.min).map((q) => q.label);
  if (underfilled.length) {
    console.log(`Note: buckets not fully covered by current chain state: ${underfilled.join("; ")}.`);
    console.log("Widen the scan with FIXTURE_SCAN=<n> if more coverage is expected.");
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
