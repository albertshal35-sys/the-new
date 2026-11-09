/** Boston source adapters. See SOURCES.md in the repository root for verified availability/limitations. */
import { UpstreamError, type Http } from "../http";
import { newFiling, type ContactPoint, type Filing, type Party, type RawRecord } from "../logic";
import {
  cleanStr, detectProjectTypes, extractNamedParties, extractUnits, hasResidentialSignal, isOrdinaryWork,
  isUnitCombination, nonresidentialSignals, parseDate, parseDateTime, parseIntLoose, parseMoney,
} from "../text";
import type { Adapter, Page, PageCtx, Upstream } from "./types";

const CKAN = "https://data.boston.gov/api/3/action";
const ds = (slug: string) => `https://data.boston.gov/dataset/${slug}`;
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const day = (iso: string) => iso.slice(0, 10);

async function ckanVersion(http: Http, id: string): Promise<Upstream> {
  const r = await http.json(`${CKAN}/resource_show`, { id });
  const lm = r?.result?.last_modified ?? r?.result?.metadata_modified ?? null;
  return { version: lm, updatedAt: parseDateTime(lm) };
}
async function ckanPage(http: Http, id: string, where: string, cursor: any, size = 1000): Promise<{ rows: any[]; next: any | null }> {
  const last = Number(cursor?.lastId ?? 0);
  const r = await http.json(`${CKAN}/datastore_search_sql`, {
    sql: `SELECT * FROM "${id}" WHERE (${where}) AND "_id" > ${last} ORDER BY "_id" ASC LIMIT ${size}`,
  });
  if (!r?.success) throw new UpstreamError(`CKAN SQL error: ${JSON.stringify(r?.error).slice(0, 200)}`);
  const rows: any[] = r.result.records;
  const next = rows.length === size ? { lastId: Math.max(...rows.map((x) => Number(x._id))) } : null;
  return { rows, next };
}
const strip = (r: any) => { const { _id, ...rest } = r; return rest; };
const t = (v: unknown) => ["t", "true", "1", "yes"].includes(String(v ?? "").trim().toLowerCase());
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function projectSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim().replace(/\/+$/, "").split("?")[0];
  if (!u.includes("/development-projects/")) return null;
  return u.split("/").pop()?.toLowerCase() || null;
}

// ---------------------------------------------------------------- Article 80 (current)
const A80_LAYER = "https://gis.bostonplans.org/hosting/rest/services/Hosted/A80_project_points_display/FeatureServer/0";
const A80_STATUS: Record<string, string> = {
  "letter of intent": "letter_of_intent", "under review": "under_review", "board approved": "board_approved",
  "permitted / under construction": "under_construction", "construction complete": "complete",
};
async function arcgisPage(http: Http, layer: string, order: string, cursor: any): Promise<{ feats: any[]; next: any | null }> {
  const offset = Number(cursor?.offset ?? 0);
  const r = await http.json(`${layer}/query`, {
    where: "1=1", outFields: "*", outSR: 4326, orderByFields: order, resultOffset: offset, resultRecordCount: 1000, f: "json",
  });
  if (r?.error) throw new UpstreamError(`ArcGIS error: ${JSON.stringify(r.error).slice(0, 200)}`);
  const feats: any[] = r.features ?? [];
  return { feats, next: r.exceededTransferLimit && feats.length ? { offset: offset + feats.length } : null };
}

