---
title: "Abnormies: Production Spec"
status: draft
version: 0.16
source_collection: Normies (Serc, Feb 2026)
source_contract: 0x9eb6e2025b64f340691e424b7fe7022ffde12438
agent_adapter: Adapter8004 (Premm, ERC-8217)
lineage: Wiiides (Sterling Crispin, 2022)
license: CC0
website: abnormies.art
deployment: solo
---

# Abnormies

*Co-authored with Claude Opus 4.7. This document may contain errors, will be updated as the project progresses, and should be considered directional rather than authoritative.*

Abnormies is a fully on-chain art collection derived from Normies (Serc, 2026), exploring network effects, lack of control, and randomness. Each Abnormie is bound 1:1 to a seed Normie, reads Normies contract data directly, and mutates through Normies' economic activity rather than its own. Marks accumulate on the 40×40 canvas from transfers, customizations, and the destructive actions of other holders, cancelling against each other as they collide. The author is the network. In the agentic era, when a seed Normie has been awakened and its current owner also holds the corresponding Abnormie, the canvas inverts at render time. The record reads differently in the hands of the recorded.

## Thesis

A Normie is something you mint, customize, and own. An Abnormie is the weather around that ownership, the marks left by transfers, customizations, and the destructive actions of others. Each Abnormie begins minimal. All evolve as the network acts on them. Some remain spare; others become dense. None of that content is authored by the Abnormie's holder, except once, through destruction.

The collection inverts the Normies social contract: in Normies, you burn others to refine yourself. In Abnormies, you preserve others by damaging everyone.

## Visual independence from Normies

Abnormies do not visually replicate Normies. Normies is CC0 and reproducing pixel patterns would be legally permitted, but the project's conceptual position is that Abnormies record *quantities of activity* through generic spatial language, not the visual content of their source. The relationship to Normies is established through:

- Color palette (two shared values: Sky and Nimbostratus, matching Normies' factory off-pixel and on-pixel hex values).
- Canvas dimensions (40×40).
- Naming family.
- Contract-level dependency (Abnormies reads Normies state).

The relationship is not established through visual mimicry. An Abnormie tells you that its seed Normie has been touched and how much, never which pixels were touched.

## Lineage and credit

Wiiides (Sterling Crispin, NotAudited.xyz, 2022) is the direct precedent: a fully on-chain CryptoPunks derivative that read its parent's image data and mutated through its own transfer activity. Abnormies extend the lineage to a mutable parent (Normies can be customized post-mint), add destructive holder actions (Thunder, Lightning) that produce network-wide effects, and add an agentic ownership inversion via Adapter8004. Where Wiiides decayed toward stripes, Abnormies decay toward ambiguous middle-density.

## Source contracts

**Normies (ERC-721C):** `0x9eb6e2025b64f340691e424b7fe7022ffde12438` on Ethereum mainnet. The wrapper composes two pluggable contracts:

- `INormiesRenderer` produces `tokenURI`. Not used by Abnormies.
- `INormiesStorage` exposes `getTokenRawImageData`, `getTokenTraits`, `isTokenDataSet`, `isRevealed`. `getTokenTraits` returns 8 trait IDs (Type, Gender, Age, Hair Style, Facial Feature, Eyes, Expression, Accessory). It does not contain a customization bit; the customization signal lives elsewhere, below.

Plus the Canvas contract that emits `setTransformBitmap` on each customization, and a separate **NormiesCanvasStorage** contract at `0xC255BE0983776BAB027a156681b6925cde47B2D1` exposing `isTransformed(uint256 tokenId) returns (bool)` as the canonical customization signal. Abnormies reads `isTransformed` directly and ignores the Canvas event stream (events are not readable from view functions).

**Adapter8004 (Premm, ERC-8217: Agent NFT Identity Bindings):** the binding adapter that solves the agent-orphan problem inherent to vanilla ERC-8004. Adapter8004 takes permanent custody of the agent NFT and binds it to the Normie via on-chain metadata. Owning the Normie is owning the agent. Transferring the Normie atomically transfers the agent. Ethereum mainnet proxy at `0xde152AfB7db5373F34876E1499fbD893A82dD336`. Verified surface from mainnet-fork testing:

- `bindingOf(uint256 agentId) returns (Binding { TokenStandard standard; address tokenContract; uint256 tokenId })`

The `agentIdForBinding` reverse lookup documented at `adapter8004.xyz/docs/contract` is not present on the deployed implementation. Abnormies' `pokeAwakening` therefore takes a caller-supplied `agentId` and verifies the binding via `bindingOf`. The frontend resolves the agentId off-chain via `api.normies.art` (which indexes the adapter's `AgentBound` event) before calling, so users never enter or see an agentId.

**Soft dependencies:**

- Normies' renderer and storage contracts are owner-upgradeable (`setRendererContract`, `setStorageContract`).
- Adapter8004 currently has two Normies team wallets registered as a safety layer pending multi-sig governance.

Documented for transparency. Abnormies has no other external service dependencies; reveal randomness is sourced from EVM blockhashes rather than from any oracle service.

## State advancement

The EVM does not permit a contract's view functions to read past event logs from other contracts. The Solidity documentation states this explicitly: log data is not accessible from within contracts. Abnormies therefore stores its own state and advances that state through three mechanisms.

### Permissionless pokes

Anyone may call `pokeSeed(normieId)` on the Abnormies contract. The function performs view-function reads on the Normies contracts and updates Abnormies state:

