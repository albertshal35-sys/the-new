# IceCap Development Intelligence

Continuously monitors official City of Boston planning and permit records, backfills the previous 365 days,
identifies qualifying residential / residential-led mixed-use development filings (1–200 units), links records
across sources into projects, scores them as research leads, and alerts via Telegram and email when new
qualifying filings become publicly available.

See **[SOURCES.md](SOURCES.md)** for the verified availability and limitations of every source (read it first:
the legacy Article 80 GIS layer named in the original brief has been frozen since February 2016; the current
layer and the other sources listed there are what the system actually uses).

```
                ┌────────────── official public sources ──────────────┐
                │ Article 80 FeatureServer · Records Library JSON API │
                │ CKAN: issued permits · permit applications · ZBA    │
                │ CKAN: property assessment (enrichment)              │
                └───────────────┬─────────────────────────────────────┘
                                │ httpx · per-host rate limits · retries/backoff · conditional checks
┌───────────────────────────────▼──────────────────────────────────────┐
│ worker (Python, asyncio)                                             │
│  scheduler: per-source leases, watermarks + overlapping lookback,    │
│  adaptive polling, circuit breaker, missed-run recovery              │
│  pipeline: raw versions → normalize → eligibility → link → project   │
│            recompute (units, stage, financing, score) → events       │
│  notifications: queue, dedupe, quiet hours, retries, digests         │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ PostgreSQL 16 + PostGIS
              ┌─────────────────┴───────────────┐
              │ app (Next.js 15, server-render) │  api (FastAPI)
              └─────────────────────────────────┘
```

## Quick start (Docker)

```bash
cp .env.example .env        # optionally add Telegram / SMTP credentials
docker compose up -d --build
```

* Dashboard: http://localhost:3000 · API: http://localhost:8000/docs · Postgres: localhost:5432
* On first start the worker applies migrations, registers sources, and runs the 365-day backfill for each source
  in dependency order (≈10 minutes, ~45k records). Backfilled records **never** alert. After that it polls
  continuously and alerts only on genuinely new or materially changed qualifying filings.
* Without credentials, notifications are queued and marked **mocked** (written to `/app/var/mock_notifications.log`
  in the worker container); they are never reported as delivered.

## Local development (no Docker)

Requirements: Python ≥ 3.11, Node 22, PostgreSQL 16 with PostGIS 3.

```bash
createdb icecap && createdb icecap_test        # user/password: see DATABASE_URL below
export DATABASE_URL=postgresql://icecap:icecap@localhost:5432/icecap

cd worker && pip install -r requirements.txt && pip install -e .
python -m icecap.cli migrate
python -m icecap.cli backfill          # 365-day backfill of all sources
python -m icecap.cli stats             # counts by source / eligibility
python -m icecap.cli worker            # continuous monitoring + notifications + digests
python -m icecap.cli api               # REST API on :8000

cd ../web && npm install && npm run dev   # dashboard on :3000
```

Other commands: `run-source <key> [--mode backfill|incremental|reconcile]`, `dispatch` (send due notifications
now), `enrich` (owner-of-record lookups), `digest [--weekly]`, `reprocess [keys…]` (re-apply rule changes to stored
raw records — never alerts).

## Tests

```bash
cd worker && python -m pytest -q        # 54 tests; DB tests use TEST_DATABASE_URL (default icecap_test)
cd web && npm test && npx tsc --noEmit  # filter/SQL-builder tests + typecheck
```

Worker tests cover: unit/text extraction (never inventing values), address normalization, eligibility against
**real captured responses** from every source (`worker/tests/fixtures/`), pagination (Records Library markers,
CKAN keyset), retry on 5xx, backfill-without-alerts, alert-once + silent re-import, material vs non-material
changes, raw version history, independent timestamps (first_seen_at / source_filing_date / last_changed_at /
alerted_at), cross-source linking by application number, rejected permits not creating projects, notification
retry → dead-letter, mocked delivery not marking events alerted, quiet hours, conditional-check skip,
circuit breaker, rolling 365-day windows, adaptive polling.

## How it decides

**Eligibility** (`worker/icecap/eligibility.py`) — `qualified`, `needs_review` or `rejected`, always with reasons:
* 1–200 proposed residential units; >200 rejected; 0 units rejected.
* Development scope required for permits/appeals: new construction, demolition/rebuild, conversion, substantial
  rehab, additions/changes that create units. Trade permits (electrical, plumbing, gas, roofing, solar, signs,
  fire alarm, special events …), commercial-to-commercial changes, unit combinations and condo splits inside large
  existing buildings are rejected.
