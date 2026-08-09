# Abnormies site — abnormies.art

Working tree for the public Abnormies website. Deploys to **abnormies.art** via
Cloudflare Pages from **https://github.com/seanbonner/abnormies**, auto-deploying
on every push to `main`.

This is **not** the static teaser it started as. `app/` is a real build: esbuild
bundles, viem wallet integration, a holdings grid, an animated detail page with
GIF export, and pre-generated merkle proofs. Do not describe it as a pure static
site and do not "restore" it to one.

## Current state — read before writing any copy

Verified on-chain 2026-08-09: the collection is **sold out, sealed, revealed, and
fully resolved**. `phase = 2`, `phase2RemainingSlots = 0`, `nextResolveIndex =
10000`. There is no mint page and no mint bundle; `build.mjs` says so explicitly.

`llms.txt` was updated to match (2026-08-09). It ships verbatim from the repo
root, so it is the one public surface where the phase is hardcoded — update it
whenever contract state changes.

**Do not "fix" these — they are already correct.** `og.png` carries only the
wordmark and an evergreen tagline; there is no mint copy in it and no reason to
re-run `build-og.py`. The rendered pages carry no `og:description` or
`twitter:description` at all (`renderDoc` in `build.mjs` omits them deliberately,
for exactly this reason). The root `index.html` still has stale "Phase II mint
open" meta tags, but it is **not deployed** — `build.mjs` renders its own
`index.html` and the root copy is excluded from `staticRootFiles`. It is a dead
teaser file.

`README.md` is stale — it lists only the four teaser files and claims the
minting UI lives in a separate repo. It is public-facing on GitHub.

## Build

The publish root is **`app/dist`**, produced by `app/scripts/build.mjs`. Nothing
is served from the repo root directly.

```
cd app && npm run build      # dev: npm run dev serves dist/ on :8000
```

Build config comes from **`process.env`** — the Cloudflare Pages environment
variables, not `app/.env`. That local file is for local builds only; setting a
value there does not change production.

```
FRONTEND_CHAIN_ID  FRONTEND_CONTRACT_ADDRESS  FRONTEND_RPC_URL
FRONTEND_ETHERSCAN_BASE_URL  FRONTEND_NORMIES_ADDRESS  FRONTEND_RENDERER_ADDRESS
```

Merkle proofs are **pre-generated and committed** at `app/public/proofs/`, built
by `npm run build-proofs` from `app/snapshot/`. They are not regenerated at
deploy time.

Runtime has **no CDN dependencies** by design — viem is bundled, gif.js is
vendored and its worker copied same-origin. Keep it that way.

## Layout

- `app/newsite/pages/` + `partials/` — page templates and the shared
  header/footer the build stitches in. Source of truth for page content.
- `app/public/` — wallet scripts (`clouds.js` → `/home`, `abnormie.js` →
  `/abnormie`), styles, ABIs, proofs.
- `app/scripts/build.mjs` — renders pages, bundles scripts, slims the Foundry
  artifact to a bare ABI, copies an **explicit allowlist** of repo-root files.
  Anything not on that list (README, CLAUDE.md, `app/` source, node_modules) is
  never deployed.
- Repo root: `spec.md` (canonical), `_headers`, `_redirects`, `llms.txt`,
  `og.png`, `robots.txt`, favicons.

`_headers` serves `spec.md` as `text/markdown; charset=utf-8` so it renders in
the browser instead of downloading. `_redirects` 301s the old `/app/*` URLs and
`/newsitedemo/*` to the promoted clean routes.

The `post-reveal` branch is **fully merged into `main`** and carries nothing
`main` lacks. It can be deleted.

## Working rules

- Push directly to `main`. No branches, no PRs, no force-push without explicit
  instruction, no remotes other than `origin`.
- Don't add analytics, tracking, or third-party scripts.
- Don't add runtime CDN dependencies.
- Commit messages: imperative and brief. `Fix holdings scan`, `Update _headers`.

## Spec authority

`spec.md` is authoritative for any factual question about the project. Conflicts
between this brief and the spec resolve toward the spec. Contract-side detail
lives in `../contracts/CLAUDE.md` and its skills.

General working preferences live in the shared `01-PROJECTS/CLAUDE.md`.
