/** SQLite schema for the IceCapStore Durable Object. Each entry runs once, in order. */
export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE sources (
      key TEXT PRIMARY KEY, city_id TEXT NOT NULL, name TEXT NOT NULL, record_class TEXT NOT NULL,
      official_url TEXT NOT NULL, api_url TEXT, description TEXT, limitations TEXT, cadence TEXT,
      min_interval_s INTEGER NOT NULL, max_interval_s INTEGER NOT NULL, is_enrichment_only INTEGER NOT NULL DEFAULT 0,
      backfill_order INTEGER NOT NULL DEFAULT 50)`,
    `CREATE TABLE source_state (
      source_key TEXT PRIMARY KEY, watermark_ts TEXT, backfill_completed_at TEXT, upstream_version TEXT,
      upstream_updated_at TEXT, next_run_at TEXT NOT NULL, current_interval_s INTEGER NOT NULL,
      last_check_at TEXT, last_success_at TEXT, last_change_detected_at TEXT, last_error_at TEXT, last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0, circuit_open_until TEXT, newest_record_at TEXT,
      records_total INTEGER NOT NULL DEFAULT 0, stats TEXT NOT NULL DEFAULT '{}',
      run_id INTEGER, run_mode TEXT, run_window_start TEXT, run_window_end TEXT, run_cursor TEXT,
      run_started_at TEXT, run_upstream TEXT)`,
    `CREATE TABLE ingestion_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL, mode TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL DEFAULT 'running',
      window_start TEXT, window_end TEXT, chunks INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
      fetched INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0,
      unchanged INTEGER NOT NULL DEFAULT 0, qualified INTEGER NOT NULL DEFAULT 0, needs_review INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0, events INTEGER NOT NULL DEFAULT 0, http_requests INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0, error TEXT)`,
    `CREATE INDEX ingestion_runs_src ON ingestion_runs (source_key, id DESC)`,
    `CREATE TABLE raw_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL, source_record_id TEXT NOT NULL,
      content_hash TEXT NOT NULL, payload TEXT NOT NULL, source_url TEXT, source_filing_date TEXT,
      source_updated_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_changed_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, removed_upstream_at TEXT, UNIQUE (source_key, source_record_id))`,
    `CREATE TABLE raw_record_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, raw_record_id INTEGER NOT NULL, version INTEGER NOT NULL,
      previous_payload TEXT NOT NULL, changed_fields TEXT, observed_at TEXT NOT NULL)`,
    `CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'unknown')`,
    `CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, link_key TEXT NOT NULL UNIQUE, a80_project_id TEXT UNIQUE, name TEXT,
      address TEXT, address_norm TEXT, project_slug TEXT, parcel_id TEXT, neighborhood TEXT, zip TEXT, lat REAL, lon REAL,
      property_type TEXT, project_types TEXT NOT NULL DEFAULT '[]', is_mixed_use INTEGER, units_proposed INTEGER,
      units_existing INTEGER, units_source TEXT, units_confidence TEXT, gross_sqft INTEGER, retail_sqft INTEGER,
      proposed_cost REAL, declared_valuation REAL, stage TEXT, stage_rank INTEGER, review_status TEXT,
      lending_category TEXT, est_tdc_low REAL, est_tdc_high REAL, est_loan_low REAL, est_loan_high REAL,
      financing_basis TEXT NOT NULL DEFAULT '{}', financing_fit TEXT NOT NULL DEFAULT 'uncertain',
      eligibility TEXT NOT NULL DEFAULT 'needs_review', eligibility_reasons TEXT NOT NULL DEFAULT '[]', score INTEGER,
      score_breakdown TEXT NOT NULL DEFAULT '{}', confidence TEXT NOT NULL DEFAULT 'low',
      missing_data TEXT NOT NULL DEFAULT '[]', has_contact INTEGER NOT NULL DEFAULT 0, developer_entity_id INTEGER,
      new_project_event_id INTEGER, first_filing_date TEXT, latest_filing_date TEXT, first_seen_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL, project_url TEXT, description TEXT, pipeline_status TEXT NOT NULL DEFAULT 'New',
      is_read INTEGER NOT NULL DEFAULT 0, notes TEXT, updated_at TEXT NOT NULL)`,
    `CREATE INDEX projects_feed ON projects (first_seen_at DESC, id DESC)`,
    `CREATE INDEX projects_filed ON projects (latest_filing_date DESC, id DESC)`,
    `CREATE INDEX projects_elig ON projects (eligibility, first_seen_at DESC)`,
    `CREATE INDEX projects_parcel ON projects (parcel_id)`,
    `CREATE INDEX projects_slug ON projects (project_slug)`,
    `CREATE INDEX projects_dev ON projects (developer_entity_id)`,
    `CREATE INDEX projects_name ON projects (lower(name))`,
    `CREATE TABLE project_keys (key TEXT NOT NULL, project_id INTEGER NOT NULL, PRIMARY KEY (key, project_id))`,
    `CREATE TABLE filings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL, source_record_id TEXT NOT NULL,
      raw_record_id INTEGER NOT NULL, project_id INTEGER, record_class TEXT NOT NULL, filing_kind TEXT NOT NULL,
      title TEXT, doc_type TEXT, address TEXT, address_norm TEXT, parcel_id TEXT, neighborhood TEXT, zip TEXT,
      lat REAL, lon REAL, units_proposed INTEGER, units_existing INTEGER, units_source TEXT, gross_sqft INTEGER,
      retail_sqft INTEGER, declared_valuation REAL, proposed_cost REAL, project_types TEXT NOT NULL DEFAULT '[]',
      is_mixed_use INTEGER, status TEXT, stage TEXT, description TEXT, people TEXT NOT NULL DEFAULT '[]',
      contacts TEXT NOT NULL DEFAULT '[]', related_ids TEXT NOT NULL DEFAULT '{}',
      application_number TEXT, zba_application_number TEXT, a80_project_id TEXT, project_slug TEXT,
      document_url TEXT, source_url TEXT, project_url TEXT, source_filing_date TEXT, source_updated_at TEXT,
      first_seen_at TEXT NOT NULL, last_changed_at TEXT NOT NULL, material_fingerprint TEXT NOT NULL,
      eligibility TEXT NOT NULL, eligibility_reasons TEXT NOT NULL DEFAULT '[]', UNIQUE (source_key, source_record_id))`,
    `CREATE INDEX filings_feed ON filings (first_seen_at DESC, id DESC)`,
    `CREATE INDEX filings_filed ON filings (source_filing_date DESC, id DESC)`,
    `CREATE INDEX filings_project ON filings (project_id)`,
    `CREATE INDEX filings_parcel ON filings (parcel_id)`,
    `CREATE INDEX filings_app ON filings (application_number)`,
    `CREATE INDEX filings_zba_app ON filings (zba_application_number)`,
    `CREATE INDEX filings_a80 ON filings (a80_project_id)`,
    `CREATE INDEX filings_slug ON filings (project_slug)`,
    `CREATE INDEX filings_elig ON filings (eligibility, first_seen_at DESC)`,
    `CREATE TABLE filing_keys (key TEXT NOT NULL, filing_id INTEGER NOT NULL, PRIMARY KEY (key, filing_id))`,
    `CREATE TABLE project_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, role TEXT NOT NULL,
      source_key TEXT NOT NULL, source_record_id TEXT, source_url TEXT, evidence TEXT, first_seen_at TEXT NOT NULL,
      UNIQUE (project_id, entity_id, role))`,
    `CREATE INDEX project_entities_entity ON project_entities (entity_id)`,
    `CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
      role_label TEXT NOT NULL, is_city_staff INTEGER NOT NULL DEFAULT 0, source_key TEXT NOT NULL, source_url TEXT,
      observed_at TEXT NOT NULL, UNIQUE (project_id, kind, value))`,
    `CREATE TABLE project_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, filing_id INTEGER, event_type TEXT NOT NULL,
      summary TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', source_filing_date TEXT, source_published_at TEXT,
      detected_at TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, alertable INTEGER NOT NULL DEFAULT 0,
      suppressed_reason TEXT, alerted_at TEXT)`,
    `CREATE INDEX project_events_detected ON project_events (detected_at DESC, id DESC)`,
    `CREATE INDEX project_events_project ON project_events (project_id)`,
    `CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, kind TEXT NOT NULL DEFAULT 'alert', channel TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE, subject TEXT, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 6, next_attempt_at TEXT NOT NULL,
      last_error TEXT, provider_message_id TEXT, created_at TEXT NOT NULL, sent_at TEXT)`,
    `CREATE INDEX notifications_due ON notifications (status, next_attempt_at)`,
    `CREATE TABLE parcel_assessments (
      parcel_id TEXT PRIMARY KEY, owner TEXT, mail_address TEXT, land_use TEXT, res_units INTEGER, land_sf INTEGER,
      gross_area INTEGER, total_value REAL, yr_built INTEGER, found INTEGER NOT NULL DEFAULT 1, fetched_at TEXT NOT NULL)`,
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE saved_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL,
      qs TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE pipeline_history (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
      from_status TEXT, to_status TEXT NOT NULL, changed_at TEXT NOT NULL)`,
    `CREATE TABLE scheduled_jobs (key TEXT PRIMARY KEY, next_run_at TEXT NOT NULL, last_run_at TEXT,
      last_status TEXT, last_error TEXT)`,
  ],
];

import type { Sql } from "./sql";

export function migrate(sql: Sql): void {
  sql.run(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const done = new Set(sql.all<{ version: number }>(`SELECT version FROM _migrations`).map((r) => r.version));
  MIGRATIONS.forEach((stmts, i) => {
    const v = i + 1;
    if (done.has(v)) return;
    sql.tx(() => {
      for (const s of stmts) sql.run(s);
      sql.run(`INSERT INTO _migrations (version, applied_at) VALUES (?, ?)`, v, new Date().toISOString());
    });
  });
}
