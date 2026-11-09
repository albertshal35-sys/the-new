/** Models + business rules: eligibility, unit selection, financing estimate, lead score, stages. */

export interface RawRecord {
  sourceKey: string;
  sourceRecordId: string;
  payload: Record<string, any>;
  sourceUrl?: string | null;
  sourceFilingDate?: string | null;
  sourceUpdatedAt?: string | null;
}
export interface Party { role: string; name: string; source_field: string; evidence?: string | null }
export interface ContactPoint { kind: string; value: string; role_label: string; source_field: string; is_city_staff?: boolean }

export interface Filing {
  sourceKey: string;
  sourceRecordId: string;
  recordClass: string; // planning_project | planning_document | permit_application | issued_permit | certificate_of_occupancy | zoning_appeal
  filingKind: string; // project_record | developer_filing | approval | community_engagement | administrative | application | permit | appeal | completion
  title?: string | null;
  docType?: string | null;
  address?: string | null;
  parcelId?: string | null;
  neighborhood?: string | null;
  zip?: string | null;
  lat?: number | null;
  lon?: number | null;
  unitsProposed?: number | null;
  unitsExisting?: number | null;
  unitsSource?: string | null;
  grossSqft?: number | null;
  retailSqft?: number | null;
  declaredValuation?: number | null;
  proposedCost?: number | null;
  projectTypes: string[];
  isMixedUse?: boolean | null;
  nonresSignals: string[];
  residentialSignal: boolean;
  ordinaryWork: boolean;
  status?: string | null;
  stage?: string | null;
  description?: string | null;
  people: Party[];
  contacts: ContactPoint[];
  relatedIds: Record<string, any>;
  documentUrl?: string | null;
  sourceUrl?: string | null;
  projectUrl?: string | null;
  sourceFilingDate?: string | null;
  sourceUpdatedAt?: string | null;
  inWindow: boolean;
  canCreateProject: boolean;
  linkByOfficialIdOnly: boolean;
  eligibility: string;
  eligibilityReasons: string[];
}

export function newFiling(p: Partial<Filing> & Pick<Filing, "sourceKey" | "sourceRecordId" | "recordClass" | "filingKind">): Filing {
  return {
    projectTypes: [], nonresSignals: [], residentialSignal: false, ordinaryWork: false, people: [], contacts: [],
    relatedIds: {}, inWindow: true, canCreateProject: true, linkByOfficialIdOnly: false, eligibility: "needs_review",
    eligibilityReasons: [], ...p,
  };
}

export function materialValues(f: Filing): unknown[] {
  return [f.recordClass, f.filingKind, f.docType ?? null, f.unitsProposed ?? null, f.unitsExisting ?? null, f.status ?? null,
    f.stage ?? null, f.declaredValuation ?? null, f.proposedCost ?? null, f.sourceFilingDate ?? null, f.documentUrl ?? null,
    [...f.projectTypes].sort()];
}

// ---------------------------------------------------------------- stages
export const STAGES: Record<string, [number, string]> = {
  denied_or_withdrawn: [5, "Denied / withdrawn"],
  letter_of_intent: [10, "Letter of Intent (planning)"],
  planning_filing: [15, "Planning filing submitted"],
  under_review: [20, "Under Article 80 review"],
  zoning_appeal: [25, "Zoning appeal filed"],
  permit_application: [30, "Building permit application filed"],
  zoning_approved: [35, "Zoning relief approved"],
  board_approved: [40, "Planning board approved"],
  permit_issued: [50, "Building permit issued"],
  under_construction: [60, "Under construction"],
  complete: [70, "Construction complete"],
};
export const stageRank = (s: string | null | undefined): number | null => (s && STAGES[s] ? STAGES[s][0] : null);
export const stageLabel = (s: string | null | undefined): string => (s && STAGES[s] ? STAGES[s][1] : "Unknown");

