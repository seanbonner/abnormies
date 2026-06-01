// Reads holders.tsv (output of holders.mjs) and writes batch1.json … batch4.json
// containing checksummed addresses of every Phase-2 minter (mint-only + both),
// split into roughly equal batches sized for the airdrop ceremony.
//
// Each batch fits comfortably in a single airdropBatch(recipients, 10) call:
// ~93 recipients * 10 tokens ≈ 22M gas, well under the 30M block limit.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const tsv = readFileSync(resolve(here, "holders.tsv"), "utf8").trim().split("\n").slice(1);

// Keep wallets that have minted at least once (mint-only + both). Exclude pure claimers.
const minters = tsv
  .map((line) => {
    const [addr, claims, mints] = line.split("\t");
    return { addr: getAddress(addr), claims: +claims, mints: +mints };
  })
  .filter((h) => h.mints > 0);

console.log(`Found ${minters.length} Phase-2 minters (mint-only + both claim & mint).`);

// Split into 4 near-equal batches. With 370 minters: 93 + 93 + 92 + 92 = 370.
// With more or fewer, the split still divides as evenly as possible.
const N_BATCHES = 4;
const base = Math.floor(minters.length / N_BATCHES);
const remainder = minters.length % N_BATCHES;
const batches = [];
let cursor = 0;
for (let i = 0; i < N_BATCHES; i++) {
  const size = base + (i < remainder ? 1 : 0);
  batches.push(minters.slice(cursor, cursor + size).map((h) => h.addr));
  cursor += size;
}

let total = 0;
batches.forEach((batch, i) => {
  const path = resolve(here, `batch${i + 1}.json`);
  writeFileSync(path, JSON.stringify(batch, null, 2) + "\n");
  console.log(`  batch${i + 1}.json: ${batch.length} recipients`);
  total += batch.length;
});

console.log(`Total: ${total} recipients * 10 tokens = ${total * 10} airdrop tokens.`);
console.log("\nNext: confirm phase2RemainingSlots >= ${total * 10} + buffer before executing.");