export const article80: Adapter = {
  meta: {
    key: "boston.a80_projects", name: "Boston Article 80 Development Projects (Planning Dept. FeatureServer)",
    recordClass: "planning_project", officialUrl: ds("article80-development-projects"), apiUrl: A80_LAYER,
    description: "Current Article 80 projects: status, last filed date, board approval, units, GFA, description, coordinates.",
    limitations: "No developer, proponent, contact or cost fields. last_filed_date is a date only. Projects marked Construction Complete are stored but not treated as leads.",
    cadence: "Edited most days; lastEditDate used as conditional check.",
    minIntervalS: 300, maxIntervalS: 1800, lookbackDays: 0, reconcileEveryH: 24, isEnrichmentOnly: false, backfillOrder: 10,
  },
  async checkUpstream(http) {
    const r = await http.json(A80_LAYER, { f: "json" });
    const led = r?.editingInfo?.lastEditDate ?? r?.editingInfo?.dataLastEditDate ?? null;
    return { version: led ? String(led) : null, updatedAt: led ? parseDateTime(led) : null };
  },
  async fetchPage(http, ctx) {
    const { feats, next } = await arcgisPage(http, A80_LAYER, "objectid", ctx.cursor);
    const records: RawRecord[] = [];
    for (const f of feats) {
      const a = { ...(f.attributes ?? {}) };
      if (f.geometry) a._geometry = f.geometry;
      if (a.project_id === null || a.project_id === undefined) continue;
      records.push({ sourceKey: this.meta.key, sourceRecordId: String(a.project_id), payload: a,
        sourceUrl: cleanStr(a.website_url) ?? `${A80_LAYER}/query?where=project_id=${a.project_id}`,
        sourceFilingDate: parseDate(a.last_filed_date), sourceUpdatedAt: ctx.upstream?.updatedAt ?? null });
    }
    return { records, nextCursor: next, fullSnapshot: true };
  },
  normalize(raw) {
    const a = raw.payload;
    const desc = cleanStr(a.description), name = cleanStr(a.project__project_name);
    const street = [a.project_street_number, a.project_street_name, a.project_street_suffix].map(cleanStr).filter(Boolean).join(" ");
    const status = cleanStr(a.project_status);
    let units = parseIntLoose(a.total_residential_units);
    let unitsSource = units !== null ? "structured:total_residential_units" : null;
    if (units === null) {
      const tu = extractUnits(desc);
      if (tu.units !== null) { units = tu.units; unitsSource = `text:${tu.method}`; }
    }
    const types = detectProjectTypes(desc);
    const g = a._geometry ?? {};
    const url = cleanStr(a.website_url);
    return newFiling({
      sourceKey: this.meta.key, sourceRecordId: raw.sourceRecordId, recordClass: "planning_project", filingKind: "project_record",
      title: name, docType: cleanStr(a.project__record_type), address: street || name, neighborhood: cleanStr(a.neighborhood),
      zip: cleanStr(a.project_zip_code), lat: num(a.latitude ?? g.y), lon: num(a.longitude ?? g.x),
      unitsProposed: units, unitsSource, grossSqft: parseIntLoose(a.gross_square_footage), projectTypes: types,
      isMixedUse: types.includes("mixed_use") || null,
      nonresSignals: nonresidentialSignals([name, desc].filter(Boolean).join(" ")), residentialSignal: hasResidentialSignal(desc) || Boolean(units),
      status, stage: A80_STATUS[(status ?? "").toLowerCase()] ?? null, description: desc,
      people: extractNamedParties(desc).map((p) => ({ role: p.role, name: p.name, source_field: "description (official text)", evidence: p.evidence })),
      relatedIds: { a80_project_id: raw.sourceRecordId, sam_ids: cleanStr(a.sam_ids), project_slug: projectSlug(url),
        last_board_approved_date: parseDate(a.last_board_approved_date) },
      documentUrl: url, sourceUrl: raw.sourceUrl, projectUrl: url, sourceFilingDate: parseDate(a.last_filed_date),
      sourceUpdatedAt: raw.sourceUpdatedAt,
    });
  },
};

