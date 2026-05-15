---
title: "Abnormies: Production Spec"
status: draft
version: 0.9
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

Wiiides (Sterling Crispin, NotAudited.xyz, 2022) is the direct precedent: a fully on-chain CryptoPunks derivative that reads source data and mutates through transfer activity. Abnormies extends this lineage into a source collection that is itself mutable (Normies customization), adds destructive holder actions (Thunder, Lightning) that produce network-wide effects, and adds an agentic ownership inversion via Adapter8004. Where Wiiides decays toward stripes, Abnormies decay toward ambiguous middle-density.

## Source contracts

**Normies (ERC-721C):** `0x9eb6e2025b64f340691e424b7fe7022ffde12438` on Ethereum mainnet. The wrapper composes two pluggable contracts:

- `INormiesRenderer` produces `tokenURI`. Not used by Abnormies.
- `INormiesStorage` exposes `getTokenRawImageData`, `getTokenTraits`, `isTokenDataSet`, `isRevealed`.

Plus a Canvas contract emitting `setTransformBitmap` events when a Normie is customized. The event history is exposed via the Normies API (`/history/normie/{id}/versions`) and is sourced on-chain from the Canvas contract.

**Adapter8004 (Premm, ERC-8217: Agent NFT Identity Bindings):** the binding adapter that solves the agent-orphan problem inherent to vanilla ERC-8004. Adapter8004 takes permanent custody of the agent NFT and binds it to the Normie via on-chain metadata. Owning the Normie is owning the agent. Transferring the Normie atomically transfers the agent. See `adapter8004.xyz` for the contract and ERC-8217 for the standard.

**Soft dependencies:**

- Normies' renderer and storage contracts are owner-upgradeable (`setRendererContract`, `setStorageContract`).
- Adapter8004 currently has two Normies team wallets registered as a safety layer pending multi-sig governance.

Documented for transparency; mitigations are unnecessary given the parties' reputational stakes.

## Source dependencies: what Abnormies reads

At render time, the Abnormies contract performs the following reads:

1. **`Normies.ownerOf(normieId)`**: for the agent-ownership inversion check and Living/Dead detection.
2. **`setTransformBitmap` event count for the seed Normie**: used to derive the source Nimbostratus marks. See Mutation below. Falls back to the `Customized` flag from `getTokenTraits` if event scanning proves gas-prohibitive (see Source-Mark Fallback below).
3. **Standard ERC-721 `Transfer` events** on the Normies contract, scoped to the seed Normie, used to count Cirrus events.
4. **`Adapter8004.bindingOf(normieId)`** (or equivalent): to determine whether the seed Normie has been awakened.

Plus, from Abnormies' own state:

5. **Thunder event log**: emitted by Abnormies contract.
6. **Lightning event log**: emitted by Abnormies contract.
7. **Static records**: per-Abnormie, set when Thunder or Lightning freezes the Abnormie.

The Abnormies contract does **not** read the current pixel bitmap (`getTokenRawImageData`) of any Normie.

## Deployment

Solo. Custom contract deployed by the project. Mint page on abnormies.art. No third-party launchpad or platform dependency.

## Supply and claim

- Total supply: 10,000, paired 1:1 with Normies token IDs.
- All 10,000 slots exist as latent claimable positions at deploy.

### Random assignment

Claims are 1:1 by quantity, not by token ID. A Normies holder with N Normies can claim N Abnormies, but the specific Abnormie token IDs they receive are randomly assigned at claim time from the unclaimed pool. Dead-source slots are included in the random pool from the start.

### Claim phases

- **Phase 1 (Holder Claim).** Duration: 7 days from contract deploy. Normies holders claim 1:1 with Normies held. Cost: gas only. Token IDs assigned randomly.
- **Phase 2 (Open Mint).** Any address may mint remaining unclaimed slots at **0.01 ETH** per Abnormie. Token IDs assigned randomly.

## Visual specification

### Layers

40×40 monochrome grid, identical dimensions to Normies. Four-color cloud palette:

