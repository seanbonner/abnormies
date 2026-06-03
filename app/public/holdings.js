// Shared holdings logic for the Abnormies UI.
//
// Two sets, unioned:
//
//   Set 1 — RESOLVED, currently-owned tokens. Derived from ERC-721 Transfer
//   events on the Abnormies contract: scan transfers TO and FROM the wallet,
//   keep the most recent Transfer per tokenId. If that Transfer landed the
//   token AT the wallet, it's currently held. Captures OpenSea purchases and
//   any secondary-market move that the receipt's frozen `claimant` can't.
//
//   Set 2 — UNRESOLVED claims. The receipt's `claimant` field is the only
//   ownership signal that exists before `resolveReceipts` mints the ERC-721,
//   because no Transfer event has fired yet. Scan all receipts and filter to
//   { claimant == wallet, resolved == false }. Once a receipt resolves the
//   token migrates to Set 1 (and is excluded here by the resolved filter).
//
// Resolved entries carry their abnormieId; unresolved entries don't have one
// yet (null) — render code handles this as the "[unrevealed]" stand-in.

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true }
  ]
};

// Conservative pre-deploy floor for mainnet Abnormies (deploy was at block
// 25,202,777 on 2026-05-29). Scans bound to `latest` so post-deploy growth
// is captured automatically.
const ABNORMIES_DEPLOY_BLOCK = 25_200_000n;
const LOG_WINDOW = 50_000n; // publicnode caps eth_getLogs at 50k blocks/request

async function scanTransfersChunked(publicClient, address, args, fromBlock, toBlock) {
  const all = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_WINDOW) {
    const to = from + LOG_WINDOW - 1n > toBlock ? toBlock : from + LOG_WINDOW - 1n;
    const logs = await publicClient.getLogs({
      address,
      event: TRANSFER_EVENT,
      args,
      fromBlock: from,
      toBlock: to
    });
    all.push(...logs);
  }
  return all;
}

async function scanCurrentOwnership(walletAddress, contract, publicClient) {
  const wallet = walletAddress.toLowerCase();
  const latestBlock = await publicClient.getBlockNumber();
  const [received, sent] = await Promise.all([
    scanTransfersChunked(publicClient, contract.address, { to: walletAddress }, ABNORMIES_DEPLOY_BLOCK, latestBlock),
    scanTransfersChunked(publicClient, contract.address, { from: walletAddress }, ABNORMIES_DEPLOY_BLOCK, latestBlock)
  ]);
  // Sort by (blockNumber, logIndex) so the last entry per tokenId is the most
  // recent ownership decision for that token.
  const all = [...received, ...sent].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return Number(a.blockNumber - b.blockNumber);
    return a.logIndex - b.logIndex;
  });
  const lastTransfer = new Map();
  for (const log of all) {
    lastTransfer.set(log.args.tokenId.toString(), log);
  }
  const owned = [];
  for (const log of lastTransfer.values()) {
    if (log.args.to.toLowerCase() === wallet) owned.push(Number(log.args.tokenId));
  }
  return owned;
}

async function scanUnresolvedClaims(walletAddress, contract, publicClient) {
  const wallet = walletAddress.toLowerCase();
  const len = Number(
    await publicClient.readContract({
      address: contract.address,
      abi: contract.abi,
      functionName: "receiptsLength"
    })
  );
  if (len === 0) return [];

  const unresolved = [];
  const CHUNK = 400;
  for (let start = 0; start < len; start += CHUNK) {
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
