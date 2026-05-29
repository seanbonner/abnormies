// Abnormies Phase 1 app.
//
// Reads contract state with viem (public client over the configured RPC) and
// the connected wallet's eligible Normies (from prebuilt proof shards) and
// receipts. The Phase 1 claim write path is wired (onClaimAll); the Phase 2
// mint write path is still STUBBED (see onMintClick). Function names are taken
// from the deployed ABI.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatEther,
  parseEther,
  isAddress,
  getAddress,
  getContract,
  zeroAddress
} from "viem";
import { mainnet, sepolia } from "viem/chains";

const cfg = window.ABNORMIES_CONFIG || {};
const CHAINS = { 1: mainnet, 11155111: sepolia };
const CHAIN_NAMES = { 1: "Ethereum Mainnet", 11155111: "Sepolia" };

const expectedChainId = Number(cfg.chainId || 1);
const chain = CHAINS[expectedChainId] || sepolia;
const contractAddress = cfg.contractAddress;

// delegate.xyz v2 registry (same address on every network it deploys to).
const DELEGATE_REGISTRY = "0x00000000000000447e69651d841bD8D104Bed493";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const DELEGATION_TYPE = { ALL: 1, CONTRACT: 2 }; // subset of delegate.xyz v2's enum
const DELEGATE_REGISTRY_ABI = [
  {
    type: "function",
    name: "getIncomingDelegations",
    stateMutability: "view",
    inputs: [{ name: "to", type: "address" }],
    outputs: [
      {
        name: "delegations",
        type: "tuple[]",
        components: [
          { name: "type_", type: "uint8" },
          { name: "to", type: "address" },
          { name: "from", type: "address" },
          { name: "rights", type: "bytes32" },
          { name: "contract_", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "amount", type: "uint256" }
        ]
      }
    ]
  }
];

let abi = null;
let publicClient = null;
let reader = null; // getContract bound to the public client
let walletClient = null;
let account = null;
let walletChainId = null;
let listenersAttached = false;

let currentPhase = null;
let claimOpen = false; // phase()===0 AND still inside the deployedAt + PHASE_1_DURATION window
let mintPrice = 0n;
let maxPerCall = 50n;
let phase2Remaining = 0n; // phase2RemainingSlots, refreshed while Phase 2 is open
let mintInFlight = false;
let eligibleShard = null; // proof shard for the current claim target (or null)
let claimInFlight = false;
let claimVault = null; // checksummed vault address when delegate-claiming, else null
let vaultInvalid = false; // true when the vault field holds a malformed address
let discoveredVaults = []; // vaults that have delegated to the connected wallet for Abnormies
let delegationsAccount = null; // account the vault dropdown was last populated for

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function showBanner(kind, msg) {
  const b = $("banner");
  b.className = `banner banner-${kind}`;
  b.textContent = msg;
  b.hidden = false;
}
function hideBanner() {
  $("banner").hidden = true;
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Inline Sky-colored (#e3e5e4, the renderer's lightest cloud-palette value)
// stand-in for an Abnormie whose canvas has not been revealed yet. Built via DOM
// nodes rather than markup so it carries no injection surface. Size comes from CSS.
function skyThumb(className) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Unrevealed Abnormie");
  if (className) svg.setAttribute("class", className);
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("width", "40");
  rect.setAttribute("height", "40");
  rect.setAttribute("fill", "#e3e5e4");
  svg.appendChild(rect);
  return svg;
}

// Mirrors EtherPool's describeError: surface the most human-readable field.
function describeError(err) {
  if (!err) return "Unknown error.";
  return err.shortMessage || err.details || err.message || String(err);
}

// Walks the viem error cause chain to detect the contract's InvalidDelegation() revert.
function isInvalidDelegation(err) {
  let e = err;
  while (e) {
    if (e.data?.errorName === "InvalidDelegation") return true;
    if (typeof e.message === "string" && e.message.includes("InvalidDelegation")) return true;
    e = e.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  $("expected-chain").textContent = `${CHAIN_NAMES[expectedChainId] || `chain ${expectedChainId}`} (${expectedChainId})`;
  $("connect-btn").addEventListener("click", connect);
  $("refresh-btn").addEventListener("click", refreshAll);
  $("mint-count").addEventListener("input", syncMintForm);
  $("mint-btn").addEventListener("click", onMintClick);
  $("claim-btn").addEventListener("click", onClaimAll);
  $("vault-input").addEventListener("input", onVaultInput);
  $("vault-select").addEventListener("change", onVaultSelect);

  if (!contractAddress || !isAddress(contractAddress)) {
    showBanner("error", "No contract address configured. Set FRONTEND_CONTRACT_ADDRESS and rebuild.");
    return;
  }

  try {
    const res = await fetch("./abi/Abnormies.json");
    abi = (await res.json()).abi;
  } catch {
    showBanner("error", "Failed to load contract ABI.");
    return;
  }

  publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl || undefined) });
  reader = getContract({ address: contractAddress, abi, client: publicClient });

  // Silent reconnect if the wallet already authorized this site.
  if (window.ethereum) {
    try {
      const accs = await window.ethereum.request({ method: "eth_accounts" });
      if (accs && accs.length) await setupWallet(accs[0]);
    } catch {
      /* ignore */
    }
  }

  await refreshAll();
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
async function connect() {
  if (!window.ethereum) {
    showBanner("error", "No injected wallet found. Install a browser wallet to claim.");
    return;
  }
  try {
    const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
    await setupWallet(accs[0]);
    await refreshAll();
  } catch (e) {
    showBanner("error", `Connection rejected: ${e.shortMessage || e.message || e}`);
  }
}

