# abnormies.art

Public site for **Abnormies**, a fully on-chain art collection derived from Normies (Serc, 2026).

Live: https://abnormies.art

Each Abnormie is paired 1:1 with a Normie. Marks accumulate on a 40×40 grid from
transfers, customizations, and the destructive actions of other holders, and
cancel on collision. The collection is fully minted, revealed, and resolved
on-chain; the artwork keeps evolving as the seed Normies change hands.

## What's in here

This is the whole front end, not a static page. `app/` is an esbuild project with
viem wallet integration, a holdings grid, and an animated token detail page with
GIF export.

- `app/newsite/pages/` + `partials/` — page templates and the shared header and
  footer the build stitches in
- `app/public/` — client scripts, styles, contract ABIs, and pre-generated merkle
  proofs
- `app/scripts/build.mjs` — renders the pages, bundles the scripts, and copies an
  explicit allowlist of repo-root files
- `spec.md` — the specification, and the source of truth for anything factual
  about the project
- `spec.html` — the same specification, browser-rendered
- `_headers`, `_redirects`, `llms.txt`, `robots.txt`, `og.png`, favicons — served
  from the publish root

## Build

The publish root is `app/dist`. Nothing is served from the repo root directly.

```
cd app
npm install
npm run build     # writes dist/
npm run dev       # build, then serve dist/ on :8000
```

Build configuration comes from the environment (`FRONTEND_CHAIN_ID`,
`FRONTEND_CONTRACT_ADDRESS`, `FRONTEND_RPC_URL`, and friends). In production
those are Cloudflare Pages environment variables.

Merkle proofs are committed under `app/public/proofs/` rather than regenerated at
deploy time; `npm run build-proofs` rebuilds them from `app/snapshot/`.

There are no runtime CDN dependencies by design. viem is bundled and gif.js is
vendored with its worker served same-origin.

## Deploys

Cloudflare Pages builds from this repository and deploys on every push to `main`.

## Contracts

The smart contracts live in a separate repository.

## License

CC0.
