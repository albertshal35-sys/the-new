/** Ingestion pipeline (synchronous SQLite): raw versioning → normalize → eligibility → link → recompute → events. */
import type { Adapter } from "./adapters/types";
import { formatAlert, quietHoursRelease } from "./notify";
import {
  classifyFiling, DEV_TYPES, estimateFinancing, evaluateProject, materialValues, pickUnits, score, stageRank,
  type Filing, type FilingRow, type RawRecord, type Settings,
} from "./logic";
import { b, j, nowIso, pj, type Row, type Sql } from "./sql";
import { addressKeys, changedFields, entityKind, hash, normalizeAddress, normalizeEntityName } from "./text";

export const ENRICHMENT_SOURCES = new Set(["boston.a80_legacy"]);
const MAX_LINK_DISTANCE_M = 200;

export interface RunCtx { mode: string; alertsEnabled: boolean; publishedAt: string | null; stats: Record<string, number> }
export const newStats = () => ({ fetched: 0, inserted: 0, changed: 0, unchanged: 0, qualified: 0, needs_review: 0, rejected: 0, events: 0, alerts_queued: 0, errors: 0 });

export interface PipelineEnv { channels: string[]; dashboardUrl: string }

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const inList = (n: number) => Array(n).fill("?").join(",");

export class Pipeline {
  constructor(private sql: Sql, private settings: Settings, private env: PipelineEnv) {}

