// Shared holdings logic for the Abnormies UI.
//
// Two sets, unioned:
//
//   Set 1 — RESOLVED, currently-owned tokens. Read live from the contract:
//   balanceOf gives the wallet's exact token count, then ownerOf is swept
//   across the id space and any id the wallet currently owns is kept. The
//   sweep stops as soon as that many are found, so a wallet holding a handful
//   of tokens barely scans. Because it reads live ownership it captures
//   OpenSea purchases and any secondary-market move that the receipt's frozen
//   `claimant` can't.
//
//   Set 2 — UNRESOLVED claims. The receipt's `claimant` field is the only
//   ownership signal that exists before `resolveReceipts` mints the ERC-721,
//   because no token exists yet. Scan all receipts and filter to
//   { claimant == wallet, resolved == false }. Once a receipt resolves the
//   token migrates to Set 1 (and is excluded here by the resolved filter).
//
// Set 1 previously scanned ERC-721 Transfer events to derive current owners,
// but public RPCs now gate historical eth_getLogs behind paid archive tokens,
// which broke the holdings page. ownerOf / balanceOf are plain current state
// that every node still serves for free, so Set 1 reads those instead.
//
// Resolved entries carry their abnormieId; unresolved entries don't have one
// yet (null) — render code handles this as the "[unrevealed]" stand-in.

const OWNER_CHUNK = 400; // ownerOf reads per multicall batch

// Resolve a wallet's currently-held, minted token ids by reading live ownership.
// Token ids are 1-based (ownerOf(0) reverts). balanceOf bounds the work: once we
// have found that many owned ids we stop. ownerOf reverts for burned ids; under
// multicall that surfaces as a per-call failure we skip.
async function scanCurrentOwnership(walletAddress, contract, publicClient) {
  const wallet = walletAddress.toLowerCase();
  const balance = Number(
    await publicClient.readContract({
      address: contract.address,
      abi: contract.abi,
      functionName: "balanceOf",
      args: [walletAddress]
    })
  );
  if (balance === 0) return [];

  const maxSupply = Number(
    await publicClient.readContract({
      address: contract.address,
      abi: contract.abi,
      functionName: "MAX_SUPPLY"
    })
  );

  const owned = [];
  for (let start = 1; start <= maxSupply && owned.length < balance; start += OWNER_CHUNK) {
    const end = Math.min(start + OWNER_CHUNK - 1, maxSupply);
    const contracts = [];
    for (let id = start; id <= end; id++) {
      contracts.push({
        address: contract.address,
        abi: contract.abi,
        functionName: "ownerOf",
        args: [BigInt(id)]
      });
    }
    let results;
    try {
      results = await publicClient.multicall({ contracts, allowFailure: true });
    } catch {
      // Fall back to sequential reads if the RPC rejects the batch.
      results = [];
      for (let id = start; id <= end; id++) {
        try {
          const o = await publicClient.readContract({
            address: contract.address,
            abi: contract.abi,
            functionName: "ownerOf",
            args: [BigInt(id)]
          });
          results.push({ status: "success", result: o });
        } catch {
          results.push({ status: "failure" });
        }
      }
    }
    results.forEach((res, i) => {
      if (res.status === "success" && typeof res.result === "string" && res.result.toLowerCase() === wallet) {
        owned.push(start + i);
      }
    });
  }
  return owned;
}

async function scanUnresolvedClaims(walletAddress, contract, publicClient) {
  const wallet = walletAddress.toLowerCase();
  const [len, nextResolveIndex] = (
    await Promise.all([
      publicClient.readContract({ address: contract.address, abi: contract.abi, functionName: "receiptsLength" }),
      publicClient.readContract({ address: contract.address, abi: contract.abi, functionName: "nextResolveIndex" })
    ])
  ).map(Number);

  // Receipts resolve strictly in index order, so everything below
  // nextResolveIndex is already resolved and is picked up by Set 1's live
  // ownerOf sweep. Only the [nextResolveIndex, len) tail can hold unresolved
  // claims, so scan just that — once resolution is complete this is empty and
  // skips the receipt read entirely.
  if (nextResolveIndex >= len) return [];

  const unresolved = [];
  const CHUNK = 400;
  for (let start = nextResolveIndex; start < len; start += CHUNK) {
    const end = Math.min(start + CHUNK, len);
    const contracts = [];
    for (let i = start; i < end; i++) {
      contracts.push({
        address: contract.address,
        abi: contract.abi,
        functionName: "receiptAt",
        args: [BigInt(i)]
      });
    }
    let results;
    try {
      results = await publicClient.multicall({ contracts });
    } catch {
      // Fall back to sequential reads if the RPC rejects the batch.
      results = [];
      for (let i = start; i < end; i++) {
        try {
          const r = await publicClient.readContract({
            address: contract.address,
            abi: contract.abi,
            functionName: "receiptAt",
            args: [BigInt(i)]
          });
          results.push({ status: "success", result: r });
        } catch {
          results.push({ status: "failure" });
        }
      }
    }
    for (const r of results) {
      if (r.status !== "success") continue;
      // Receipt tuple: (claimant, normieId, fromPhase1, snapshotCustomized, resolved, abnormieId)
      const [claimant, , , , resolved] = r.result;
      if (resolved) continue;
      if (claimant.toLowerCase() !== wallet) continue;
      unresolved.push({});
    }
  }
  return unresolved;
}

/**
 * Get the wallet's full Abnormies holdings.
 *
 * @param {string} walletAddress - checksummed or lowercased EVM address
 * @param {{address: string, abi: any[]}} contract - Abnormies contract handle
 * @param {import("viem").PublicClient} publicClient
 * @returns {Promise<Array<{abnormieId: number|null, resolved: boolean}>>}
 *          Resolved entries first (ascending by abnormieId), unresolved last
 *          (abnormieId === null).
 */
export async function getHoldings(walletAddress, contract, publicClient) {
  const [resolvedIds, unresolved] = await Promise.all([
    scanCurrentOwnership(walletAddress, contract, publicClient),
    scanUnresolvedClaims(walletAddress, contract, publicClient)
  ]);
  resolvedIds.sort((a, b) => a - b);
  return [
    ...resolvedIds.map((abnormieId) => ({ abnormieId, resolved: true })),
    ...unresolved.map(() => ({ abnormieId: null, resolved: false }))
  ];
}