// ---------------------------------------------------------------- Article 80 (legacy, frozen 2016) — enrichment only
const LEGACY_LAYER = "https://gisportal.boston.gov/arcgis/rest/services/Planning/OpenData/MapServer/6";
export const article80Legacy: Adapter = {
  meta: {
    key: "boston.a80_legacy", name: "Boston Article 80 Projects — legacy GIS layer (enrichment only)",
    recordClass: "planning_project", officialUrl: LEGACY_LAYER, apiUrl: LEGACY_LAYER,
    description: "Legacy layer with Developer, Proponent, Contact, Phone, eMail, ProposedCost.",
    limitations: "FROZEN: newest ModifiedDate is 2016-02-03. Cannot reveal new filings. Used only as dated enrichment matched on the official ProjectID; never creates projects or alerts.",
    cadence: "Not updated since February 2016.",
    minIntervalS: 86400, maxIntervalS: 7 * 86400, lookbackDays: 0, reconcileEveryH: 24 * 7, isEnrichmentOnly: true, backfillOrder: 90,
  },
  async checkUpstream(http) {
    const r = await http.json(`${LEGACY_LAYER}/query`, { where: "1=1", f: "json",
      outStatistics: '[{"statisticType":"max","onStatisticField":"ModifiedDate","outStatisticFieldName":"mx"},{"statisticType":"count","onStatisticField":"OBJECTID","outStatisticFieldName":"n"}]' });
    const at = r?.features?.[0]?.attributes ?? {};
    const mx = at.mx ?? at.MX, n = at.n ?? at.N;
    return { version: `${mx}:${n}`, updatedAt: mx ? parseDateTime(mx) : null };
  },
  async fetchPage(http, ctx) {
    const { feats, next } = await arcgisPage(http, LEGACY_LAYER, "OBJECTID", ctx.cursor);
    const records: RawRecord[] = feats.filter((f) => f.attributes?.ProjectID != null).map((f) => ({
      sourceKey: this.meta.key, sourceRecordId: String(f.attributes.ProjectID), payload: f.attributes,
      sourceUrl: `${LEGACY_LAYER}/query?where=ProjectID%3D${f.attributes.ProjectID}&outFields=*&f=html`,
      sourceFilingDate: parseDate(f.attributes.EnteredDate), sourceUpdatedAt: parseDateTime(f.attributes.ModifiedDate),
    }));
    return { records, nextCursor: next, fullSnapshot: true };
  },
  normalize(raw) {
    const a = raw.payload;
    const mod = parseDate(a.ModifiedDate);
    const asof = mod ? ` (legacy BRA dataset, last modified ${mod})` : " (legacy BRA dataset)";
    const people: Party[] = [];
    for (const [field, role] of [["Developer", "developer"], ["Proponent", "proponent"], ["Contact", "contact_person"]] as const) {
      const v = cleanStr(a[field]);
      if (v && !["n/a", "na", "none", "tbd"].includes(v.toLowerCase())) people.push({ role, name: v, source_field: field + asof });
    }
    const who = cleanStr(a.Contact) ?? cleanStr(a.Proponent) ?? cleanStr(a.Developer);
    const label = (who ? `Project contact ${who}` : "Project contact") + (cleanStr(a.Title) ? `, ${cleanStr(a.Title)}` : "") + asof;
    const contacts: ContactPoint[] = [];
    for (const [field, kind] of [["Phone", "phone"], ["eMail", "email"], ["MailingAddress", "mailing_address"]] as const) {
      const v = cleanStr(a[field]);
      if (v) contacts.push({ kind, value: v, role_label: label, source_field: field });
    }
    const units = parseIntLoose(a.TotalResidentialUnits);
    return newFiling({
      sourceKey: this.meta.key, sourceRecordId: raw.sourceRecordId, recordClass: "planning_project", filingKind: "project_record",
      title: cleanStr(a.ProjectName), docType: "Legacy Article 80 record",
      address: [cleanStr(a.ProjectStreetNum), cleanStr(a.ProjectStreetName)].filter(Boolean).join(" ") || cleanStr(a.ProjectName),
      parcelId: cleanStr(a.ParcelID), neighborhood: cleanStr(a.ProjectNeighborhood), zip: cleanStr(a.ProjectZipCode),
      lat: num(a.Lat), lon: num(a.Lon), unitsProposed: units || null,
      unitsSource: units ? "structured:TotalResidentialUnits (legacy 2016)" : null, grossSqft: parseIntLoose(a.BldgSqFt),
      retailSqft: parseIntLoose(a.Retail_sqft), proposedCost: num(a.ProposedCost) || null, status: cleanStr(a.Article80Status),
      description: cleanStr(a.Notes), people, contacts,
      relatedIds: { a80_project_id: raw.sourceRecordId, zoning: cleanStr(a.Zoning), legacy_modified: mod },
      sourceUrl: raw.sourceUrl, sourceFilingDate: parseDate(a.EnteredDate), sourceUpdatedAt: raw.sourceUpdatedAt,
      inWindow: false, canCreateProject: false, linkByOfficialIdOnly: true,
    });
  },
};