  processPage(adapter: Adapter, raws: RawRecord[], ctx: RunCtx, force = false): void {
    const byId = new Map<string, RawRecord>();
    for (const r of raws) byId.set(r.sourceRecordId, r);
    ctx.stats.fetched += byId.size;
    const ids = [...byId.keys()];
    const existing = new Map<string, Row>();
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      for (const row of this.sql.all(`SELECT id, source_record_id, content_hash FROM raw_records WHERE source_key=? AND source_record_id IN (${inList(chunk.length)})`, adapter.meta.key, ...chunk))
        existing.set(row.source_record_id, row);
    }
    const now = nowIso();
    const unchanged: number[] = [];
    for (const [rid, raw] of byId) {
      const h = hash(raw.payload);
      const ex = existing.get(rid);
      if (ex && ex.content_hash === h && !force) { unchanged.push(ex.id); continue; }
      try {
        this.sql.tx(() => this.processRecord(adapter, raw, h, ctx));
      } catch (e) {
        ctx.stats.errors++;
        console.error(`process ${adapter.meta.key} ${rid}:`, e);
      }
    }
    for (let i = 0; i < unchanged.length; i += 90) {
      const c = unchanged.slice(i, i + 90);
      this.sql.run(`UPDATE raw_records SET last_seen_at=?, removed_upstream_at=NULL WHERE id IN (${inList(c.length)})`, now, ...c);
    }
    ctx.stats.unchanged += unchanged.length;
  }

  processRecord(adapter: Adapter, raw: RawRecord, h: string, ctx: RunCtx): void {
    const biz = this.settings.business;
    const f = adapter.normalize(raw);
    if (!f) return;
    if (f.linkByOfficialIdOnly && !f.canCreateProject) [f.eligibility, f.eligibilityReasons] = ["rejected", ["enrichment_only_record"]];
    else [f.eligibility, f.eligibilityReasons] = classifyFiling(f, biz.min_units, biz.max_units);
    ctx.stats[f.eligibility] = (ctx.stats[f.eligibility] ?? 0) + 1;
    const now = nowIso();

    // raw record + version history
    const oldRaw = this.sql.one(`SELECT id, version, payload, content_hash FROM raw_records WHERE source_key=? AND source_record_id=?`, raw.sourceKey, raw.sourceRecordId);
    let rawId: number;
    if (oldRaw && oldRaw.content_hash === h) {
      rawId = oldRaw.id;
      ctx.stats.unchanged++;
    } else if (!oldRaw) {
      rawId = this.sql.one<{ id: number }>(`INSERT INTO raw_records (source_key, source_record_id, content_hash, payload, source_url, source_filing_date, source_updated_at, first_seen_at, last_seen_at, last_changed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`, raw.sourceKey, raw.sourceRecordId, h, j(raw.payload), raw.sourceUrl ?? null,
        raw.sourceFilingDate ?? null, raw.sourceUpdatedAt ?? null, now, now, now)!.id;
      ctx.stats.inserted++;
    } else {
      rawId = oldRaw.id;
      this.sql.run(`INSERT INTO raw_record_versions (raw_record_id, version, previous_payload, changed_fields, observed_at) VALUES (?,?,?,?,?)`,
        rawId, oldRaw.version, oldRaw.payload, j(changedFields(pj(oldRaw.payload, {}), raw.payload)), now);
      this.sql.run(`UPDATE raw_records SET content_hash=?, payload=?, source_url=?, source_filing_date=?, source_updated_at=?, last_seen_at=?, last_changed_at=?, version=version+1, removed_upstream_at=NULL WHERE id=?`,
        h, j(raw.payload), raw.sourceUrl ?? null, raw.sourceFilingDate ?? null, raw.sourceUpdatedAt ?? null, now, now, rawId);
      ctx.stats.changed++;
    }

    // filing
    const fp = hash(materialValues(f));
    const old = this.sql.one(`SELECT id, material_fingerprint, units_proposed, stage, status, project_id, source_filing_date FROM filings WHERE source_key=? AND source_record_id=?`, f.sourceKey, f.sourceRecordId);
    const filingId = this.upsertFiling(f, rawId, fp, old, now);

    // linking
    let projectId: number | null = old?.project_id ?? null;
    let created = false;
    if (projectId === null) {
      projectId = this.findProject(f);
      if (projectId === null && f.canCreateProject && f.inWindow && f.eligibility !== "rejected") {
        [projectId, created] = this.createProject(f, now);
      }
      if (projectId !== null) {
        this.sql.run(`UPDATE filings SET project_id=? WHERE id=?`, projectId, filingId);
        if (created && this.attachOrphans(projectId) > 0) this.syncPartiesFromFilings(projectId, now);
      }
    }
    if (projectId === null) return;
    if (f.linkByOfficialIdOnly && old) {
      const pa = this.sql.one(`SELECT a80_project_id FROM projects WHERE id=?`, projectId);
      if (!pa || pa.a80_project_id !== String(f.relatedIds.a80_project_id)) {
        this.sql.run(`UPDATE filings SET project_id=NULL WHERE id=?`, filingId);
        this.recompute(projectId);
        return;
      }
    }
    if (f.sourceKey === "boston.a80_projects" && f.relatedIds.a80_project_id) {
      const taken = this.sql.one(`SELECT id FROM projects WHERE a80_project_id=? AND id<>?`, String(f.relatedIds.a80_project_id), projectId);
      if (!taken) this.sql.run(`UPDATE projects SET a80_project_id=COALESCE(a80_project_id, ?), project_slug=COALESCE(project_slug, ?) WHERE id=?`,
        String(f.relatedIds.a80_project_id), f.relatedIds.project_slug ?? null, projectId);
    }
    this.syncParties(projectId, f, now);
    const after = this.recompute(projectId);

    const material = old !== null && old.material_fingerprint !== fp;
    if (!old || material) this.emitEvents(f, filingId, old, after, created, ctx);
    else if (!ENRICHMENT_SOURCES.has(f.sourceKey)) this.ensureAnnouncement(after, filingId, f, created, ctx);
  }

  private upsertFiling(f: Filing, rawId: number, fp: string, old: Row | null, now: string): number {
    const vals = [f.recordClass, f.filingKind, f.title ?? null, f.docType ?? null, f.address ?? null, normalizeAddress(f.address),
      f.parcelId ?? null, f.neighborhood ?? null, f.zip ?? null, f.lat ?? null, f.lon ?? null, f.unitsProposed ?? null,
      f.unitsExisting ?? null, f.unitsSource ?? null, f.grossSqft ?? null, f.retailSqft ?? null, f.declaredValuation ?? null,
      f.proposedCost ?? null, j(f.projectTypes), b(f.isMixedUse), f.status ?? null, f.stage ?? null, f.description ?? null,
      j(f.people), j(f.contacts), j(f.relatedIds), f.relatedIds.application_number ?? null,
      f.relatedIds.zba_application_number ?? f.relatedIds.boa_apno ?? null, f.relatedIds.a80_project_id ? String(f.relatedIds.a80_project_id) : null,
      f.relatedIds.project_slug ?? null, f.documentUrl ?? null, f.sourceUrl ?? null, f.projectUrl ?? null,
      f.sourceFilingDate ?? null, f.sourceUpdatedAt ?? null, fp, f.eligibility, j(f.eligibilityReasons)] as const;
    const cols = `record_class, filing_kind, title, doc_type, address, address_norm, parcel_id, neighborhood, zip, lat, lon,
      units_proposed, units_existing, units_source, gross_sqft, retail_sqft, declared_valuation, proposed_cost, project_types,
      is_mixed_use, status, stage, description, people, contacts, related_ids, application_number, zba_application_number,
      a80_project_id, project_slug, document_url, source_url, project_url, source_filing_date, source_updated_at,
      material_fingerprint, eligibility, eligibility_reasons`;
    let id: number;
    if (!old) {
      id = this.sql.one<{ id: number }>(`INSERT INTO filings (source_key, source_record_id, raw_record_id, first_seen_at, last_changed_at, ${cols})
        VALUES (?,?,?,?,?, ${inList(vals.length)}) RETURNING id`, f.sourceKey, f.sourceRecordId, rawId, now, now, ...vals)!.id;
    } else {
      id = old.id;
      const set = cols.split(",").map((c) => `${c.trim()}=?`).join(", ");
      this.sql.run(`UPDATE filings SET raw_record_id=?, last_changed_at=CASE WHEN material_fingerprint<>? THEN ? ELSE last_changed_at END, ${set} WHERE id=?`,
        rawId, fp, now, ...vals, id);
      this.sql.run(`DELETE FROM filing_keys WHERE filing_id=?`, id);
    }
    for (const k of addressKeys(f.address)) this.sql.run(`INSERT OR IGNORE INTO filing_keys (key, filing_id) VALUES (?,?)`, k, id);
    return id;
  }

  // ---------------------------------------------------------------- linking (validated relationships only)
  findProject(f: Filing): number | null {
    const rid = f.relatedIds;
    if (rid.a80_project_id) {
      const r = this.sql.one(`SELECT id FROM projects WHERE a80_project_id=?`, String(rid.a80_project_id));
      if (r) return r.id;
    }
    if (f.linkByOfficialIdOnly) return null;
    if (rid.project_slug) {
      const r = this.sql.one(`SELECT id FROM projects WHERE project_slug=? ORDER BY id LIMIT 1`, rid.project_slug);
      if (r) return r.id;
    }
    for (const app of [rid.application_number, rid.zba_application_number, rid.boa_apno].filter(Boolean)) {
      const r = this.sql.one(`SELECT project_id FROM filings WHERE project_id IS NOT NULL AND (application_number=? OR zba_application_number=?) LIMIT 1`, app, app);
      if (r) return r.project_id;
    }
    if (f.parcelId) {
      const r = this.sql.one(`SELECT id FROM projects WHERE parcel_id=? ORDER BY last_activity_at DESC LIMIT 1`, f.parcelId);
      if (r) return r.id;
    }
    const keys = addressKeys(f.address);
    if (keys.length) {
      const cands = this.sql.all(`SELECT DISTINCT p.id, p.lat, p.lon, p.parcel_id, p.a80_project_id, p.last_activity_at FROM project_keys k JOIN projects p ON p.id=k.project_id
        WHERE k.key IN (${inList(Math.min(keys.length, 90))})`, ...keys.slice(0, 90));
      const ok = cands.filter((p) => (p.lat === null || f.lat == null || haversineM(p.lat, p.lon, f.lat!, f.lon!) <= MAX_LINK_DISTANCE_M)
        && (p.parcel_id === null || !f.parcelId || p.parcel_id === f.parcelId || p.a80_project_id !== null));
      ok.sort((a, c) => (c.a80_project_id !== null ? 1 : 0) - (a.a80_project_id !== null ? 1 : 0) || String(c.last_activity_at).localeCompare(String(a.last_activity_at)));
      if (ok.length) return ok[0].id;
    }
    if (f.recordClass === "planning_document" && f.address) {
      const r = this.sql.one(`SELECT id FROM projects WHERE lower(name)=lower(?) ORDER BY (a80_project_id IS NOT NULL) DESC LIMIT 1`, f.address);
      if (r) return r.id;
    }
    return null;
  }

  private linkKey(f: Filing): string {
    const rid = f.relatedIds;
    if (rid.a80_project_id) return `a80:${rid.a80_project_id}`;
    if (rid.project_slug) return `slug:${rid.project_slug}`;
    if (rid.application_number) return `app:${rid.application_number}`;
    const keys = addressKeys(f.address);
    if (f.parcelId) return `parcel:${f.parcelId}:${keys[0] ?? ""}`;
    const n = normalizeAddress(f.address);
    return n && keys.length ? `addr:${n}` : `src:${f.sourceKey}:${f.sourceRecordId}`;
  }

  private createProject(f: Filing, now: string): [number, boolean] {
    const key = this.linkKey(f);
    const ex = this.sql.one(`SELECT id FROM projects WHERE link_key=?`, key);
    if (ex) return [ex.id, false];
    const id = this.sql.one<{ id: number }>(`INSERT INTO projects (link_key, a80_project_id, name, address, address_norm, project_slug, parcel_id, neighborhood, zip, lat, lon,
      project_url, description, first_filing_date, latest_filing_date, first_seen_at, last_activity_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      key, f.relatedIds.a80_project_id ? String(f.relatedIds.a80_project_id) : null,
      f.recordClass === "planning_project" ? f.title ?? null : f.address ?? f.title ?? null, f.address ?? null, normalizeAddress(f.address),
      f.relatedIds.project_slug ?? null, f.parcelId ?? null, f.neighborhood ?? null, f.zip ?? null, f.lat ?? null, f.lon ?? null,
      f.projectUrl ?? null, f.description ?? null, f.sourceFilingDate ?? null, f.sourceFilingDate ?? null, now, now, now)!.id;
    for (const k of addressKeys(f.address)) this.sql.run(`INSERT OR IGNORE INTO project_keys (key, project_id) VALUES (?,?)`, k, id);
    return [id, true];
  }

  /** Attach previously unlinked filings sharing an official id, parcel or street address (enrichment: official id only). */
  attachOrphans(projectId: number): number {
    const p = this.sql.one(`SELECT parcel_id, a80_project_id, project_slug FROM projects WHERE id=?`, projectId)!;
    const keys = this.sql.all(`SELECT key FROM project_keys WHERE project_id=?`, projectId).map((r) => r.key);
    const apps = this.sql.all(`SELECT DISTINCT application_number a FROM filings WHERE project_id=? AND application_number IS NOT NULL`, projectId).map((r) => r.a);
    const ids = new Set<number>();
    const add = (rows: Row[]) => rows.forEach((r) => ids.add(r.id));
    const enrich = [...ENRICHMENT_SOURCES];
    const notEnrich = `source_key NOT IN (${inList(enrich.length)})`;
    if (p.parcel_id) add(this.sql.all(`SELECT id FROM filings WHERE project_id IS NULL AND parcel_id=? AND ${notEnrich}`, p.parcel_id, ...enrich));
    for (let i = 0; i < keys.length; i += 80) {
      const c = keys.slice(i, i + 80);
      add(this.sql.all(`SELECT f.id FROM filing_keys k JOIN filings f ON f.id=k.filing_id
        WHERE f.project_id IS NULL AND k.key IN (${inList(c.length)})
          AND (f.parcel_id IS NULL OR ? IS NULL OR f.parcel_id=? OR ? IS NOT NULL) AND f.${notEnrich}`,
        ...c, p.parcel_id, p.parcel_id, p.a80_project_id, ...enrich));
    }
    for (const a of apps) add(this.sql.all(`SELECT id FROM filings WHERE project_id IS NULL AND (application_number=? OR zba_application_number=?)`, a, a));
    if (p.a80_project_id) add(this.sql.all(`SELECT id FROM filings WHERE project_id IS NULL AND a80_project_id=?`, p.a80_project_id));
    if (p.project_slug) add(this.sql.all(`SELECT id FROM filings WHERE project_id IS NULL AND project_slug=? AND ${notEnrich}`, p.project_slug, ...enrich));
    for (const id of ids) this.sql.run(`UPDATE filings SET project_id=? WHERE id=?`, projectId, id);
    return ids.size;
  }

  // ---------------------------------------------------------------- parties
  upsertEntity(name: string): number | null {
    const norm = normalizeEntityName(name);
    if (!norm) return null;
    this.sql.run(`INSERT OR IGNORE INTO entities (name, name_norm, kind) VALUES (?,?,?)`, name, norm, entityKind(name));
    return this.sql.one(`SELECT id FROM entities WHERE name_norm=?`, norm)!.id;
  }
  syncParties(projectId: number, f: Pick<Filing, "people" | "contacts" | "sourceKey" | "sourceRecordId" | "sourceUrl" | "documentUrl">, now: string): void {
    for (const p of f.people) {
      const eid = this.upsertEntity(p.name);
      if (eid === null) continue;
      this.sql.run(`INSERT OR IGNORE INTO project_entities (project_id, entity_id, role, source_key, source_record_id, source_url, evidence, first_seen_at) VALUES (?,?,?,?,?,?,?,?)`,
        projectId, eid, p.role, f.sourceKey, f.sourceRecordId, f.sourceUrl ?? f.documentUrl ?? null, p.evidence ?? p.source_field, now);
    }
    for (const c of f.contacts) {
      this.sql.run(`INSERT OR IGNORE INTO contacts (project_id, kind, value, role_label, is_city_staff, source_key, source_url, observed_at) VALUES (?,?,?,?,?,?,?,?)`,
        projectId, c.kind, c.value, c.role_label, c.is_city_staff ? 1 : 0, f.sourceKey, f.sourceUrl ?? null, now);
    }
  }
  private syncPartiesFromFilings(projectId: number, now: string): void {
    for (const r of this.sql.all(`SELECT source_key, source_record_id, source_url, document_url, people, contacts FROM filings WHERE project_id=? AND (people<>'[]' OR contacts<>'[]')`, projectId))
      this.syncParties(projectId, { sourceKey: r.source_key, sourceRecordId: r.source_record_id, sourceUrl: r.source_url, documentUrl: r.document_url,
        people: pj(r.people, []), contacts: pj(r.contacts, []) }, now);
  }

  // ---------------------------------------------------------------- project recompute
  recompute(projectId: number): Row {
    const before = this.sql.one(`SELECT * FROM projects WHERE id=?`, projectId)!;
    const rows = this.sql.all(`SELECT * FROM filings WHERE project_id=?`, projectId).map((r) => ({
      ...r, project_types: pj<string[]>(r.project_types, []), eligibility_reasons: pj<string[]>(r.eligibility_reasons, []),
    })) as (FilingRow & Row)[];
    const biz = this.settings.business;
    const primary = rows.filter((f) => !ENRICHMENT_SOURCES.has(f.source_key));
    const relevant = primary.filter((f) => f.eligibility !== "rejected").length ? primary.filter((f) => f.eligibility !== "rejected") : primary;
    const [units, unitsExisting, unitsSource, unitsConf] = pickUnits(rows);
    const a80 = primary.find((f) => f.source_key === "boston.a80_projects");
    const withStage = primary.filter((f) => stageRank(f.stage) !== null && f.eligibility !== "rejected");
    const stageCands = withStage.length ? withStage : primary.filter((f) => stageRank(f.stage) !== null);
    let stage: string | null = null;
    if (a80?.stage) {
      stage = a80.stage;
      if (stage !== "complete") for (const f of stageCands) if (f.stage !== "complete" && stageRank(f.stage)! > stageRank(stage)!) stage = f.stage;
    } else for (const f of stageCands) if (stage === null || stageRank(f.stage)! > stageRank(stage)!) stage = f.stage;

    let types: string[] = [];
    for (const f of relevant) for (const t of f.project_types) if (!types.includes(t)) types.push(t);
    if (types.includes("demolition_only")) {
      types = types.filter((t) => t !== "demolition_only");
      if (types.includes("new_construction") && !types.includes("demolition_rebuild")) types.push("demolition_rebuild");
    }
    const mixed = relevant.some((f) => f.is_mixed_use === 1) || types.includes("mixed_use");
    const first = (field: string, prefer = ["boston.a80_projects", "boston.permit_applications", "boston.building_permits", "boston.zba", "boston.records_library", "boston.a80_legacy"]) => {
      for (const sk of prefer) for (const f of rows) if (f.source_key === sk && f[field] !== null && f[field] !== "") return f[field];
      return null;
    };
    const parcel = first("parcel_id", ["boston.permit_applications", "boston.building_permits", "boston.a80_legacy"]);
    const address = a80?.address ?? first("address");
    const lat = first("lat"), lon = first("lon");
    const devPermits = primary.filter((f) => f.record_class === "issued_permit" && f.eligibility !== "rejected" && f.declared_valuation);
    const declared = devPermits.length ? devPermits.reduce((s, f) => s + Number(f.declared_valuation), 0) : null;
    const dates = primary.map((f) => f.source_filing_date).filter(Boolean).sort() as string[];
    const proposedCost = first("proposed_cost", ["boston.a80_legacy"]);

    const roles = this.sql.all(`SELECT pe.role, pe.entity_id FROM project_entities pe WHERE pe.project_id=?`, projectId);
    const dev = roles.find((r) => r.role === "developer") ?? roles.find((r) => r.role === "proponent");
    const hasContact = Boolean(this.sql.one(`SELECT 1 x FROM contacts WHERE project_id=? AND is_city_staff=0 AND kind IN ('phone','email') LIMIT 1`, projectId));
    const entIds = roles.filter((r) => ["developer", "proponent", "owner_of_record"].includes(r.role)).map((r) => r.entity_id);
    let otherProjects: number | null = null;
    if (entIds.length) otherProjects = this.sql.one(`SELECT count(DISTINCT project_id) n FROM project_entities WHERE entity_id IN (${inList(entIds.length)}) AND project_id<>? AND role IN ('developer','proponent','owner_of_record')`, ...entIds, projectId)!.n;

    const [elig, reasons] = evaluateProject(rows, units, stage, biz.min_units, biz.max_units);
    const fin = estimateFinancing({ units_proposed: units, units_confidence: unitsConf, project_types: types, stage, proposed_cost: proposedCost ? Number(proposedCost) : null, declared_valuation: declared }, this.settings);
    const latest = dates.length ? dates[dates.length - 1] : null;
    const missing: string[] = [];
    if (units === null) missing.push("unit count");
    if (!dev) missing.push("developer/proponent");
    if (!hasContact) missing.push("verified contact");
    if (!parcel) missing.push("parcel id");
    if (lat === null) missing.push("coordinates");
    if (fin.est_loan_low === null) missing.push("cost basis");
    const confidence = unitsConf === "high" && (parcel || lat !== null) && stage ? "high" : units !== null ? "medium" : "low";
    const [sc, breakdown] = score({ units_proposed: units, stage, financing_fit: fin.financing_fit, est_loan_high: fin.est_loan_high, latest_filing_date: latest,
      has_verified_contact: hasContact, has_named_developer: Boolean(dev), has_applicant: roles.some((r) => ["applicant", "zba_contact", "owner_of_record"].includes(r.role)),
      developer_other_projects: otherProjects }, this.settings, new Date());
    const ptype = units === null ? (mixed ? "mixed_use" : "unknown") : mixed ? "mixed_use" : units === 1 ? "single_family" : units <= 4 ? "two_to_four_family" : "multifamily";
    const nbhd = a80?.neighborhood ?? first("neighborhood", ["boston.permit_applications", "boston.records_library", "boston.zba", "boston.building_permits"]);
    const changedActivity = before.latest_filing_date !== latest || before.units_proposed !== units || before.stage !== stage;
    const now = nowIso();
    this.sql.run(`UPDATE projects SET name=?, address=?, address_norm=?, parcel_id=?, neighborhood=COALESCE(?, neighborhood), zip=COALESCE(?, zip),
      lat=COALESCE(?, lat), lon=COALESCE(?, lon), property_type=?, project_types=?, is_mixed_use=?, units_proposed=?, units_existing=?, units_source=?,
      units_confidence=?, gross_sqft=?, retail_sqft=?, proposed_cost=?, declared_valuation=?, stage=?, stage_rank=?, review_status=?, lending_category=?,
      est_tdc_low=?, est_tdc_high=?, est_loan_low=?, est_loan_high=?, financing_basis=?, financing_fit=?, eligibility=?, eligibility_reasons=?, score=?,
      score_breakdown=?, confidence=?, missing_data=?, has_contact=?, developer_entity_id=?, first_filing_date=?, latest_filing_date=?,
      project_url=COALESCE(project_url, ?), description=COALESCE(?, description), last_activity_at=?, updated_at=? WHERE id=?`,
      a80?.title ?? before.name ?? address, address, normalizeAddress(address), parcel, nbhd, first("zip"), lat, lon, ptype, j(types), b(mixed),
      units, unitsExisting, unitsSource, unitsConf, first("gross_sqft", ["boston.a80_projects", "boston.a80_legacy", "boston.building_permits"]),
      first("retail_sqft", ["boston.a80_legacy"]), proposedCost, declared, stage, stageRank(stage),
      a80?.status ?? first("status", ["boston.zba", "boston.permit_applications"]), fin.lending_category, fin.est_tdc_low, fin.est_tdc_high,
      fin.est_loan_low, fin.est_loan_high, j(fin.financing_basis), fin.financing_fit, elig, j(reasons), sc, j(breakdown), confidence, j(missing),
      hasContact ? 1 : 0, dev?.entity_id ?? null, dates[0] ?? null, latest, a80?.document_url ?? null, a80?.description ?? null,
      changedActivity ? now : before.last_activity_at, now, projectId);
    for (const k of addressKeys(address)) this.sql.run(`INSERT OR IGNORE INTO project_keys (key, project_id) VALUES (?,?)`, k, projectId);
    return this.sql.one(`SELECT * FROM projects WHERE id=?`, projectId)!;
  }

  // ---------------------------------------------------------------- events & alerts
  private alertDecision(p: Row, type: string, ctx: RunCtx): [boolean, string | null] {
    const a = this.settings.alerts;
    if (!ctx.alertsEnabled) return [false, ctx.mode];
    if (!a.event_types.includes(type)) return [false, "event_type_not_alerted"];
    if (p.eligibility === "qualified") { if (!a.notify_qualified) return [false, "qualified_alerts_disabled"]; }
    else if (p.eligibility === "needs_review") { if (!a.notify_needs_review) return [false, "needs_review"]; }
    else return [false, "not_qualified"];
    if (a.min_score && (p.score ?? 0) < a.min_score) return [false, "below_min_score"];
    if (a.min_units && (p.units_proposed ?? 0) < a.min_units) return [false, "below_min_units"];
    return [true, null];
  }

  private insertEvent(p: Row, filingId: number | null, type: string, summary: string, key: string, details: unknown,
                      filingDate: string | null | undefined, ctx: RunCtx, forceSuppress: string | null = null): Row | null {
    let [alertable, reason] = this.alertDecision(p, type, ctx);
    if (forceSuppress && alertable) [alertable, reason] = [false, forceSuppress];
    if (this.sql.one(`SELECT id FROM project_events WHERE dedupe_key=?`, key)) return null;
    const ev = this.sql.one(`INSERT INTO project_events (project_id, filing_id, event_type, summary, details, source_filing_date, source_published_at, detected_at, dedupe_key, alertable, suppressed_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`, p.id, filingId, type, summary, j(details), filingDate ?? null, ctx.publishedAt, nowIso(), key, alertable ? 1 : 0, reason)!;
    ctx.stats.events++;
    if (alertable) { this.enqueueAlert(ev, p, filingId); ctx.stats.alerts_queued++; }
    return ev;
  }

  ensureAnnouncement(p: Row, filingId: number, f: Filing, created: boolean, ctx: RunCtx): boolean {
    if (p.eligibility !== "qualified" || p.new_project_event_id) return false;
    const ev = this.insertEvent(p, filingId, "new_project",
      created ? `New qualifying project from ${f.sourceKey} (${f.docType ?? f.recordClass})` : `Project now qualifies after ${f.sourceKey} ${f.recordClass} update`,
      `project:${p.id}:${created ? "created" : "qualified"}`, { source_key: f.sourceKey, source_record_id: f.sourceRecordId, reasons: pj(p.eligibility_reasons, []) },
      f.sourceFilingDate, ctx);
    if (!ev) return false;
    this.sql.run(`UPDATE projects SET new_project_event_id=? WHERE id=?`, ev.id, p.id);
    p.new_project_event_id = ev.id;
    return true;
  }

  private emitEvents(f: Filing, filingId: number, old: Row | null, p: Row, created: boolean, ctx: RunCtx): void {
    if (ENRICHMENT_SOURCES.has(f.sourceKey)) return;
    const { sourceKey: sk, sourceRecordId: sid } = f;
    const announced = this.ensureAnnouncement(p, filingId, f, created, ctx);
    const covered = announced ? "covered_by_new_project_alert" : null;
    const devScope = f.projectTypes.some((t) => DEV_TYPES.has(t)) && !f.ordinaryWork;
    if (!old) {
      if (created) {
        if (!announced) this.insertEvent(p, filingId, "new_project", `New project record (${p.eligibility}) from ${sk}`, `project:${p.id}:created`, { source_key: sk }, f.sourceFilingDate, ctx, "not_yet_qualified");
        return;
      }
      let type: string, summary: string;
      if (f.filingKind === "developer_filing" || (f.recordClass === "permit_application" && devScope)) [type, summary] = ["new_plan_submission", `New ${f.docType ?? f.recordClass} filed`];
      else if (f.filingKind === "approval") [type, summary] = ["approval", `Approval: ${f.docType ?? f.status}`];
      else if (f.recordClass === "issued_permit" && devScope) [type, summary] = ["permit_issued", `Issued permit ${sid}: ${f.docType}`];
      else if (f.filingKind === "completion") [type, summary] = ["status_changed", `Certificate of occupancy ${sid}`];
      else [type, summary] = ["new_filing", `Linked ${f.recordClass.replace(/_/g, " ")}: ${f.docType ?? sid}`];
      this.insertEvent(p, filingId, type, summary, `filing:${sk}:${sid}:new`, { source_key: sk, source_record_id: sid, record_class: f.recordClass }, f.sourceFilingDate, ctx, covered);
      return;
    }
    if (old.units_proposed !== (f.unitsProposed ?? null) && f.unitsProposed != null)
      this.insertEvent(p, filingId, "units_changed", `Unit count revised ${old.units_proposed ?? "unknown"} → ${f.unitsProposed} (${sk})`,
        `units:${sk}:${sid}:${old.units_proposed}->${f.unitsProposed}`, { old: old.units_proposed, new: f.unitsProposed }, f.sourceFilingDate, ctx, covered);
    if (old.stage !== (f.stage ?? null) && f.stage) {
      const type = ["board_approved", "zoning_approved"].includes(f.stage) ? "approval" : f.stage === "permit_issued" ? "permit_issued" : "status_changed";
      this.insertEvent(p, filingId, type, `${sk}: status ${old.status ?? old.stage} → ${f.status ?? f.stage}`, `stage:${sk}:${sid}:${f.stage}`,
        { old: old.stage, new: f.stage }, f.sourceFilingDate, ctx, covered);
    }
    if (f.recordClass === "planning_project" && f.sourceFilingDate && old.source_filing_date !== f.sourceFilingDate && (!old.source_filing_date || f.sourceFilingDate > old.source_filing_date))
      this.insertEvent(p, filingId, "new_plan_submission", `New Article 80 filing recorded (last filed date ${f.sourceFilingDate})`,
        `a80filed:${sid}:${f.sourceFilingDate}`, { old: old.source_filing_date, new: f.sourceFilingDate }, f.sourceFilingDate, ctx, covered);
  }

  enqueueAlert(ev: Row, p: Row, filingId: number | null): void {
    const filing = filingId ? this.sql.one(`SELECT record_class, doc_type, document_url, source_url FROM filings WHERE id=?`, filingId) : null;
    const parties = this.sql.all(`SELECT pe.role, e.name FROM project_entities pe JOIN entities e ON e.id=pe.entity_id WHERE pe.project_id=? ORDER BY pe.id`, p.id);
    const { subject, body } = formatAlert(ev, p, filing, parties, this.env.dashboardUrl);
    const next = quietHoursRelease(this.settings.alerts.quiet_hours, new Date()).toISOString();
    for (const ch of this.env.channels)
      this.sql.run(`INSERT OR IGNORE INTO notifications (event_id, kind, channel, dedupe_key, subject, body, next_attempt_at, created_at) VALUES (?,'alert',?,?,?,?,?,?)`,
        ev.id, ch, `alert:${ev.id}:${ch}`, subject, body, next, nowIso());
  }
}