1. Reads `Normies.ownerOf(normieId)`. If the call reverts or returns the zero address, sets `seedBurned[normieId] = true` and records the current block number as `seedDeadAtBlock[normieId]`. Otherwise, if the returned address differs from the stored `lastObservedSeedOwner[normieId]`, increments `cirrusCount[normieId]` and updates the stored owner.
2. Reads `NormiesCanvasStorage.isTransformed(normieId)`. If true and `seedCustomized[normieId]` was previously false, sets the flag to true.

A batched form, `pokeMany(uint256[] normieIds)`, applies the same logic to a list of seed Normies in a single transaction. Used by holders refreshing multiple Abnormies at once and by collection-wide indexers.

A separate `pokeAwakening(uint256 normieId, uint256 agentId)` records agent binding: it calls `Adapter8004.bindingOf(agentId)` and requires the returned binding matches `(ERC721, Normies, normieId)`. If valid, sets `seedAwakened[normieId] = true` and stores `boundAgentId[normieId] = agentId`. One-way per seed. The agentId is resolved off-chain by the frontend via `api.normies.art`; users never enter or see it.

Pokes are gas-paid by the caller. Anyone can poke any seed at any time.

### Auto-pokes via Abnormies transfer hook

`Abnormies._beforeTokenTransfer` calls `pokeSeed` for the transferred Abnormie's seed as a side effect. Every Abnormie transfer refreshes its seed's state.

### Inline updates from holder actions

Thunder and Lightning actions update Abnormies' own state in the same transaction. Cascade marks, freeze records, and seed-owner observations triggered by these actions require no external proof.

### Phase 1 initialization

A merkle root committed at deploy commits each Normie's snapshot state (owner address, customization status from `isTransformed`, burn status). Phase 1 claims include a merkle proof that initializes the relevant seed counters and flags, including setting `lastObservedSeedOwner` to the snapshot owner so subsequent pokes correctly attribute the next observed owner change as the first Cirrus event. Post-deploy activity is captured via pokes from that point forward.

### Surfacing the refresh and awaken actions

State stays current only if pokes happen. Auto-pokes on Abnormie transfer and inline updates from holder actions cover most paths. The remaining paths are users manually triggering pokes when their seed Normie has acted but their Abnormie has not been touched.

The abnormies.art website is the canonical surface for this. Requirements:

- A **Refresh** button (or equivalent label such as **Update**, **Sync**) is present on every Abnormie detail view, always visible regardless of suspected freshness.
- Clicking the button opens the user's wallet to send a `pokeSeed(normieId)` transaction for the Abnormie's seed.
- On portfolio views, a single-click **Refresh all** action sends one `pokeMany(uint256[])` transaction batching the user's holdings.
- The website surfaces a **staleness indicator** alongside the button. The indicator compares the contract's last-observed state for the seed (owner, customization) against the Normies API's current state. When they differ, a visual cue is shown: a colored dot, a "Stale" label, or a brief description of what changed. The indicator informs but does not gate; the button works either way.
- No auto-refresh on page load. The user retains the choice to click.

A separate **Awaken** action surfaces when the contract has not yet recorded `seedAwakened` for the Abnormie's seed AND the seed has been awakened on Adapter8004 (detected via `api.normies.art/agents/binding/{normieId}`). Clicking sends a `pokeAwakening(normieId, agentId)` transaction; the agentId is resolved off-chain from the API and embedded in the transaction. Users never enter or see an agentId.

User-facing language uses "refresh," "update," or "awaken." The word "poke" is internal vocabulary for the contract function and never appears in the UI.

### What Abnormies reads

| Source | Purpose | Mechanism |
|---|---|---|
| `Normies.ownerOf(normieId)` | Living/Dead detection; Cirrus accrual | Read on each `pokeSeed`; also read directly by renderer for inversion check |
| `NormiesCanvasStorage.isTransformed(normieId)` | Binary customization signal for source Nimbostratus | Read on each `pokeSeed` |
| `Adapter8004.bindingOf(agentId)` | Verifies caller-supplied agentId resolves to the seed Normie, for the inversion check | Read by `pokeAwakening`; renderer reads `seedAwakened` state |
| Abnormies own storage | Counters, flags, freeze records, event logs | Read by renderer at view time |

Abnormies does not read `getTokenRawImageData` for any Normie.

## Deployment

Solo. Custom contract deployed by the project. Mint page on abnormies.art. No third-party launchpad or platform dependency.

## Supply and claim

- Total supply: 10,000, paired 1:1 with Normies token IDs.
- All 10,000 slots exist as latent claimable positions at deploy.

### Random assignment

Claims are 1:1 by quantity, not by token ID. A Normies holder with N Normies can claim N Abnormies, but the specific Abnormie token IDs they receive are randomly assigned via the reveal mechanism described below. Dead-source slots are included in the random pool from the start. Claim and mint receipts are created in monotonic order across both phases; the entire receipt list is sealed and revealed in a single shot.

### Phase 1: Holder Claim

- Duration: 2 days from contract deploy.
- Eligible: Normies holders at the snapshot block (announced publicly before deploy).
- Cost: gas only.
- Mechanism: holders submit a merkle proof committing their per-Normie eligibility and the snapshot state of each Normie (owner, customization status, burn status). Verified proofs create claim receipts and reserve those Normie IDs from the Phase 2 pool.
- Token IDs: not assigned at claim time; assigned in the single collection-wide reveal after Phase 2 sealing (see Reveal section).

### Phase 2: Open Mint

