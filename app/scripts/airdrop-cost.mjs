// Read holders.tsv and compute airdrop cost scenarios at multiple gas prices.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(resolve(here, "holders.tsv"), "utf8").trim().split("\n").slice(1);
const holders = lines.map(l => {
  const [addr, c, m] = l.split("\t");
  return { addr, claims: +c, mints: +m };
});

// Gas model derived from on-chain estimateContractGas probes:
//   airdrop(addr, n) ≈ 47500 + 23500 * n   (gas)
// Per-call cap: PHASE2_MAX_PER_CALL = 50.
const CAP = 50;
const gas = (n) => 47500 + 23500 * n;
const txsFor = (n) => Math.ceil(n / CAP);

function planTotalGas(perRecipientCounts) {
  let totalGas = 0, totalTxs = 0;
  for (const n of perRecipientCounts) {
    let left = n;
    while (left > 0) {
      const take = Math.min(left, CAP);
      totalGas += gas(take);
      totalTxs++;
      left -= take;
    }
  }
  return { totalGas, totalTxs };
}

const PHASE2_REMAINING = 5147;

function report(label, perRecipientCounts) {
  const recipients = perRecipientCounts.length;
  const totalTokens = perRecipientCounts.reduce((a, b) => a + b, 0);
  const { totalGas, totalTxs } = planTotalGas(perRecipientCounts);
  const supplyAfter = PHASE2_REMAINING - totalTokens;
  console.log(`\n--- ${label} ---`);
  console.log(`Recipients:             ${recipients}`);
  console.log(`Tokens airdropped:      ${totalTokens}`);
  console.log(`Transactions needed:    ${totalTxs}`);
  console.log(`Total gas:              ${totalGas.toLocaleString()}`);
  console.log(`Phase 2 supply after:   ${supplyAfter} of 5147 (${supplyAfter < 0 ? "OVERFLOW — won't fit!" : `${supplyAfter} left for public mint`})`);
  // ETH cost at gas prices (in gwei): 5, 15, 30, 50, current (143)
  const prices = [
    { name: "low (5 gwei)",      gwei: 5 },
    { name: "mid (15 gwei)",     gwei: 15 },
    { name: "elevated (30 gwei)", gwei: 30 },
    { name: "high (50 gwei)",    gwei: 50 },
    { name: "current (143 gwei)", gwei: 143 },
  ];
  console.log(`ETH cost:`);
  for (const { name, gwei } of prices) {
    const eth = (totalGas * gwei * 1e-9);
    console.log(`  ${name.padEnd(22)} ${eth.toFixed(4)} ETH`);
  }
}

// Option A: 1:1 to every current holder (matches their current count).
const optA = holders.map(h => h.claims + h.mints);
report("Option A — 1:1 to every holder", optA);

// Option B: flat N to every Phase-2 minter (claims-only addresses excluded).
const minters = holders.filter(h => h.mints > 0);
for (const N of [1, 2, 3, 5, 10]) {
  report(`Option B — flat ${N} per Phase-2 minter`, minters.map(() => N));
}

// Distribution shape for Option A.
const counts = optA.slice().sort((a, b) => b - a);
const buckets = { "1": 0, "2-5": 0, "6-10": 0, "11-50": 0, "51-100": 0, "101+": 0 };
for (const n of counts) {
  if (n === 1) buckets["1"]++;
  else if (n <= 5) buckets["2-5"]++;
  else if (n <= 10) buckets["6-10"]++;
  else if (n <= 50) buckets["11-50"]++;
  else if (n <= 100) buckets["51-100"]++;
  else buckets["101+"]++;
}
console.log("\n--- Holder distribution (Option A perspective) ---");
console.log(`Top holders:   ${counts.slice(0, 10).join(", ")}`);
console.log(`Median count:  ${counts[Math.floor(counts.length / 2)]}`);
console.log("By bucket:");
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(8)} ${v} addresses`);