// ---------------------------------------------------------------- settings
export const DEFAULT_SETTINGS = {
  business: { min_units: 1, max_units: 200, max_loan: 50_000_000 },
  alerts: {
    notify_qualified: true, notify_needs_review: false, min_score: 0, min_units: null as number | null,
    event_types: ["new_project", "units_changed", "new_plan_submission", "approval", "permit_issued"],
    quiet_hours: null as null | { start: string; end: string; tz: string },
    daily_digest: true, digest_hour_local: 8, weekly_report: true, weekly_report_weekday: 1, timezone: "America/New_York",
  },
  scoring: { weights: { unit_fit: 25, early_stage: 20, loan_size: 15, newness: 15, contact_quality: 15, developer_activity: 10 } as Record<string, number> },
  financing: {
    tdc_per_unit: {
      new_construction: { single_family: [550_000, 1_000_000], two_to_four_family: [450_000, 750_000], multifamily: [450_000, 750_000] } as Record<string, number[]>,
      substantial_rehab: [200_000, 400_000], conversion: [250_000, 450_000], addition: [150_000, 350_000],
    },
    hard_cost_to_tdc: [1.25, 1.6], official_cost_band: [0.9, 1.15], loan_to_cost: [0.6, 0.75], bridge_loan_to_cost: [0.5, 0.7],
  },
};
export type Settings = typeof DEFAULT_SETTINGS;

export function deepMerge<T>(base: T, over: any): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
      ? deepMerge(out[k], v) : v;
  }
  return out;
}

// ---------------------------------------------------------------- eligibility
export const DEV_TYPES = new Set(["new_construction", "demolition_rebuild", "conversion", "substantial_rehab", "addition", "adds_units"]);
const STRONG_NONRES = new Set(["hotel", "lab_office"]);
const MINOR_RECONFIG_MIN_EXISTING = 12;
const MINOR_RECONFIG_MAX_ADDED = 2;

function residentialLedCheck(units: number, gross: number | null | undefined, nonres: string[]): string | null {
  const strong = [...new Set(nonres.filter((s) => STRONG_NONRES.has(s)))].sort();
  if (gross && units) {
    const per = gross / units;
    if (per <= 2500) return null;
    if (per >= 4000) return `verify_residential_led:${Math.trunc(per)}_gsf_per_unit${strong.length ? ":" + strong.join(",") : ""}`;
  }
  return strong.length ? `verify_residential_led:${strong.join(",")}` : null;
}

export function classifyFiling(f: Filing, minUnits = 1, maxUnits = 200): [string, string[]] {
  const types = new Set(f.projectTypes);
  const dev = [...types].filter((t) => DEV_TYPES.has(t)).sort();
  const u = f.unitsProposed ?? null;
  const nonres = f.nonresSignals.filter((s) => s !== "non_residential_occupancy" || !f.residentialSignal);
  const nonresReason = () => "non_residential:" + [...new Set(nonres)].sort().join(",");

  if (f.recordClass === "planning_document") {
    if (f.filingKind === "community_engagement" || f.filingKind === "administrative") return ["rejected", [`not_a_development_filing:${f.filingKind}`]];
    return ["needs_review", ["document_evaluated_with_project"]];
  }
  if (f.recordClass === "certificate_of_occupancy") return ["rejected", ["completion_record_certificate_of_occupancy"]];
  if (f.stage === "denied_or_withdrawn") return ["rejected", ["denied_withdrawn_or_abandoned"]];
  if (f.recordClass === "planning_project" && f.stage === "complete") return ["rejected", ["construction_complete"]];
  if (f.ordinaryWork && !dev.length) return ["rejected", ["non_development_permit_or_ordinary_work"]];
  if (u !== null) {
    if (u > maxUnits) return ["rejected", [`units_above_${maxUnits}`]];
    if (u < minUnits) return ["rejected", [nonres.length ? nonresReason() : "no_residential_units"]];
  }
  if (f.recordClass === "planning_project") {
    if (u === null) {
      if (nonres.length && !f.residentialSignal) return ["rejected", [nonresReason()]];
      return ["needs_review", ["units_unknown"]];
    }
    const v = residentialLedCheck(u, f.grossSqft, nonres);
    return v ? ["needs_review", [v]] : ["qualified", [`units_${u}_in_range`, "article80_residential"]];
  }
  if (!dev.length) return ["rejected", ["no_development_scope"]];
  if (dev.length === 1 && dev[0] === "addition" && u === null) return ["rejected", ["addition_without_unit_evidence"]];
  const ex = f.unitsExisting ?? null;
  const builds = types.has("new_construction") || types.has("demolition_rebuild");
  if (ex !== null && u !== null && u <= ex && !builds && !types.has("substantial_rehab")) return ["rejected", ["no_additional_units"]];
  if (ex !== null && u !== null && ex >= MINOR_RECONFIG_MIN_EXISTING && u - ex > 0 && u - ex <= MINOR_RECONFIG_MAX_ADDED && !builds)
    return ["rejected", ["minor_unit_reconfiguration_in_existing_building"]];
  if (u === null) {
    if (nonres.length && !f.residentialSignal) return ["rejected", [nonresReason()]];
    return ["needs_review", f.residentialSignal ? ["units_unknown"] : ["units_unknown", "residential_use_unconfirmed"]];
  }
  const v = residentialLedCheck(u, f.grossSqft, nonres);
  return v ? ["needs_review", [v]] : ["qualified", [`units_${u}_in_range`, `development_scope:${dev.join(",")}`]];
}