- Opens immediately after Phase 1 closes via permissionless `closePhase1()`.
- Any address may mint remaining slots at 0.005 ETH per Abnormie.
- The contract owner may airdrop unminted slots to any address as gas-only transactions, in any quantity up to a per-call cap of 50. Airdrop receipts and paid-mint receipts are interleaved in the unified receipt list in append order.
- Phase 2 ends in one of two ways:
  - **Supply exhaustion**: the last mint or airdrop that brings remaining supply to zero auto-seals the receipt list.
  - **Fallback seal**: anyone may call `sealForReveal()` after `phase1ClosedAt + 14 days` to seal the current receipt list and trigger the reveal sequence, regardless of remaining supply.

After sealing, no more mints or airdrops are accepted. Unminted slots if any (only possible under the fallback path) remain unminted forever; the corresponding Abnormie IDs simply never enter circulation.

## Phase 3 · Reveal

Once Phase 2 closes and the entropy window passes, the reveal phase begins. The collection reveals through the same network mechanic that shapes the art itself. Anyone may call resolveReceipts(N), paying gas to advance the reveal cursor by N positions. The next N receipts in the queue are resolved: each receives a randomly drawn Abnormie token ID and a randomly drawn seed Normie pairing. The receipt becomes a real ERC-721 token in its owner's wallet.

Resolution is strictly monotonic. The caller has no control over which receipts they advance. A claimant clicking 'reveal' on the site may resolve their own receipts, or someone else's, depending on the current cursor position. Receipts at the front of the queue resolve first; later receipts wait until the cursor reaches them.

The reveal continues until all receipts are resolved. The cost of reveal is borne by whoever chooses to advance the queue, in proportion to their participation. There is no fee, deposit, or bounty. Only gas.

## Reveal

Random assignment of receipts to Abnormie IDs happens in a single collection-wide reveal after the receipt list is sealed. The reveal architecture is a three-step seal-then-commit-then-reveal flow that uses Ethereum blockhashes as the entropy source. No external oracle service.

1. **Seal.** The receipt list is closed (no more mints or airdrops). Recorded `sealedAtBlock` is the current block number at the moment of sealing. Triggered automatically by the last receipt-creating transaction when supply hits zero, or manually by anyone via `sealForReveal()` after the 14-day fallback delay.

2. **Wait.** After sealing, the contract requires that all four entropy blocks be mined and within EVM blockhash range before reveal can proceed. The entropy blocks are `sealedAtBlock + 8` through `sealedAtBlock + 11` inclusive.

