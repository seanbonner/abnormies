# Abnormies site — Claude Code brief

This folder is the working tree for the Abnormies project's public website. It deploys to **abnormies.art** via Cloudflare Pages, sourced from **https://github.com/seanbonner/abnormies**.

## Your role

You manage the git repo and Cloudflare deployment. Sean authors site content in this folder. You commit, push, and handle deployment configuration. You do not modify content Sean has authored.

## File layout

| File | Purpose |
|---|---|
| `index.html` | Public teaser. Front door of the site. |
| `spec.html` | Specification rendered for browsers. |
| `spec.md` | Specification in markdown (machine-readable, for LLMs and agents). |
| `_headers` | Cloudflare Pages header overrides. |
| `README.md` | Minimal repo description (public-facing on GitHub). |
| `CLAUDE.md` | This file. Your standing context. |
| `.gitignore` | Standard ignores. |

If files are missing from this list, that's fine — Sean adds them as needed. If files exist that aren't on this list, leave them alone.

## `_headers` contents

```
/spec.md
  Content-Type: text/markdown; charset=utf-8
```

This ensures `spec.md` renders as text in the browser instead of triggering a download.

## Initial setup (run once)

If the folder is not yet a git repo:

```bash
git init -b main
git remote add origin https://github.com/seanbonner/abnormies.git
git add .
git commit -m "Initial commit"
git push -u origin main
```

If `gh` is configured and you need to set the remote afresh:

```bash
gh repo set-default seanbonner/abnormies
```

## Cloudflare Pages setup (one time)

The cleanest path is the Cloudflare web UI:

1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Authorize and select `seanbonner/abnormies`.
3. Build settings: leave **build command** and **output directory** blank. This is a pure static site; no build step.
4. Production branch: `main`.
5. Deploy.

After first deploy:

6. In the Pages project settings → **Custom domains** → add `abnormies.art`.
7. DNS: if `abnormies.art` already uses Cloudflare nameservers, the CNAME is added automatically. If not, configure DNS at the registrar to point at the Pages deployment.

CLI alternative (if `wrangler` is authed via `wrangler login`):

```bash
npx wrangler pages project create abnormies --production-branch=main
npx wrangler pages deploy . --project-name=abnormies
```

Custom domain via CLI:

```bash
npx wrangler pages domain add abnormies.art --project-name=abnormies
```

The web UI flow is usually faster. Recommend it to Sean unless he prefers CLI.

## Routine workflow

When Sean drops updated files in this folder:

```bash
git status                                    # confirm what changed
git add .
git commit -m "<concise imperative description>"
git push
```

Cloudflare Pages auto-deploys on push to `main`. No further action needed.

**Commit message style:** imperative, brief, no preamble. Examples:
- `Update teaser copy`
- `Fix spec terminology`
- `Tweak prototype defaults`
- `Update _headers`

## Don't

- Don't modify the content of files Sean has authored (HTML, MD). If something looks broken, flag it but don't fix it.
- Don't reorganize the file structure.
- Don't add a build pipeline. This is a static site by design.
- Don't add analytics, tracking, or third-party scripts.
- Don't create branches unless Sean asks. Push directly to `main`.
- Don't open PRs. Direct pushes.
- Don't push to remotes other than `origin`.
- Don't force-push without explicit instruction.

## Project context

**Abnormies** is a fully on-chain NFT derivative art collection paired 1:1 with **Normies** (Serc, Feb 2026). The site is a teaser and specification publication. There is no minting on this site, no wallet connect, no commerce. Pure static HTML. Smart contracts and minting UI will live in separate repos (forthcoming).

License: CC0.

## Sean's interaction preferences

- Direct, concise responses. No preamble, no summaries of what you just did.
- Single action per message unless impossible.
- Skip confirmation for reversible actions.
- Don't assume user error.
- Treat the spec as authoritative for any factual question about the project. Conflicts between this brief and the spec resolve toward the spec.
