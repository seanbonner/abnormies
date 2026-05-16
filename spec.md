---
title: "Abnormies: Production Spec"
status: draft
version: 0.10
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
- `INormiesStorage` exposes `getTokenRawImageData`, `getTokenTraits`, `isTokenDataSet`, `isRevealed`. `getTokenTraits` returns 8 bytes including a `Customized` boolean.

Plus a Canvas contract that emits `setTransformBitmap` on each customization. Abnormies does not read these events directly (see State advancement below).

**Adapter8004 (Premm, ERC-8217: Agent NFT Identity Bindings):** the binding adapter that solves the agent-orphan problem inherent to vanilla ERC-8004. Adapter8004 takes permanent custody of the agent NFT and binds it to the Normie via on-chain metadata. Owning the Normie is owning the agent. Transferring the Normie atomically transfers the agent. See `adapter8004.xyz`.

**Soft dependencies:**

- Normies' renderer and storage contracts are owner-upgradeable (`setRendererContract`, `setStorageContract`).
- Adapter8004 currently has two Normies team wallets registered as a safety layer pending multi-sig governance.

Documented for transparency.

## State advancement

The EVM does not permit a contract's view functions to read past event logs from other contracts. The Solidity documentation states this explicitly: log data is not accessible from within contracts. Abnormies therefore stores its own state and advances that state through three mechanisms.

### Permissionless pokes

Anyone may call `pokeSeed(normieId)` on the Abnormies contract. The function performs view-function reads on the Normies contracts and updates Abnormies state:

1. Reads `Normies.ownerOf(normieId)`. If the call reverts or returns the zero address, sets `seedBurned[normieId] = true`. Otherwise, if the returned address differs from the stored `lastObservedSeedOwner[normieId]`, increments `cirrusCount[normieId]` and updates the stored owner.
2. Reads `INormiesStorage.getTokenTraits(normieId)` and decodes the `Customized` boolean. If true and `seedCustomized[normieId]` was previously false, sets the flag to true.

A batched form, `pokeMany(uint256[] normieIds)`, applies the same logic to a list of seed Normies in a single transaction. Used by holders refreshing multiple Abnormies at once and by collection-wide indexers.

Pokes are gas-paid by the caller. Anyone can poke any seed at any time.

### Auto-pokes via Abnormies transfer hook

`Abnormies._beforeTokenTransfer` (or the LimitBreak ERC-721C equivalent) calls `pokeSeed` for the transferred Abnormie's seed as a side effect. Every Abnormie transfer refreshes its seed's state.

### Inline updates from holder actions

Thunder and Lightning actions update Abnormies' own state in the same transaction. Cascade marks, freeze records, and seed-owner observations triggered by these actions require no external proof.

### Phase 1 initialization

A merkle root committed at deploy commits each Normie's snapshot state (owner address, `Customized` flag, burn status). Phase 1 claims include a merkle proof that initializes the relevant seed counters and flags. Post-deploy activity is captured via pokes from that point forward.

### Surfacing the refresh action

State stays current only if pokes happen. Auto-pokes on Abnormie transfer and inline updates from holder actions cover most paths. The remaining path is users manually triggering pokes when their seed Normie has acted but their Abnormie has not been touched.

The abnormies.art website is the canonical surface for this. Requirements:

- A **Refresh** button (or equivalent label such as **Update**, **Sync**) is present on every Abnormie detail view, always visible regardless of suspected freshness.
- Clicking the button opens the user's wallet to send a `pokeSeed(normieId)` transaction for the Abnormie's seed.
- On portfolio views, a single-click **Refresh all** action sends one `pokeMany(uint256[])` transaction batching the user's holdings.
- The website surfaces a **staleness indicator** alongside the button. The indicator compares the contract's last-observed state for the seed (owner, Customized flag) against the Normies API's current state. When they differ, a visual cue is shown: a colored dot, a "Stale" label, or a brief description of what changed. The indicator informs but does not gate; the button works either way.
- No auto-refresh on page load. The user retains the choice to click. Auto-popping a wallet on visit would be invasive.

User-facing language uses "refresh" or "update." The word "poke" is internal vocabulary for the contract function and never appears in the UI.

### What Abnormies reads