// ---------------------------------------------------------------- Records Library
const RL_API = "https://sire.bostonplans.org/api/documentSearch";
export function classifyDocument(type: string | null, subtype: string | null): [string, string | null] {
  const ty = (type ?? "").toLowerCase(), s = subtype ?? "";
  if (ty === "developer filing") return ["developer_filing", /letter of intent|\bloi\b/i.test(s) ? "letter_of_intent" : "planning_filing"];
  if (ty === "vote") return ["approval", "board_approved"];
  if (ty === "community engagement") return ["community_engagement", null];
  if (ty === "executed documents") {
    return /(determination|approval|certification of approval|scoping|adequacy|board vote|cooperation agreement|development plan|certificate of compliance)/i.test(s)
      ? ["approval", "board_approved"] : ["administrative", null];
  }
  if (/(project notification form|pnf|small project review application|spra|letter of intent|draft project impact report|notice of project change|project impact report|institutional master plan|additional information|project fact sheet|application)/i.test(s))
    return ["developer_filing", "planning_filing"];
  return ["administrative", null];
}
export const recordsLibrary: Adapter = {
  meta: {
    key: "boston.records_library", name: "Boston Planning Dept. Article 80 Records Library", recordClass: "planning_document",
    officialUrl: "https://apps.bostonplans.org/recordslibrary/", apiUrl: `${RL_API}/getMetadataWithProjects`,
    description: "Article 80 documents (PNF, SPRA, LOI, NPC, board votes, agreements, presentations, videos) with document date, category, project and Box link.",
    limitations: "documentDate has no time and can be back-dated; a 21-day overlapping lookback is re-scanned. PDFs are linked, not parsed. No ETag support.",
    cadence: "Business days, irregular times.",
    minIntervalS: 600, maxIntervalS: 1800, lookbackDays: 21, reconcileEveryH: 24, isEnrichmentOnly: false, backfillOrder: 20,
  },
  async fetchPage(http, ctx) {
    const page = Number(ctx.cursor?.page ?? 1);
    const marker = ctx.cursor?.marker ?? "";
    const end = new Date(new Date(ctx.windowEnd).getTime() + 86_400_000).toISOString();
    const r = await http.json(`${RL_API}/getMetadataWithProjects`, {
      ft_docType: "", ft_projID: "", ft_neighborhood: "", ft_Search: "", ft_startDate: day(ctx.windowStart),
      ft_endDate: day(end), ft_page: page, ft_next_marker: marker,
    });
    const items: any[] = r?.metadataObj ?? [];
    const records: RawRecord[] = [];
    for (const it of items) {
      const bm = it.boxMetadata ?? {};
      const rid = bm.$parent ?? it.shareLink;
      if (!rid) continue;
      records.push({ sourceKey: this.meta.key, sourceRecordId: String(rid), payload: { boxMetadata: bm, shareLink: it.shareLink ?? null },
        sourceUrl: it.shareLink ?? this.meta.officialUrl, sourceFilingDate: parseDate(bm.documentDate) });
    }
    const nm = r?.next_marker ?? "";
    const seen: string[] = ctx.cursor?.seen ?? [];
    const next = nm && items.length && !seen.includes(nm) ? { page: page + 1, marker: nm, seen: [...seen.slice(-20), nm] } : null;
    return { records, nextCursor: next };
  },
  normalize(raw) {
    const bm = raw.payload.boxMetadata ?? {};
    const subtype = cleanStr(bm.subtype) ?? cleanStr((bm.subtypeSelect ?? [])[0]);
    const type = cleanStr(bm.type);
    const [kind, stage] = classifyDocument(type, subtype);
    const pname = cleanStr(bm.projectName);
    const url = cleanStr(bm.url);
    return newFiling({
      sourceKey: this.meta.key, sourceRecordId: raw.sourceRecordId, recordClass: "planning_document", filingKind: kind,
      title: `${pname ?? "Unknown project"} — ${subtype ?? type ?? "Document"}`, docType: subtype ?? type, address: pname,
      neighborhood: cleanStr(bm.neighborhood), stage, status: type,
      relatedIds: { salesforce_project_id: bm.id ?? null, project_slug: projectSlug(url), document_category: type },
      documentUrl: cleanStr(raw.payload.shareLink), sourceUrl: this.meta.officialUrl, projectUrl: url,
      sourceFilingDate: parseDate(bm.documentDate), canCreateProject: kind === "developer_filing",
    });
  },
};