const UNIT_PRIORITY: Record<string, number> = {
  "boston.a80_projects": 5, "boston.permit_applications": 4, "boston.building_permits": 3, "boston.zba": 2,
};

export interface FilingRow {
  source_key: string; record_class: string; units_proposed: number | null; units_existing: number | null;
  units_source: string | null; source_filing_date: string | null; eligibility: string; eligibility_reasons: string[];
  project_types: string[]; stage: string | null;
}

export function pickUnits(filings: FilingRow[]): [number | null, number | null, string | null, string] {
  let usable = filings.filter((f) => f.units_proposed !== null && f.eligibility !== "rejected" && f.source_key !== "boston.a80_legacy");
  if (!usable.length) usable = filings.filter((f) => f.units_proposed !== null && f.record_class === "planning_project" && f.source_key !== "boston.a80_legacy");
  if (!usable.length) return [null, null, null, "unknown"];
  const key = (f: FilingRow) => [(f.units_source ?? "").startsWith("structured") ? 1 : 0, UNIT_PRIORITY[f.source_key] ?? 0, f.source_filing_date ?? ""] as const;
  const best = usable.reduce((a, c) => {
    const ka = key(a), kc = key(c);
    for (let i = 0; i < 3; i++) if (kc[i] !== ka[i]) return kc[i] > ka[i] ? c : a;
    return a;
  });
  const structured = (best.units_source ?? "").startsWith("structured");
  return [best.units_proposed, best.units_existing, `${best.source_key}:${best.units_source}`, structured ? "high" : "medium"];
}

export function evaluateProject(filings: FilingRow[], units: number | null, stage: string | null, minUnits = 1, maxUnits = 200): [string, string[]] {
  const active = filings.filter((f) => f.source_key !== "boston.a80_legacy");
  if (!active.length) return ["needs_review", ["no_primary_source"]];
  if (units !== null && units > maxUnits) return ["rejected", [`units_above_${maxUnits}`]];
  const a80 = active.filter((f) => f.record_class === "planning_project");
  if (a80.length && a80.every((f) => f.stage === "complete") && stage === "complete") return ["rejected", ["construction_complete"]];
  const order: Record<string, number> = { qualified: 3, needs_review: 2, rejected: 1 };
  const best = active.reduce((a, c) => ((order[c.eligibility] ?? 0) > (order[a.eligibility] ?? 0) ? c : a));
  const reasons = [...(best.eligibility_reasons ?? [])];
  if (best.eligibility === "needs_review" && units !== null && units >= minUnits && units <= maxUnits) {
    const blockers = reasons.filter((r) => /^(verify_residential_led|residential_use_unconfirmed|document_evaluated_with_project|no_primary_source)/.test(r));
    const hasDev = active.some((f) => (f.project_types ?? []).some((t) => DEV_TYPES.has(t))) || a80.length > 0;
    if (hasDev && (!blockers.length || (reasons.length === 1 && reasons[0] === "document_evaluated_with_project")))
      return ["qualified", [`units_${units}_in_range`, "units_from_linked_filing"]];
  }
  if (best.eligibility === "qualified" && units !== null && units < minUnits) return ["rejected", ["no_residential_units"]];
  return [best.eligibility ?? "needs_review", reasons];
}

