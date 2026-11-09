/** Engine: scheduling + resumable source runs + enrichment + digests, on top of synchronous SQLite. */
import { ADAPTERS, ASSESSMENT, BY_KEY, lookupParcel } from "./adapters/boston";
import type { Adapter, Upstream } from "./adapters/types";
import { Http } from "./http";
import { DEFAULT_SETTINGS, deepMerge, type Settings } from "./logic";
import { buildChannels, dispatchDue, enqueueDailyDigest, enqueueWeeklyReport, nextLocalTime, type NotifyEnv } from "./notify";
import { newStats, Pipeline, type RunCtx } from "./pipeline";
import { migrate } from "./schema";
import { j, nowIso, pj, type Row, type Sql } from "./sql";

export interface EngineEnv extends NotifyEnv {
  BACKFILL_DAYS?: string; NOTIFY_CHANNELS?: string; USER_AGENT?: string; DASHBOARD_URL?: string; TICK_BUDGET_MS?: string;
  MAX_REQUESTS_PER_TICK?: string;
}
const CIRCUIT_THRESHOLD = 5;
const iso = (ms: number) => new Date(ms).toISOString();

export class Engine {
  private ready = false;
  private ticking = false;
  constructor(public sql: Sql, private env: EngineEnv, private fetcher: typeof fetch = (...a) => fetch(...a)) {}

  init(): void {
    if (this.ready) return;
    migrate(this.sql);
    this.seed();
    this.ready = true;
  }

  get channels(): string[] { return (this.env.NOTIFY_CHANNELS ?? "telegram,email").split(",").map((s) => s.trim()).filter(Boolean); }
  get dashboardUrl(): string { return (this.env.DASHBOARD_URL ?? "").replace(/\/$/, ""); }
  get backfillDays(): number { return Number(this.env.BACKFILL_DAYS ?? 365); }

  settings(): Settings {
    let s: Settings = DEFAULT_SETTINGS;
    for (const r of this.sql.all(`SELECT key, value FROM settings`)) s = deepMerge(s, { [r.key]: pj(r.value, {}) });
    return s;
  }
  pipeline(): Pipeline { return new Pipeline(this.sql, this.settings(), { channels: this.channels, dashboardUrl: this.dashboardUrl }); }

  seed(): void {
    const now = nowIso();
    for (const a of ADAPTERS) {
      const m = a.meta;
      this.sql.run(`INSERT INTO sources (key, city_id, name, record_class, official_url, api_url, description, limitations, cadence, min_interval_s, max_interval_s, is_enrichment_only, backfill_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name, official_url=excluded.official_url, api_url=excluded.api_url,
        description=excluded.description, limitations=excluded.limitations, cadence=excluded.cadence, min_interval_s=excluded.min_interval_s,
        max_interval_s=excluded.max_interval_s, is_enrichment_only=excluded.is_enrichment_only, backfill_order=excluded.backfill_order`,
        m.key, "boston", m.name, m.recordClass, m.officialUrl, m.apiUrl, m.description, m.limitations, m.cadence, m.minIntervalS, m.maxIntervalS,
        m.isEnrichmentOnly ? 1 : 0, m.backfillOrder);
      this.sql.run(`INSERT OR IGNORE INTO source_state (source_key, next_run_at, current_interval_s) VALUES (?,?,?)`, m.key, now, m.minIntervalS);
    }
    this.sql.run(`INSERT INTO sources (key, city_id, name, record_class, official_url, api_url, description, limitations, cadence, min_interval_s, max_interval_s, is_enrichment_only, backfill_order)
      VALUES (?,'boston','Boston Property Assessment (owner of record) — enrichment','property_record',?,?,'Owner of record, mailing address, land use, existing units by parcel id.',
      'Annual snapshot. Owner of record is not necessarily the developer or borrower. Looked up only for parcels of non-rejected projects.','Annual',600,600,1,99)
      ON CONFLICT(key) DO NOTHING`, ASSESSMENT.key, ASSESSMENT.url, `datastore_search (resource ${ASSESSMENT.resource})`);
    this.sql.run(`INSERT OR IGNORE INTO source_state (source_key, next_run_at, current_interval_s) VALUES (?,?,600)`, ASSESSMENT.key, now);
  }

