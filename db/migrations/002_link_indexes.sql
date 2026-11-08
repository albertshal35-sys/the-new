-- Indexes for cross-source linking by permit application / ZBA numbers and project slug.
CREATE INDEX IF NOT EXISTS filings_related_zba_app_idx ON filings ((related_ids->>'zba_application_number'));
CREATE INDEX IF NOT EXISTS filings_related_boa_idx ON filings ((related_ids->>'boa_apno'));
CREATE INDEX IF NOT EXISTS filings_related_a80_idx ON filings ((related_ids->>'a80_project_id'));
CREATE INDEX IF NOT EXISTS filings_related_slug_idx ON filings ((related_ids->>'project_slug'));
CREATE INDEX IF NOT EXISTS projects_lower_name_idx ON projects (lower(name));
