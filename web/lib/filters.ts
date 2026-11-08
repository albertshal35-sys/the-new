/** Lead filters: parsed from URL search params and compiled to parameterized SQL (server-side filtering). */

export type SP = Record<string, string | string[] | undefined>;

export const UNIT_BUCKETS: Record<string, [number, number]> = {
  "1-4": [1, 4],
  "5-20": [5, 20],
  "21-50": [21, 50],
  "51-100": [51, 100],
  "101-200": [101, 200],
};
export const PROJECT_TYPES: Record<string, string> = {
  new_construction: "New construction",
  demolition_rebuild: "Demolition / rebuild",
  substantial_rehab: "Substantial rehab",
  conversion: "Conversion",
  addition: "Addition",
  adds_units: "Adds units",
  mixed_use: "Mixed-use",
};
export const STAGES: Record<string, string> = {
  letter_of_intent: "Letter of Intent",
  planning_filing: "Planning filing submitted",
  under_review: "Under Article 80 review",
  zoning_appeal: "Zoning appeal filed",
  permit_application: "Permit application filed",
  zoning_approved: "Zoning relief approved",
  board_approved: "Planning board approved",
  permit_issued: "Building permit issued",
  under_construction: "Under construction",
  complete: "Construction complete",
  denied_or_withdrawn: "Denied / withdrawn",
};
export const FITS: Record<string, string> = { likely: "Likely", uncertain: "Uncertain", outside_scope: "Outside scope" };
export const ELIGIBILITY: Record<string, string> = {
  qualified: "Qualified",
  needs_review: "Needs review",
  rejected: "Rejected",
};
export const PIPELINE = ["New", "Researching", "Contacted", "In Discussion", "Term Sheet", "Closed", "Not a Fit"];

export const FILTER_KEYS = [
  "eligibility", "units", "type", "stage", "fit", "neighborhood", "developer", "applicant", "unread",
  "contact", "filed_from", "filed_to", "seen_from", "seen_to", "q", "pipeline", "sort",
] as const;
export type Filters = Partial<Record<(typeof FILTER_KEYS)[number], string>>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFilters(sp: SP): Filters {
  const f: Filters = {};
  for (const k of FILTER_KEYS) {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (s !== undefined && s !== "") f[k] = String(s).slice(0, 200);
  }
  if (!sp.eligibility) f.eligibility = "qualified";
  if (f.eligibility === "all") delete f.eligibility;
  return f;
}

export function toQueryString(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
  if (!f.eligibility && !extra.eligibility) p.set("eligibility", "all");
  return p.toString();
}

/** Build WHERE clause over alias `p` (projects). Returns [sql, params]. */
export function buildWhere(f: Filters, startIndex = 1): [string, unknown[]] {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...vals: unknown[]) => {
    let s = sql;
    for (const v of vals) {
      params.push(v);
      s = s.replace("?", `$${startIndex + params.length - 1}`);
    }
    where.push(s);
  };
  if (f.eligibility && f.eligibility in ELIGIBILITY) add("p.eligibility = ?", f.eligibility);
  if (f.units && UNIT_BUCKETS[f.units]) add("p.units_proposed BETWEEN ? AND ?", ...UNIT_BUCKETS[f.units]);
  if (f.units === "unknown") where.push("p.units_proposed IS NULL");
  if (f.type && f.type in PROJECT_TYPES) {
    if (f.type === "mixed_use") where.push("(p.is_mixed_use OR 'mixed_use' = ANY(p.project_types))");
    else add("? = ANY(p.project_types)", f.type);
  }
  if (f.stage && f.stage in STAGES) add("p.stage = ?", f.stage);
  if (f.fit && f.fit in FITS) add("p.financing_fit = ?", f.fit);
  if (f.neighborhood) add("p.neighborhood = ?", f.neighborhood);
  if (f.pipeline && PIPELINE.includes(f.pipeline)) add("p.pipeline_status = ?", f.pipeline);
  if (f.developer)
    add(
      "EXISTS (SELECT 1 FROM project_entities pe JOIN entities e ON e.id = pe.entity_id WHERE pe.project_id = p.id AND pe.role IN ('developer','proponent','owner_of_record') AND e.name ILIKE ?)",
      `%${f.developer}%`,
    );
  if (f.applicant)
    add(
      "EXISTS (SELECT 1 FROM project_entities pe JOIN entities e ON e.id = pe.entity_id WHERE pe.project_id = p.id AND pe.role IN ('applicant','zba_contact') AND e.name ILIKE ?)",
      `%${f.applicant}%`,
    );
  if (f.unread === "1") where.push("NOT p.is_read");
  if (f.contact === "1") where.push("p.has_contact");
  if (f.filed_from && DATE_RE.test(f.filed_from)) add("p.latest_filing_date >= ?", f.filed_from);
  if (f.filed_to && DATE_RE.test(f.filed_to)) add("p.latest_filing_date <= ?", f.filed_to);
  if (f.seen_from && DATE_RE.test(f.seen_from)) add("p.first_seen_at >= ?::date", f.seen_from);
  if (f.seen_to && DATE_RE.test(f.seen_to)) add("p.first_seen_at < (?::date + 1)", f.seen_to);
  if (f.q) add("(p.name ILIKE ? OR p.address ILIKE ? OR p.parcel_id = ?)", `%${f.q}%`, `%${f.q}%`, f.q);
  return [where.length ? where.join(" AND ") : "TRUE", params];
}

export const SORTS: Record<string, { label: string; order: string; key: string[] }> = {
  first_seen: { label: "First seen (newest)", order: "p.first_seen_at DESC, p.id DESC", key: ["first_seen_at", "id"] },
  filed: { label: "Filing date (newest)", order: "p.latest_filing_date DESC NULLS LAST, p.id DESC", key: ["latest_filing_date", "id"] },
  score: { label: "Score (highest)", order: "p.score DESC NULLS LAST, p.id DESC", key: ["score", "id"] },
};

export function sortOf(f: Filters) {
  return SORTS[f.sort ?? "first_seen"] ?? SORTS.first_seen;
}