  // ---------------------------------------------------------------- tick
  async tick(opts: { budgetMs?: number; maxRequests?: number; force?: string } = {}): Promise<Record<string, any>> {
    this.init();
    if (this.ticking) return { skipped: "another run is in progress" };
    this.ticking = true;
    const deadline = Date.now() + (opts.budgetMs ?? Number(this.env.TICK_BUDGET_MS ?? 25_000));
    const http = new Http(this.env.USER_AGENT ?? "IceCapDevelopmentIntelligence/0.2", 3, 1500, this.fetcher);
    const maxReq = opts.maxRequests ?? Number(this.env.MAX_REQUESTS_PER_TICK ?? 40);
    const budget = { deadline, maxReq, http };
    const results: any[] = [];
    try {
      if (opts.force) this.sql.run(`UPDATE source_state SET next_run_at=?, circuit_open_until=NULL WHERE source_key=?`, nowIso(), opts.force);
      // 1) Initial backfill runs one source at a time in dependency order so later sources can link to earlier ones.
      const pending = this.sql.all(`SELECT s.key FROM sources s JOIN source_state ss ON ss.source_key=s.key
        WHERE ss.backfill_completed_at IS NULL AND s.key<>? ORDER BY s.backfill_order`, ASSESSMENT.key).map((r) => r.key as string);
      if (pending.length) {
        for (const key of pending) {
          if (this.exhausted(budget)) break;
          results.push(await this.runSource(BY_KEY[key], budget, "backfill"));
          if (this.sql.one(`SELECT backfill_completed_at FROM source_state WHERE source_key=?`, key)?.backfill_completed_at == null) break;
        }
      } else {
        // 2) Continuous monitoring: in-progress runs first, then due sources.
        const due = this.sql.all(`SELECT source_key FROM source_state WHERE source_key<>? AND (run_mode IS NOT NULL OR next_run_at<=?)
          AND (circuit_open_until IS NULL OR circuit_open_until<=?) ORDER BY (run_mode IS NULL), next_run_at`, ASSESSMENT.key, nowIso(), nowIso());
        for (const r of due) {
          if (this.exhausted(budget)) break;
          const a = BY_KEY[r.source_key];
          if (a) results.push(await this.runSource(a, budget));
        }
      }
      const delivered = await dispatchDue(this.sql, buildChannels(this.env, this.fetcher));
      if (!this.exhausted(budget)) await this.scheduledJobs(budget);
      return { results, delivered, http_requests: http.requests };
    } finally {
      this.ticking = false;
    }
  }
  private exhausted(b: { deadline: number; maxReq: number; http: Http }): boolean {
    return Date.now() >= b.deadline || b.http.requests >= b.maxReq;
  }

  chooseMode(st: Row, a: Adapter, now: number): string {
    if (!st.backfill_completed_at) return "backfill";
    const last = pj<any>(st.stats, {}).last_reconcile_at;
    if (!last || now - Date.parse(last) >= a.meta.reconcileEveryH * 3600_000) return "reconcile";
    return "incremental";
  }
  nextInterval(st: Row, a: Adapter, changed: boolean, now: number): number {
    const m = a.meta;
    if (changed) return m.minIntervalS;
    const hours: number[] = pj<any>(st.stats, {}).publish_hours_utc ?? [];
    const h = new Date(now).getUTCHours();
    if (hours.some((x) => Math.min(Math.abs(h - x), 24 - Math.abs(h - x)) <= 1)) return m.minIntervalS;
    return Math.round(Math.min(m.maxIntervalS, Math.max(m.minIntervalS, (st.current_interval_s ?? m.minIntervalS) * 1.5)));
  }