| Color | Hex | RGB | Name | Source |
|---|---|---|---|---|
| Lightest | `#e3e5e4` | 227, 229, 228 | **Sky** | Untouched, or touched an even number of times (cancelled). |
| Light | `#b0b1b0` | 176, 177, 176 | **Cirrus** | Mark left by a transfer of the seed Normie. |
| Mid | `#7c7d7e` | 124, 125, 126 | **Altocumulus** | Mark left by a Thunder cascade. |
| Dark | `#48494b` | 72, 73, 75 | **Nimbostratus** | Mark left by a source customization, or by a Lightning cascade. Indistinguishable visually; distinguishable in metadata. |

Lightness progression: Sky > Cirrus > Altocumulus > Nimbostratus.

Sky and Nimbostratus match Normies' factory values exactly.

Source-customization Nimbostratus and Lightning-cascade Nimbostratus share the darkest color by design. Their counts are exposed separately in metadata (traits) for sorting and rarity, but no pixel on the rendered canvas reveals which event produced it. The ambiguity is the point: by the time the canvas is dense enough to read closely, the distinction between "what the source authored" and "what the network sacrificed onto it" no longer matters at the level of looking.

## Mutation: layers with cancellation

Five event classes contribute to the canvas. Four produce visually distinct colors (Cirrus, Altocumulus, source Nimbostratus, Lightning Nimbostratus). Source Nimbostratus and Lightning Nimbostratus collapse into a single visible color but are tracked separately as events.

All events use the same touch-accumulation logic. Each event produces N random pixel positions on the Abnormie, seeded deterministically.

### Cancellation rule

Events are processed in chronological order at render time. For each pixel position assigned by an event:

1. If the position is currently Sky, it takes the event's color.
2. If the position is currently any non-Sky color, the new mark and the existing mark cancel: the position reverts to Sky, available for future events.

Every visible non-Sky pixel on an Abnormie has been touched an odd number of times. Coverage plateaus at approximately 50%. The endpoint of an active history is ambiguous middle-density, neither pristine nor saturated.

There is no layer hierarchy. Any color can cancel any other.

### Event sources

#### Cirrus: source Normie transfers

- **Trigger:** any `Transfer` event on Normies contract for the seed Normie. Mint counts as transfer #1.
- **N per event:** 2 pixels.
- **Positions:** deterministic, seeded by `keccak256(normieId, transferIndex, "cirrus")`.

#### Nimbostratus (source): Normies customization events

- **Trigger:** each `setTransformBitmap` event on the Normies Canvas contract for the seed Normie.
- **N per event:** 3 pixels (default; tunable parameter, finalized after visual testing).
- **Positions:** deterministic, seeded by `keccak256(normieId, customizationEventIndex, "nimbostratus-source")`.

##### Source-Mark Fallback

If event scanning proves gas-prohibitive at deploy time, the source Nimbostratus layer falls back to a binary signal derived from the `Customized` field in `getTokenTraits`:

- Customized = false → 0 source Nimbostratus events.
- Customized = true → 1 source Nimbostratus event with a larger pixel batch (default 12 pixels), seeded by `keccak256(normieId, "nimbostratus-source-fallback")`.

The fallback collapses customization fidelity to "ever or never" but preserves the binary uncustomized/customized distinction and remains fully on-chain.

#### Nimbostratus (Lightning): Lightning cascade

- **Trigger:** a Lightning action recorded in Abnormies contract.
- **N per event:** 1 Nimbostratus pixel per Active Abnormie (across the collection).
- **Positions:** deterministic, seeded by `keccak256(lightningBlockhash, targetTokenId)`.

#### Altocumulus: Thunder cascade

- **Trigger:** a Thunder action recorded in Abnormies contract.
- **N per event:** random integer in range [5, 10] per Active Abnormie (across the collection).
- **Positions:** deterministic, seeded by `keccak256(thunderBlockhash, targetTokenId)`.

### Event processing order at render time

1. All Cirrus events for the seed Normie, in chronological transfer index.
2. All source Nimbostratus events (`setTransformBitmap`), in chronological order.
3. All Lightning events received, in chronological order from Abnormies contract.
4. All Thunder events received, in chronological order from Abnormies contract.

Deterministic and reproducible. Anyone can replay the same sequence and produce the same canvas.

## State system

Two independent binary axes describe each Abnormie:

### Axis 1: mutability

- **Active**: the Abnormie may still receive new marks from any event type that targets it.
- **Static**: the Abnormie is frozen. State at the moment of becoming Static is permanent. Immune to all future events. Terminal.