// ---------------------------------------------------------------- Issued building permits
const PERMITS = "6ddcd912-32a0-43df-9908-63574f8c7e77";
const NON_DEV_TYPE = /^(electrical|plumbing|gas|use of premises|electrical low voltage|electrical fire alarms|electrical temporary service)/i;
const NON_DEV_WT = new Set(["ROOF", "SOL", "SIGNES", "FA", "LVOLT", "SPRINK", "FENCE", "SPCEVE", "TMPSER", "GEN", "INSUL", "SIDE",
  "VIOL", "MAINT", "ELECTRICAL", "PLUMBING", "GAS", "SRVCHG", "SD", "RESPAR", "COB", "SITE", "TCOO"]);
const WT_TYPES: Record<string, string[]> = { ERECT: ["new_construction"], CHGOCC: ["conversion"], ADDITION: ["addition"], RAZE: ["demolition_only"], EXTDEM: ["demolition_only"] };
const RES_OCC = new Set(["1-2FAM", "1-3FAM", "1-4FAM", "MULTI", "MIXED", "7MORE", "2UNIT", "1UNIT", "3UNIT", "4UNIT"]);
const parcel10 = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? String(Math.trunc(n)).padStart(10, "0") : cleanStr(v); };

export const buildingPermits: Adapter = {
  meta: {
    key: "boston.building_permits", name: "Analyze Boston — Approved Building Permits", recordClass: "issued_permit",
    officialUrl: ds("approved-building-permits"), apiUrl: `${CKAN}/datastore_search_sql (resource ${PERMITS})`,
    description: "Issued building permits: number, work type, description, applicant, declared valuation, issued date, occupancy, address, parcel, coordinates.",
    limitations: "ISSUED permits only — no application-submission date. declared_valuation is the applicant's declared construction value, not total cost or a loan request. Daily batch refresh.",
    cadence: "Daily batch refresh.",
    minIntervalS: 300, maxIntervalS: 3600, lookbackDays: 7, reconcileEveryH: 24 * 7, isEnrichmentOnly: false, backfillOrder: 50,
  },
  checkUpstream: (http) => ckanVersion(http, PERMITS),
  async fetchPage(http, ctx) {
    const where = `issued_date >= ${q(day(ctx.windowStart))} AND issued_date < (${q(day(ctx.windowEnd))}::date + 1)`;
    const { rows, next } = await ckanPage(http, PERMITS, where, ctx.cursor);
    return { nextCursor: next, records: rows.filter((r) => r.permitnumber).map((r) => ({
      sourceKey: this.meta.key, sourceRecordId: String(r.permitnumber), payload: strip(r),
      sourceUrl: `${ds("approved-building-permits")}?permit=${r.permitnumber}`, sourceFilingDate: parseDate(r.issued_date),
      sourceUpdatedAt: ctx.upstream?.updatedAt ?? null })) };
  },
  normalize(raw) {
    const r = raw.payload;
    const ptype = cleanStr(r.permittypedescr) ?? "";
    const wt = (cleanStr(r.worktype) ?? "").toUpperCase();
    const desc = cleanStr(r.description), comments = cleanStr(r.comments);
    const occ = (cleanStr(r.occupancytype) ?? "").toUpperCase();
    const isCo = ptype.toLowerCase().startsWith("certificate of occupancy") || raw.sourceRecordId.toUpperCase().startsWith("COO");
    let types = [...new Set([...(WT_TYPES[wt] ?? []), ...detectProjectTypes(comments)])];
    if (wt === "CHGOCC" && !types.includes("conversion")) types.push("conversion");
    let nonDev = NON_DEV_TYPE.test(ptype) || NON_DEV_WT.has(wt) || (ptype.toLowerCase().startsWith("short form") && wt !== "RAZE" && wt !== "EXTDEM");
    if (isUnitCombination(comments)) nonDev = true;
    if (nonDev) types = [];
    const u = extractUnits(comments);
    const resSig = hasResidentialSignal(comments);
    const nonres = nonresidentialSignals(comments);
    if ((occ === "COMM" || occ === "OTHER") && !resSig) nonres.push("non_residential_occupancy");
    const city = cleanStr(r.city);
    const people: Party[] = cleanStr(r.applicant) ? [{ role: "applicant", name: cleanStr(r.applicant)!, source_field: "applicant (permit applicant — not necessarily owner or developer)" }] : [];
    return newFiling({
      sourceKey: this.meta.key, sourceRecordId: raw.sourceRecordId, recordClass: isCo ? "certificate_of_occupancy" : "issued_permit",
      filingKind: isCo ? "completion" : "permit", title: `${ptype || "Permit"} — ${desc ?? wt}`, docType: `${ptype} / ${wt}`.replace(/^ \/ | \/ $/g, ""),
      address: cleanStr(r.address), parcelId: parcel10(r.parcel_id), neighborhood: city && city.toLowerCase() !== "boston" ? city : null,
      zip: cleanStr(r.zip), lat: num(r.y_latitude), lon: num(r.x_longitude), unitsProposed: u.units, unitsExisting: u.existing,
      unitsSource: u.units !== null ? `text:${u.method}` : null, grossSqft: parseIntLoose(r.sq_feet) || null,
      declaredValuation: parseMoney(r.declared_valuation), projectTypes: types, isMixedUse: types.includes("mixed_use") || occ === "MIXED" || null,
      nonresSignals: nonres, residentialSignal: (RES_OCC.has(occ) && occ !== "COMM" && occ !== "OTHER") || resSig,
      ordinaryWork: nonDev || (isOrdinaryWork([desc, comments].filter(Boolean).join(" ")) && !types.length),
      status: cleanStr(r.status), stage: isCo ? "complete" : nonDev ? null : "permit_issued", description: comments ?? desc, people,
      relatedIds: { application_number: raw.sourceRecordId.toUpperCase(), worktype: wt, permit_type: ptype, occupancy_type: occ },
      sourceUrl: raw.sourceUrl, sourceFilingDate: parseDate(r.issued_date), sourceUpdatedAt: raw.sourceUpdatedAt ?? parseDateTime(r.issued_date),
    });
  },
};

