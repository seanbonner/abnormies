// One-shot analysis: scan all receipts on mainnet Abnormies, aggregate by
// claimant + fromPhase1 flag, print airdrop-cost scenarios.

import { createPublicClient, http, getAddress } from "viem";
import { mainnet } from "viem/chains";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const abi = JSON.parse(readFileSync(resolve(here, "../public/abi/Abnormies.json"), "utf8")).abi;
const ADDR = "0xFa3BB476E170FF090E2b40ab266eb310Cc3E4b1d";
const RPC = process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";

const client = createPublicClient({ chain: mainnet, transport: http(RPC) });

const len = Number(await client.readContract({ address: ADDR, abi, functionName: "receiptsLength" }));
console.log(`Scanning ${len} receipts…`);

const CHUNK = 500;
const byAddr = new Map(); // lower -> { addr, claims, mints }
let totalClaims = 0, totalMints = 0;

for (let start = 0; start < len; start += CHUNK) {
  const end = Math.min(start + CHUNK, len);
  const contracts = [];
  for (let i = start; i < end; i++) {
    contracts.push({ address: ADDR, abi, functionName: "receiptAt", args: [BigInt(i)] });
  }
  const results = await client.multicall({ contracts });
  for (const r of results) {
    if (r.status !== "success") continue;
    // (claimant, normieId, fromPhase1, snapshotCustomized, resolved, abnormieId)
    const claimant = r.result[0];
    const fromPhase1 = r.result[2];
    const key = claimant.toLowerCase();
    const e = byAddr.get(key) || { addr: getAddress(claimant), claims: 0, mints: 0 };
    if (fromPhase1) { e.claims++; totalClaims++; } else { e.mints++; totalMints++; }
    byAddr.set(key, e);
  }
  process.stdout.write(`  ${end}/${len}\r`);
}
console.log();

const all = [...byAddr.values()];
const claimantsOnly = all.filter(e => e.claims > 0 && e.mints === 0);
const mintersOnly = all.filter(e => e.mints > 0 && e.claims === 0);
const both = all.filter(e => e.claims > 0 && e.mints > 0);
const anyMinter = all.filter(e => e.mints > 0); // mintersOnly + both
const anyHolder = all;

const sum = (xs, f) => xs.reduce((a, b) => a + f(b), 0);

console.log("\n=== Receipt breakdown ===");
console.log(`Total receipts:        ${len}`);
console.log(`  from Phase 1 claim:  ${totalClaims}`);
console.log(`  from Phase 2 mint:   ${totalMints}`);
console.log(`Unique addresses:      ${all.length}`);
console.log(`  claim-only:          ${claimantsOnly.length}  (holds ${sum(claimantsOnly, x => x.claims)} receipts)`);
console.log(`  mint-only:           ${mintersOnly.length}   (holds ${sum(mintersOnly,   x => x.mints)} receipts)`);
console.log(`  both claim & mint:   ${both.length}          (holds ${sum(both, x => x.claims + x.mints)} receipts)`);

console.log("\n=== Option A: 1:1 to every holder ===");
const optA_recipients = anyHolder.length;
const optA_tokens = sum(anyHolder, x => x.claims + x.mints);
console.log(`Recipients:            ${optA_recipients}`);
console.log(`Tokens to airdrop:     ${optA_tokens}`);
const maxA = Math.max(...anyHolder.map(x => x.claims + x.mints));
console.log(`Max per recipient:     ${maxA}`);

console.log("\n=== Option B: flat N to every Phase-2 minter ===");
console.log(`Recipients (any mint): ${anyMinter.length}`);
for (const N of [1, 2, 3, 5, 10]) {
  console.log(`  flat ${N}/wallet -> ${anyMinter.length * N} tokens total`);
}

// Per-airdrop gas: airdrop(address, uint256). The cost mostly scales with
// `count` (one receipt write per token). Estimating both a small and a
// large call to interpolate.
console.log("\n=== Gas probes ===");
const SAMPLE_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
for (const n of [1, 5, 20, 50]) {
  try {
    const g = await client.estimateContractGas({
      address: ADDR, abi, functionName: "airdrop",
      args: [SAMPLE_RECIPIENT, BigInt(n)],
      account: "0x986224203fb480f759c57999170f8fd2199eb693" // OWNER_ADMIN
    });
    console.log(`  airdrop(dead, ${n}):  ${g} gas`);
  } catch (e) {
    console.log(`  airdrop(dead, ${n}):  estimate failed (${e.shortMessage || e.message})`);
  }
}

// Dump per-address counts for any later spot-checks.
const dump = all.sort((a, b) => (b.claims + b.mints) - (a.claims + a.mints))
  .map(x => `${x.addr}\t${x.claims}\t${x.mints}`).join("\n");
const out = resolve(here, "holders.tsv");
import("node:fs").then(fs => {
  fs.writeFileSync(out, `address\tclaims\tmints\n${dump}\n`);
  console.log(`\nWrote ${out}`);
});