3. **Reveal.** Anyone calls `reveal()`. The function mixes the four entropy blockhashes through a `keccak256` chain into the `revealSeed`. The reveal window opens at `sealedAtBlock + 13` (one block after the last entropy block is mined) and closes at `sealedAtBlock + 240` (deliberately before EVM's 256-block blockhash horizon, with margin).

4. **Resolve.** After reveal, anyone calls `resolveReceipts(count)` repeatedly until every receipt is paired. Resolution is strictly monotonic; receipts cannot be reordered or skipped. Each receipt's assigned Abnormie ID is derived deterministically from `revealSeed`, the receipt index, and a Fisher-Yates draw over the unclaimed pool.

If `reveal()` is not called within 240 blocks of sealing (the EVM blockhash window expires for the earliest entropy block beyond that), anyone may call `reseal()` to reset `sealedAtBlock` to the current block. The receipt list itself does not change; only the seal block is updated. Reveal then proceeds against a fresh entropy window.

### Reveal randomness properties

The four-block entropy mix prevents intermediate-block proposer bias: any proposer in positions 1 through 3 of the entropy window sees only partial seed data and cannot compute the final seed. The proposer of the **final** entropy block, however, can compute the complete reveal seed before publishing their block and can withhold the block (forfeiting that block's MEV reward) to roll for a different final hash on a replacement block. This is a single conditional reroll, not arbitrary seed selection, and the attacker pays the cost of a block reward forfeit per attempt.

For a small-fractional-stakes art project (0.005 ETH per Abnormie, total project pot in the low tens of ETH), the manipulation surface is small relative to other operational concerns. The architecture trades the absolute proposer-bias resistance of an oracle-based randomness service (Chainlink VRF and similar) for the absence of any external service dependency.

## Visual specification

### Layers

40×40 monochrome grid, identical dimensions to Normies. Four-color cloud palette:

| Color | Hex | RGB | Name | Origin |
|---|---|---|---|---|
| Lightest | `#e3e5e4` | 227, 229, 228 | **Sky** | Untouched, or touched an even number of times (cancelled). |
| Light | `#b0b1b0` | 176, 177, 176 | **Cirrus** | Mark left by an observed change in the seed Normie's owner. |
| Mid | `#7c7d7e` | 124, 125, 126 | **Altocumulus** | Mark left by a Thunder cascade. |
| Dark | `#48494b` | 72, 73, 75 | **Nimbostratus** | Mark left by source customization (binary), or by a Lightning cascade. Indistinguishable visually; distinguishable in metadata. |

Lightness progression: Sky > Cirrus > Altocumulus > Nimbostratus.

Sky and Nimbostratus match Normies' factory values exactly.

Source-customization Nimbostratus and Lightning-cascade Nimbostratus share the darkest color by design. Their counts are exposed separately in metadata for sorting and rarity, but no pixel on the rendered canvas reveals which event produced it.

## Mutation: layers with cancellation

Four event classes contribute to the canvas. All use the same touch-accumulation logic. Each event produces N deterministic pixel positions on the Abnormie, seeded by `keccak256(...)`.

### Cancellation rule

Events are processed in chronological order at render time. For each pixel position assigned by an event:

1. If the position is currently Sky, it takes the event's color.
2. If the position is currently any non-Sky color, the new mark and the existing mark cancel: the position reverts to Sky, available for future events.

Every visible non-Sky pixel on an Abnormie has been touched an odd number of times. Coverage plateaus at approximately 50%. The endpoint of an active history is ambiguous middle-density, neither pristine nor saturated.

There is no layer hierarchy. Any color can cancel any other.

### Event sources

#### Cirrus: observed seed Normie owner changes

- **Trigger:** an observed change in `Normies.ownerOf(normieId)` since the last poke or initial snapshot. Recorded via `pokeSeed` or auto-poke.
- **N per event:** 2 pixels.
- **Positions:** deterministic, seeded by `keccak256(normieId, cirrusIndex, "cirrus")`.

Cirrus accrues only on observed owner changes. Transfers that occur between two pokes and end at the same owner that was previously observed are not recorded. The Phase 1 snapshot owner counts as the initial observation. The counter saturates at `uint16.max`; subsequent observations do not revert.

#### Nimbostratus (source): seed Normie first customization

- **Trigger:** the first time `pokeSeed` observes `NormiesCanvasStorage.isTransformed(normieId)` returning true. Binary; once per seed.
- **N per event:** 12 pixels.
- **Positions:** deterministic, seeded by `keccak256(normieId, "nimbostratus-source")`.

A seed Normie that has never been customized contributes zero source Nimbostratus marks. A seed Normie that has been customized at least once contributes the 12-pixel batch exactly once. The `isTransformed` flag is one-way for our purposes; once observed true, the seed Normie's source Nimbostratus is locked in.

Note: Awakening (Adapter8004 binding) and customization (NormiesCanvasStorage transformation) are independent. Awakening is a gas-only transaction; customization requires burning a Normie. Holders are more likely to awaken than customize, so a Normie can be Awakened without being Customized. The two signals address different state axes and should not be treated as proxies for each other.

#### Nimbostratus (Lightning): Lightning cascade

- **Trigger:** a Lightning action recorded in the Abnormies contract.
- **N per event:** 1 Nimbostratus pixel per Active Abnormie across the collection.
- **Positions:** deterministic, seeded by `keccak256(lightningBlockhash, targetTokenId)`.

#### Altocumulus: Thunder cascade

- **Trigger:** a Thunder action recorded in the Abnormies contract.
- **N per event:** random integer in range [5, 10] per Active Abnormie across the collection.
- **Positions:** deterministic, seeded by `keccak256(thunderBlockhash, targetTokenId)`.

### Event processing order at render time

The renderer replays events from stored counters in chronological order:

1. All Cirrus events: `cirrusCount[normieId]` events (or the freeze-time snapshot for Static Abnormies), indexed 0 through count - 1.
2. Source Nimbostratus event: one event, conditional on `seedCustomized[normieId] = true` (or the freeze-time snapshot for Static Abnormies).
3. All Lightning events received, in chronological order from Abnormies storage.
4. All Thunder events received, in chronological order from Abnormies storage.

Deterministic and reproducible. Anyone can replay the same sequence and produce the same canvas.

## State system

Two independent binary axes describe each Abnormie:

### Axis 1: mutability

- **Active**: the Abnormie may still receive new marks from any event type that targets it.
- **Static**: the Abnormie is frozen. State at the moment of becoming Static is permanent. Immune to all future events. Terminal. All seed-derived render inputs (cirrusCount, seedCustomized, seedBurned, and the Dead At block) are snapshotted into per-Abnormie storage at the moment of freeze. Subsequent pokes against the seed do not affect a Static Abnormie's render or metadata.

An Abnormie becomes Static when chosen as the freeze target of a Thunder or Lightning action. The freeze applies before the cascade fires, so the newly Static Abnormie receives no contribution from the action that froze it. The freezing action also inline-pokes the freeze target's seed so the snapshot reflects the latest observable seed state at freeze time.

### Axis 2: source life

- **Living**: the seed Normie is alive and may continue to influence the Abnormie (transfers and customizations are observable via pokes).
- **Dead**: the seed Normie has been burned. No further Cirrus or source Nimbostratus events can accrue. The Abnormie may still receive Thunder and Lightning cascades while Active.

The transition from Living to Dead is recorded on a poke that observes `Normies.ownerOf(normieId)` reverting or returning address(0). One-way. For Static Abnormies, Source Life is read from the freeze-time snapshot per Axis 1; subsequent observed burns of the seed do not change a Static Abnormie's Source Life or Dead At trait.

### Combinations

| Active | Living | Description | Receives | Burnable |
|---|---|---|---|---|
| Active | Living, uncustomized | Cirrus only until/unless seed becomes customized; plus all network cascades | Cirrus, Thunder, Lightning cascades | Not burnable |
| Active | Living, customized | All event types | Cirrus, source Nimbostratus (already accrued), Thunder, Lightning cascades | **Lightning** |
| Active | Dead | Network cascades only | Thunder, Lightning cascades | **Thunder** |
| Static | Living | Frozen | None | Not burnable |
| Static | Dead | Frozen. The doubly-preserved rare category. | None | Not burnable |

## Destructive holder actions

Two burn paths. Each burns the burner's Abnormie, casts a cascade across the network, and freezes one Active Abnormie of the burner's choice.

### Thunder: burn a Dead Abnormie

**Plain instructions:** Burning a Dead Abnormie freezes one Active Abnormie of your choice (it becomes Static, permanently locked in its current state) and creates a Thunder cascade: 5 to 10 Altocumulus pixels land on every other Active Abnormie in the collection. The frozen Abnormie cannot be one you own.

- **Burns:** one Active+Dead Abnormie.
- **Freezes:** one Active Abnormie of the burner's choice. Frozen *before* cascade fires. **Must not be owned by burner.**
- **Cascade:** 5 to 10 Altocumulus pixels per Active Abnormie (excluding the freeze target and the burned Abnormie).
- The burner's seed is inline-poked before the SeedDead check; the freeze target's seed is inline-poked before the freeze snapshot is captured. Both ensure the action operates on the latest observable seed state.

### Lightning: burn a Living, customized Abnormie

**Plain instructions:** Burning a Living Abnormie whose seed Normie has been customized at least once freezes one Active Abnormie of your choice (it becomes Static) and creates a Lightning cascade: one Nimbostratus pixel lands on every other Active Abnormie in the collection. The frozen Abnormie cannot be one you own.

- **Burns:** one Active+Living Abnormie whose seed is customized.
- **Freezes:** one Active Abnormie of the burner's choice. Frozen *before* cascade fires. **Must not be owned by burner.**
- **Cascade:** 1 Nimbostratus pixel per Active Abnormie (excluding the freeze target and the burned Abnormie).
- The burner's seed is inline-poked before the SeedDead and SeedNotCustomized checks; the freeze target's seed is inline-poked before the freeze snapshot is captured.

### The non-self freeze rule

**The freeze target must not be owned by the burner.** A burner can freeze any Active Abnormie owned by anyone else. Self-preservation requires either coordination with another holder who freezes on your behalf, or moving the Abnormie to a side wallet before triggering the burn.

Rationale: preservation is a relational act in this system. The cascades that motivate freezing are involuntary network effects; the freeze that absorbs the burner's "save one" choice is therefore also relational by construction. Coordination and wallet-shuffle are explicit escape valves and considered legitimate. The rule is enforced at the contract level; any attempt to freeze a self-owned Abnormie reverts.

### Why two action types

Lightning is the long-term Nimbostratus-seeding mechanic: the network's customization analogue, driven by destruction of Living-customized Abnormies. Thunder seeds Altocumulus: the network's burn-history layer.

- Altocumulus accumulates from Thunder, fed by Active+Dead supply (~1,822 candidates at launch).
- Nimbostratus accumulates from Lightning, fed by Active+Living+Customized supply.

Over time, even Abnormies whose seed Normies were never customized will accumulate network-Nimbostratus from Lightning. Nimbostratus's meaning shifts from "what your seed authored" to "what the network has authored through sacrifice." Both readings are valid simultaneously, and indistinguishable at the level of pixels.

## Agent-ownership inversion (Adapter8004)

When the Abnormie's owner is also the effective owner of the seed Normie's Adapter8004-bound agent, the canvas inverts at render time.

When the same wallet holds both the Abnormie and its seed Normie AND the seed Normie has been awakened via Adapter8004, the Abnormie is **Aligned**. An Aligned Abnormie renders inverted.

### Why Adapter8004 simplifies the check

Vanilla ERC-8004 mints a separate agent NFT, allowing the Normie and the agent to be owned by different addresses. Adapter8004 (ERC-8217, Premm) takes permanent custody of the agent NFT and binds it via on-chain metadata to the Normie. Selling the Normie atomically transfers control of the agent. **Owning the Normie is owning the agent.**

The inversion check reduces to two view-function reads against Abnormies state:

1. Has the seed Normie been awakened? Read `seedAwakened[normieId]`, set on-chain via `pokeAwakening`, which verifies a user-supplied agentId via `Adapter8004.bindingOf`.
2. Is `Abnormies.ownerOf(abnormieId) == Normies.ownerOf(normieId)`?

Both true: the Abnormie is Aligned. No separate agent-wallet detection needed.

### Phase 1 vs Phase 2 alignment

In Phase 1 of Normies Awakening (registry only, current), the agent's effective control is the Normie holder's wallet. In Phase 2 (agent wallets, planned), the agent gets its own wallet but Adapter8004's binding guarantees atomic transfer of authority. The same-owner check is canonical in Phase 1 and remains correct in Phase 2.

### Inversion rule

For every pixel position on the rendered canvas:

- Sky ↔ Nimbostratus (Sky renders as Nimbostratus; Nimbostratus renders as Sky)
- Cirrus ↔ Altocumulus (Cirrus renders as Altocumulus; Altocumulus renders as Cirrus)

The underlying event history and stored counters are unchanged. Inversion is a render-time transformation, fully reversible. If the owners diverge, the canvas returns to normal.

### Cases distinguished

1. **Different owners** (human owns Abnormie, someone else owns seed Normie): normal render.
2. **Same owner, seed Normie not awakened** (collector holds both but hasn't registered the Normie through Adapter8004): normal render.
3. **Same owner, seed Normie awakened** (the autobiographer holds its own autobiography): Aligned, inverted render.

## Architecture summary

| Mechanic | Update path |
|---|---|
| Phase 1 claim | Merkle proof of snapshot; creates a claim receipt and initializes seed state (including `lastObservedSeedOwner = snapshot owner`) |
| Phase 2 mint | Paid mint at 0.005 ETH per receipt; appended to the unified receipt list |
| Phase 2 airdrop | Owner-only, gas-only; appended to the unified receipt list, identical resolution semantics to paid mints |
| Reveal | Seal then commit then reveal: receipt list seals on supply exhaustion or 14-day fallback; `reveal()` mixes four blockhashes from `sealedAtBlock + 8` through `sealedAtBlock + 11` into a single `revealSeed`; window opens at `sealedAtBlock + 13` and closes at `sealedAtBlock + 240`; `reseal()` resets the window if 240 blocks pass without reveal |
| Resolution | After reveal, anyone calls `resolveReceipts(count)` to pair receipts to Abnormie IDs via Fisher-Yates from the unclaimed pool, in strictly monotonic receipt-index order |
| Cirrus (seed transfers) | `pokeSeed` observes `Normies.ownerOf` change; increments counter (saturating at `uint16.max`) |
| Source Nimbostratus (seed customization) | `pokeSeed` observes `NormiesCanvasStorage.isTransformed` returning true; sets one-time flag |
| Lightning, Thunder, freeze | State updated inline in the action transaction; both the burner's seed and the freeze target's seed are inline-poked at action time |
| Auto-pokes | `Abnormies._beforeTokenTransfer` calls `pokeSeed` for the transferred Abnormie's seed |
| Agent inversion | `pokeAwakening(normieId, agentId)` verifies via `bindingOf` and records `seedAwakened`; renderer reads stored flag plus ownership |
| Living/Dead state | Cached by poke when observed for Active Abnormies; renderer may also call `ownerOf` for freshness. For Static Abnormies, read from the freeze-time snapshot stored on the Abnormie. |
| Static render inputs | All seed-derived inputs (cirrusCount, seedCustomized, seedBurned, Dead At block) snapshotted at freeze; subsequent pokes against the seed do not affect Static Abnormies' renders or metadata |
| Treasury | Phase 2 mint revenue accumulates in the contract until anyone calls permissionless `withdraw()` to push the balance to the immutable treasury address |

The renderer is a pure function of contract state. No external event reads, no oracles, no off-chain dependencies for the canonical visual.

## Royalty and treasury

**ERC-721C** (LimitBreak Creator Token Standards), matching Normies' own pattern. Default 2.5% royalty, enforced at the contract level; non-compliant marketplaces are blocked from facilitating transfers.

**Treasury** for Phase 2 mint revenue is an immutable address set in the constructor. A permissionless `withdraw()` function pushes the contract's ETH balance to the treasury. No admin discretion, no upgrade path. The treasury address and the royalty receiver are independent constructor parameters and may be the same or different.

## Rendering

- **Fully on-chain SVG renderer**, computed at view-call time as a pure function of stored state.
- Renderer topology: separable contract, immutable. The token contract holds the renderer address as `immutable`, set in the constructor with no setter.
- Token URI format: data URI with embedded SVG, matching Normies' format for marketplace compatibility.
- For Active Abnormies, the renderer reads live seed-derived inputs (cirrusCount, seedCustomized, seedBurned, Dead At block). For Static Abnormies, it reads the per-Abnormie freeze-time snapshots of those same inputs.

### Website (abnormies.art)

- **Refresh button** on every Abnormie detail view that calls `pokeSeed` for the seed Normie, paired with a staleness indicator showing when the Normies API reports newer activity than the contract has observed. **Refresh all** button on portfolio views that calls `pokeMany` for the viewer's holdings. User-facing label is "Refresh" or "Update"; the contract function name is not exposed.
- **Awaken button** that surfaces when the contract has not yet recorded `seedAwakened` for the Abnormie's seed AND the Normies API reports an Adapter8004 binding exists. Resolves the agentId off-chain via the API and calls `pokeAwakening(normieId, agentId)`. Users never enter or see an agentId.
- Wallet connect.
- Static and animated views of any Abnormie.
- Animation playback reads Normies API `/history/normie/{id}/versions` for fine-grained customization history (display only, not authoritative). The on-chain canonical static state remains the only authoritative visual.
- Filter holdings by state combination.
- Thunder and Lightning interfaces, with non-self freeze rule enforced in the UI.
- Force-refresh metadata link (calls marketplace cache invalidation APIs after pokes that change state).

The canonical visual state lives in the contract. The website is a richer presentation layer; the contract is authoritative.

### Hosting and decentralization

Frontend deployed on Cloudflare Pages. Mirrored to IPFS, pointed at via ENS (`abnormies.eth`) as a parallel route. Open-sourced under MIT or CC0 so anyone can fork and host an alternative frontend. The artifact survives any single deployment.

## Traits

**State (two axes):**
- **Mutability:** Active | Static
- **Source Life:** Living | Dead (locked at freeze time for Static Abnormies)

**Source-derived (from stored state):**
- **Source Customized:** boolean (the seed Normie has been observed customized at least once; locked at freeze time for Static Abnormies)
- **Source Awakened:** boolean (the seed Normie has been registered via Adapter8004)

**Recorded (counters):**
- **Cirrus Events:** count of observed owner changes on the seed Normie (saturating at `uint16.max`; locked at freeze time for Static Abnormies)
- **Lightning Events Received:** count of Lightning cascade contributions
- **Thunder Events Received:** count of Thunder cascade contributions
- **Static At:** block number at which the Abnormie was frozen (null if Active)
- **Dead At:** block number at which the seed Normie's burn was observed. Null for Active Abnormies whose seed is currently Living. For Static Abnormies, the value is locked at freeze time; null forever if the seed was Living at freeze.

**Visible:**
- **Visible Cirrus / Altocumulus / Nimbostratus:** counts of currently-rendered pixels (post-cancellation)
- **Total Coverage:** percentage of canvas that is non-Sky

**Action attribution:**
- **Frozen By:** address of the burner who triggered the Thunder or Lightning that froze this Abnormie (null if Active)
- **Freeze Action:** Thunder | Lightning | null
- **Frozen After Death:** boolean, true if the Abnormie was already Dead at the moment of freezing

**Unique:**
- **First Static:** boolean, true only for the very first Abnormie ever frozen in collection history
- **Inverted:** boolean, true when the agent-ownership inversion is currently active (resolves at render time, can change as ownership changes)

## Locked parameters

- Source contract: `0x9eb6e2025b64f340691e424b7fe7022ffde12438`
- Source standard: ERC-721C (LimitBreak Creator Token Standards)
- NormiesCanvasStorage: `0xC255BE0983776BAB027a156681b6925cde47B2D1`
- Agent adapter: Adapter8004 (Premm, ERC-8217), proxy `0xde152AfB7db5373F34876E1499fbD893A82dD336`
- Adapter8004 binding lookup: `bindingOf(agentId)`; caller-supplied agentId
- Sky: `#e3e5e4`
- Nimbostratus: `#48494b`
- Cirrus per observed owner change: 2 pixels
- Source Nimbostratus per customized seed: 12 pixels, applied once
- Lightning cascade: 1 Nimbostratus pixel per Active Abnormie
- Thunder cascade range: 5 to 10 Altocumulus pixels per Active Abnormie
- Cancellation rule (any-color collision cancels to Sky)
- Freeze-before-cascade ordering
- Non-self freeze rule (freeze target must not be owned by the burner; enforced at contract level)
- Static state: all seed-derived render inputs snapshotted at freeze time; terminal
- Agent-ownership inversion (Sky↔Nimbostratus, Cirrus↔Altocumulus)
- Thunder and Lightning are the only destructive holder actions
- ERC-721C royalty enforcement, 2.5% default
- Treasury: immutable address set at deploy, permissionless `withdraw()` to that address
- Renderer topology: separable and immutable
- Phase 1 duration: 2 days, permissionless close
- Phase 2 mint price: 0.005 ETH per Abnormie
- Owner airdrop available during Phase 2: gas-only, capped at 50 receipts per call, any quantity total up to remaining supply
- Reveal mechanism: seal-then-commit-then-reveal, no oracle dependency. Seal triggered by supply exhaustion or by permissionless `sealForReveal()` 14 days after Phase 1 close. `reveal()` callable from `sealedAtBlock + 13` through `sealedAtBlock + 240`; mixes four blockhashes (`sealedAtBlock + 8` through `sealedAtBlock + 11`) into the seed. `reseal()` callable after the 240-block window expires unrevealed.
- Resolution: monotonic, permissionless, via `resolveReceipts(count)` over the unified Phase 1 plus Phase 2 receipt list.

## Out of scope

- Royalty mechanisms beyond ERC-721C with the LimitBreak validator.
- Any cryptocurrency, points, or reward mechanic.
- Off-chain artwork or rendering of any kind for canonical state.
- Cross-chain.
- On-chain animation. Abnormies are still images that change between blocks. The website's animated view replays history client-side; it is not on-chain animation.
- Third-party deployment platforms.
- Any visual reproduction of Normies pixel patterns.
- Burning Active+Living+Uncustomized Abnormies (no destructive action available for them).
- Off-chain indexers for canonical state.
- Self-freezing (structurally impossible by design).
- Reading another contract's past event logs from view functions (not possible on the EVM).
- Admin-controlled withdrawal of Phase 2 revenue (the treasury address is immutable and the withdraw function is permissionless).
- Cancellation Rate trait (canvas conveys cancellation visually; counting total touches on-chain is expensive and the visible plateau already encodes the information).
- Oracle-based randomness for the reveal (Chainlink VRF and similar). The seal-then-commit-then-reveal flow uses EVM blockhashes only; no external service dependency.

## Naming and surface

- Collection name: **Abnormies**
- Token name: **Abnormie #N**
- Layer names: **Sky · Cirrus · Altocumulus · Nimbostratus**
- Action names: **Thunder · Lightning**
- State axes: **Active / Static · Living / Dead**
- Website: **abnormies.art**

## Changelog

- **v0.16**: Added Phase 3 (reveal) documentation.
- **v0.15**: Named the inversion condition Aligned. Mechanism otherwise unchanged from v0.14.
- **v0.14**: Reveal architecture replaced. Chainlink VRF v2.5 (rolling batches in Phase 2 and single call in Phase 1) is removed entirely. New mechanism is a single collection-wide seal-then-commit-then-reveal flow using EVM blockhashes for entropy: receipts seal on Phase 2 supply exhaustion or via permissionless `sealForReveal()` 14 days after Phase 1 close; `reveal()` mixes four blockhashes from `sealedAtBlock + 8` through `sealedAtBlock + 11` into the seed and is callable from `sealedAtBlock + 13` through `sealedAtBlock + 240`; `reseal()` restarts the window if reveal is not called in time. No oracle dependency; no LINK funding required. Owner airdrop added: gas-only mint of unminted Phase 2 receipts to any address, capped at 50 per call. Phase 2 mint price lowered to 0.005 ETH to match Normies. Phase 1 and Phase 2 receipts unified into a single list resolved by `resolveReceipts(count)` in strictly monotonic order. Proposer-bias bound documented honestly: the final entropy block's proposer can withhold for one conditional reroll at the cost of forfeited MEV; multi-block mixing prevents intermediate-block bias but does not fully eliminate proposer influence. For a small-fractional-stakes art project this is an acceptable bound. Mechanism otherwise unchanged from v0.13.
- **v0.13**: Static-state snapshots clarified. The terminal-state rule on Axis 1 (Static Abnormies immune to future events) is now made explicit for all seed-derived render inputs: `cirrusCount`, `seedCustomized`, `seedBurned`, and `Dead At` block are each snapshotted into per-Abnormie storage at the moment of freeze. Source Life and the Dead At trait read from these snapshots for Static Abnormies and from live seed state for Active Abnormies. Cirrus counter behavior added: saturates at `uint16.max` rather than reverting, preserving liveness of pokes and Abnormie transfers in the extreme edge case. Phase 1 and Phase 2 reveal resolution clarified: receipts are resolved in strictly monotonic order to prevent reordering attacks against the public VRF seed. Thunder and Lightning inline-poke both the burner's seed and the freeze target's seed at action time to ensure all checks and snapshots operate on the latest observable seed state. Cancellation Rate trait removed; counting total touches on-chain is expensive and the canvas already conveys cancellation visually. Mechanism otherwise unchanged from v0.12.
- **v0.12**: Awakening flow correction. The `agentIdForBinding` reverse-lookup function documented at `adapter8004.xyz/docs/contract` is not present on the deployed Adapter8004 implementation (verified by mainnet-fork testing). `pokeAwakening` therefore takes a caller-supplied `agentId` and verifies the binding via `bindingOf(agentId)`. The frontend resolves the agentId off-chain via `api.normies.art/agents/binding/{normieId}` and embeds it in the transaction; users never enter or see an agentId. Treasury added: an immutable address set at deploy receives Phase 2 mint revenue via a permissionless `withdraw()` function. Treasury and royalty receiver are independent constructor parameters and may be the same or different. Note added that awakening and customization are independent signals and should not be treated as proxies. Phase 1 `lastObservedSeedOwner` initialization made explicit in the architecture summary. Mechanism otherwise unchanged from v0.11.
- **v0.11**: Customization signal correction. The customization status is not in `INormiesStorage.getTokenTraits` as previously documented; `getTokenTraits` returns eight trait IDs (Type, Gender, Age, Hair Style, Facial Feature, Eyes, Expression, Accessory). Customization is tracked on a separate contract, `NormiesCanvasStorage` (`0xC255BE0983776BAB027a156681b6925cde47B2D1`), exposing `isTransformed(tokenId)`. `pokeSeed` now reads `isTransformed`; the source Nimbostratus accrual rule (binary, 12 pixels on first observed true) is unchanged. Adapter8004 binding lookup corrected: `bindingOf` takes an `agentId`, not a normie id. Phase 1 duration set to 2 days (down from 7). Locked parameters expanded to include renderer topology, Phase 1 duration, and Phase 2 reveal mechanism. Mechanism otherwise unchanged.
- **v0.10**: Mechanism corrected. EVM view functions cannot read past event logs from other contracts (Solidity documentation, explicit). State advancement specified via permissionless `pokeSeed`, auto-pokes via `Abnormies._beforeTokenTransfer`, and inline updates from holder actions. Cirrus is "observed owner changes via pokes" rather than exact transfer count. Source Nimbostratus is binary (one 12-pixel batch when customization first observed true), not a per-event count. Phase 1 claim initializes seed state from a merkle snapshot at deploy. Thunder, Lightning, cancellation, plateau dynamics, freeze rules, and agent-ownership inversion unchanged from v0.9. Traits updated: `Source Customizations` (integer) becomes `Source Customized` (boolean). Architecture summary and locked parameters updated to reflect mechanism. Out of scope expanded to note the EVM constraint.
- **v0.9**: Naming pass locked. Cloud terminology throughout. Layers are Sky / Cirrus / Altocumulus / Nimbostratus. Destructive actions are Thunder (burn a Dead Abnormie, Altocumulus cascade, plus freeze) and Lightning (burn a Living-customized Abnormie, Nimbostratus cascade, plus freeze). State model restructured as two independent binary axes: Active/Static (mutability) and Living/Dead (source life). Cascades affect Active Abnormies regardless of Living/Dead, so Dead-Active Abnormies continue receiving Thunder and Lightning marks until explicitly frozen. The Static+Dead combination natively expresses what earlier drafts called Posthumous Seal. Plain-language instructions on all destructive actions; cloud terminology reserved for layer and action names so users always know what an action does. Source-Nimbostratus and Lightning-Nimbostratus share the darkest color (visually indistinguishable; metadata-separable). Conceptually, the collection also ties into Sean Bonner's forthcoming "Static" photographic series.
- **v0.8**: Adapter8004 architecture locked. Simplified inversion check.
- **v0.7**: Locked Normies contract address.
- **v0.6**: Lightning mechanic added. Agent-ownership inversion added.
- **v0.5**: XOR pixel cancellation rule. Mint counts as transfer #1 (later superseded by snapshot-and-poke model).
- **v0.4**: Visual independence from Normies principle.
- **v0.3**: Solo deployment. Four-color palette.
- **v0.2**: Random claim assignment. Phase 2 mint fee 0.01 ETH.
- **v0.1**: Initial spec.