// ---------------------------------------------------------------- Permit applications (Zoning Reform Impact Tracker)
const ZRIT = "f9b736f2-60da-4240-b793-f9b498eb475e";
const F_FILED = "Permit application filing date", F_ISSUED = "Permit issued date";
const F_BEFORE = "Residential units before permitted work-on and after Oct. 2024", F_AFTER = "Residential units after permitted work-on and after Oct. 2024";
const ORDINARY_WT = new Set(["signs", "solar panels", "roofing", "renovations - exterior", "fencing renovation >6ft", "outside seating",
  "residential parking", "commercial parking", "city of boston", "application to correct a violation"]);

export const permitApplications: Adapter = {
  meta: {
    key: "boston.permit_applications", name: "Boston Building Permit Applications (Zoning Reform Impact Tracker)",
    recordClass: "permit_application", officialUrl: ds("zoning-reform-impact-tracker"), apiUrl: `${CKAN}/datastore_search_sql (resource ${ZRIT})`,
    description: "Permit applications with filing date, status (zoning review, appeal, issued, abandoned), Article 80 flags, units before/after, parcel, coordinates.",
    limitations: "Daily batch, not real time. No applicant names or descriptions. Units only for applications after Oct 2024.",
    cadence: "Daily batch refresh.",
    minIntervalS: 300, maxIntervalS: 3600, lookbackDays: 10, reconcileEveryH: 24, isEnrichmentOnly: false, backfillOrder: 30,
  },
  checkUpstream: (http) => ckanVersion(http, ZRIT),
  async fetchPage(http, ctx) {
    const s = q(day(ctx.windowStart)), e = q(day(ctx.windowEnd) + "T23:59:59");
    const where = `("${F_FILED}" >= ${s} AND "${F_FILED}" <= ${e}) OR ("${F_ISSUED}" >= ${s} AND "${F_ISSUED}" <= ${e})`;
    const { rows, next } = await ckanPage(http, ZRIT, where, ctx.cursor);
    return { nextCursor: next, records: rows.filter((r) => r["Permit application number"]).map((r) => ({
      sourceKey: this.meta.key, sourceRecordId: String(r["Permit application number"]).toUpperCase(), payload: strip(r),
      sourceUrl: this.meta.officialUrl, sourceFilingDate: parseDate(r[F_FILED]), sourceUpdatedAt: ctx.upstream?.updatedAt ?? null })) };
  },
  normalize(raw) {
    const r = raw.payload;
    const wtype = cleanStr(r["Permit application work type"]) ?? "", atype = cleanStr(r["Permit application type"]) ?? "";
    const before = parseIntLoose(r[F_BEFORE]), after = parseIntLoose(r[F_AFTER]);
    const wl = wtype.toLowerCase();
    let types = wl === "erect" ? ["new_construction"] : wl === "change occupancy" ? ["conversion"] : wl === "addition" ? ["addition"] : [];
    if (before !== null && after !== null && after > before && !types.includes("conversion") && !types.includes("new_construction")) types.push("adds_units");
    if (wl === "change occupancy" && (after === null || before === null || after <= before)) types = after ? ["conversion"] : [];
    const issued = t(r["Permit issued"]);
    let stage: string, status: string;
    if (issued) [stage, status] = ["permit_issued", "Permit issued"];
    else if (t(r["Permit application abandoned"])) [stage, status] = ["denied_or_withdrawn", "Application abandoned"];
    else if (t(r["Permit application inactive"])) [stage, status] = ["permit_application", "Application inactive"];
    else if (t(r["Completed appeal"])) [stage, status] = ["zoning_appeal", "Zoning appeal completed"];
    else if (t(r["Started appeal"])) [stage, status] = ["zoning_appeal", "Zoning appeal in progress"];
    else if (t(r["Zoning review approved"])) [stage, status] = ["permit_application", "Zoning review approved"];
    else [stage, status] = ["permit_application", "Application filed"];
    const ordinary = ORDINARY_WT.has(wl) || atype.toUpperCase() === "UOP" || (wl.startsWith("renovations") && !(after && before !== null && after > before));
    const zba = cleanStr(r["Zoning Board of Appeal decision link"]), rec = cleanStr(r["Planning Department recommendation link"]);
    return newFiling({
      sourceKey: this.meta.key, sourceRecordId: raw.sourceRecordId, recordClass: "permit_application", filingKind: "application",
      title: `Permit application ${raw.sourceRecordId} — ${atype} / ${wtype}`, docType: `${atype} / ${wtype}`,
      address: cleanStr(r.Address), parcelId: cleanStr(r["Parcel ID"]), neighborhood: cleanStr(r.Neighborhood), zip: cleanStr(r["Zip code"]),
      lat: num(r["Y latitude"]), lon: num(r["X longitude"]), unitsProposed: after || null, unitsExisting: before,
      unitsSource: after ? `structured:${F_AFTER}` : null, projectTypes: types, residentialSignal: Boolean(after) || Boolean(before),
      ordinaryWork: ordinary, status, stage,
      relatedIds: { application_number: raw.sourceRecordId, zba_application_number: cleanStr(r["Board of Appeal application number"]),
        is_article80: t(r["Is Article 80?"]), zba_decision_link: zba, planning_recommendation_link: rec,
        permit_issued_date: cleanStr(r[F_ISSUED]), has_adu: t(r["Permit application has ADU"]) },
      documentUrl: zba ?? rec, sourceUrl: raw.sourceUrl, sourceFilingDate: parseDate(r[F_FILED]), sourceUpdatedAt: raw.sourceUpdatedAt,
    });
  },
};