async function setupWallet(addr) {
  account = getAddress(addr);
  walletClient = createWalletClient({ account, chain, transport: custom(window.ethereum) });
  await refreshWalletChain();
  attachListeners();
  $("connect-btn").textContent = "Reconnect";
}

async function refreshWalletChain() {
  try {
    const hex = await window.ethereum.request({ method: "eth_chainId" });
    walletChainId = parseInt(hex, 16);
  } catch {
    walletChainId = null;
  }
}

function attachListeners() {
  if (listenersAttached || !window.ethereum) return;
  listenersAttached = true;
  window.ethereum.on?.("accountsChanged", async (accs) => {
    if (!accs || !accs.length) {
      account = null;
      walletClient = null;
      $("connect-btn").textContent = "Connect";
    } else {
      account = getAddress(accs[0]);
      walletClient = createWalletClient({ account, chain, transport: custom(window.ethereum) });
    }
    await refreshAll();
  });
  window.ethereum.on?.("chainChanged", async () => {
    await refreshWalletChain();
    await refreshAll();
  });
}

function renderWalletBar() {
  hideBanner();
  if (account) {
    $("wallet-address").textContent = short(account);
    $("wallet-chain").textContent = walletChainId != null ? `chain ${walletChainId}` : "";
  } else {
    $("wallet-address").textContent = "Not connected";
    $("wallet-chain").textContent = "";
  }
  if (account && walletChainId != null && walletChainId !== expectedChainId) {
    showBanner(
      "warn",
      `Wrong network. Switch your wallet to ${CHAIN_NAMES[expectedChainId] || expectedChainId} (chainId ${expectedChainId}).`
    );
  }
}