  async runSource(a: Adapter, budget: { deadline: number; maxReq: number; http: Http }, forceMode?: string): Promise<Row> {
    const key = a.meta.key;
    const http = budget.http;
    const req0 = http.requests, t0 = Date.now();
    let st = this.sql.one(`SELECT * FROM source_state WHERE source_key=?`, key)!;
    const stats = pj<any>(st.stats, {});
    try {
      if (!st.run_mode) {
        const now = Date.now();
        const mode = forceMode ?? this.chooseMode(st, a, now);
        const up: Upstream | null = a.checkUpstream ? await a.checkUpstream(http) : null;
        const changedUp = Boolean(up?.version && up.version !== st.upstream_version);
        if (mode === "incremental" && up?.version && !changedUp) {
          const interval = this.nextInterval(st, a, false, now);
          this.sql.run(`UPDATE source_state SET last_check_at=?, last_success_at=?, consecutive_failures=0, circuit_open_until=NULL, last_error=NULL,
            current_interval_s=?, next_run_at=? WHERE source_key=?`, nowIso(), nowIso(), interval, iso(now + interval * 1000), key);
          this.sql.run(`INSERT INTO ingestion_runs (source_key, mode, started_at, finished_at, status, http_requests, duration_ms) VALUES (?,?,?,?,?,?,?)`,
            key, mode, iso(t0), nowIso(), "unchanged", http.requests - req0, Date.now() - t0);
          return { source: key, mode, status: "unchanged" };
        }
        const end = now;
        const start = mode === "incremental"
          ? Math.min(st.watermark_ts ? Date.parse(st.watermark_ts) : now - Math.max(a.meta.lookbackDays, 1) * 86_400_000, now) - a.meta.lookbackDays * 86_400_000
          : now - this.backfillDays * 86_400_000;
        const run = this.sql.one(`INSERT INTO ingestion_runs (source_key, mode, started_at, window_start, window_end) VALUES (?,?,?,?,?) RETURNING id`,
          key, mode, iso(t0), iso(start), iso(end))!;
        this.sql.run(`UPDATE source_state SET run_id=?, run_mode=?, run_window_start=?, run_window_end=?, run_cursor=NULL, run_started_at=?, run_upstream=? WHERE source_key=?`,
          run.id, mode, iso(start), iso(end), iso(t0), j(up), key);
        st = this.sql.one(`SELECT * FROM source_state WHERE source_key=?`, key)!;
      }
      const up = pj<Upstream | null>(st.run_upstream, null);
      const ctx: RunCtx = { mode: st.run_mode, alertsEnabled: st.run_mode !== "backfill", publishedAt: up?.updatedAt ?? null, stats: newStats() };
      const pipe = this.pipeline();
      let cursor = pj<any>(st.run_cursor, null);
      let done = false, fullSnapshot = false, pages = 0;
      while (!this.exhausted(budget)) {
        const page = await a.fetchPage(http, { mode: st.run_mode, windowStart: st.run_window_start, windowEnd: st.run_window_end, cursor, upstream: up });
        pages++;
        pipe.processPage(a, page.records, ctx);
        fullSnapshot = fullSnapshot || Boolean(page.fullSnapshot);
        cursor = page.nextCursor;
        this.sql.run(`UPDATE source_state SET run_cursor=? WHERE source_key=?`, j(cursor), key);
        if (cursor === null) { done = true; break; }
      }
      const s = ctx.stats;
      this.sql.run(`UPDATE ingestion_runs SET chunks=chunks+1, pages=pages+?, fetched=fetched+?, inserted=inserted+?, changed=changed+?, unchanged=unchanged+?,
        qualified=qualified+?, needs_review=needs_review+?, rejected=rejected+?, events=events+?, http_requests=http_requests+?, duration_ms=duration_ms+? WHERE id=?`,
        pages, s.fetched, s.inserted, s.changed, s.unchanged, s.qualified, s.needs_review, s.rejected, s.events, http.requests - req0, Date.now() - t0, st.run_id);
      if (!done) {
        this.sql.run(`UPDATE source_state SET last_check_at=?, consecutive_failures=0, last_error=NULL WHERE source_key=?`, nowIso(), key);
        return { source: key, mode: st.run_mode, status: "in_progress", ...s };
      }
      // finalize
      if (fullSnapshot) this.sql.run(`UPDATE raw_records SET removed_upstream_at=? WHERE source_key=? AND last_seen_at<? AND removed_upstream_at IS NULL`, nowIso(), key, st.run_started_at);
      const run = this.sql.one(`SELECT * FROM ingestion_runs WHERE id=?`, st.run_id)!;
      const agg = this.sql.one(`SELECT max(source_filing_date) newest, count(*) n FROM raw_records WHERE source_key=? AND removed_upstream_at IS NULL`, key)!;
      const changedUp = Boolean(up?.version && up.version !== st.upstream_version);
      const changed = run.inserted + run.changed > 0 || changedUp;
      if (changedUp && up?.updatedAt) stats.publish_hours_utc = [...(stats.publish_hours_utc ?? []), new Date(up.updatedAt).getUTCHours()].slice(-20);
      if (st.run_mode !== "incremental") stats.last_reconcile_at = st.run_started_at;
      stats.last_run = { mode: st.run_mode, fetched: run.fetched, inserted: run.inserted, changed: run.changed };
      const now = Date.now();
      const interval = this.nextInterval(st, a, changed, now);
      this.sql.run(`UPDATE source_state SET watermark_ts=?, upstream_version=COALESCE(?, upstream_version), upstream_updated_at=COALESCE(?, upstream_updated_at),
        last_check_at=?, last_success_at=?, last_change_detected_at=CASE WHEN ? THEN ? ELSE last_change_detected_at END, consecutive_failures=0,
        circuit_open_until=NULL, last_error=NULL, newest_record_at=?, records_total=?, stats=?, current_interval_s=?, next_run_at=?,
        backfill_completed_at=CASE WHEN ?='backfill' THEN COALESCE(backfill_completed_at, ?) ELSE backfill_completed_at END,
        run_id=NULL, run_mode=NULL, run_window_start=NULL, run_window_end=NULL, run_cursor=NULL, run_started_at=NULL, run_upstream=NULL WHERE source_key=?`,
        st.run_window_end, up?.version ?? null, up?.updatedAt ?? null, nowIso(), nowIso(), changed ? 1 : 0, nowIso(), agg.newest, agg.n, j(stats),
        interval, iso(now + interval * 1000), st.run_mode, nowIso(), key);
      this.sql.run(`UPDATE ingestion_runs SET finished_at=?, status=? WHERE id=?`, nowIso(), "success", st.run_id);
      return { source: key, mode: st.run_mode, status: "success", ...s };
    } catch (e) {
      const failures = (st.consecutive_failures ?? 0) + 1;
      const backoff = Math.min(a.meta.minIntervalS * 2 ** Math.min(failures, 6), 6 * 3600);
      const circuit = failures >= CIRCUIT_THRESHOLD;
      this.sql.run(`UPDATE source_state SET last_check_at=?, last_error_at=?, last_error=?, consecutive_failures=?, circuit_open_until=?, next_run_at=? WHERE source_key=?`,
        nowIso(), nowIso(), String(e).slice(0, 1000), failures, circuit ? iso(Date.now() + backoff * 1000) : null, iso(Date.now() + backoff * 1000), key);
      if (st.run_id) this.sql.run(`UPDATE ingestion_runs SET error=? WHERE id=?`, String(e).slice(0, 1000), st.run_id);
      else this.sql.run(`INSERT INTO ingestion_runs (source_key, mode, started_at, finished_at, status, error, http_requests, duration_ms) VALUES (?,?,?,?,?,?,?,?)`,
        key, forceMode ?? "check", iso(t0), nowIso(), "error", String(e).slice(0, 1000), http.requests - req0, Date.now() - t0);
      if (failures >= 3 && st.run_id) {   // give up on a stuck run; next run restarts from the watermark
        this.sql.run(`UPDATE ingestion_runs SET finished_at=?, status='error' WHERE id=?`, nowIso(), st.run_id);
        this.sql.run(`UPDATE source_state SET run_id=NULL, run_mode=NULL, run_cursor=NULL, run_started_at=NULL, run_upstream=NULL WHERE source_key=? AND backfill_completed_at IS NOT NULL`, key);
      }
      return { source: key, status: "error", error: String(e) };
    }
  }