// ---------------------------------------------------------------- financing
export function lendingCategory(types: string[], stage: string | null): string {
  const t = new Set(types);
  if (stage === "complete") return "bridge";
  if (t.has("conversion")) return "conversion";
  if (t.has("substantial_rehab")) return "heavy_rehab";
  if (["new_construction", "demolition_rebuild", "addition", "adds_units"].some((x) => t.has(x))) return "construction";
  return "unknown";
}
const bucket = (u: number | null) => (u === null ? "multifamily" : u === 1 ? "single_family" : u <= 4 ? "two_to_four_family" : "multifamily");
const fmt$ = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

export interface FinanceInput { units_proposed: number | null; units_confidence?: string; project_types: string[]; stage: string | null; proposed_cost: number | null; declared_valuation: number | null }
export function estimateFinancing(p: FinanceInput, s: Settings) {
  const fin = s.financing;
  const cat = lendingCategory(p.project_types, p.stage);
  const ltc = cat === "bridge" ? fin.bridge_loan_to_cost : fin.loan_to_cost;
  const basis: any = { lending_category: cat, loan_to_cost: ltc, assumptions: [] as string[] };
  let lo: number | null = null, hi: number | null = null;
  const u = p.units_proposed;
  if (p.proposed_cost) {
    [lo, hi] = [p.proposed_cost * fin.official_cost_band[0], p.proposed_cost * fin.official_cost_band[1]];
    basis.method = "official_proposed_cost";
    basis.assumptions.push(`Officially stated project cost ${fmt$(p.proposed_cost)} (band ${fin.official_cost_band.join("–")}).`);
  } else if (p.declared_valuation && p.declared_valuation >= 50_000 && ["construction", "heavy_rehab", "conversion"].includes(cat)) {
    const m = fin.hard_cost_to_tdc;
    [lo, hi] = [p.declared_valuation * m[0], p.declared_valuation * m[1]];
    basis.method = "declared_construction_valuation";
    basis.assumptions.push(`Declared construction valuation ${fmt$(p.declared_valuation)} on issued permit(s) treated as hard cost; TDC = valuation × ${m[0]}–${m[1]}.`);
  } else if (u) {
    const per = fin.tdc_per_unit;
    const rng = cat === "conversion" ? per.conversion : cat === "heavy_rehab" ? per.substantial_rehab
      : p.project_types.length === 1 && p.project_types[0] === "addition" ? per.addition : per.new_construction[bucket(u)];
    [lo, hi] = [u * rng[0], u * rng[1]];
    basis.method = "unit_count_x_per_unit_cost";
    basis.assumptions.push(`${u} units × ${fmt$(rng[0])}–${fmt$(rng[1])} per unit (Boston ${cat} assumption, editable).`);
  } else {
    basis.method = "none";
    basis.assumptions.push("No unit count or cost evidence published; no estimate made.");
    return { est_tdc_low: null, est_tdc_high: null, est_loan_low: null, est_loan_high: null, financing_fit: "uncertain", lending_category: cat, financing_basis: basis };
  }
  const llo = lo! * ltc[0], lhi = hi! * ltc[1];
  basis.assumptions.push(`Loan = TDC × ${ltc[0] * 100}%–${ltc[1] * 100}% loan-to-cost. Not a borrower request.`);
  let fit = lhi <= s.business.max_loan ? "likely" : llo > s.business.max_loan ? "outside_scope" : "uncertain";
  if (basis.method === "unit_count_x_per_unit_cost" && fit === "likely" && ["low", "unknown"].includes(p.units_confidence ?? "")) fit = "uncertain";
  basis.max_loan = s.business.max_loan;
  return { est_tdc_low: Math.round(lo!), est_tdc_high: Math.round(hi!), est_loan_low: Math.round(llo), est_loan_high: Math.round(lhi), financing_fit: fit, lending_category: cat, financing_basis: basis };
}