| Source | Purpose | Mechanism |
|---|---|---|
| `Normies.ownerOf(normieId)` | Living/Dead detection; Cirrus accrual | Read on each `pokeSeed`; also read directly by renderer for inversion check |
| `INormiesStorage.getTokenTraits(normieId)` | `Customized` boolean for source Nimbostratus | Read on each `pokeSeed` |
| `Adapter8004.bindingOf(normieId)` | Agent-binding presence for inversion check | Read by renderer at view time |
| Abnormies own storage | Counters, flags, freeze records, event logs | Read by renderer at view time |

Abnormies does not read `getTokenRawImageData` for any Normie.

## Deployment

Solo. Custom contract deployed by the project. Mint page on abnormies.art. No third-party launchpad or platform dependency.

## Supply and claim

- Total supply: 10,000, paired 1:1 with Normies token IDs.
- All 10,000 slots exist as latent claimable positions at deploy.

### Random assignment

Claims are 1:1 by quantity, not by token ID. A Normies holder with N Normies can claim N Abnormies, but the specific Abnormie token IDs they receive are randomly assigned at claim time from the unclaimed pool. Dead-source slots are included in the random pool from the start.

### Phase 1: Holder Claim

- Duration: 7 days from contract deploy.
- Eligible: Normies holders at the snapshot block (determined off-chain; the deploy block or an earlier announced cutoff).
- Cost: gas only.
- Mechanism: holders submit a merkle proof committing their per-Normie eligibility and the snapshot state of each Normie (owner, `Customized`, burn status). Verified proofs initialize the claimed Abnormies' seed counters and flags.
- Token IDs: assigned randomly from the unclaimed pool.

### Phase 2: Open Mint

- Any address may mint remaining unclaimed slots at 0.01 ETH per Abnormie.
- Token IDs assigned randomly.

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

Cirrus accrues only on observed owner changes. Transfers that occur between two pokes and end at the same owner that was previously observed are not recorded. The Phase 1 snapshot owner counts as the initial observation.

#### Nimbostratus (source): seed Normie first customization

- **Trigger:** the first time `pokeSeed` observes `Customized = true` from `INormiesStorage.getTokenTraits(normieId)`. Binary; once per seed.
- **N per event:** 12 pixels.
- **Positions:** deterministic, seeded by `keccak256(normieId, "nimbostratus-source")`.

A seed Normie that has never been customized contributes zero source Nimbostratus marks. A seed Normie that has been customized at least once contributes the 12-pixel batch exactly once. The Normies `Customized` flag is one-way; once true, it does not return to false.

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

1. All Cirrus events: `cirrusCount[normieId]` events, indexed 0 through `cirrusCount - 1`.
2. Source Nimbostratus event: one event, conditional on `seedCustomized[normieId] = true`.
3. All Lightning events received, in chronological order from Abnormies storage.
4. All Thunder events received, in chronological order from Abnormies storage.

Deterministic and reproducible. Anyone can replay the same sequence and produce the same canvas.

## State system

Two independent binary axes describe each Abnormie:

### Axis 1: mutability

- **Active**: the Abnormie may still receive new marks from any event type that targets it.
- **Static**: the Abnormie is frozen. State at the moment of becoming Static is permanent. Immune to all future events. Terminal.

An Abnormie becomes Static when chosen as the freeze target of a Thunder or Lightning action. The freeze applies before the cascade fires, so the newly Static Abnormie receives no contribution from the action that froze it.

### Axis 2: source life

- **Living**: the seed Normie is alive and may continue to influence the Abnormie (transfers and customizations are observable via pokes).
- **Dead**: the seed Normie has been burned. No further Cirrus or source Nimbostratus events can accrue. The Abnormie may still receive Thunder and Lightning cascades while Active.

The transition from Living to Dead is recorded on a poke that observes `Normies.ownerOf(normieId)` reverting or returning address(0). One-way.

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

### Lightning: burn a Living, customized Abnormie

**Plain instructions:** Burning a Living Abnormie whose seed Normie has been customized at least once freezes one Active Abnormie of your choice (it becomes Static) and creates a Lightning cascade: one Nimbostratus pixel lands on every other Active Abnormie in the collection. The frozen Abnormie cannot be one you own.

- **Burns:** one Active+Living Abnormie whose seed is customized.
- **Freezes:** one Active Abnormie of the burner's choice. Frozen *before* cascade fires. **Must not be owned by burner.**
- **Cascade:** 1 Nimbostratus pixel per Active Abnormie (excluding the freeze target and the burned Abnormie).