  // ---------------------------------------------------------------- scheduled jobs
  async scheduledJobs(budget: { deadline: number; maxReq: number; http: Http }): Promise<void> {
    const s = this.settings().alerts;
    const now = new Date();
    const jobs: Record<string, [boolean, () => Date]> = {
      daily_digest: [s.daily_digest, () => nextLocalTime(now, s.digest_hour_local, s.timezone)],
      weekly_report: [s.weekly_report, () => nextLocalTime(now, s.digest_hour_local, s.timezone, s.weekly_report_weekday)],
      owner_enrichment: [true, () => new Date(now.getTime() + 10 * 60_000)],
    };
    for (const [key, [enabled, next]] of Object.entries(jobs)) {
      const row = this.sql.one(`SELECT * FROM scheduled_jobs WHERE key=?`, key);
      if (!row) {
        this.sql.run(`INSERT OR IGNORE INTO scheduled_jobs (key, next_run_at) VALUES (?,?)`, key, key === "owner_enrichment" ? now.toISOString() : next().toISOString());
        continue;
      }
      if (!enabled || row.next_run_at > now.toISOString() || this.exhausted(budget)) continue;
      this.sql.run(`UPDATE scheduled_jobs SET next_run_at=?, last_run_at=? WHERE key=?`, next().toISOString(), now.toISOString(), key);
      try {
        if (key === "daily_digest") enqueueDailyDigest(this.sql, this.channels, this.dashboardUrl, now);
        else if (key === "weekly_report") enqueueWeeklyReport(this.sql, this.channels, this.dashboardUrl, now);
        else await this.enrichOwners(budget, 15);
        this.sql.run(`UPDATE scheduled_jobs SET last_status='success', last_error=NULL WHERE key=?`, key);
      } catch (e) {
        this.sql.run(`UPDATE scheduled_jobs SET last_status='error', last_error=? WHERE key=?`, String(e).slice(0, 500), key);
      }
    }
  }

