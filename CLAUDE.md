# Slopedea

The Global AI Slop Index: a public vote on which social platform has the most AI slop. Domain: slopedea.com.

## Stack

Cloudflare free plan only. The only money spent is the domain.

- `public/index.html`: the whole frontend (HTML, CSS, JS in one file, no build step)
- `src/worker.js`: Worker API (`/api/standings`, `/api/me`, `/api/vote`) plus an hourly cron
- `src/platforms.js`: platform ids the API accepts. Keep in sync with `PLATFORMS` in index.html
- `schema.sql`: D1 tables (`votes`, `tallies`, `meta`, `ip_daily`)
- `wrangler.jsonc`: config. Static assets skip the Worker; only `/api/*` runs it

Local dev: `npm run db:init:local` once, then `npm run dev`. `.dev.vars` holds local test secrets (git-ignored). Trigger the cron locally with `curl "http://localhost:8787/cdn-cgi/local/scheduled"`. README.md has full deploy steps.

## Product decisions (already made, don't undo without asking)

- **No sign-in.** One tap to vote. Identity is a random id in a signed HttpOnly cookie (`sl_v`). Protection: Cloudflare Turnstile (invisible) on every vote, plus `IP_DAILY_CAP` (20) new voters per network per day. IPs are only stored as an HMAC and deleted after a day.
- **One vote, movable.** `SWITCH_COOLDOWN_MIN` = 60 minutes between moves.
- **Results unlock at `REVEAL_AT` (100) votes.** Before that, percentages are sealed and a progress bar shows.
- **Never seed fake votes.** It's an anti-slop index; faking numbers would destroy it.
- **No browser fingerprinting** for now (consent/privacy issues). If gaming becomes a problem, the next step is optional "verify with Google" plus a verified-only view.
- **Cheap reads.** `/api/standings` is edge-cached 60s; running totals live in `tallies`; the hourly cron recounts from `votes` and appends a snapshot to a 15-day history (one JSON row in `meta`).
- **Disclaimer** in the footer: independent opinion poll, not affiliated with any platform.

## Design rules

- The site must not look like AI slop. No purple gradients, no emoji section headers, no generic cards, no AI-generated images, no marketing copy ("unlock", "elevate").
- Look: election-night results sheet. Cool newsprint grey, ink type, one "slop" highlighter yellow-green (`--slop`) used only for the leader and the voter's own pick. Fonts: Fraunces (display, SOFT/WONK axes), Schibsted Grotesk (body), IBM Plex Mono (data).
- Copy is short, a little cheeky, written like a person. **No em dashes anywhere.**
- Light and dark themes via tokens in `:root`; keep both working.
- `public/og.png` is the link preview. Regenerate it after changing the share card (use the page's "Download image").

## Open tasks

- [x] Wordmark drips redrawn as flat teardrops; dark mode letters get a hard shadow over the green
- [x] Footer: GitHub link (404s until the repo is public)
- [x] Deployed to slopedea.com (D1, Turnstile, secrets, custom domain). www redirects to the apex; WAF limit on /api/vote is 5 per 10s per IP; Bot Fight Mode on. Still to do: Email Routing for hello@
- [ ] After launch: request-a-platform with +1s, Hall of Slop, weekly "state of slop" posts