// ---------------------------------------------------------------- Zoning Board of Appeal
const ZBA = "0f0fa8c2-87ba-45d6-a876-0d177dd02512";
export const zba: Adapter = {
  meta: {
    key: "boston.zba", name: "Boston Zoning Board of Appeal Tracker", recordClass: "zoning_appeal",
    officialUrl: ds("zoning-board-of-appeal-tracker"), apiUrl: `${CKAN}/datastore_search_sql (resource ${ZBA})`,
    description: "ZBA appeals: address, status, parent permit application, contact, submitted/hearing/decision dates, decision, description.",
    limitations: "Daily batch. 'contact' is the person listed on the appeal (often an attorney/agent), not necessarily owner or developer. No parcel id or coordinates.",
    cadence: "Daily batch refresh.",
    minIntervalS: 300, maxIntervalS: 3600, lookbackDays: 14, reconcileEveryH: 24, isEnrichmentOnly: false, backfillOrder: 40,
  },
  checkUpstream: (http) => ckanVersion(http, ZBA),
  async fetchPage(http, ctx) {
    const s = q(day(ctx.windowStart)), e = q(day(ctx.windowEnd) + "T23:59:59");
    const where = ["submitted_date", "hearing_date", "final_decision_date", "closed_date"].map((c) => `(${c} >= ${s} AND ${c} <= ${e})`).join(" OR ");
    const { rows, next } = await ckanPage(http, ZBA, where, ctx.cursor);
    return { nextCursor: next, records: rows.filter((r) => cleanStr(r.boa_apno)).map((r) => ({
      sourceKey: this.meta.key, sourceRecordId: `${cleanStr(r.boa_apno)}:${cleanStr(r.parent_apno) ?? "-"}`.toUpperCase(), payload: strip(r),
      sourceUrl: this.meta.officialUrl, sourceFilingDate: parseDate(r.submitted_date), sourceUpdatedAt: ctx.upstream?.updatedAt ?? null })) };
  },
  normalize(raw) {
    const r = raw.payload;
    const desc = cleanStr(r.project_description);
    const decision = cleanStr(r.decision) ?? "", status = cleanStr(r.status);
    const dl = decision.toLowerCase();
    const [kind, stage] = ["approved", "appprov"].includes(dl) ? ["approval", "zoning_approved"]
      : ["denied", "deniedprej", "withdrawn", "withdraw", "void"].includes(dl) ? ["appeal", "denied_or_withdrawn"] : ["appeal", "zoning_appeal"];
    const u = extractUnits(desc);
    const types = detectProjectTypes(desc);
    const parent = cleanStr(r.parent_apno);
    return newFiling({
      sourceKey: this.meta.key, sourceRecordId: raw.sourceRecordId, recordClass: "zoning_appeal", filingKind: kind,
      title: `ZBA ${cleanStr(r.boa_apno)} — ${status ?? "appeal"}${decision ? ` (${decision})` : ""}`, docType: cleanStr(r.appeal_type) ?? "Zoning appeal",
      address: cleanStr(r.address), neighborhood: cleanStr(r.city), zip: cleanStr(r.zip),
      unitsProposed: u.units, unitsExisting: u.existing, unitsSource: u.units !== null ? `text:${u.method}` : null,
      projectTypes: types, isMixedUse: types.includes("mixed_use") || null, nonresSignals: nonresidentialSignals(desc),
      residentialSignal: hasResidentialSignal(desc), ordinaryWork: isOrdinaryWork(desc) && !types.length,
      status: [status, decision].filter(Boolean).join(" / ") || null, stage, description: desc,
      people: cleanStr(r.contact) ? [{ role: "zba_contact", name: cleanStr(r.contact)!, source_field: "contact (person listed on ZBA appeal — not necessarily owner)" }] : [],
      relatedIds: { application_number: parent ? parent.toUpperCase() : null, boa_apno: cleanStr(r.boa_apno), hearing_date: cleanStr(r.hearing_date),
        final_decision_date: parseDate(r.final_decision_date), zoning_district: cleanStr(r.zoning_district) },
      sourceUrl: raw.sourceUrl, sourceFilingDate: parseDate(r.submitted_date) ?? parseDate(r.final_decision_date), sourceUpdatedAt: raw.sourceUpdatedAt,
    });
  },
};