An Abnormie becomes Static when chosen as the freeze target of a Thunder or Lightning action. The freeze applies before the cascade fires, so the newly Static Abnormie receives no contribution from the action that froze it.

### Axis 2: source life

- **Living**: the seed Normie is alive and may continue to author marks (transfers and customizations).
- **Dead**: the seed Normie has been burned. No further Cirrus or source Nimbostratus events can ever accrue. The Abnormie may still receive Thunder and Lightning cascades while Active.

An Abnormie transitions from Living to Dead when its seed Normie is burned. This is a one-way transition.

### Combinations

| Active | Living | Description | Receives | Burnable |
|---|---|---|---|---|
| Active | Living | uncustomized | Mutates with all five event types | Thunder, Lightning cascades; Cirrus from transfers (source Nimbostratus only when source is customized) | Not burnable while uncustomized |
| Active | Living | customized | Mutates with all five event types | All five | **Lightning** (the action) |
| Active | Dead | n/a | Mutates with network events only | Thunder, Lightning cascades. No new Cirrus or source Nimbostratus. | **Thunder** (the action) |
| Static | Living | n/a | Frozen. No further marks of any kind. | None | Not burnable |
| Static | Dead | n/a | Frozen. The doubly-preserved rare category. Frozen during life or frozen after death. | None | Not burnable |

(The "Static + Dead" category absorbs what earlier drafts called Posthumous Seal: an Abnormie that was already Dead when chosen as a freeze target. Detectable via the `Frozen After Death` trait below.)

## Destructive holder actions

Two burn paths. Each burns the burner's Abnormie, casts a cascade across the network, and freezes one Active Abnormie of the burner's choice.

### Thunder: burn a Dead Abnormie

**Plain instructions:** Burning a Dead Abnormie freezes one Active Abnormie of your choice (it becomes Static, permanently locked in its current state) and creates a Thunder cascade: 5 to 10 Altocumulus pixels land on every other Active Abnormie in the collection. The frozen Abnormie cannot be one you own.

- **Burns:** one Active+Dead Abnormie.
- **Freezes:** one Active Abnormie of the burner's choice. Frozen *before* cascade fires. **Must not be owned by burner.**
- **Cascade:** 5–10 Altocumulus pixels per Active Abnormie (excluding the freeze target and the burned Abnormie).

### Lightning: burn a Living, customized Abnormie

**Plain instructions:** Burning a Living Abnormie whose seed Normie has been customized at least once freezes one Active Abnormie of your choice (it becomes Static) and creates a Lightning cascade: one Nimbostratus pixel lands on every other Active Abnormie in the collection. The frozen Abnormie cannot be one you own.

- **Burns:** one Active+Living+Customized Abnormie.
- **Freezes:** one Active Abnormie of the burner's choice. Frozen *before* cascade fires. **Must not be owned by burner.**
- **Cascade:** 1 Nimbostratus pixel per Active Abnormie (excluding the freeze target and the burned Abnormie).

### The non-self freeze rule

**The freeze target must not be owned by the burner.** A burner can freeze any Active Abnormie owned by anyone else: strangers, friends, opponents. Self-preservation requires either (1) coordination with another holder who freezes on your behalf, or (2) moving the Abnormie to a side wallet before triggering the burn.

Rationale: preservation is a relational act in this system. The cascades that motivate freezing are involuntary network effects; the freeze that absorbs the burner's "save one" choice is therefore also relational by construction. Direct self-preservation is structurally impossible. Coordination and wallet-shuffle are explicit escape valves and considered legitimate. The rule is enforced at the contract level; any attempt to freeze a self-owned Abnormie reverts.

### Why two action types

Lightning is the long-term Nimbostratus-seeding mechanic: the network's customization analogue, driven by destruction of Living-customized Abnormies. Thunder seeds Altocumulus: the network's burn-history layer.

- Altocumulus accumulates from Thunder, fed by Active+Dead supply (~1,822 candidates at launch).
- Nimbostratus accumulates from Lightning, fed by Active+Living+Customized supply (~300 candidates at launch, growing with Normies customization).

Lightning is rarer and more costly because customized Living Abnormies are scarcer. Over time, even Abnormies whose seed Normies were never customized will accumulate network-Nimbostratus from Lightning. Nimbostratus's meaning shifts from "what your source authored" to "what the network has authored through sacrifice." Both readings are valid simultaneously, and indistinguishable at the level of pixels.