  async enrichOwners(budget: { deadline: number; maxReq: number; http: Http }, limit: number): Promise<number> {
    const rows = this.sql.all(`SELECT DISTINCT p.parcel_id FROM projects p LEFT JOIN parcel_assessments pa ON pa.parcel_id=p.parcel_id
      WHERE p.parcel_id IS NOT NULL AND p.eligibility<>'rejected' AND pa.parcel_id IS NULL ORDER BY p.score DESC LIMIT ?`, limit);
    const pipe = this.pipeline();
    let n = 0;
    try {
      for (const r of rows) {
        if (this.exhausted(budget)) break;
        const info = await lookupParcel(budget.http, r.parcel_id);
        this.sql.tx(() => {
          this.sql.run(`INSERT OR IGNORE INTO parcel_assessments (parcel_id, owner, mail_address, land_use, res_units, land_sf, gross_area, total_value, yr_built, found, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, r.parcel_id, info?.owner ?? null, info?.mail_address ?? null, info?.land_use ?? null, info?.res_units ?? null,
            info?.land_sf ?? null, info?.gross_area ?? null, info?.total_value ?? null, info?.yr_built ?? null, info ? 1 : 0, nowIso());
          for (const p of this.sql.all(`SELECT id FROM projects WHERE parcel_id=?`, r.parcel_id)) {
            if (info?.owner) {
              const eid = pipe.upsertEntity(info.owner);
              if (eid) this.sql.run(`INSERT OR IGNORE INTO project_entities (project_id, entity_id, role, source_key, source_record_id, source_url, evidence, first_seen_at)
                VALUES (?,?,'owner_of_record',?,?,?,?,?)`, p.id, eid, ASSESSMENT.key, r.parcel_id, ASSESSMENT.url,
                "Owner of record in Boston property assessment (not necessarily the developer)", nowIso());
            }
            pipe.recompute(p.id);
          }
        });
        n++;
      }
      this.sql.run(`UPDATE source_state SET last_check_at=?, last_success_at=?, consecutive_failures=0, last_error=NULL,
        records_total=(SELECT count(*) FROM parcel_assessments) WHERE source_key=?`, nowIso(), nowIso(), ASSESSMENT.key);
    } catch (e) {
      this.sql.run(`UPDATE source_state SET last_check_at=?, last_error_at=?, last_error=?, consecutive_failures=consecutive_failures+1 WHERE source_key=?`,
        nowIso(), nowIso(), String(e).slice(0, 500), ASSESSMENT.key);
    }
    return n;
  }

  /** Re-apply rules to stored raw records (never alerts). Runs in chunks of `limit` records; returns next cursor. */
  reprocess(sourceKey: string, afterId: number, limit = 3000): { processed: number; nextAfterId: number | null } {
    this.init();
    const a = BY_KEY[sourceKey];
    if (!a) throw new Error(`unknown source ${sourceKey}`);
    const rows = this.sql.all(`SELECT id, source_record_id, payload, source_url, source_filing_date, source_updated_at FROM raw_records WHERE source_key=? AND id>? ORDER BY id LIMIT ?`, sourceKey, afterId, limit);
    const ctx: RunCtx = { mode: "reprocess", alertsEnabled: false, publishedAt: null, stats: newStats() };
    this.pipeline().processPage(a, rows.map((r) => ({ sourceKey, sourceRecordId: r.source_record_id, payload: pj(r.payload, {}), sourceUrl: r.source_url,
      sourceFilingDate: r.source_filing_date, sourceUpdatedAt: r.source_updated_at })), ctx, true);
    return { processed: rows.length, nextAfterId: rows.length === limit ? rows[rows.length - 1].id : null };
  }

  stats(): Row {
    this.init();
    return {
      by_source: this.sql.all(`SELECT source_key, count(*) filings, sum(eligibility='qualified') qualified, sum(eligibility='needs_review') needs_review,
        sum(eligibility='rejected') rejected, sum(project_id IS NOT NULL) linked, min(source_filing_date) oldest, max(source_filing_date) newest FROM filings GROUP BY 1 ORDER BY 1`),
      projects: this.sql.one(`SELECT count(*) total, sum(eligibility='qualified') qualified, sum(eligibility='needs_review') needs_review, sum(eligibility='rejected') rejected,
        sum(financing_fit='likely') fit_likely, sum(financing_fit='uncertain') fit_uncertain, sum(financing_fit='outside_scope') fit_outside, sum(has_contact) with_contact FROM projects`),
      sources: this.sql.all(`SELECT source_key, backfill_completed_at, run_mode, records_total, last_success_at, last_error FROM source_state ORDER BY source_key`),
      notifications: this.sql.all(`SELECT channel, kind, status, count(*) n FROM notifications GROUP BY 1,2,3`),
    };
  }
}