### The non-self freeze rule

**The freeze target must not be owned by the burner.** A burner can freeze any Active Abnormie owned by anyone else. Self-preservation requires either coordination with another holder who freezes on your behalf, or moving the Abnormie to a side wallet before triggering the burn.

Rationale: preservation is a relational act in this system. The cascades that motivate freezing are involuntary network effects; the freeze that absorbs the burner's "save one" choice is therefore also relational by construction. Coordination and wallet-shuffle are explicit escape valves and considered legitimate. The rule is enforced at the contract level; any attempt to freeze a self-owned Abnormie reverts.

### Why two action types

Lightning is the long-term Nimbostratus-seeding mechanic: the network's customization analogue, driven by destruction of Living-customized Abnormies. Thunder seeds Altocumulus: the network's burn-history layer.

- Altocumulus accumulates from Thunder, fed by Active+Dead supply (~1,822 candidates at launch).
- Nimbostratus accumulates from Lightning, fed by Active+Living+Customized supply (~300 candidates at launch, growing with Normies customization).

Over time, even Abnormies whose seed Normies were never customized will accumulate network-Nimbostratus from Lightning. Nimbostratus's meaning shifts from "what your seed authored" to "what the network has authored through sacrifice." Both readings are valid simultaneously, and indistinguishable at the level of pixels.

## Agent-ownership inversion (Adapter8004)

When the Abnormie's owner is also the effective owner of the seed Normie's Adapter8004-bound agent, the canvas inverts at render time.

### Why Adapter8004 simplifies the check

Vanilla ERC-8004 mints a separate agent NFT, allowing the Normie and the agent to be owned by different addresses. Adapter8004 (ERC-8217, Premm) takes permanent custody of the agent NFT and binds it via on-chain metadata to the Normie. Selling the Normie atomically transfers control of the agent. **Owning the Normie is owning the agent.**

The inversion check reduces to two view-function reads:

1. Has the seed Normie been awakened? Query `Adapter8004.bindingOf(normieId)`.
2. Is `Abnormies.ownerOf(abnormieId) == Normies.ownerOf(normieId)`?

Both true: inversion. No separate agent-wallet detection needed.

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
3. **Same owner, seed Normie awakened** (the autobiographer holds its own autobiography): inverted render.

## Architecture summary

| Mechanic | Update path |
|---|---|
| Phase 1 claim | Merkle proof of snapshot; initializes seed state for claimed Abnormies |
| Phase 2 mint | Standard mint with random ID assignment |
| Cirrus (seed transfers) | `pokeSeed` observes `Normies.ownerOf` change; increments counter |
| Source Nimbostratus (seed customization) | `pokeSeed` observes `Customized` flag flip; sets one-time flag |
| Lightning, Thunder, freeze | State updated inline in the action transaction |
| Auto-pokes | `Abnormies._beforeTokenTransfer` calls `pokeSeed` for the transferred Abnormie's seed |
| Agent inversion | Render-time view-function reads of `Adapter8004.bindingOf` and ownership |
| Living/Dead state | Cached by poke when observed; renderer may also call `ownerOf` for freshness |

The renderer is a pure function of contract state. No external event reads, no oracles, no off-chain dependencies for the canonical visual.

## Royalty enforcement

**ERC-721C** (LimitBreak Creator Token Standards), matching Normies' own pattern. Default 2.5% royalty, enforced at the contract level; non-compliant marketplaces are blocked from facilitating transfers.

## Rendering

- **Fully on-chain SVG renderer**, computed at view-call time as a pure function of stored state.
- Token URI format: data URI with embedded SVG, matching Normies' format for marketplace compatibility.

### Website (abnormies.art)

- **Refresh button** on every Abnormie detail view that calls `pokeSeed` for the seed Normie, paired with a staleness indicator showing when the Normies API reports newer activity than the contract has observed. **Refresh all** button on portfolio views that calls `pokeMany` for the viewer's holdings. User-facing label is "Refresh" or "Update"; the contract function name is not exposed.
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
- **Source Life:** Living | Dead

**Source-derived (from stored state):**
- **Source Customized:** boolean (the seed Normie has been observed customized at least once)
- **Source Awakened:** boolean (the seed Normie has been registered via Adapter8004)