// ---------------------------------------------------------------- scoring
export interface ScoreInput { units_proposed: number | null; stage: string | null; financing_fit: string; est_loan_high: number | null; latest_filing_date: string | null; has_verified_contact: boolean; has_named_developer: boolean; has_applicant: boolean; developer_other_projects: number | null }
export function score(p: ScoreInput, s: Settings, today: Date): [number, Record<string, any>] {
  const u = p.units_proposed;
  const unitFit: [number, string] = u === null ? [0.3, "unit count unknown"] : u < 1 || u > 200 ? [0, `${u} units outside 1–200`]
    : u >= 5 && u <= 100 ? [1, `${u} units — core fit`] : u >= 101 ? [0.8, `${u} units — upper range`] : u >= 2 ? [0.8, `${u} units — small multifamily`] : [0.6, "single unit"];
  const r = stageRank(p.stage);
  const stage: [number, string] = r === null ? [0.4, "stage unknown"] : r <= 25 ? [1, "early: planning / zoning"] : r <= 40 ? [0.8, "approvals / permit application"]
    : r <= 50 ? [0.5, "permit issued — financing may be arranged"] : r <= 60 ? [0.25, "under construction"] : [0.1, "complete / inactive"];
  const loan: [number, string] = p.financing_fit === "likely" ? (p.est_loan_high !== null && p.est_loan_high < 1_000_000 ? [0.5, "likely fit but small estimated loan"] : [1, "estimated loan within cap"])
    : p.financing_fit === "outside_scope" ? [0, "estimated loan above cap"] : [0.4, "loan size uncertain"];
  let newness: [number, string] = [0.2, "no filing date"];
  if (p.latest_filing_date) {
    const d = Math.floor((today.getTime() - new Date(p.latest_filing_date + "T00:00:00Z").getTime()) / 86_400_000);
    newness = [d <= 7 ? 1 : d <= 30 ? 0.8 : d <= 90 ? 0.5 : d <= 180 ? 0.3 : 0.1, `filed ${d}d ago`];
  }
  const contact: [number, string] = p.has_verified_contact ? [1, "public business contact with source"] : p.has_named_developer ? [0.5, "developer/proponent named, no contact"]
    : p.has_applicant ? [0.3, "applicant/agent named only"] : [0, "no named party"];
  const n = p.developer_other_projects;
  const act: [number, string] = n === null ? [0, "developer unknown"] : n >= 2 ? [1, `${n} other projects`] : n === 1 ? [0.6, "1 other project"] : [0.2, "no other projects on record"];
  const parts: Record<string, [number, string]> = { unit_fit: unitFit, early_stage: stage, loan_size: loan, newness, contact_quality: contact, developer_activity: act };
  const w = s.scoring.weights;
  const total = Object.values(w).reduce((a, x) => a + x, 0) || 1;
  let sum = 0;
  const br: Record<string, any> = {};
  for (const [k, [v, why]] of Object.entries(parts)) {
    sum += v * (w[k] ?? 0);
    br[k] = { weight: w[k] ?? 0, value: v, points: Math.round((v * (w[k] ?? 0) * 100) / total * 10) / 10, why };
  }
  return [Math.round((sum / total) * 100), br];
}
