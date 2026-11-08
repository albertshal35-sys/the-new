-- IceCap Development Intelligence — initial schema
-- PostgreSQL 16 + PostGIS 3

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Cities and sources (multi-city ready)
-- ---------------------------------------------------------------------------
CREATE TABLE cities (
    id          text PRIMARY KEY,               -- e.g. 'boston'
    name        text NOT NULL,
    state       text NOT NULL,
    timezone    text NOT NULL DEFAULT 'America/New_York',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sources (
    key                 text PRIMARY KEY,       -- e.g. 'boston.a80_projects'
    city_id             text NOT NULL REFERENCES cities(id),
    name                text NOT NULL,
    record_class        text NOT NULL,          -- planning_project | planning_document | permit_application | issued_permit | zoning_appeal | property_record
    official_url        text NOT NULL,
    api_url             text,
    description         text,
    limitations         text,
    publication_cadence text,                   -- human description of upstream cadence
    min_interval_s      integer NOT NULL DEFAULT 300,
    max_interval_s      integer NOT NULL DEFAULT 3600,
    enabled             boolean NOT NULL DEFAULT true,
    is_enrichment_only  boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- Durable per-source scheduling + watermark + health state
CREATE TABLE source_state (
    source_key              text PRIMARY KEY REFERENCES sources(key) ON DELETE CASCADE,
    watermark_ts            timestamptz,        -- newest source data timestamp fully processed
    watermark_cursor        text,
    backfill_completed_at   timestamptz,
    backfill_window_start   timestamptz,
    upstream_version        text,               -- ETag / lastEditDate / CKAN last_modified
    upstream_updated_at     timestamptz,        -- when the provider says the data last changed
    etag                    text,
    last_modified           text,
    next_run_at             timestamptz NOT NULL DEFAULT now(),
    current_interval_s      integer NOT NULL DEFAULT 300,
    lease_owner             text,
    lease_expires_at        timestamptz,
    last_run_started_at     timestamptz,
    last_check_at           timestamptz,        -- last time we contacted the source (even if unchanged)
    last_success_at         timestamptz,
    last_change_detected_at timestamptz,
    last_error_at           timestamptz,
    last_error              text,
    consecutive_failures    integer NOT NULL DEFAULT 0,
    circuit_open_until      timestamptz,
    newest_record_at        timestamptz,        -- newest source_filing_date / data timestamp seen
    records_total           integer NOT NULL DEFAULT 0,
    last_run_stats          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX source_state_next_run_idx ON source_state (next_run_at);

CREATE TABLE ingestion_runs (
    id              bigserial PRIMARY KEY,
    source_key      text NOT NULL REFERENCES sources(key),
    mode            text NOT NULL,              -- backfill | incremental | snapshot | check
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    status          text NOT NULL DEFAULT 'running', -- running | success | unchanged | error | skipped
    window_start    timestamptz,
    window_end      timestamptz,
    pages           integer NOT NULL DEFAULT 0,
    fetched         integer NOT NULL DEFAULT 0,
    inserted        integer NOT NULL DEFAULT 0,
    changed         integer NOT NULL DEFAULT 0,
    unchanged       integer NOT NULL DEFAULT 0,
    qualified       integer NOT NULL DEFAULT 0,
    needs_review    integer NOT NULL DEFAULT 0,
    rejected        integer NOT NULL DEFAULT 0,
    events          integer NOT NULL DEFAULT 0,
    http_requests   integer NOT NULL DEFAULT 0,
    duration_ms     integer,
    error           text
);
CREATE INDEX ingestion_runs_source_started_idx ON ingestion_runs (source_key, started_at DESC);

-- ---------------------------------------------------------------------------
-- Raw records (original payloads, versioned)
-- ---------------------------------------------------------------------------
CREATE TABLE raw_records (
    id                  bigserial PRIMARY KEY,
    source_key          text NOT NULL REFERENCES sources(key),
    source_record_id    text NOT NULL,
    content_hash        text NOT NULL,
    payload             jsonb NOT NULL,
    source_url          text,
    source_filing_date  date,
    source_updated_at   timestamptz,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    last_changed_at     timestamptz NOT NULL DEFAULT now(),
    version             integer NOT NULL DEFAULT 1,
    removed_upstream_at timestamptz,
    UNIQUE (source_key, source_record_id)
);
CREATE INDEX raw_records_filing_date_idx ON raw_records (source_key, source_filing_date DESC);

CREATE TABLE raw_record_versions (
    id              bigserial PRIMARY KEY,
    raw_record_id   bigint NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
    version         integer NOT NULL,
    content_hash    text NOT NULL,
    payload         jsonb NOT NULL,
    changed_fields  jsonb,
    observed_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (raw_record_id, version)
);

-- ---------------------------------------------------------------------------
-- Entities (developers, proponents, applicants, owners …)
-- ---------------------------------------------------------------------------
CREATE TABLE entities (
    id          bigserial PRIMARY KEY,
    name        text NOT NULL,
    name_norm   text NOT NULL UNIQUE,
    kind        text NOT NULL DEFAULT 'unknown',   -- organization | person | unknown
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entities_name_trgm_idx ON entities USING gin (name_norm gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Projects (deduplicated development projects, linked across sources)
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
    id                  bigserial PRIMARY KEY,
    city_id             text NOT NULL REFERENCES cities(id),
    link_key            text NOT NULL UNIQUE,      -- a80:<id> | app:<apno> | parcel:<pid> | addr:<norm>
    a80_project_id      text UNIQUE,
    name                text,
    address             text,
    address_norm        text,
    address_keys        text[] NOT NULL DEFAULT '{}',  -- '<number>|<street core>' tokens used for cross-source linking
    project_slug        text,          -- bostonplans.org project page slug
    parcel_id           text,
    neighborhood        text,
    zip                 text,
    geom                geography(Point, 4326),
    property_type       text,          -- single_family | two_to_four_family | multifamily | mixed_use | unknown
    project_types       text[] NOT NULL DEFAULT '{}', -- new_construction, demolition_rebuild, conversion, substantial_rehab, addition, mixed_use
    is_mixed_use        boolean,
    units_proposed      integer,
    units_existing      integer,
    units_source        text,          -- structured field / text extraction source
    units_confidence    text,          -- high | medium | low | unknown
    gross_sqft          integer,
    retail_sqft         integer,
    land_sqft           integer,
    construction_type   text,
    proposed_cost       numeric,       -- official stated project cost (A80 ProposedCost) if any
    declared_valuation  numeric,       -- sum of declared construction valuation on linked permits (NOT a loan request)
    stage               text,
    stage_rank          integer,
    review_status       text,
    lending_category    text,          -- construction | heavy_rehab | bridge | conversion | unknown
    est_tdc_low         numeric,
    est_tdc_high        numeric,
    est_loan_low        numeric,
    est_loan_high       numeric,
    financing_basis     jsonb NOT NULL DEFAULT '{}'::jsonb,
    financing_fit       text NOT NULL DEFAULT 'uncertain', -- likely | uncertain | outside_scope
    eligibility         text NOT NULL DEFAULT 'needs_review', -- qualified | needs_review | rejected
    eligibility_reasons text[] NOT NULL DEFAULT '{}',
    score               integer,
    score_breakdown     jsonb NOT NULL DEFAULT '{}'::jsonb,
    confidence          text NOT NULL DEFAULT 'low',
    missing_data        text[] NOT NULL DEFAULT '{}',
    has_contact         boolean NOT NULL DEFAULT false,
    developer_entity_id bigint REFERENCES entities(id),
    new_project_event_id bigint,       -- event that announced (or, during backfill, silently recorded) this project as qualifying
    first_filing_date   date,
    latest_filing_date  date,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_activity_at    timestamptz NOT NULL DEFAULT now(),
    project_url         text,
    description         text,
    pipeline_status     text NOT NULL DEFAULT 'New',
    is_read             boolean NOT NULL DEFAULT false,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_feed_idx ON projects (first_seen_at DESC, id DESC);
CREATE INDEX projects_latest_filing_idx ON projects (latest_filing_date DESC NULLS LAST, id DESC);
CREATE INDEX projects_parcel_idx ON projects (parcel_id);
CREATE INDEX projects_addr_idx ON projects (address_norm);
CREATE INDEX projects_dev_idx ON projects (developer_entity_id);
CREATE INDEX projects_elig_idx ON projects (eligibility, first_seen_at DESC);
CREATE INDEX projects_neighborhood_idx ON projects (neighborhood);
CREATE INDEX projects_pipeline_idx ON projects (pipeline_status);
CREATE INDEX projects_geom_idx ON projects USING gist (geom);
CREATE INDEX projects_addr_keys_idx ON projects USING gin (address_keys);
CREATE INDEX projects_slug_idx ON projects (project_slug);

-- ---------------------------------------------------------------------------
-- Filings (one normalized row per source record)
-- ---------------------------------------------------------------------------
CREATE TABLE filings (
    id                  bigserial PRIMARY KEY,
    source_key          text NOT NULL REFERENCES sources(key),
    source_record_id    text NOT NULL,
    raw_record_id       bigint NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
    project_id          bigint REFERENCES projects(id) ON DELETE SET NULL,
    record_class        text NOT NULL,     -- planning_project | planning_document | permit_application | issued_permit | certificate_of_occupancy | zoning_appeal
    filing_kind         text NOT NULL,     -- developer_filing | approval | community_engagement | administrative | application | permit | appeal | completion | project_record
    title               text,
    doc_type            text,
    address             text,
    address_norm        text,
    address_keys        text[] NOT NULL DEFAULT '{}',
    parcel_id           text,
    neighborhood        text,
    zip                 text,
    geom                geography(Point, 4326),
    units_proposed      integer,
    units_existing      integer,
    units_source        text,
    gross_sqft          integer,
    retail_sqft         integer,
    declared_valuation  numeric,
    proposed_cost       numeric,
    property_type       text,
    project_types       text[] NOT NULL DEFAULT '{}',
    is_mixed_use        boolean,
    status              text,
    stage               text,
    description         text,
    people              jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{role, name, source_field}]
    contacts            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{kind, value, role_label, source_field}]
    related_ids         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {application_number, a80_project_id, salesforce_id, ...}
    document_url        text,
    source_url          text,
    source_filing_date  date,
    source_updated_at   timestamptz,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_changed_at     timestamptz NOT NULL DEFAULT now(),
    material_fingerprint text NOT NULL,
    eligibility         text NOT NULL,
    eligibility_reasons text[] NOT NULL DEFAULT '{}',
    UNIQUE (source_key, source_record_id)
);
CREATE INDEX filings_first_seen_idx ON filings (first_seen_at DESC, id DESC);
CREATE INDEX filings_filing_date_idx ON filings (source_filing_date DESC NULLS LAST, id DESC);
CREATE INDEX filings_project_idx ON filings (project_id, source_filing_date DESC);
CREATE INDEX filings_parcel_idx ON filings (parcel_id);
CREATE INDEX filings_addr_idx ON filings (address_norm);
CREATE INDEX filings_elig_idx ON filings (eligibility, first_seen_at DESC);
CREATE INDEX filings_addr_keys_idx ON filings USING gin (address_keys);
CREATE INDEX filings_unlinked_idx ON filings (id) WHERE project_id IS NULL;
CREATE INDEX filings_related_app_idx ON filings ((related_ids->>'application_number'));

-- Role-labeled people/organizations per project (with source attribution)
CREATE TABLE project_entities (
    id                  bigserial PRIMARY KEY,
    project_id          bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    entity_id           bigint NOT NULL REFERENCES entities(id),
    role                text NOT NULL,    -- developer | proponent | owner_of_record | applicant | architect | engineer | contractor | contact_person | planning_staff | zba_contact
    source_key          text NOT NULL,
    source_record_id    text,
    source_url          text,
    evidence            text,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, entity_id, role)
);
CREATE INDEX project_entities_entity_idx ON project_entities (entity_id);

CREATE TABLE contacts (
    id              bigserial PRIMARY KEY,
    project_id      bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    entity_id       bigint REFERENCES entities(id),
    kind            text NOT NULL,    -- phone | email | mailing_address
    value           text NOT NULL,
    role_label      text NOT NULL,    -- whose contact this is, exactly as attributed by the source
    is_city_staff   boolean NOT NULL DEFAULT false,
    source_key      text NOT NULL,
    source_url      text,
    observed_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, kind, value)
);

-- ---------------------------------------------------------------------------
-- Events and notifications
-- ---------------------------------------------------------------------------
CREATE TABLE project_events (
    id                  bigserial PRIMARY KEY,
    project_id          bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filing_id           bigint REFERENCES filings(id) ON DELETE SET NULL,
    event_type          text NOT NULL,  -- new_project | new_filing | units_changed | new_plan_submission | approval | permit_issued | status_changed | stage_changed
    summary             text NOT NULL,
    details             jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_filing_date  date,
    source_published_at timestamptz,    -- best evidence of public availability (provider update time)
    detected_at         timestamptz NOT NULL DEFAULT now(),
    dedupe_key          text NOT NULL UNIQUE,
    alertable           boolean NOT NULL DEFAULT false,
    suppressed_reason   text,           -- backfill | below_threshold | not_qualified | ...
    alerted_at          timestamptz
);
CREATE INDEX project_events_detected_idx ON project_events (detected_at DESC, id DESC);
CREATE INDEX project_events_project_idx ON project_events (project_id, detected_at DESC);

CREATE TABLE notifications (
    id                  bigserial PRIMARY KEY,
    event_id            bigint REFERENCES project_events(id) ON DELETE CASCADE,
    kind                text NOT NULL DEFAULT 'alert',  -- alert | daily_digest | weekly_report
    channel             text NOT NULL,                  -- telegram | email
    dedupe_key          text NOT NULL UNIQUE,
    subject             text,
    body                text NOT NULL,
    status              text NOT NULL DEFAULT 'pending', -- pending | sending | sent | mocked | failed | dead | suppressed
    attempts            integer NOT NULL DEFAULT 0,
    max_attempts        integer NOT NULL DEFAULT 6,
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    last_error          text,
    provider_message_id text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz
);
CREATE INDEX notifications_due_idx ON notifications (status, next_attempt_at);
CREATE INDEX notifications_created_idx ON notifications (created_at DESC);

-- ---------------------------------------------------------------------------
-- Enrichment caches
-- ---------------------------------------------------------------------------
CREATE TABLE parcel_assessments (
    parcel_id       text PRIMARY KEY,
    owner           text,
    mail_address    text,
    land_use        text,
    res_units       integer,
    land_sf         integer,
    gross_area      integer,
    total_value     numeric,
    yr_built        integer,
    payload         jsonb NOT NULL,
    source_url      text,
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    found           boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- App state: settings, saved searches, pipeline history, scheduled jobs
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saved_searches (
    id          bigserial PRIMARY KEY,
    name        text NOT NULL,
    query       jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pipeline_history (
    id          bigserial PRIMARY KEY,
    project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_status text,
    to_status   text NOT NULL,
    note        text,
    changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_jobs (
    key             text PRIMARY KEY,   -- daily_digest | weekly_report | enrichment
    next_run_at     timestamptz NOT NULL,
    last_run_at     timestamptz,
    last_status     text,
    last_error      text
);
