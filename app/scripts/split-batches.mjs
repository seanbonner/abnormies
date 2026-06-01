// Reads holders.tsv (output of holders.mjs) and writes batch1.json … batchN.json
// containing checksummed addresses of every Phase-2 minter (mint-only + both),
// split into the minimum number of batches such that each batch satisfies the
// proxy's MAX_RECEIPTS_PER_BATCH = 1000 cap (recipients * countPerWallet <= 1000).
//
// Usage: COUNT_PER_WALLET=10 node scripts/split-batches.mjs

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

const COUNT_PER_WALLET = Number(process.env.COUNT_PER_WALLET || 10);
const MAX_RECEIPTS_PER_BATCH = 1000; // mirrors AirdropProxy.MAX_RECEIPTS_PER_BATCH

if (COUNT_PER_WALLET < 1 || COUNT_PER_WALLET > 50) {
  console.error(`COUNT_PER_WALLET must be in [1, 50]. Got ${COUNT_PER_WALLET}.`);
  process.exit(1);
}

const maxPerBatch = Math.floor(MAX_RECEIPTS_PER_BATCH / COUNT_PER_WALLET);
const N_BATCHES = Math.ceil(minters.length / maxPerBatch);

console.log(`Found ${minters.length} Phase-2 minters (mint-only + both claim & mint).`);
console.log(`countPerWallet: ${COUNT_PER_WALLET}, max recipients/batch: ${maxPerBatch}, batches: ${N_BATCHES}.`);

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
  const receipts = batch.length * COUNT_PER_WALLET;
  console.log(`  batch${i + 1}.json: ${batch.length} recipients * ${COUNT_PER_WALLET} = ${receipts} receipts`);
  total += batch.length;
});

console.log(`Total: ${total} recipients * ${COUNT_PER_WALLET} tokens = ${total * COUNT_PER_WALLET} airdrop tokens.`);
console.log(`\nNext: confirm phase2RemainingSlots >= ${total * COUNT_PER_WALLET} + buffer before executing.`);