// ---------------------------------------------------------------- Property assessment (owner of record) — enrichment lookup
export const ASSESSMENT = { key: "boston.property_assessment", resource: "ee73430d-96c0-423e-ad21-c4cfb54c8961", url: ds("property-assessment") };
export async function lookupParcel(http: Http, parcelId: string) {
  const r = await http.json(`${CKAN}/datastore_search`, { resource_id: ASSESSMENT.resource, filters: JSON.stringify({ PID: parcelId }), limit: 5 });
  const rec = r?.result?.records?.[0];
  if (!rec) return null;
  const mail = [rec.MAIL_ADDRESSEE, rec.MAIL_STREET_ADDRESS, rec.MAIL_CITY, rec.MAIL_STATE, rec.MAIL_ZIP_CODE].map(cleanStr).filter(Boolean).join(", ");
  return { owner: cleanStr(rec.OWNER), mail_address: mail || null, land_use: cleanStr(rec.LU_DESC), res_units: parseIntLoose(rec.RES_UNITS),
    land_sf: parseIntLoose(rec.LAND_SF), gross_area: parseIntLoose(rec.GROSS_AREA), total_value: parseMoney(rec.TOTAL_VALUE), yr_built: parseIntLoose(rec.YR_BUILT) };
}

export const ADAPTERS: Adapter[] = [article80, recordsLibrary, permitApplications, zba, buildingPermits, article80Legacy];
export const BY_KEY: Record<string, Adapter> = Object.fromEntries(ADAPTERS.map((a) => [a.meta.key, a]));
export type { Page, PageCtx };