## Agent-ownership inversion (Adapter8004)

When the Abnormie's owner is also the effective owner of the seed Normie's Adapter8004-bound agent, the canvas inverts at render time.

### Why Adapter8004 simplifies the check

Vanilla ERC-8004 mints a separate agent NFT, allowing the Normie and the agent to be owned by different addresses. Adapter8004 (ERC-8217, Premm) takes permanent custody of the agent NFT and binds it via on-chain metadata to the Normie. Selling the Normie atomically transfers control of the agent. **Owning the Normie is owning the agent.**

The inversion check reduces to two reads:

1. Has the seed Normie been awakened? (Query `Adapter8004.bindingOf(normieId)`.)
2. Is `Abnormies.ownerOf(abnormieId) == Normies.ownerOf(normieId)`?

Both true → inversion. No separate agent-wallet detection needed.

### Phase 1 vs Phase 2 alignment

In Phase 1 of Normies Awakening (registry only, current), the agent's effective control is the Normie holder's wallet. In Phase 2 (agent wallets, planned), the agent gets its own wallet but Adapter8004's binding guarantees atomic transfer of authority. The same-owner check is canonical in Phase 1 and remains correct in Phase 2.

### Inversion rule

For every pixel position on the rendered canvas:

- Sky ↔ Nimbostratus (Sky renders as Nimbostratus; Nimbostratus renders as Sky)
- Cirrus ↔ Altocumulus (Cirrus renders as Altocumulus; Altocumulus renders as Cirrus)

The underlying event history is unchanged. Inversion is a render-time transformation, fully reversible. If the owners diverge, the canvas returns to normal.

### Cases distinguished

