# Slopedea

The Global AI Slop Index. Which platform is drowning in the most AI slop? One person, one vote.

**[slopedea.com](https://slopedea.com)**

![Slopedea share card](public/og.png)

Runs entirely on Cloudflare's free plan: static site + one Worker + a D1 database.

```
public/index.html   the whole site (HTML, CSS, JS in one file)
public/favicon.svg
src/worker.js       API: voting, standings, hourly snapshots
src/platforms.js    platform ids the API accepts (keep in sync with index.html)
schema.sql          D1 tables
wrangler.jsonc      Cloudflare config
```

## How it works

- **No sign-up.** One tap and the vote counts. Each voter gets a random id in a signed cookie, and their vote lives in one row. Moving it updates that row.
- **Abuse protection.** Cloudflare Turnstile (an invisible bot check) runs on every vote, and each network (IP) can add at most `IP_DAILY_CAP` new voters a day (default 20, so shared mobile and office networks still work). IPs are only stored as a salted hash and deleted after a day.
- **Cooldown.** You can move your vote once an hour (`SWITCH_COOLDOWN_MIN`).
- **Results unlock.** Percentages stay hidden until `REVEAL_AT` votes are in (default 100), so the launch never looks empty.
- **Cheap reads.** Running totals live in a `tallies` table, and `/api/standings` is cached at the edge for 60 seconds. A page view costs one Worker request and almost no database reads.
- **History.** An hourly cron recounts every vote (fixing any drift) and appends a snapshot to a 15-day history. The chart, the 24h movement and the "X overtakes Y" headlines are all built from it.

## Run your own

You need Node 18+ and a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler d1 create slopedea      # copy the database_id into wrangler.jsonc
npm run db:init
```

Create an **Invisible** Turnstile widget in the Cloudflare dashboard and put its site key in `wrangler.jsonc` (`TURNSTILE_SITE_KEY`). Then add the secrets and deploy:

```bash
npx wrangler secret put TURNSTILE_SECRET   # the Turnstile secret key
npx wrangler secret put SESSION_SECRET     # openssl rand -base64 48
npx wrangler secret put ID_SALT            # a different random string
npm run deploy
```

- Attach a custom domain to the Worker. Edge caching doesn't work on workers.dev.
- Never change `SESSION_SECRET` after launch, or every voter's cookie breaks and they can vote again.
- Recommended: a WAF rate limit on `/api/vote` (10 per minute per IP) and Bot Fight Mode, both free.
- Using a different domain? Update the contact address in the footer of `public/index.html`.

## Local development

Create `.dev.vars` (it's gitignored):

```
SESSION_SECRET=any-local-string
ID_SALT=another-local-string
TURNSTILE_SITE_KEY=
REVEAL_AT=3
SWITCH_COOLDOWN_MIN=1
IP_DAILY_CAP=20
```

With no Turnstile secret set, the bot check is skipped locally.

```bash
npm run db:init:local
npm run dev
```

Open `http://localhost:8787` and vote. Use a private window to vote as a second person. Trigger the hourly job with:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

## Free plan limits

| | Free allowance | What it means here |
|---|---|---|
| Worker requests | 100,000 / day | ~1 per page view and 1 per vote. Static files don't count. |
| Burst | 1,000 requests / minute | The edge cache absorbs repeat visits, but a huge spike can hit this. |
| D1 writes | 100,000 rows / day | 3 rows per new vote, so about 30,000 new votes a day. |
| D1 reads | 5 million rows / day | About 12 rows per uncached standings request. |

Past these limits, Workers Paid ($5/month) removes the daily caps.

## Adding a platform

Add it to `IDS` in `src/platforms.js` and to `PLATFORMS` in `public/index.html` (with a one-line description), then deploy.

## Honest limits of no-sign-in voting

Someone determined can still add extra votes by clearing cookies and switching networks. The bot check and the network cap keep that slow and expensive, which is enough for a public opinion poll. If gaming ever becomes a real problem, the next step is an optional "verify with Google" and a verified-only view of the standings.
