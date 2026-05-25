// Abnormies Phase 1 proofs builder.
//
// Reads the merkle snapshot and shards it into per-owner proof files the
// frontend fetches at claim time. The output doubles as a holder-verifiable
// artifact (root + per-leaf proofs against the on-chain SNAPSHOT_ROOT).
//
// Snapshot shape (produced by contracts/snapshot/build.ts):
//   { snapshotBlock, root, totalEligible, totalDead, leafCount,
//     leaves: { "<normieId>": { owner, customized, proof: [..] } }, deadTokenIds }
//
// Run:
//   npm run build-proofs
// Honors SNAPSHOT_PATH and PROOFS_OUTPUT_DIR env vars (see .env.example).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

const snapshotPath = resolve(appRoot, process.env.SNAPSHOT_PATH || "./snapshot/snapshot-25169317.json");
const outDir = resolve(appRoot, process.env.PROOFS_OUTPUT_DIR || "./public/proofs");
const ownerDir = resolve(outDir, "owner");

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const leaves = snapshot.leaves || {};

// owner (lowercased) -> [normieId]              (index.json)
// owner (lowercased) -> [{ normieId, ownerAtSnapshot, customizedAtSnapshot, proof }]  (owner/<addr>.json)
const index = {};
const shards = new Map();

for (const [normieIdStr, leaf] of Object.entries(leaves)) {
  const normieId = Number(normieIdStr);
  // The snapshot stores `owner` / `customized`; emit them under the
  // ownerAtSnapshot / customizedAtSnapshot names the frontend expects.
  const ownerAtSnapshot = leaf.owner;
  const customizedAtSnapshot = Boolean(leaf.customized);
  const proof = leaf.proof || [];
  const key = ownerAtSnapshot.toLowerCase();

  (index[key] ||= []).push(normieId);
  if (!shards.has(key)) shards.set(key, []);
  shards.get(key).push({ normieId, ownerAtSnapshot, customizedAtSnapshot, proof });
}

// Deterministic ordering.
for (const ids of Object.values(index)) ids.sort((a, b) => a - b);
for (const arr of shards.values()) arr.sort((a, b) => a.normieId - b.normieId);

// Wipe to clear stale shards from a previous snapshot, then recreate.
await rm(outDir, { recursive: true, force: true });
await mkdir(ownerDir, { recursive: true });

let totalBytes = 0;
let maxShardBytes = 0;
let maxShardOwner = "";

async function writeJson(path, data, { compact = false } = {}) {
  const body = `${compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)}\n`;
  await writeFile(path, body);
  return Buffer.byteLength(body);
}

totalBytes += await writeJson(resolve(outDir, "index.json"), index, { compact: true });

for (const [key, arr] of shards) {
  const bytes = await writeJson(resolve(ownerDir, `${key}.json`), arr);
  totalBytes += bytes;
  if (bytes > maxShardBytes) {
    maxShardBytes = bytes;
    maxShardOwner = key;
  }
}

const meta = {
  snapshotBlock: snapshot.snapshotBlock,
  root: snapshot.root,
  totalEligible: snapshot.totalEligible,
  totalDead: snapshot.totalDead,
  ownerCount: shards.size,
  generatedAt: new Date().toISOString()
};
totalBytes += await writeJson(resolve(outDir, "meta.json"), meta);

const totalLeaves = Object.values(index).reduce((n, ids) => n + ids.length, 0);

console.log(`Proofs written to ${outDir}`);
console.log(`  source snapshot: block ${snapshot.snapshotBlock}, root ${snapshot.root}`);
console.log(`  total leaves:    ${totalLeaves}`);
console.log(`  unique owners:   ${shards.size}`);
console.log(`  total bytes:     ${totalBytes} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  max shard:       ${maxShardBytes} bytes (owner ${maxShardOwner})`);