1. **Different owners** (human owns Abnormie, someone else owns seed Normie): normal render.
2. **Same owner, Normie not awakened** (collector holds both but hasn't registered the Normie through Adapter8004): normal render.
3. **Same owner, Normie awakened** (the autobiographer holds its own autobiography): inverted render.

## Architecture summary

| Mechanic | Storage cost | Compute location |
|---|---|---|
| Claim | 1 write per claim | n/a |
| Source Nimbostratus | 0 writes | Render-time event scan of `setTransformBitmap` |
| Lightning Nimbostratus | 1 write per Lightning event | Render-time replay |
| Cirrus | 0 writes | Render-time read of Normies `Transfer` events |
| Altocumulus | 1 write per Thunder event | Render-time replay |
| Freeze (Static) | Implicit in Thunder or Lightning event | Render-time check |
| Agent inversion | 0 writes | Render-time read of Adapter8004 binding + ownership |
| Living/Dead state | 0 writes | Check Normies burn state via `ownerOf` |

No per-token writes for any mutation. The contract holds: ownership table, claim assignment, Thunder event log, Lightning event log, claim phase state, royalty config.

## Royalty enforcement

**ERC-721C** (LimitBreak Creator Token Standards), matching Normies' own pattern. Default 2.5% royalty, enforced at the contract level; non-compliant marketplaces are blocked from facilitating transfers.

## Rendering

- **Fully on-chain SVG renderer**, computed at view-call time. No external image dependencies.
- Token URI format: data URI with embedded SVG, matching Normies' format for marketplace compatibility.

### Website (abnormies.art)

- Wallet connect.
- Static and animated views of any Abnormie.
- Animation playback reads Normies API `/history/normie/{id}/versions` for fine-grained customization history. On-chain `setTransformBitmap` count is used for the canonical static state.
- Filter holdings by state combination.
- Thunder and Lightning interfaces, with non-self freeze rule enforced in the UI.
- Force-refresh metadata link.

The canonical visual state lives in the contract. The website is a richer presentation layer; the contract is authoritative.

### Hosting and decentralization

Frontend deployed on Cloudflare Pages (no server-side compute needed). Mirrored to IPFS, pointed at via ENS (`abnormies.eth`) as a parallel route. Open-sourced under MIT or CC0 so anyone can fork and host an alternative frontend. The artifact survives any single deployment.

## Traits

**State (two axes):**
- **Mutability:** Active | Static
- **Source Life:** Living | Dead

**Source-derived:**
- **Source Customizations:** integer (count of `setTransformBitmap` events on seed Normie)
- **Customized:** boolean (Source Customizations ≥ 1)
- **Source Awakened:** boolean (seed Normie has been registered via Adapter8004)

**Recorded:**
- **Cirrus Events:** count of source Transfer events
- **Lightning Events Received:** count of Lightning cascade contributions
- **Thunder Events Received:** count of Thunder cascade contributions
- **Static At:** block number at which the Abnormie was frozen (null if Active)
- **Dead At:** block number at which the source was burned (null if Living)

**Visible:**
- **Visible Cirrus / Altocumulus / Nimbostratus:** counts of currently-rendered pixels (post-cancellation)
- **Total Coverage:** percentage of canvas that is non-Sky
- **Cancellation Rate:** ratio of cancelled touches to total touches

**Action attribution (low-key documented):**
- **Frozen By:** address of the burner who triggered the Thunder or Lightning that froze this Abnormie (null if Active)
- **Freeze Action:** Thunder | Lightning | null
- **Frozen After Death:** boolean, true if the Abnormie was already Dead at the moment of freezing (the doubly-preserved category, rare, occurring only when a burner chooses to freeze an already-Dead target)

**Unique:**
- **First Static:** boolean, true only for the very first Abnormie ever frozen in collection history
- **Inverted:** boolean, true when the agent-ownership inversion is currently active (resolves at render time, can change as ownership changes)


## Locked parameters

- Source contract: `0x9eb6e2025b64f340691e424b7fe7022ffde12438`
- Source standard: ERC-721C (LimitBreak Creator Token Standards)
- Agent adapter: Adapter8004 (Premm, ERC-8217)
- Sky: `#e3e5e4`
- Nimbostratus: `#48494b`
- Cirrus per transfer event: 2 pixels
- Thunder cascade range: 5–10 Altocumulus pixels
- Lightning cascade: 1 Nimbostratus pixel per Active Abnormie
- Source Nimbostratus default per customization event: 3 pixels (tunable in prototype)
- Mint counts as transfer #1
- Cancellation rule (any-color collision cancels to Sky)
- Freeze-before-cascade ordering
- **Non-self freeze rule** (freeze target must not be owned by the burner; enforced at contract level)
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
- Off-chain indexers for canonical state (only used for website animation enhancement).
- Self-freezing (structurally impossible by design).

## Naming and surface

- Collection name: **Abnormies**
- Token name: **Abnormie #N**
- Layer names: **Sky · Cirrus · Altocumulus · Nimbostratus**
- Action names: **Thunder · Lightning**
- State axes: **Active / Static · Living / Dead**
- Website: **abnormies.art**


## Changelog

- **v0.9**: Naming pass locked. Cloud terminology throughout. Layers are Sky / Cirrus / Altocumulus / Nimbostratus. Destructive actions are Thunder (burn a Dead Abnormie, Altocumulus cascade, plus freeze) and Lightning (burn a Living-customized Abnormie, Nimbostratus cascade, plus freeze). State model restructured as two independent binary axes: Active/Static (mutability) and Living/Dead (source life). Cascades now affect Active Abnormies regardless of Living/Dead, so Dead-Active Abnormies continue receiving Thunder and Lightning marks until explicitly frozen. The Static+Dead combination natively expresses what earlier drafts called Posthumous Seal. Plain-language instructions on all destructive actions; cloud terminology reserved for layer and action names so users always know what an action does. Source-Nimbostratus and Lightning-Nimbostratus share the darkest color (visually indistinguishable; metadata-separable). Conceptually, the collection also ties into Sean Bonner's forthcoming "Static" photographic series.
- **v0.8**: Adapter8004 architecture locked. Simplified inversion check. Ink source via `setTransformBitmap` event count with binary fallback. Non-self Sealing rule locked.
- **v0.7**: Locked Normies contract address. Initial Level-as-Ink-proxy (later corrected to event-count).
- **v0.6**: Bleed mechanic added. Agent-ownership inversion added.
- **v0.5**: XOR pixel cancellation rule. Mint counts as transfer #1.
- **v0.4**: Visual independence from Normies principle.
- **v0.3**: Solo deployment. Four-color palette.
- **v0.2**: Random claim assignment. Phase 2 mint fee 0.01 ETH.
- **v0.1**: Initial spec.
