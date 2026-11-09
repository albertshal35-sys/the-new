# IceCap Development Intelligence — Cloudflare Worker version

The whole app runs on Cloudflare. There's no server, database or Docker to manage.

- **Every 5 minutes** Cloudflare wakes the Worker, which checks the official Boston sources for new or changed filings
  and sends alerts for new qualifying projects (Telegram and/or email).
- **The dashboard** (live feed, leads, map, developers, pipeline, source health, settings) is a password-protected web
  page served by the same Worker at `https://icecap-dev-intel.<your-subdomain>.workers.dev`.
- **All data** lives in one SQLite-backed Durable Object (Cloudflare's built-in storage). Nothing else to set up.

The first time it runs, it loads the previous 365 days of records (about 45,000) in small chunks, one chunk every
5 minutes. That takes about an hour (around a dozen 5-minute runs). Those backfilled records never trigger alerts. After that, alerts go out
only for records that are newly published.

## What you need

1. A Cloudflare account. The **Workers Paid plan ($5/month)** is recommended: the first 365-day load needs more CPU time
   per run than the free plan allows. Monitoring after that is light.
2. Node.js 20+ on your computer (only for the one-time deploy).
3. Optional, for real alerts:
   - **Telegram:** a bot token from [@BotFather](https://t.me/BotFather) and your chat id.
   - **Email:** a [Resend](https://resend.com) API key and a sender address on a domain verified with Resend.

Without Telegram/email credentials, alerts are still created and shown under **Sources & alerts**, marked
"mocked (not delivered)".

## Deploy (about 5 minutes)

```bash
cd cloudflare
npm install
npx wrangler login                          # opens a browser to sign in to Cloudflare
npx wrangler secret put DASHBOARD_PASSWORD  # choose the password for the dashboard
npx wrangler deploy
```

`wrangler deploy` prints your URL. Open it, sign in with any username and the password you chose, and go to **Sources &
alerts** to watch the first load progress.

Optional alert secrets (run any you need, then they apply automatically):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ALERT_EMAIL_FROM     # e.g. alerts@yourdomain.com (verified in Resend)
npx wrangler secret put ALERT_EMAIL_TO       # where alerts go; comma-separate several addresses
```

So that alert links open the dashboard, set `DASHBOARD_URL` in `wrangler.toml` to your Worker URL, then run
`npx wrangler deploy` again.

## Using it

| Page | What it's for |
|---|---|
| Live feed | Newest records first, by when IceCap saw them or by filing date |
| Leads | All projects, with filters (units 1–4 / 5–20 / 21–50 / 51–100 / 101–200, type, stage, financing fit, neighborhood, developer, applicant, filing and first-seen dates, unread, has contact), CSV export and saved searches |
| Needs review | Projects that may qualify but are missing a unit count or need checking |
| Map | Same filters, on a map |
| Lead detail | Timeline, linked public records and documents, role-labelled people, financing estimate with its assumptions, score breakdown, pipeline status and notes |
| Developers | Projects grouped by named developer / proponent / owner, with filing history |
| Pipeline | New → Researching → Contacted → In Discussion → Term Sheet → Closed / Not a Fit |
| Sources & alerts | Health of each source, publication lag, alert delivery status, run history, "Run now" |
| Settings | Unit range, loan cap, alert thresholds, quiet hours, digests, score weights and cost assumptions (JSON) |

## How it works

| File | Role |
|---|---|
| `src/index.ts` | Worker entry: password check, cross-site POST protection, cron → Durable Object |
| `src/engine.ts` | Scheduling: resumable chunked runs, conditional checks, adaptive polling, circuit breaker, digests, owner lookups |
| `src/adapters/boston.ts` | The 6 Boston sources (see `../SOURCES.md`) and the property-assessment lookup |
| `src/pipeline.ts` | Raw-record versioning, eligibility, cross-source linking, project recompute, change events, alert queueing |
| `src/logic.ts` | Business rules: eligibility, unit selection, financing estimate, score |
| `src/text.ts` | Address normalization and conservative unit/project-type extraction (never invents values) |
| `src/notify.ts` | Alert text, quiet hours, Telegram / Resend / mock delivery, retries, daily digest and weekly report |
| `src/ui.ts` | Server-rendered dashboard, CSV and JSON endpoints |

Each cron run has a time and request budget (`TICK_BUDGET_MS`, `MAX_REQUESTS_PER_TICK`). Long jobs save a cursor and
continue on the next run, so no single run exceeds Cloudflare's limits.

## Development

```bash
npm test                         # 32 tests on real captured responses from each source (node:sqlite stands in for the Durable Object)
LIVE=1 npx vitest run test/live.test.ts   # full live 365-day backfill against the real sources, using the same chunk limits
npx tsx test/serve-local.ts      # preview the dashboard locally from the live-test database (http://localhost:8788)
npx wrangler dev --test-scheduled  # run in the local Workers runtime; trigger a run at /__scheduled
npm run typecheck
```
