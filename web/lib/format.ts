export function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

export function dt(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function day(v: string | Date | null | undefined): string {
  if (!v) return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = typeof v === "string" ? new Date(v) : v;
  return d.toISOString().slice(0, 10);
}

export function ago(v: string | Date | null | undefined): string {
  if (!v) return "never";
  const ms = Date.now() - new Date(v).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function until(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const m = Math.round((new Date(v).getTime() - Date.now()) / 60000);
  if (m <= 0) return m > -2 ? "due now" : `overdue ${duration(-m)}`;
  return `in ${duration(m)}`;
}

export function duration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 60 * 48) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} d`;
}

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const ROLE_LABELS: Record<string, string> = {
  developer: "Developer",
  proponent: "Proponent",
  owner_of_record: "Owner of record (assessor)",
  applicant: "Permit applicant",
  zba_contact: "ZBA appeal contact",
  contact_person: "Project contact",
  architect: "Architect",
  engineer: "Engineer",
  contractor: "Contractor",
  planning_staff: "Planning Dept. staff",
};

export const CLASS_LABELS: Record<string, string> = {
  planning_project: "Article 80 project record",
  planning_document: "Planning document",
  permit_application: "Permit application",
  issued_permit: "Issued permit",
  certificate_of_occupancy: "Certificate of occupancy",
  zoning_appeal: "Zoning appeal",
};

export const KIND_LABELS: Record<string, string> = {
  project_record: "Project record",
  developer_filing: "Developer filing",
  approval: "Approval",
  community_engagement: "Presentation / video / comments",
  administrative: "Administrative",
  application: "Application",
  permit: "Permit",
  appeal: "Appeal",
  completion: "Completion",
};

export const SOURCE_LABELS: Record<string, string> = {
  "boston.a80_projects": "Article 80",
  "boston.records_library": "Records Library",
  "boston.permit_applications": "Permit applications",
  "boston.building_permits": "Issued permits",
  "boston.zba": "ZBA",
  "boston.a80_legacy": "A80 legacy (2016)",
  "boston.property_assessment": "Assessing",
};