* Hotel / lab-office signals, or > 4,000 gross sf per unit, send a project with units to *Needs Review* to verify it
  is residential-led. Institutional/industrial words alone do not (they usually describe the existing use being
  converted, e.g. a church to housing).
* Unknown unit count → *Needs Review*, never discarded and never guessed. Planning documents are evaluated with
  their project.
* Estimated cost above the $50M cap is **not** a rejection reason.

**Units** — structured official fields (Article 80 `total_residential_units`, application "units after") beat
explicit statements in official text ("32 residential units", "convert … into a three family"); the source and
confidence are shown everywhere.

**Linking** (`linking.py`) — official Article 80 ProjectID → project page slug → permit application number
(shared by applications, issued permits and ZBA appeals) → parcel id → same street number + street name (ranges
expanded, ≤ 200 m when coordinates exist) → exact project name. Rejected records attach to existing projects as
permit history but never create projects. Enrichment records attach only by official id.

**Financing** (`financing.py`) — kept separate: official project cost (only the 2016 legacy layer has one),
declared construction valuation on issued permits (hard-cost proxy), estimated total development cost range, and
estimated loan range (TDC × 60–75 % LTC). Per-unit costs, multipliers and LTC are editable assumptions stored in the
`settings` table. Fit = *likely* if the high estimate ≤ $50M, *outside scope* if the low estimate > $50M, else
*uncertain*; no basis → no estimate and *uncertain*.

**Score** (`scoring.py`, weights in `settings.scoring.weights`) — unit fit 25, early stage 20, loan size 15,
newness 15, verified contact 15, prior developer activity 10. It ranks research priority; it is not evidence of a
borrower's financing need.

**Alerts** — one `NEW DEVELOPMENT FILING` alert the first time a project qualifies, then separate alerts for
revised unit count, new plan submission (developer filing / development permit application / new Article 80 filed
date), approval (board vote, ZBA approval, determination) and issuance of a development permit. Every event has a
unique dedupe key and every notification a unique (event, channel) key, so re-imports and unchanged records never
re-alert. Thresholds (`min_score`, `min_units`, `notify_needs_review`) and quiet hours live in
`settings.alerts`; the default notifies on every verified new qualifying filing. Daily digest (08:00 ET) and
weekly developer report (Mondays) are enabled by default.

Change settings with SQL, e.g.:
```sql
INSERT INTO settings(key, value) VALUES
  ('alerts', '{"quiet_hours": {"start": "22:00", "end": "07:00", "tz": "America/New_York"}}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

## Monitoring behaviour

| Source | Check | Interval | Window |
|---|---|---|---|
| Article 80 FeatureServer | `lastEditDate` | 5–30 min | full snapshot (≈1,000 rows) on change; removals detected |
| Records Library | none available | 10–30 min | watermark − 21 days |
| Permit applications / ZBA / issued permits | CKAN `last_modified` | 5 min near learned publish hour, backing off to 60 min | watermark − 7…14 days |
| Every source | — | daily (weekly for permits) | full 365-day reconcile to catch silent edits |

Per-source state (watermark, provider version, last check/success/error, newest record, failures, circuit,
next run) is durable in `source_state`; leases make multiple workers safe and recover from crashes; overdue
runs execute immediately on start (missed-run recovery). Every run is recorded in `ingestion_runs` with timing,
counts and HTTP request totals. The **Sources & alerts** page shows source health, publication lag, latency from
provider update → detection → notification, delivery status and run history.

## Adding a city

Implement `SourceAdapter` subclasses (`fetch`, `normalize`, optional `check_upstream`) under
`worker/icecap/adapters/<city>/`, add them and the city to `adapters/registry.py`. The pipeline, linking,
eligibility, scoring, notifications and dashboard are city-agnostic.

## Honesty constraints built in

* Alerts only for records that are publicly accessible; "first detected" is when IceCap saw it.
* Issued permits, permit applications, zoning appeals, Article 80 records and planning documents are labelled as
  such everywhere; issued permits are never described as submitted plans.
* Applicants, ZBA contacts and owners of record are labelled by role; none is assumed to be the developer or owner.
* Missing units, costs, contacts and developers are shown as missing (`missing_data`), never filled in.
* No paywalls, CAPTCHAs, logins or access restrictions are bypassed; APIs are preferred over HTML.