// ---------------------------------------------------------------------------
// Refresh orchestration
// ---------------------------------------------------------------------------
async function refreshAll() {
  renderWalletBar();
  try {
    await refreshPhaseAndSupply();
  } catch (e) {
    showBanner("error", `Failed to read contract state: ${e.shortMessage || e.message || e}`);
    return;
  }

  if (account) {
    if (claimOpen) await loadDelegations();
    await Promise.allSettled([loadEligible(), loadReceipts()]);
  } else {
    resetVaultPicker();
    $("receipts-section").hidden = true;
    $("claim-list").innerHTML = "";
    $("claim-btn").hidden = true;
    eligibleShard = null;
    const empty = $("claim-empty");
    if (claimOpen) {
      empty.hidden = false;
      empty.textContent = "Connect a wallet to see your eligible Normies.";
    } else {
      empty.hidden = true;
    }
  }
}

// Phase: derived from phase() + the Phase 1 time window + isSealed() + revealed().
//   phase 0, within window      -> "Phase 1: claims open"          (claim active)
//   phase 0, window elapsed     -> "Phase 1 closed — awaiting ..." (neither active)
//   phase 1 && !sealed          -> "Phase 2: mint open"            (mint active)
//   phase 1 && sealed           -> "Reveal pending"
//   phase 2 (revealed)          -> "Revealed"
//
// Critical: claim() reverts Phase1Ended once block.timestamp reaches
// deployedAt + PHASE_1_DURATION, even while phase() is still 0 — closePhase1() is
// permissionless and may not have been called yet (exactly the live Sepolia state).
// So the claim UI must gate on the time window too, not on phase() alone, or it
// will keep offering claims that revert.
async function refreshPhaseAndSupply() {
  const [phase, sealed, revealed, receiptsLen, maxSupply, deployedAt, phase1Duration, block] = await Promise.all([
    reader.read.phase(),
    reader.read.isSealed(),
    reader.read.revealed(),
    reader.read.receiptsLength(),
    reader.read.MAX_SUPPLY(),
    reader.read.deployedAt(),
    reader.read.PHASE_1_DURATION(),
    publicClient.getBlock()
  ]);

  currentPhase = Number(phase);

  // Compare against chain time (block.timestamp), the same clock the contract's
  // Phase1Ended guard uses, rather than the viewer's wall clock.
  const phase1Deadline = deployedAt + phase1Duration;
  const phase1WindowOpen = block.timestamp < phase1Deadline;
  claimOpen = currentPhase === 0 && phase1WindowOpen;
  const phase1ClosedByTime = currentPhase === 0 && !phase1WindowOpen;

  let label;
  if (claimOpen) label = "Phase 1: claims open";
  else if (phase1ClosedByTime) label = "Phase 1 closed — Phase 2 opens once closePhase1 is called";
  else if (currentPhase === 1 && !sealed) label = "Phase 2: mint open";
  else if (currentPhase === 1 && sealed) label = "Reveal pending";
  else label = "Revealed";
  $("phase-label").textContent = label;

  // Remaining supply framed as a countdown: total cap minus receipts created
  // so far (claims in Phase 1; claims + mints + airdrops once Phase 2 opens).
  const remaining = maxSupply - receiptsLen;
  $("progress-counter").textContent = `${remaining.toString()} of ${maxSupply.toString()} remaining`;

  $("claim-section").hidden = !claimOpen;
  $("mint-section").hidden = !(currentPhase === 1 && !sealed);

  if (currentPhase === 1 && !sealed) await prepareMint();
}

// ---------------------------------------------------------------------------
// Mint (Phase 2)
// ---------------------------------------------------------------------------
// Called while Phase 2 is open: read mint params + remaining supply, then render.
async function prepareMint() {
  try {
    const [price, cap, remaining] = await Promise.all([
      reader.read.MINT_PRICE(),
      reader.read.PHASE2_MAX_PER_CALL(),
      reader.read.phase2RemainingSlots()
    ]);
    mintPrice = price;
    maxPerCall = cap;
    phase2Remaining = remaining;
  } catch {
    /* keep last-known values */
  }
  renderMint();
}

// Upper bound on a single mint: min(PHASE2_MAX_PER_CALL, phase2RemainingSlots).
function mintMax() {
  return Math.min(Number(maxPerCall), Number(phase2Remaining));
}