**Recorded (counters):**
- **Cirrus Events:** count of observed owner changes on the seed Normie
- **Lightning Events Received:** count of Lightning cascade contributions
- **Thunder Events Received:** count of Thunder cascade contributions
- **Static At:** block number at which the Abnormie was frozen (null if Active)
- **Dead At:** block number at which the seed Normie's burn was observed (null if Living)

**Visible:**
- **Visible Cirrus / Altocumulus / Nimbostratus:** counts of currently-rendered pixels (post-cancellation)
- **Total Coverage:** percentage of canvas that is non-Sky
- **Cancellation Rate:** ratio of cancelled touches to total touches

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
- Agent adapter: Adapter8004 (Premm, ERC-8217)
- Sky: `#e3e5e4`
- Nimbostratus: `#48494b`
- Cirrus per observed owner change: 2 pixels
- Source Nimbostratus per customized seed: 12 pixels, applied once
- Lightning cascade: 1 Nimbostratus pixel per Active Abnormie
- Thunder cascade range: 5 to 10 Altocumulus pixels per Active Abnormie
- Cancellation rule (any-color collision cancels to Sky)
- Freeze-before-cascade ordering
- Non-self freeze rule (freeze target must not be owned by the burner; enforced at contract level)
- Agent-ownership inversion (Sky↔Nimbostratus, Cirrus↔Altocumulus)
- Thunder and Lightning are the only destructive holder actions
- ERC-721C royalty enforcement, 2.5% default

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

## Naming and surface

- Collection name: **Abnormies**
- Token name: **Abnormie #N**
- Layer names: **Sky · Cirrus · Altocumulus · Nimbostratus**
- Action names: **Thunder · Lightning**
- State axes: **Active / Static · Living / Dead**
- Website: **abnormies.art**

## Changelog

- **v0.10**: Mechanism corrected. EVM view functions cannot read past event logs from other contracts (Solidity documentation, explicit). State advancement specified via permissionless `pokeSeed` (reads `Normies.ownerOf` and `INormiesStorage.getTokenTraits`, advances counters and flags), auto-pokes via `Abnormies._beforeTokenTransfer`, and inline updates from holder actions. Cirrus is "observed owner changes via pokes" rather than exact transfer count. Source Nimbostratus is binary (one 12-pixel batch when `Customized` flag first observed true), not a per-event count. Phase 1 claim initializes seed state from a merkle snapshot at deploy. Thunder, Lightning, cancellation, plateau dynamics, freeze rules, and agent-ownership inversion unchanged from v0.9. Traits updated: `Source Customizations` (integer) becomes `Source Customized` (boolean). Architecture summary and locked parameters updated to reflect mechanism. Out of scope expanded to note the EVM constraint.
- **v0.9**: Naming pass locked. Cloud terminology throughout. Layers are Sky / Cirrus / Altocumulus / Nimbostratus. Destructive actions are Thunder (burn a Dead Abnormie, Altocumulus cascade, plus freeze) and Lightning (burn a Living-customized Abnormie, Nimbostratus cascade, plus freeze). State model restructured as two independent binary axes: Active/Static (mutability) and Living/Dead (source life). Cascades affect Active Abnormies regardless of Living/Dead, so Dead-Active Abnormies continue receiving Thunder and Lightning marks until explicitly frozen. The Static+Dead combination natively expresses what earlier drafts called Posthumous Seal. Plain-language instructions on all destructive actions; cloud terminology reserved for layer and action names so users always know what an action does. Source-Nimbostratus and Lightning-Nimbostratus share the darkest color (visually indistinguishable; metadata-separable). Conceptually, the collection also ties into Sean Bonner's forthcoming "Static" photographic series.
- **v0.8**: Adapter8004 architecture locked. Simplified inversion check.
- **v0.7**: Locked Normies contract address.
- **v0.6**: Lightning mechanic added. Agent-ownership inversion added.
- **v0.5**: XOR pixel cancellation rule. Mint counts as transfer #1 (later superseded by snapshot-and-poke model).
- **v0.4**: Visual independence from Normies principle.
- **v0.3**: Solo deployment. Four-color palette.
- **v0.2**: Random claim assignment. Phase 2 mint fee 0.01 ETH.
- **v0.1**: Initial spec.