// Choose form vs. empty-state (not connected / sold out) for the mint section.
function renderMint() {
  const form = $("mint-form");
  const empty = $("mint-empty");

  if (!account) {
    form.hidden = true;
    empty.hidden = false;
    empty.textContent = "Connect a wallet to mint.";
    return;
  }
  if (mintMax() < 1) {
    form.hidden = true;
    empty.hidden = false;
    empty.textContent = "Phase 2 sold out. Awaiting reveal.";
    return;
  }
  empty.hidden = true;
  form.hidden = false;
  syncMintForm();
}

// Clamp the count input to [1, mintMax()], then update total, label, and gating.
function syncMintForm() {
  const max = Math.max(1, mintMax());
  $("mint-count").max = String(max);

  let n = Math.floor(Number($("mint-count").value));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > max) n = max;
  $("mint-count").value = String(n);

  $("mint-total").textContent = `${formatEther(mintPrice * BigInt(n))} ETH`;
  $("mint-btn").textContent = `Mint ${n} ${n === 1 ? "Abnormie" : "Abnormies"}`;

  const wrongChain = walletChainId != null && walletChainId !== expectedChainId;
  $("mint-btn").disabled = !account || wrongChain || mintMax() < 1 || mintInFlight;
}

async function onMintClick() {
  const btn = $("mint-btn");
  if (!walletClient || !account) {
    showBanner("error", "Connect a wallet first.");
    return;
  }
  if (currentPhase !== 1) {
    showBanner("warn", "Minting is only open in Phase 2.");
    return;
  }
  if (walletChainId != null && walletChainId !== expectedChainId) {
    showBanner("warn", `Switch your wallet to ${CHAIN_NAMES[expectedChainId] || expectedChainId} (chainId ${expectedChainId}) to mint.`);
    return;
  }

  // 1. Validate count against the last-known bound.
  const maxNow = mintMax();
  let count = Math.floor(Number($("mint-count").value));
  if (!Number.isInteger(count) || count < 1 || count > Math.max(1, maxNow)) {
    showBanner("error", "Enter a whole number of Abnormies within the available range.");
    return;
  }
  if (maxNow < 1) {
    showBanner("warn", "Phase 2 sold out. Awaiting reveal.");
    return;
  }

  const originalLabel = btn.textContent;
  mintInFlight = true;
  btn.disabled = true;
  $("refresh-btn").disabled = true;
  btn.textContent = "Checking…";

  try {
    // 2. Re-read remaining; silently reduce count if a race shrank it.
    let remaining;
    try {
      remaining = Number(await reader.read.phase2RemainingSlots());
    } catch {
      remaining = maxNow;
    }
    if (remaining < 1) {
      showBanner("warn", "Phase 2 sold out. Awaiting reveal.");
      await refreshPhaseAndSupply();
      return;
    }
    if (count > remaining) count = remaining;

    // 3. value must equal count * MINT_PRICE (no refunds).
    const value = mintPrice * BigInt(count);

    // 4. Send.
    btn.textContent = "Confirm in wallet…";
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi,
      functionName: "mintPhase2",
      args: [BigInt(count)],
      value,
      account
    });
    btn.textContent = "Waiting for confirmation…";
    await publicClient.waitForTransactionReceipt({ hash });

    // 5. Success: report the actual count minted, then refresh state + receipts.
    mintInFlight = false; // let the post-mint refresh render an accurate button
    showBanner("ok", `Minted ${count} ${count === 1 ? "Abnormie" : "Abnormies"} for ${formatEther(value)} ETH.`);
    await refreshPhaseAndSupply();
    if (account) await loadReceipts();
  } catch (err) {
    // 6. Failure: surface the reason and re-enable the button.
    showBanner("error", `Mint failed. ${describeError(err)}`);
    btn.textContent = originalLabel;
    btn.disabled = false;
  } finally {
    mintInFlight = false;
    $("refresh-btn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Eligible Normies (Phase 1)
// ---------------------------------------------------------------------------
// Reads claimed(normieId) for every leaf in a shard. Batched via Multicall3,
// with a sequential fallback. Returns a boolean[] aligned to the shard.
async function readClaimedFlags(shard) {
  try {
    const results = await publicClient.multicall({
      contracts: shard.map((s) => ({
        address: contractAddress,
        abi,
        functionName: "claimed",
        args: [BigInt(s.normieId)]
      }))
    });
    return results.map((r) => (r.status === "success" ? Boolean(r.result) : false));
  } catch {
    return Promise.all(shard.map((s) => reader.read.claimed([BigInt(s.normieId)]).catch(() => false)));
  }
}

// Accepts a checksummed or all-lowercase address; returns the checksummed form, or null.
function normalizeVault(value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  if (value === value.toLowerCase()) return getAddress(value); // all-lowercase is fine
  if (isAddress(value, { strict: true })) return getAddress(value); // correct checksum is fine
  return null; // mixed-case with a bad checksum
}

// Resolve the active target from the dropdown + optional text input. A concrete vault
// chosen in the dropdown wins; otherwise the visible text input governs; otherwise self.
function resolveVaultTarget() {
  const select = $("vault-select");
  const input = $("vault-input");

  if (!select.hidden && select.value && select.value !== "__manual__") {
    return { vault: getAddress(select.value), invalid: false };
  }
  if (!input.hidden) {
    const v = input.value.trim();
    if (v === "") return { vault: null, invalid: false };
    const norm = normalizeVault(v);
    return norm ? { vault: norm, invalid: false } : { vault: null, invalid: true };
  }
  return { vault: null, invalid: false };
}

// Apply the resolved target to state + inline error, then refresh both lists.
function applyVaultTarget() {
  const { vault, invalid } = resolveVaultTarget();
  claimVault = vault;
  vaultInvalid = invalid;
  const err = $("vault-error");
  if (invalid) {
    err.hidden = false;
    err.textContent = "Enter a valid address (checksummed or all-lowercase).";
  } else {
    err.hidden = true;
  }
  loadEligible();
  loadReceipts();
}

// Text input changed.
function onVaultInput() {
  applyVaultTarget();
}

// Dropdown changed: manage text-input visibility, then apply the target.
function onVaultSelect() {
  const select = $("vault-select");
  const input = $("vault-input");
  // Text input shows for the no-delegations fallback or when "manual" is chosen.
  const inputVisible = discoveredVaults.length === 0 || select.value === "__manual__";
  input.hidden = !inputVisible;
  if (select.value === "__manual__") input.focus();
  applyVaultTarget();
}

// Reset the picker to its disconnected default (self only, no discovered vaults).
function resetVaultPicker() {
  discoveredVaults = [];
  delegationsAccount = null;
  claimVault = null;
  vaultInvalid = false;
  const select = $("vault-select");
  select.hidden = false;
  select.disabled = false;
  select.innerHTML =
    '<option value="">Claim for myself (default)</option><option value="__manual__">Enter another address manually…</option>';
  select.value = "";
  $("vault-input").hidden = true;
  $("vault-input").value = "";
  $("vault-error").hidden = true;
  $("delegate-note").textContent = "Claiming on behalf of another wallet? Enter the vault address below.";
}

// Query delegate.xyz v2 for vaults that have delegated to the connected wallet for
// Abnormies (type ALL, or CONTRACT scoped to this contract, with rights == 0) and
// populate the dropdown. On failure, silently fall back to the manual text input.
async function loadDelegations() {
  if (delegationsAccount === account) return; // already populated for this account

  const select = $("vault-select");
  const input = $("vault-input");
  const note = $("delegate-note");

  select.hidden = false;
  select.disabled = true;
  select.innerHTML = "<option>Checking delegations…</option>";
  input.hidden = true;
  $("vault-error").hidden = true;

  let vaults = [];
  let failed = false;
  try {
    const delegations = await publicClient.readContract({
      address: DELEGATE_REGISTRY,
      abi: DELEGATE_REGISTRY_ABI,
      functionName: "getIncomingDelegations",
      args: [account]
    });
    const seen = new Set();
    for (const d of delegations) {
      const t = Number(d.type_);
      const typeOk =
        t === DELEGATION_TYPE.ALL ||
        (t === DELEGATION_TYPE.CONTRACT && d.contract_.toLowerCase() === contractAddress.toLowerCase());
      const rightsOk = d.rights.toLowerCase() === ZERO_BYTES32;
      if (typeOk && rightsOk) {
        const v = getAddress(d.from);
        if (!seen.has(v.toLowerCase())) {
          seen.add(v.toLowerCase());
          vaults.push(v);
        }
      }
    }
  } catch (e) {
    failed = true;
    console.warn("delegate.xyz getIncomingDelegations failed; falling back to manual input:", e);
  }

  discoveredVaults = vaults;
  delegationsAccount = account;
  claimVault = null;
  vaultInvalid = false;

  if (failed) {
    // Silent fallback: behave like the manual-text-input-only UX.
    select.hidden = true;
    select.disabled = false;
    input.hidden = false;
    input.value = "";
    note.textContent = "Claiming on behalf of another wallet? Enter the vault address below.";
    return;
  }

  select.disabled = false;
  select.innerHTML = "";
  const optSelf = document.createElement("option");
  optSelf.value = "";
  optSelf.textContent = "Claim for myself (default)";
  select.appendChild(optSelf);
  for (const v of vaults) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = short(v);
    select.appendChild(o);
  }
  const optManual = document.createElement("option");
  optManual.value = "__manual__";
  optManual.textContent = "Enter another address manually…";
  select.appendChild(optManual);
  select.value = "";
  input.value = "";
  $("vault-error").hidden = true;

  if (vaults.length > 0) {
    note.textContent = "Claim for a wallet that's delegated to you. Choose a vault below.";
    input.hidden = true;
  } else {
    // No delegations found: keep the dropdown (self + manual) and expose the text input.
    note.textContent = "Claiming on behalf of another wallet? Enter the vault address below.";
    input.hidden = false;
  }
}

// Loads eligible Normies for the current claim target: the vault address when set,
// otherwise the connected wallet.
async function loadEligible() {
  const list = $("claim-list");
  const empty = $("claim-empty");
  const btn = $("claim-btn");
  btn.hidden = true;

  if (!claimOpen) {
    list.innerHTML = "";
    empty.hidden = true;
    eligibleShard = null;
    return;
  }
  if (vaultInvalid) {
    // Malformed vault address; onVaultInput already surfaced the inline error.
    list.innerHTML = "";
    empty.hidden = true;
    eligibleShard = null;
    return;
  }
  if (!account) {
    list.innerHTML = "";
    eligibleShard = null;
    empty.hidden = false;
    empty.textContent = "Connect a wallet to see your eligible Normies.";
    return;
  }

  const isVault = claimVault != null;
  const target = isVault ? claimVault : account;
  const notHolderMsg = isVault
    ? "No eligible Normies for that address."
    : "Your wallet was not a Normies holder at the snapshot block.";

  list.innerHTML = "<div class='loading'>Loading eligible Normies…</div>";
  empty.hidden = true;

  let shard = null;
  try {
    const res = await fetch(`./proofs/owner/${target.toLowerCase()}.json`);
    if (res.status === 404) {
      list.innerHTML = "";
      eligibleShard = null;
      empty.hidden = false;
      empty.textContent = notHolderMsg;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    shard = await res.json();
  } catch (err) {
    list.innerHTML = "";
    eligibleShard = null;
    empty.hidden = true;
    showBanner("error", `Could not load eligibility. ${describeError(err)} Retry with Refresh.`);
    return;
  }

  if (!Array.isArray(shard) || shard.length === 0) {
    list.innerHTML = "";
    eligibleShard = null;
    empty.hidden = false;
    empty.textContent = notHolderMsg;
    return;
  }

  eligibleShard = shard;
  const claimedFlags = await readClaimedFlags(shard);

  list.innerHTML = "";
  let unclaimed = 0;
  shard.forEach((s, i) => {
    if (!claimedFlags[i]) unclaimed++;
    const row = document.createElement("div");
    row.className = "claim-row";
    row.innerHTML = `<span class="normie-id">Normie #${s.normieId}</span>
      <span class="badge">${s.customizedAtSnapshot ? "Customized" : "Uncustomized"}</span>`;
    if (claimedFlags[i]) {
      const badge = document.createElement("span");
      badge.className = "badge badge-claimed";
      badge.textContent = "Already claimed";
      row.appendChild(badge);
    }
    list.appendChild(row);
  });

  if (unclaimed === 0) {
    empty.hidden = false;
    empty.textContent = isVault
      ? "All eligible Normies for that address are already claimed."
      : "You have claimed all eligible Normies.";
    btn.hidden = true;
  } else {
    empty.hidden = true;
    btn.hidden = false;
    const noun = unclaimed === 1 ? "Abnormie" : "Abnormies";
    btn.textContent = isVault ? `Claim ${unclaimed} ${noun} for ${short(target)}` : `Claim ${unclaimed} ${noun}`;
    // Gating: enabled only on the expected chain and when no claim is in flight.
    const wrongChain = walletChainId != null && walletChainId !== expectedChainId;
    btn.disabled = wrongChain || claimInFlight;
  }
}

// Bulk claim: every unclaimed eligible Normie in a single tx. No per-Normie buttons.
async function onClaimAll() {
  const btn = $("claim-btn");
  if (!walletClient || !account) {
    showBanner("error", "Connect a wallet first.");
    return;
  }
  if (!claimOpen) {
    showBanner("warn", "Claiming is only open during the Phase 1 window.");
    return;
  }
  if (walletChainId != null && walletChainId !== expectedChainId) {
    showBanner("warn", `Switch your wallet to ${CHAIN_NAMES[expectedChainId] || expectedChainId} (chainId ${expectedChainId}) to claim.`);
    return;
  }
  if (vaultInvalid) {
    showBanner("warn", "Enter a valid vault address, or clear the field to claim for yourself.");
    return;
  }
  if (!eligibleShard || eligibleShard.length === 0) return;

  const originalLabel = btn.textContent;
  claimInFlight = true;
  btn.disabled = true;
  $("refresh-btn").disabled = true;
  btn.textContent = "Checking…";

  try {
    // 1. Re-read claimed() immediately before the call; filter to unclaimed.
    const claimedFlags = await readClaimedFlags(eligibleShard);
    const unclaimed = eligibleShard.filter((_, i) => !claimedFlags[i]);

    // 2. Race: everything was claimed since the last refresh.
    if (unclaimed.length === 0) {
      showBanner("warn", "Already claimed.");
      await loadEligible();
      return;
    }

    // 3. Parallel-indexed arrays. Proof hex strings pass through to viem as-is.
    const normieIds = unclaimed.map((s) => BigInt(s.normieId));
    const customizedFlags = unclaimed.map((s) => Boolean(s.customizedAtSnapshot));
    const proofs = unclaimed.map((s) => s.proof);
    // vault: a real zero-address param for direct claims, the vault for delegated claims.
    const vaultArg = claimVault ?? zeroAddress;

    // 4. One tx for the whole batch (whales included; ~8k gas per Normie).
    btn.textContent = "Confirm in wallet…";
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi,
      functionName: "claim",
      args: [normieIds, customizedFlags, proofs, vaultArg],
      account
    });
    btn.textContent = "Waiting for confirmation…";
    await publicClient.waitForTransactionReceipt({ hash });

    // 5. Success: refresh phase state, receipts, and per-Normie claimed status.
    claimInFlight = false; // let the post-claim refresh render an accurate button
    const noun = unclaimed.length === 1 ? "Abnormie" : "Abnormies";
    showBanner(
      "ok",
      claimVault ? `Claimed ${unclaimed.length} ${noun} for ${short(claimVault)}.` : `Claimed ${unclaimed.length} ${noun}.`
    );
    await refreshPhaseAndSupply();
    await Promise.allSettled([loadEligible(), loadReceipts()]);
  } catch (err) {
    // 6. Failure: surface the reason and re-enable the button.
    if (claimVault && isInvalidDelegation(err)) {
      showBanner(
        "error",
        `Your wallet is not delegated by ${short(claimVault)} on delegate.xyz. Set up the delegation at https://delegate.xyz before claiming.`
      );
    } else {
      showBanner("error", `Claim failed. ${describeError(err)}`);
    }
    btn.textContent = originalLabel;
    btn.disabled = false;
  } finally {
    claimInFlight = false;
    $("refresh-btn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// My Abnormies (Unrevealed)
// ---------------------------------------------------------------------------
// No per-owner receipt index exists on-chain, so we scan receiptsLength() and
// filter receiptAt(i) by claimant against the active target (the selected vault
// when set, otherwise the connected wallet). Token IDs aren't assigned until
// reveal, so each holding renders as "[unrevealed]". Batched via Multicall3.
async function loadReceipts() {
  const section = $("receipts-section");
  const listEl = $("receipts-list");
  const empty = $("receipts-empty");
  const subtitle = $("receipts-subtitle");
  section.hidden = false;

  const target = claimVault || account;
  if (!target) {
    section.hidden = true;
    return;
  }

  if (claimVault) {
    subtitle.hidden = false;
    subtitle.textContent = `Showing Unrevealed Abnormies for ${short(claimVault)}`;
  } else {
    subtitle.hidden = true;
  }

  listEl.innerHTML = "<div class='loading'>Loading Unrevealed Abnormies…</div>";
  empty.hidden = true;

  let len = 0;
  try {
    len = Number(await reader.read.receiptsLength());
  } catch {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Could not load Unrevealed Abnormies.";
    return;
  }

  if (len === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Nothing to show yet.";
    return;
  }

  const targetLower = target.toLowerCase();
  let count = 0;
  const CHUNK = 400;
  for (let start = 0; start < len; start += CHUNK) {
    const end = Math.min(start + CHUNK, len);
    const contracts = [];
    for (let i = start; i < end; i++) {
      contracts.push({ address: contractAddress, abi, functionName: "receiptAt", args: [BigInt(i)] });
    }

    let results;
    try {
      results = await publicClient.multicall({ contracts });
    } catch {
      results = [];
      for (let i = start; i < end; i++) {
        try {
          results.push({ status: "success", result: await reader.read.receiptAt([BigInt(i)]) });
        } catch {
          results.push({ status: "failure" });
        }
      }
    }

    results.forEach((r) => {
      if (r.status !== "success") return;
      // Receipt tuple: (claimant, normieId, fromPhase1, snapshotCustomized, resolved, abnormieId).
      if (r.result[0].toLowerCase() === targetLower) count++;
    });
  }

  if (count === 0) {
    listEl.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Nothing to show yet.";
    return;
  }

  listEl.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.className = "receipt-row";
    row.appendChild(skyThumb("receipt-thumb"));
    const status = document.createElement("span");
    status.className = "receipt-status";
    status.textContent = "[unrevealed]";
    row.appendChild(status);
    listEl.appendChild(row);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => showBanner("error", e.message || String(e)));
});
