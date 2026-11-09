/** Server-rendered dashboard + JSON/CSV endpoints. All filtering/pagination happens in SQL. */
import type { Engine } from "./engine";
import { STAGES } from "./logic";
import { CLASS_LABELS } from "./notify";
import { nowIso, pj, type Row } from "./sql";

// ---------------------------------------------------------------- helpers
export const h = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const money = (v: number | null | undefined) => (v == null ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`);
const dt = (v: string | null | undefined) => (v ? new Date(v).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : "—");
const dur = (min: number | null | undefined) => (min == null || Number.isNaN(min) ? "—" : min < 60 ? `${Math.round(min)} min` : min < 2880 ? `${(min / 60).toFixed(1)} h` : `${(min / 1440).toFixed(1)} d`);
const ago = (v: string | null | undefined) => {
  if (!v) return "never";
  const m = Math.round((Date.now() - Date.parse(v)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const until = (v: string | null | undefined) => {
  if (!v) return "—";
  const m = Math.round((Date.parse(v) - Date.now()) / 60000);
  return m <= 0 ? (m > -2 ? "due now" : `overdue ${dur(-m)}`) : `in ${dur(m)}`;
};
const csv = (v: unknown) => { const s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const ELIG: Record<string, string> = { qualified: "Qualified", needs_review: "Needs review", rejected: "Rejected" };
const FITS: Record<string, string> = { likely: "Likely", uncertain: "Uncertain", outside_scope: "Outside scope" };
const TYPES: Record<string, string> = { new_construction: "New construction", demolition_rebuild: "Demolition / rebuild", substantial_rehab: "Substantial rehab",
  conversion: "Conversion", addition: "Addition", adds_units: "Adds units", mixed_use: "Mixed-use" };
const UNITS: Record<string, [number, number]> = { "1-4": [1, 4], "5-20": [5, 20], "21-50": [21, 50], "51-100": [51, 100], "101-200": [101, 200] };
const PIPELINE = ["New", "Researching", "Contacted", "In Discussion", "Term Sheet", "Closed", "Not a Fit"];
const ROLE: Record<string, string> = { developer: "Developer", proponent: "Proponent", owner_of_record: "Owner of record (assessor)", applicant: "Permit applicant",
  zba_contact: "ZBA appeal contact", contact_person: "Project contact" };
const SRC: Record<string, string> = { "boston.a80_projects": "Article 80", "boston.records_library": "Records Library", "boston.permit_applications": "Permit applications",
  "boston.building_permits": "Issued permits", "boston.zba": "ZBA", "boston.a80_legacy": "A80 legacy (2016)", "boston.property_assessment": "Assessing" };
const KIND: Record<string, string> = { project_record: "Project record", developer_filing: "Developer filing", approval: "Approval", community_engagement: "Presentation / video / comments",
  administrative: "Administrative", application: "Application", permit: "Permit", appeal: "Appeal", completion: "Completion" };
const STAGE_LABEL = Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v[1]]));
const opt = (m: Record<string, string>, sel?: string, any = "Any") => `<option value="">${any}</option>` + Object.entries(m).map(([k, v]) => `<option value="${h(k)}"${k === sel ? " selected" : ""}>${h(v)}</option>`).join("");
const pill = (text: string, tone = "") => `<span class="pill ${tone}">${h(text)}</span>`;
const elig = (v: string) => pill(ELIG[v] ?? v, v === "qualified" ? "ok" : v === "needs_review" ? "warn" : "mute");
const fit = (v: string) => pill(`Fit: ${FITS[v] ?? v}`, v === "likely" ? "ok" : v === "outside_scope" ? "bad" : "warn");
const scoreBar = (v: number | null) => (v == null ? "—" : `<span class="score"><span style="width:${v}%"></span></span> ${v}`);

const CSS = `*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f8fa;color:#0f172a}
a{color:#1f6290;text-decoration:none}a:hover{text-decoration:underline}header{background:#0d2a40;color:#fff}header .in{max-width:1500px;margin:auto;display:flex;gap:18px;align-items:center;padding:0 16px;height:48px;overflow-x:auto}
header a{color:#fff;white-space:nowrap;padding:4px 8px;border-radius:4px}header a:hover{background:#ffffff1a;text-decoration:none}header b{white-space:nowrap}main{max-width:1500px;margin:auto;padding:18px 16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px}.pad{padding:14px}table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;background:#f8fafc;padding:8px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}.tbl{overflow-x:auto}.muted{color:#64748b;font-size:12px}.small{font-size:12px}.pill{display:inline-block;padding:1px 6px;border-radius:4px;font-size:12px;background:#f1f5f9;border:1px solid #e2e8f0;white-space:nowrap}
.ok{background:#ecfdf5;color:#047857;border-color:#a7f3d0}.warn{background:#fffbeb;color:#92400e;border-color:#fde68a}.bad{background:#fff1f2;color:#be123c;border-color:#fecdd3}.mute{color:#475569}
.grid{display:grid;gap:12px}.g6{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}.g3{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}.stat .v{font-size:22px;font-weight:600}
form.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;align-items:end;padding:12px}label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#64748b}
input,select,textarea{font:inherit;padding:5px 7px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;color:#0f172a}button,.btn{font:inherit;padding:6px 12px;border-radius:4px;border:1px solid #1f6290;background:#1f6290;color:#fff;cursor:pointer;display:inline-block}
.btn2{background:#fff;color:#0f172a;border-color:#cbd5e1}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}h1{font-size:20px;margin:0 0 10px}h2{font-size:16px;margin:0 0 8px}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}dt{color:#64748b;font-size:12px}dd{margin:0;word-break:break-word}
.score{display:inline-block;width:40px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;vertical-align:middle}.score span{display:block;height:100%;background:#2b7aa8}.new{background:#f0f7fb}
.kanban{display:grid;grid-template-columns:repeat(7,minmax(180px,1fr));gap:10px;overflow-x:auto}.col{background:#eef2f6;border-radius:8px;padding:8px;min-height:200px}.col .card{padding:8px;margin-bottom:8px;font-size:12px}`;

function page(title: string, body: string, head = ""): Response {
  const nav = [["/", "Live feed"], ["/leads", "Leads"], ["/leads?eligibility=needs_review", "Needs review"], ["/map", "Map"], ["/developers", "Developers"],
    ["/pipeline", "Pipeline"], ["/health", "Sources & alerts"], ["/settings", "Settings"]];
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · IceCap</title><style>${CSS}</style>${head}</head><body><header><div class="in"><b>IceCap <span style="opacity:.75;font-weight:400">Development Intelligence</span></b>
${nav.map(([u, l]) => `<a href="${u}">${l}</a>`).join("")}<span style="margin-left:auto;opacity:.7;font-size:12px;white-space:nowrap">Boston · public records only</span></div></header><main>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } });

// ---------------------------------------------------------------- filters
type F = Record<string, string>;
const KEYS = ["eligibility", "units", "type", "stage", "fit", "neighborhood", "developer", "applicant", "unread", "contact", "filed_from", "filed_to", "seen_from", "seen_to", "q", "pipeline", "sort"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function parseFilters(sp: URLSearchParams): F {
  const f: F = {};
  for (const k of KEYS) { const v = sp.get(k); if (v) f[k] = v.slice(0, 200); }
  if (!sp.has("eligibility")) f.eligibility = "qualified";
  if (f.eligibility === "all") delete f.eligibility;
  return f;
}
export function qsOf(f: F, extra: F = {}): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) u.set(k, v);
  if (!f.eligibility && !extra.eligibility) u.set("eligibility", "all");
  return u.toString();
}
export function buildWhere(f: F): [string, (string | number)[]] {
  const w: string[] = [], p: (string | number)[] = [];
  const add = (s: string, ...v: (string | number)[]) => { w.push(s); p.push(...v); };
  if (f.eligibility && ELIG[f.eligibility]) add("p.eligibility=?", f.eligibility);
  if (f.units && UNITS[f.units]) add("p.units_proposed BETWEEN ? AND ?", ...UNITS[f.units]);
  if (f.units === "unknown") w.push("p.units_proposed IS NULL");
  if (f.type && TYPES[f.type]) f.type === "mixed_use" ? w.push("(p.is_mixed_use=1 OR EXISTS (SELECT 1 FROM json_each(p.project_types) WHERE value='mixed_use'))")
    : add("EXISTS (SELECT 1 FROM json_each(p.project_types) WHERE value=?)", f.type);
  if (f.stage && STAGES[f.stage]) add("p.stage=?", f.stage);
  if (f.fit && FITS[f.fit]) add("p.financing_fit=?", f.fit);
  if (f.neighborhood) add("p.neighborhood=?", f.neighborhood);
  if (f.pipeline && PIPELINE.includes(f.pipeline)) add("p.pipeline_status=?", f.pipeline);
  if (f.developer) add("EXISTS (SELECT 1 FROM project_entities pe JOIN entities e ON e.id=pe.entity_id WHERE pe.project_id=p.id AND pe.role IN ('developer','proponent','owner_of_record') AND e.name LIKE ?)", `%${f.developer}%`);
  if (f.applicant) add("EXISTS (SELECT 1 FROM project_entities pe JOIN entities e ON e.id=pe.entity_id WHERE pe.project_id=p.id AND pe.role IN ('applicant','zba_contact') AND e.name LIKE ?)", `%${f.applicant}%`);
  if (f.unread === "1") w.push("p.is_read=0");
  if (f.contact === "1") w.push("p.has_contact=1");
  if (f.filed_from && DATE.test(f.filed_from)) add("p.latest_filing_date>=?", f.filed_from);
  if (f.filed_to && DATE.test(f.filed_to)) add("p.latest_filing_date<=?", f.filed_to);
  if (f.seen_from && DATE.test(f.seen_from)) add("p.first_seen_at>=?", f.seen_from);
  if (f.seen_to && DATE.test(f.seen_to)) add("substr(p.first_seen_at,1,10)<=?", f.seen_to);
  if (f.q) add("(p.name LIKE ? OR p.address LIKE ? OR p.parcel_id=?)", `%${f.q}%`, `%${f.q}%`, f.q);
  return [w.length ? w.join(" AND ") : "1=1", p];
}
const SORTS: Record<string, [string, string]> = {
  first_seen: ["First seen (newest)", "p.first_seen_at DESC, p.id DESC"], filed: ["Filing date (newest)", "p.latest_filing_date IS NULL, p.latest_filing_date DESC, p.id DESC"],
  score: ["Score (highest)", "p.score IS NULL, p.score DESC, p.id DESC"],
};
const LEAD_COLS = `p.*, (SELECT e.name FROM entities e WHERE e.id=p.developer_entity_id) developer,
  (SELECT group_concat(e.name, '; ') FROM project_entities pe JOIN entities e ON e.id=pe.entity_id WHERE pe.project_id=p.id AND pe.role='owner_of_record') owner_of_record,
  (SELECT group_concat(e.name, '; ') FROM project_entities pe JOIN entities e ON e.id=pe.entity_id WHERE pe.project_id=p.id AND pe.role IN ('applicant','zba_contact')) applicants`;

function filterForm(eng: Engine, f: F, action: string, sort = true): string {
  const nb = eng.sql.all(`SELECT DISTINCT neighborhood n FROM projects WHERE neighborhood IS NOT NULL ORDER BY 1`).map((r) => r.n);
  const sel = (n: string, m: Record<string, string>) => `<select name="${n}">${opt(m, f[n])}</select>`;
  return `<form class="card filters" method="get" action="${action}">
  <label>Eligibility<select name="eligibility"><option value="all">All</option>${Object.entries(ELIG).map(([k, v]) => `<option value="${k}"${f.eligibility === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>
  <label>Units${sel("units", { ...Object.fromEntries(Object.keys(UNITS).map((k) => [k, `${k} units`])), unknown: "Unknown" })}</label>
  <label>Project type${sel("type", TYPES)}</label><label>Stage${sel("stage", STAGE_LABEL)}</label><label>Financing fit${sel("fit", FITS)}</label>
  <label>Neighborhood${sel("neighborhood", Object.fromEntries(nb.map((n) => [n, n])))}</label>
  <label>Developer / owner<input name="developer" value="${h(f.developer)}" placeholder="name contains"></label>
  <label>Applicant / agent<input name="applicant" value="${h(f.applicant)}" placeholder="name contains"></label>
  <label>Filing date from<input type="date" name="filed_from" value="${h(f.filed_from)}"></label><label>Filing date to<input type="date" name="filed_to" value="${h(f.filed_to)}"></label>
  <label>First seen from<input type="date" name="seen_from" value="${h(f.seen_from)}"></label><label>First seen to<input type="date" name="seen_to" value="${h(f.seen_to)}"></label>
  <label>Pipeline${sel("pipeline", Object.fromEntries(PIPELINE.map((x) => [x, x])))}</label><label>Search<input name="q" value="${h(f.q)}" placeholder="address, name, parcel"></label>
  ${sort ? `<label>Sort<select name="sort">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}"${(f.sort ?? "first_seen") === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
  <div class="small"><label style="flex-direction:row;gap:4px"><input type="checkbox" name="unread" value="1"${f.unread === "1" ? " checked" : ""}> Only new / unread</label>
  <label style="flex-direction:row;gap:4px"><input type="checkbox" name="contact" value="1"${f.contact === "1" ? " checked" : ""}> Only with contact info</label></div>
  <div class="row"><button>Apply</button><a class="btn btn2" href="${action}">Reset</a></div></form>`;
}
function savedSearches(eng: Engine, path: string, qs: string): string {
  const items = eng.sql.all(`SELECT * FROM saved_searches ORDER BY name`);
  return `<div class="row small" style="margin:10px 0"><span class="muted">Saved searches:</span>
  ${items.map((s) => `<span class="pill"><a href="${h(s.path)}?${h(s.qs)}">${h(s.name)}</a> <form method="post" action="/saved-searches/${s.id}/delete" style="display:inline"><button class="btn2" style="padding:0 4px;border:0" title="delete">×</button></form></span>`).join("")}
  <form method="post" action="/saved-searches" class="row"><input type="hidden" name="path" value="${h(path)}"><input type="hidden" name="qs" value="${h(qs)}">
  <input name="name" placeholder="name this search" required style="width:160px"><button class="btn2">Save current</button></form></div>`;
}

// ---------------------------------------------------------------- pages
function unitsCell(r: Row): string {
  if (r.units_proposed != null) return String(r.units_proposed);
  return r.pu != null ? `${r.pu}*` : '<span class="muted">?</span>';
}
function feed(eng: Engine, sp: URLSearchParams): Response {
  const sel = sp.get("eligibility") ?? "relevant", order = sp.get("order") === "filed" ? "filed" : "seen";
  const w: string[] = [], p: (string | number)[] = [];
  if (sel === "relevant") w.push("f.eligibility IN ('qualified','needs_review')");
  else if (ELIG[sel]) { w.push("f.eligibility=?"); p.push(sel); }
  const cls = sp.get("class"), src = sp.get("source");
  if (cls && CLASS_LABELS[cls]) { w.push("f.record_class=?"); p.push(cls); }
  if (src && SRC[src]) { w.push("f.source_key=?"); p.push(src); } else w.push("f.source_key NOT IN (SELECT key FROM sources WHERE is_enrichment_only=1)");
  const before = sp.get("before");
  if (before) {
    const [ts, id] = before.split("|");
    if (order === "seen") { w.push("(f.first_seen_at < ? OR (f.first_seen_at = ? AND f.id < ?))"); p.push(ts, ts, Number(id)); }
    else { w.push("(COALESCE(f.source_filing_date,'') < ? OR (COALESCE(f.source_filing_date,'') = ? AND f.id < ?))"); p.push(ts, ts, Number(id)); }
  }
  const rows = eng.sql.all(`SELECT f.*, pr.neighborhood pn, pr.units_proposed pu, pr.is_read FROM filings f LEFT JOIN projects pr ON pr.id=f.project_id
    WHERE ${w.join(" AND ")} ORDER BY ${order === "seen" ? "f.first_seen_at DESC, f.id DESC" : "COALESCE(f.source_filing_date,'') DESC, f.id DESC"} LIMIT 50`, ...p);
  const st = eng.sql.one(`SELECT (SELECT count(*) FROM projects WHERE eligibility='qualified') q, (SELECT count(*) FROM projects WHERE eligibility='needs_review') nr,
    (SELECT count(*) FROM filings) f, (SELECT count(*) FROM project_events WHERE detected_at>? AND (suppressed_reason IS NULL OR suppressed_reason NOT IN ('backfill','reprocess'))) ev,
    (SELECT count(*) FROM notifications WHERE kind='alert' AND created_at>?) al, (SELECT max(last_success_at) FROM source_state) ls`,
    new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() - 864e5).toISOString())!;
  const pending = eng.sql.one(`SELECT count(*) n FROM source_state WHERE backfill_completed_at IS NULL AND source_key<>'boston.property_assessment'`)!.n;
  const last = rows[rows.length - 1];
  const next = rows.length === 50 && last ? (order === "seen" ? `${last.first_seen_at}|${last.id}` : `${last.source_filing_date ?? ""}|${last.id}`) : null;
  const link = (extra: Record<string, string>) => "/?" + new URLSearchParams(Object.entries({ eligibility: sel, order, class: cls ?? "", source: src ?? "", ...extra }).filter(([, v]) => v) as [string, string][]).toString();
  const tile = (l: string, v: unknown, href: string) => `<a class="card pad stat" href="${href}"><div class="muted">${l}</div><div class="v">${h(v ?? "—")}</div></a>`;
  return page("Live feed", `${pending ? `<div class="card pad warn" style="margin-bottom:12px">Initial 365-day backfill in progress — ${pending} source(s) remaining. It continues automatically every 5 minutes; backfilled records never trigger alerts.</div>` : ""}
  <div class="grid g6">${tile("Qualified leads", st.q, "/leads")}${tile("Needs review", st.nr, "/leads?eligibility=needs_review")}${tile("Filings stored", st.f, "/?eligibility=all")}
  ${tile("Events (24h)", st.ev, "/health")}${tile("Alerts queued (24h)", st.al, "/health#alerts")}${tile("Last successful check", ago(st.ls), "/health")}</div>
  <div class="row" style="margin:14px 0"><h1 style="margin:0">Live feed</h1>
  ${[["relevant", "Qualified + review"], ["qualified", "Qualified"], ["needs_review", "Needs review"], ["rejected", "Rejected"], ["all", "All"]].map(([k, l]) => `<a class="btn ${sel === k ? "" : "btn2"}" href="${link({ eligibility: k })}">${l}</a>`).join("")}
  <span class="muted">|</span>${order === "seen" ? "<b>Newest first seen</b>" : `<a href="${link({ order: "seen" })}">Newest first seen</a>`} ${order === "filed" ? "<b>Newest filing date</b>" : `<a href="${link({ order: "filed" })}">Newest filing date</a>`}
  <form class="row" method="get" style="margin-left:auto"><input type="hidden" name="eligibility" value="${h(sel)}"><input type="hidden" name="order" value="${order}">
  <select name="class">${opt(CLASS_LABELS, cls ?? undefined, "All record types")}</select><select name="source">${opt(SRC, src ?? undefined, "All sources")}</select><button class="btn2">Filter</button></form></div>
  <div class="card tbl"><table><tr><th>First seen</th><th>Filed / dated</th><th>Record</th><th>Address / title</th><th>Units</th><th>Eligibility</th><th>Links</th></tr>
  ${rows.map((r) => `<tr class="${r.project_id && !r.is_read ? "new" : ""}"><td class="small">${dt(r.first_seen_at)}</td><td class="small">${day(r.source_filing_date)}</td>
  <td class="small"><b>${h(CLASS_LABELS[r.record_class] ?? r.record_class)}</b><div class="muted">${h(KIND[r.filing_kind] ?? r.filing_kind)} · ${h(SRC[r.source_key] ?? r.source_key)}</div></td>
  <td>${r.project_id ? `<a href="/leads/${r.project_id}"><b>${h(r.address ?? r.title)}</b></a>` : `<b>${h(r.address ?? r.title)}</b>`}<div class="muted">${h(r.doc_type)}${r.pn ? ` · ${h(r.pn)}` : ""}</div></td>
  <td>${unitsCell(r)}</td><td>${elig(r.eligibility)}<div class="muted">${h(pj<string[]>(r.eligibility_reasons, []).slice(0, 2).join(", "))}</div></td>
  <td class="small">${r.document_url ? `<a href="${h(r.document_url)}" target="_blank" rel="noreferrer">Document</a> ` : ""}${r.source_url ? `<a href="${h(r.source_url)}" target="_blank" rel="noreferrer">Source</a>` : ""}</td></tr>`).join("")}
  ${rows.length ? "" : `<tr><td colspan="7" class="muted">No filings match.</td></tr>`}</table></div>
  <div class="row" style="justify-content:space-between;margin-top:10px"><span class="muted">* unit count from the linked project. Issued permits are not applications; only publicly accessible records are shown.</span>${next ? `<a class="btn btn2" href="${link({ before: next })}">Older →</a>` : ""}</div>`);
}

function leads(eng: Engine, sp: URLSearchParams): Response {
  const f = parseFilters(sp);
  const [w, p] = buildWhere(f);
  const pg = Math.max(1, Number(sp.get("page") ?? 1) || 1);
  const rows = eng.sql.all(`SELECT ${LEAD_COLS} FROM projects p WHERE ${w} ORDER BY ${(SORTS[f.sort ?? "first_seen"] ?? SORTS.first_seen)[1]} LIMIT 51 OFFSET ?`, ...p, (pg - 1) * 50);
  const total = eng.sql.one(`SELECT count(*) n FROM projects p WHERE ${w}`, ...p)!.n;
  const qs = qsOf(f);
  return page("Leads", `<div class="row" style="margin-bottom:10px"><h1 style="margin:0">Leads</h1><span class="muted">${total.toLocaleString()} projects</span>
  <a class="btn btn2" style="margin-left:auto" href="/export.csv?${h(qs)}">Export CSV</a><a class="btn btn2" href="/map?${h(qs)}">View on map</a></div>
  ${filterForm(eng, f, "/leads")}${savedSearches(eng, "/leads", qs)}
  <div class="card tbl"><table><tr><th>Project</th><th>Units</th><th>Type</th><th>Stage</th><th>Developer / owner</th><th>Est. loan</th><th>Score</th><th>Filed</th><th>First seen</th><th>Status</th></tr>
  ${rows.slice(0, 50).map((r) => `<tr class="${r.is_read ? "" : "new"}"><td><a href="/leads/${r.id}"><b>${h(r.address ?? r.name)}</b></a>${r.is_read ? "" : ' <b class="small" style="color:#1f6290">NEW</b>'}<div class="muted">${h(r.neighborhood ?? "—")}${r.parcel_id ? ` · parcel ${h(r.parcel_id)}` : ""}</div></td>
  <td>${r.units_proposed ?? '<span class="pill warn">unknown</span>'}${r.units_confidence === "medium" ? '<div class="muted">from text</div>' : ""}</td>
  <td class="small">${h(pj<string[]>(r.project_types, []).map((t) => TYPES[t] ?? t).join(", ") || "—")}</td><td>${pill(STAGE_LABEL[r.stage] ?? "Stage unknown")}</td>
  <td class="small">${r.developer ? h(r.developer) : r.owner_of_record ? `Owner: ${h(r.owner_of_record)}` : '<span class="muted">not published</span>'}${r.applicants ? `<div class="muted">Applicant: ${h(String(r.applicants).slice(0, 60))}</div>` : ""}</td>
  <td class="small">${r.est_loan_low != null ? `${money(r.est_loan_low)}–${money(r.est_loan_high)}` : "—"}<div>${fit(r.financing_fit)}</div></td><td>${scoreBar(r.score)}</td>
  <td class="small">${day(r.latest_filing_date)}</td><td class="small">${day(r.first_seen_at)}</td><td>${elig(r.eligibility)}<div class="muted">${h(r.pipeline_status)}</div></td></tr>`).join("")}
  ${rows.length ? "" : `<tr><td colspan="10" class="muted">No projects match these filters.</td></tr>`}</table></div>
  <div class="row" style="justify-content:space-between;margin-top:10px">${pg > 1 ? `<a class="btn btn2" href="/leads?${h(qs)}&page=${pg - 1}">← Newer</a>` : "<span></span>"}${rows.length > 50 ? `<a class="btn btn2" href="/leads?${h(qs)}&page=${pg + 1}">Older →</a>` : ""}</div>`);
}

function exportCsv(eng: Engine, sp: URLSearchParams): Response {
  const f = parseFilters(sp);
  const [w, p] = buildWhere(f);
  const rows = eng.sql.all(`SELECT ${LEAD_COLS} FROM projects p WHERE ${w} ORDER BY ${(SORTS[f.sort ?? "first_seen"] ?? SORTS.first_seen)[1]} LIMIT 10000`, ...p);
  const cols = ["id", "name", "address", "neighborhood", "parcel_id", "units_proposed", "units_confidence", "property_type", "project_types", "stage", "eligibility",
    "eligibility_reasons", "developer", "owner_of_record", "applicants", "has_contact", "declared_valuation", "est_loan_low", "est_loan_high", "financing_fit",
    "lending_category", "score", "confidence", "missing_data", "first_filing_date", "latest_filing_date", "first_seen_at", "pipeline_status", "project_url", "lat", "lon"];
  const jsonCols = new Set(["project_types", "eligibility_reasons", "missing_data"]);
  const body = [cols.join(","), ...rows.map((r) => cols.map((c) => csv(jsonCols.has(c) ? pj(r[c], []) : r[c])).join(","))].join("\n");
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="icecap-leads-${nowIso().slice(0, 10)}.csv"` } });
}

function lead(eng: Engine, id: number): Response {
  const p = eng.sql.one(`SELECT * FROM projects WHERE id=?`, id);
  if (!p) return page("Not found", "<h1>Lead not found</h1>");
  const sql = eng.sql;
  const filings = sql.all(`SELECT * FROM filings WHERE project_id=? ORDER BY source_filing_date DESC, id DESC`, id);
  const parties = sql.all(`SELECT pe.*, e.name FROM project_entities pe JOIN entities e ON e.id=pe.entity_id WHERE pe.project_id=? ORDER BY pe.role`, id);
  const contacts = sql.all(`SELECT * FROM contacts WHERE project_id=?`, id);
  const events = sql.all(`SELECT e.*, (SELECT group_concat(channel || ':' || status, ', ') FROM notifications n WHERE n.event_id=e.id) deliveries FROM project_events e WHERE project_id=? ORDER BY detected_at DESC, id DESC`, id);
  const assess = p.parcel_id ? sql.one(`SELECT * FROM parcel_assessments WHERE parcel_id=?`, p.parcel_id) : null;
  const related = sql.all(`SELECT DISTINCT p2.id, p2.address, p2.units_proposed, p2.latest_filing_date, e.name entity, pe2.role FROM project_entities pe
    JOIN project_entities pe2 ON pe2.entity_id=pe.entity_id AND pe2.project_id<>pe.project_id JOIN projects p2 ON p2.id=pe2.project_id JOIN entities e ON e.id=pe.entity_id
    WHERE pe.project_id=? AND pe.role IN ('developer','proponent','owner_of_record') AND pe2.role IN ('developer','proponent','owner_of_record') ORDER BY p2.latest_filing_date DESC LIMIT 25`, id);
  const history = sql.all(`SELECT * FROM pipeline_history WHERE project_id=? ORDER BY changed_at DESC`, id);
  if (!p.is_read) sql.run(`UPDATE projects SET is_read=1 WHERE id=?`, id);
  const basis = pj<any>(p.financing_basis, {}), sb = pj<Record<string, any>>(p.score_breakdown, {});
  const dlrow = (k: string, v: string) => `<dt>${k}</dt><dd>${v}</dd>`;
  return page(p.address ?? p.name ?? "Lead", `<div class="row" style="align-items:flex-start"><div><div class="muted"><a href="/leads">Leads</a> / #${p.id}</div><h1 style="font-size:24px;margin:2px 0">${h(p.address ?? p.name)}</h1>
  <div class="muted">${h(p.name && p.name !== p.address ? p.name + " · " : "")}${h(p.neighborhood ?? "Neighborhood unknown")} ${h(p.zip ?? "")}${p.parcel_id ? ` · Parcel ${h(p.parcel_id)}` : ""}${p.lat != null ? ` · ${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)}` : ""}</div>
  <div class="row" style="margin-top:6px">${elig(p.eligibility)}${pill(STAGE_LABEL[p.stage] ?? "Stage unknown")}${fit(p.financing_fit)}${pill(`${p.confidence} confidence`, p.confidence === "high" ? "ok" : "")}${pj<string[]>(p.project_types, []).map((t) => pill(TYPES[t] ?? t)).join("")}</div></div>
  <div style="margin-left:auto;text-align:right"><div class="muted">Lead score</div><div style="font-size:30px;font-weight:600">${p.score ?? "—"}</div><div class="muted" style="max-width:200px">Research priority — not evidence of a financing need</div></div></div>
  <div class="grid g3" style="margin-top:14px">
  <section class="card pad"><h2>Project facts</h2><dl>${dlrow("Proposed units", p.units_proposed != null ? `${p.units_proposed}${p.units_existing != null ? ` <span class="muted">(existing ${p.units_existing})</span>` : ""}` : '<span class="pill warn">Unknown</span>')}
  ${dlrow("Unit source", `<span class="small">${h(p.units_source ?? "—")}</span>`)}${dlrow("Property type", h(String(p.property_type ?? "unknown").replace(/_/g, " ")))}${dlrow("Mixed-use", p.is_mixed_use ? "Yes" : "No / unknown")}
  ${dlrow("Gross floor area", p.gross_sqft ? `${Number(p.gross_sqft).toLocaleString()} sf` : "—")}${dlrow("Review status", h(p.review_status ?? "—"))}${dlrow("First filing date", day(p.first_filing_date))}
  ${dlrow("Latest filing date", day(p.latest_filing_date))}${dlrow("First detected", dt(p.first_seen_at))}${dlrow("Eligibility reasons", `<span class="small">${h(pj<string[]>(p.eligibility_reasons, []).join(", "))}</span>`)}
  ${dlrow("Missing data", `<span class="small" style="color:#92400e">${h(pj<string[]>(p.missing_data, []).join(", ") || "none")}</span>`)}</dl>
  ${p.project_url ? `<p><a href="${h(p.project_url)}" target="_blank" rel="noreferrer">Planning Department project page ↗</a></p>` : ""}${p.description ? `<p class="small">${h(p.description)}</p>` : ""}</section>
  <section class="card pad"><h2>Financing estimate</h2><p class="muted">Estimates only. Project cost, construction valuation, total development cost and lending need are different values; none is a loan request.</p>
  <dl>${dlrow("Official project cost", money(p.proposed_cost))}${dlrow("Declared construction valuation", money(p.declared_valuation))}${dlrow("Est. total dev. cost", p.est_tdc_low != null ? `${money(p.est_tdc_low)}–${money(p.est_tdc_high)}` : "—")}
  ${dlrow("Est. loan range", `<b>${p.est_loan_low != null ? `${money(p.est_loan_low)}–${money(p.est_loan_high)}` : "Not estimated"}</b>`)}${dlrow("Lending category", h(String(p.lending_category ?? "unknown").replace("_", " ")))}
  ${dlrow("Fit vs $50M cap", fit(p.financing_fit))}${dlrow("Method", `<span class="small">${h(basis.method ?? "—")}</span>`)}</dl>
  <ul class="small muted">${(basis.assumptions ?? []).map((a: string) => `<li>${h(a)}</li>`).join("")}</ul>
  <h2 style="margin-top:10px">Score breakdown</h2><table class="small">${Object.entries(sb).map(([k, v]) => `<tr><td class="muted">${h(k.replace(/_/g, " "))}</td><td>${v.points}/${v.weight}</td><td>${h(v.why)}</td></tr>`).join("")}</table></section>
  <section class="card pad"><h2>Pipeline</h2><form method="post" action="/leads/${p.id}"><label>Pipeline status<select name="pipeline_status">${PIPELINE.map((x) => `<option${x === p.pipeline_status ? " selected" : ""}>${x}</option>`).join("")}</select></label>
  <label style="margin-top:8px">Internal notes<textarea name="notes" rows="5">${h(p.notes)}</textarea></label><div class="row" style="margin-top:8px"><button>Save</button>
  <button class="btn2" name="is_read" value="0">Mark unread</button></div></form>
  <ul class="small muted">${history.map((x) => `<li>${dt(x.changed_at)}: ${h(x.from_status)} → ${h(x.to_status)}</li>`).join("")}</ul></section></div>
  <div class="grid g3" style="margin-top:12px"><section class="card pad"><h2>People &amp; organizations (role-labeled)</h2>
  ${parties.length ? parties.map((x) => `<div style="margin-bottom:6px">${pill(ROLE[x.role] ?? x.role)} <a href="/developers/${x.entity_id}">${h(x.name)}</a><div class="muted">Source: ${h(SRC[x.source_key] ?? x.source_key)} — ${h(x.evidence)}</div></div>`).join("")
    : '<p class="muted">No developer, proponent, owner or applicant is named in the linked public records.</p>'}
  <h2 style="margin-top:10px">Public contact information</h2>${contacts.length ? contacts.map((c) => `<div class="small">${h(c.kind)}: ${h(c.value)} <span class="muted">— ${h(c.role_label)}; source ${h(SRC[c.source_key] ?? c.source_key)}</span></div>`).join("") : '<p class="muted">None published in linked records.</p>'}
  ${assess?.found ? `<p class="small muted">Assessor (parcel ${h(assess.parcel_id)}): owner of record ${h(assess.owner ?? "—")} · mailing ${h(assess.mail_address ?? "—")} · ${h(assess.land_use ?? "")} · existing units ${h(assess.res_units ?? "—")} · assessed ${money(assess.total_value)}. Owner of record is not necessarily the developer or borrower.</p>` : ""}</section>
  <section class="card pad"><h2>Developer / owner historical activity</h2>${related.length ? related.map((r) => `<div class="small"><a href="/leads/${r.id}">${h(r.address)}</a> <span class="muted">— ${h(r.entity)} (${h(ROLE[r.role] ?? r.role)}), ${r.units_proposed ?? "?"} units, last filed ${day(r.latest_filing_date)}</span></div>`).join("")
    : '<p class="muted">No other projects linked to the same named developer, proponent or owner of record.</p>'}</section>
  <section class="card pad"><h2>Timeline</h2>${events.map((e) => `<div class="small" style="margin-bottom:6px"><b>${h(e.event_type.replace(/_/g, " "))}</b> — ${h(e.summary)}<div class="muted">filed ${day(e.source_filing_date)} · detected ${dt(e.detected_at)} · ${e.alertable ? `alert queued${e.deliveries ? ` (${h(e.deliveries)})` : ""}${e.alerted_at ? ` · delivered ${dt(e.alerted_at)}` : ""}` : `no alert (${h(e.suppressed_reason)})`}</div></div>`).join("")}</section></div>
  <section class="card tbl" style="margin-top:12px"><h2 class="pad" style="margin:0">Linked public records (${filings.length})</h2><table><tr><th>Date</th><th>Record</th><th>Title</th><th>Status</th><th>Units</th><th>Valuation</th><th>Eligibility</th><th>Links</th></tr>
  ${filings.map((f) => `<tr><td class="small">${day(f.source_filing_date)}<div class="muted">seen ${day(f.first_seen_at)}</div></td><td class="small"><b>${h(CLASS_LABELS[f.record_class] ?? f.record_class)}</b><div class="muted">${h(KIND[f.filing_kind])} · ${h(SRC[f.source_key])} · ${h(f.source_record_id)}</div></td>
  <td class="small" style="max-width:380px">${h(f.title)}${f.description ? `<div class="muted">${h(String(f.description).slice(0, 220))}</div>` : ""}</td><td class="small">${h(f.status ?? "—")}</td>
  <td class="small">${f.units_proposed ?? "—"}${f.units_source ? `<div class="muted">${h(f.units_source)}</div>` : ""}</td><td class="small">${money(f.declared_valuation)}</td>
  <td>${elig(f.eligibility)}<div class="muted">${h(pj<string[]>(f.eligibility_reasons, []).join(", "))}</div></td>
  <td class="small">${f.document_url ? `<a href="${h(f.document_url)}" target="_blank" rel="noreferrer">Document</a><br>` : ""}${f.source_url ? `<a href="${h(f.source_url)}" target="_blank" rel="noreferrer">Source</a>` : ""}</td></tr>`).join("")}</table></section>`);
}

function mapPage(eng: Engine, sp: URLSearchParams): Response {
  const f = parseFilters(sp);
  const [w, p] = buildWhere(f);
  const pts = eng.sql.all(`SELECT p.id, p.lat, p.lon, COALESCE(p.address, p.name) a, p.units_proposed u, p.stage s, p.eligibility e, p.score sc, p.financing_fit fi
    FROM projects p WHERE ${w} AND p.lat IS NOT NULL ORDER BY p.first_seen_at DESC LIMIT 5000`, ...p);
  const missing = eng.sql.one(`SELECT count(*) n FROM projects p WHERE ${w} AND p.lat IS NULL`, ...p)!.n;
  const head = `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"><script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>`;
  const data = JSON.stringify(pts).replace(/</g, "\\u003c");
  return page("Map", `<div class="row" style="margin-bottom:10px"><h1 style="margin:0">Map</h1><span class="muted">${pts.length} mapped · ${missing} without published coordinates</span>
  <span class="small" style="margin-left:auto"><span style="color:#059669">●</span> qualified <span style="color:#d97706">●</span> needs review <span style="color:#94a3b8">●</span> rejected</span></div>
  ${filterForm(eng, f, "/map", false)}${savedSearches(eng, "/map", qsOf(f))}<div class="card" id="map" style="height:68vh"></div>
  <script>const pts=${data};const m=L.map('map').setView([42.325,-71.075],12);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap contributors'}).addTo(m);
  const col={qualified:'#059669',needs_review:'#d97706',rejected:'#94a3b8'};const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  for(const p of pts){L.circleMarker([p.lat,p.lon],{radius:p.u?Math.min(4+Math.sqrt(p.u)*1.2,18):5,color:col[p.e]||'#2b7aa8',weight:1,fillOpacity:.6}).addTo(m)
  .bindPopup('<a href="/leads/'+p.id+'"><b>'+esc(p.a)+'</b></a><br>'+(p.u??'unknown')+' units · '+esc(p.s??'stage unknown')+'<br>'+esc(p.e)+' · fit '+esc(p.fi)+' · score '+(p.sc??'—'));}</script>`, head);
}

function developers(eng: Engine, sp: URLSearchParams): Response {
  const role = sp.get("role");
  const roles = role && ROLE[role] ? [role] : ["developer", "proponent", "owner_of_record"];
  const q = sp.get("q");
  const rows = eng.sql.all(`SELECT e.id, e.name, group_concat(DISTINCT pe.role) roles, count(DISTINCT p.id) projects, count(DISTINCT CASE WHEN p.eligibility='qualified' THEN p.id END) qualified,
    max(p.latest_filing_date) last_filing, count(DISTINCT CASE WHEN p.first_seen_at>? THEN p.id END) new_90d
    FROM entities e JOIN project_entities pe ON pe.entity_id=e.id JOIN projects p ON p.id=pe.project_id
    WHERE pe.role IN (${roles.map(() => "?").join(",")}) ${q ? "AND e.name LIKE ?" : ""} GROUP BY e.id ORDER BY projects DESC, last_filing DESC LIMIT 300`,
    new Date(Date.now() - 90 * 864e5).toISOString(), ...roles, ...(q ? [`%${q}%`] : []));
  return page("Developers", `<div class="row" style="margin-bottom:10px"><h1 style="margin:0">Developers &amp; entities</h1><form class="row" method="get" style="margin-left:auto">
  <select name="role"><option value="">Developer / proponent / owner</option>${Object.entries(ROLE).map(([k, v]) => `<option value="${k}"${role === k ? " selected" : ""}>${v}</option>`).join("")}</select>
  <input name="q" value="${h(q)}" placeholder="name contains"><button class="btn2">Filter</button></form></div>
  <p class="muted">Grouped by exact normalized name as published in official records, with each role labeled. A named applicant or owner of record is not assumed to be the developer.</p>
  <div class="card tbl"><table><tr><th>Entity</th><th>Roles</th><th>Projects</th><th>Qualified</th><th>New (90d)</th><th>Last filing</th></tr>
  ${rows.map((r) => `<tr><td><a href="/developers/${r.id}"><b>${h(r.name)}</b></a></td><td>${String(r.roles ?? "").split(",").map((x) => pill(ROLE[x] ?? x)).join(" ")}</td><td>${r.projects}</td><td>${r.qualified}</td><td>${r.new_90d}</td><td class="small">${day(r.last_filing)}</td></tr>`).join("")}
  ${rows.length ? "" : '<tr><td colspan="6" class="muted">No entities yet.</td></tr>'}</table></div>`);
}

function developer(eng: Engine, id: number): Response {
  const e = eng.sql.one(`SELECT * FROM entities WHERE id=?`, id);
  if (!e) return page("Not found", "<h1>Entity not found</h1>");
  const projects = eng.sql.all(`SELECT p.*, pe.role, pe.source_key sk, pe.evidence FROM project_entities pe JOIN projects p ON p.id=pe.project_id WHERE pe.entity_id=? ORDER BY p.latest_filing_date DESC`, id);
  const filings = eng.sql.all(`SELECT source_filing_date, title, project_id, document_url FROM filings WHERE project_id IN (SELECT project_id FROM project_entities WHERE entity_id=?) ORDER BY source_filing_date DESC LIMIT 100`, id);
  return page(e.name, `<div class="muted"><a href="/developers">Developers</a></div><h1 style="font-size:24px">${h(e.name)}</h1>
  <div class="card tbl"><table><tr><th>Project</th><th>Role</th><th>Units</th><th>Stage</th><th>Eligibility</th><th>Last filing</th><th>Attribution</th></tr>
  ${projects.map((p) => `<tr><td><a href="/leads/${p.id}">${h(p.address)}</a><div class="muted">${h(p.neighborhood)}</div></td><td>${pill(ROLE[p.role] ?? p.role)}</td><td>${p.units_proposed ?? "?"}</td>
  <td>${pill(STAGE_LABEL[p.stage] ?? "—")}</td><td>${elig(p.eligibility)}</td><td class="small">${day(p.latest_filing_date)}</td><td class="muted">${h(SRC[p.sk] ?? p.sk)}: ${h(p.evidence)}</td></tr>`).join("")}</table></div>
  <section class="card pad" style="margin-top:12px"><h2>Filing history across linked projects</h2>${filings.map((f) => `<div class="small"><span class="muted">${day(f.source_filing_date)}</span> <a href="/leads/${f.project_id}">${h(f.title)}</a>${f.document_url ? ` · <a href="${h(f.document_url)}" target="_blank" rel="noreferrer">document</a>` : ""}</div>`).join("")}</section>`);
}

function pipelineBoard(eng: Engine): Response {
  const rows = eng.sql.all(`SELECT id, COALESCE(address, name) a, neighborhood, units_proposed, score, pipeline_status, est_loan_low, est_loan_high FROM projects
    WHERE pipeline_status<>'New' OR (eligibility='qualified' AND (first_seen_at>? OR score>=60)) ORDER BY score DESC LIMIT 600`, new Date(Date.now() - 30 * 864e5).toISOString());
  return page("Pipeline", `<div class="row"><h1 style="margin:0">Pipeline</h1><span class="muted">"New" shows qualified leads first seen in the last 30 days or scoring ≥ 60.</span></div>
  <div class="kanban" style="margin-top:12px">${PIPELINE.map((st) => { const items = rows.filter((r) => r.pipeline_status === st); return `<div class="col"><div class="small" style="font-weight:600;text-transform:uppercase;color:#475569;margin-bottom:6px">${st} (${items.length})</div>
  ${items.slice(0, 80).map((r) => `<div class="card"><a href="/leads/${r.id}"><b>${h(r.a)}</b></a><div class="muted">${h(r.neighborhood ?? "—")} · ${r.units_proposed ?? "?"} units</div>
  <div class="row" style="justify-content:space-between">${scoreBar(r.score)}<span>${r.est_loan_low != null ? `${money(r.est_loan_low)}–${money(r.est_loan_high)}` : ""}</span></div>
  <form method="post" action="/leads/${r.id}" class="row" style="margin-top:4px"><input type="hidden" name="back" value="/pipeline"><select name="pipeline_status" style="flex:1">${PIPELINE.map((x) => `<option${x === st ? " selected" : ""}>${x}</option>`).join("")}</select><button class="btn2">Move</button></form></div>`).join("")}</div>`; }).join("")}</div>`);
}

function health(eng: Engine): Response {
  const sql = eng.sql;
  const sources = sql.all(`SELECT s.*, ss.* FROM sources s JOIN source_state ss ON ss.source_key=s.key ORDER BY s.is_enrichment_only, s.backfill_order`);
  const runs = sql.all(`SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 40`);
  const notes = sql.all(`SELECT n.*, e.project_id FROM notifications n LEFT JOIN project_events e ON e.id=n.event_id ORDER BY n.id DESC LIMIT 50`);
  const agg = sql.all(`SELECT channel, status, count(*) n FROM notifications GROUP BY 1,2 ORDER BY 1,2`);
  const live = "(suppressed_reason IS NULL OR suppressed_reason NOT IN ('backfill','reprocess'))";
  const median = (vals: number[]) => { if (!vals.length) return null; const s = [...vals].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const ev = sql.all(`SELECT detected_at, source_published_at, source_filing_date FROM project_events WHERE ${live} ORDER BY id DESC LIMIT 2000`);
  const pubLag = median(ev.filter((e) => e.source_published_at).map((e) => (Date.parse(e.detected_at) - Date.parse(e.source_published_at)) / 60000));
  const fileLag = median(ev.filter((e) => e.source_filing_date).map((e) => (Date.parse(e.detected_at) - Date.parse(e.source_filing_date + "T00:00:00Z")) / 60000));
  const notifyLag = median(sql.all(`SELECT n.sent_at, e.detected_at FROM notifications n JOIN project_events e ON e.id=n.event_id WHERE n.sent_at IS NOT NULL ORDER BY n.id DESC LIMIT 2000`)
    .map((r) => (Date.parse(r.sent_at) - Date.parse(r.detected_at)) / 1000));
  const silent = sql.one(`SELECT count(*) n FROM project_events WHERE NOT ${live}`)!.n;
  const jobs = sql.all(`SELECT * FROM scheduled_jobs ORDER BY key`);
  const tile = (l: string, v: string, s: string) => `<div class="card pad stat"><div class="muted">${l}</div><div class="v">${v}</div><div class="muted">${s}</div></div>`;
  return page("Source health", `<div class="row"><h1 style="margin:0">Source health</h1><span class="muted">IceCap only sees records after the City publishes them. Lag is measured from the provider's own timestamps where available.</span>
  <form method="post" action="/run" style="margin-left:auto"><button>Run checks now</button></form></div>
  <div class="grid g6" style="margin:12px 0">${tile("Median provider update → detection", dur(pubLag), "live events with a provider timestamp")}${tile("Median filing date → detection", dur(fileLag), "includes the City's publication delay")}
  ${tile("Median detection → notification", notifyLag == null ? "—" : `${Math.round(notifyLag)} s`, "sent or mocked")}${tile("Events", `${ev.length} live`, `${silent} recorded silently (backfill / rule reprocessing)`)}</div>
  <div class="card tbl"><table><tr><th>Source</th><th>Last check</th><th>Last success</th><th>Provider updated</th><th>Newest record date</th><th>Records</th><th>Polling</th><th>State</th><th></th></tr>
  ${sources.map((s) => { const open = s.circuit_open_until && Date.parse(s.circuit_open_until) > Date.now();
    return `<tr><td style="max-width:360px"><a href="${h(s.official_url)}" target="_blank" rel="noreferrer"><b>${h(s.name)}</b></a><div class="muted">${h(s.record_class)}${s.is_enrichment_only ? " · enrichment only" : ""} · ${h(s.cadence)}</div>
    <details class="small"><summary>Limitations</summary>${h(s.limitations)}</details></td><td class="small">${ago(s.last_check_at)}</td>
    <td class="small">${ago(s.last_success_at)}<div class="muted">${s.run_mode ? `${h(s.run_mode)} in progress` : s.backfill_completed_at ? `backfilled ${day(s.backfill_completed_at)}` : s.record_class === "property_record" ? "on-demand lookups" : "backfill pending"}</div></td>
    <td class="small">${s.upstream_updated_at ? dt(s.upstream_updated_at) : "not exposed"}</td><td class="small">${day(s.newest_record_at)}</td><td class="small">${Number(s.records_total).toLocaleString()}</td>
    <td class="small">every ${dur(s.current_interval_s / 60)}<div class="muted">next run ${until(s.next_run_at)}</div></td>
    <td>${open ? pill("circuit open", "bad") : s.consecutive_failures > 0 ? pill(`${s.consecutive_failures} failure(s)`, "warn") : pill("healthy", "ok")}${s.last_error ? `<div class="small" style="color:#be123c;max-width:260px">${h(String(s.last_error).slice(0, 200))}</div>` : ""}</td>
    <td>${s.record_class === "property_record" ? "" : `<form method="post" action="/sources/${h(s.key)}/run"><button class="btn2 small">Run now</button></form>`}</td></tr>`; }).join("")}</table></div>
  <h2 id="alerts" style="margin-top:16px">Alert delivery</h2><div class="row">${agg.map((r) => pill(`${r.channel}: ${r.status} ${r.n}`, r.status === "sent" ? "ok" : r.status === "dead" ? "bad" : r.status === "mocked" ? "" : "warn")).join("") || '<span class="muted">No notifications yet (backfilled records never alert).</span>'}</div>
  <p class="muted">"mocked" = credentials not configured; the message is stored here and was NOT delivered.</p>
  <div class="card tbl"><table><tr><th>Created</th><th>Kind</th><th>Channel</th><th>Status</th><th>Attempts</th><th>Subject</th><th>Sent</th></tr>
  ${notes.map((n) => `<tr><td class="small">${dt(n.created_at)}</td><td class="small">${h(n.kind)}</td><td class="small">${h(n.channel)}</td><td class="small">${h(n.status)}${n.last_error ? `<div style="color:#be123c">${h(String(n.last_error).slice(0, 120))}</div>` : ""}</td>
  <td class="small">${n.attempts}</td><td class="small"><details><summary>${n.project_id ? `<a href="/leads/${n.project_id}">${h(n.subject)}</a>` : h(n.subject)}</summary><pre style="white-space:pre-wrap">${h(n.body)}</pre></details></td><td class="small">${dt(n.sent_at)}</td></tr>`).join("")}</table></div>
  <h2 style="margin-top:16px">Recent ingestion runs</h2><div class="card tbl"><table><tr><th>Started</th><th>Source</th><th>Mode</th><th>Status</th><th>Chunks</th><th>Time</th><th>Fetched</th><th>New</th><th>Changed</th><th>Q / R / X</th><th>Events</th><th>HTTP</th></tr>
  ${runs.map((r) => `<tr><td class="small">${dt(r.started_at)}</td><td class="small">${h(SRC[r.source_key] ?? r.source_key)}</td><td class="small">${h(r.mode)}</td><td class="small">${h(r.status)}${r.error ? `<div style="color:#be123c;max-width:240px">${h(String(r.error).slice(0, 160))}</div>` : ""}</td>
  <td class="small">${r.chunks}</td><td class="small">${(r.duration_ms / 1000).toFixed(1)}s</td><td class="small">${r.fetched}</td><td class="small">${r.inserted}</td><td class="small">${r.changed}</td><td class="small">${r.qualified} / ${r.needs_review} / ${r.rejected}</td><td class="small">${r.events}</td><td class="small">${r.http_requests}</td></tr>`).join("")}</table></div>
  <p class="muted">Scheduled jobs: ${jobs.map((j) => `${h(j.key)} next ${dt(j.next_run_at)} (${h(j.last_status ?? "not run")})`).join(" · ") || "none yet"}</p>`);
}

function settingsPage(eng: Engine, msg = ""): Response {
  const s = eng.settings();
  const area = (k: keyof typeof s) => `<label>${k}<textarea name="${k}" rows="${k === "financing" ? 16 : 10}" style="font-family:ui-monospace,monospace;font-size:12px">${h(JSON.stringify(s[k], null, 2))}</textarea></label>`;
  return page("Settings", `<h1>Settings</h1>${msg ? `<div class="card pad ${msg.startsWith("Error") ? "bad" : "ok"}" style="margin-bottom:10px">${h(msg)}</div>` : ""}
  <p class="muted">Business filters, alert thresholds / quiet hours / digests, score weights and financing assumptions. Quiet hours example: {"start":"22:00","end":"07:00","tz":"America/New_York"}. Changes apply to new records; use "Re-apply rules" to re-evaluate stored records (never sends alerts).</p>
  <form method="post" action="/settings" class="grid g3">${area("business")}${area("alerts")}${area("scoring")}${area("financing")}<div><button>Save settings</button></div></form>
  <form method="post" action="/reprocess" style="margin-top:14px"><button class="btn2">Re-apply rules to stored records</button> <span class="muted">Runs in chunks; may take several minutes for ~45k records.</span></form>`);
}

// ---------------------------------------------------------------- router
export async function handle(eng: Engine, req: Request, ctx: { reprocess: () => Promise<string> }): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const sp = url.searchParams;
  if (req.method === "GET") {
    if (path === "/") return feed(eng, sp);
    if (path === "/leads") return leads(eng, sp);
    let m = path.match(/^\/leads\/(\d+)$/);
    if (m) return lead(eng, Number(m[1]));
    if (path === "/map") return mapPage(eng, sp);
    if (path === "/developers") return developers(eng, sp);
    m = path.match(/^\/developers\/(\d+)$/);
    if (m) return developer(eng, Number(m[1]));
    if (path === "/pipeline") return pipelineBoard(eng);
    if (path === "/health") return health(eng);
    if (path === "/settings") return settingsPage(eng);
    if (path === "/export.csv") return exportCsv(eng, sp);
    if (path === "/api/stats") return Response.json(eng.stats());
    if (path === "/api/projects") {
      const f = parseFilters(sp);
      const [w, p] = buildWhere(f);
      const limit = Math.min(500, Number(sp.get("limit") ?? 50) || 50), offset = Number(sp.get("offset") ?? 0) || 0;
      return Response.json(eng.sql.all(`SELECT ${LEAD_COLS} FROM projects p WHERE ${w} ORDER BY p.first_seen_at DESC, p.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset));
    }
    return new Response("Not found", { status: 404 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = await req.formData();
  const g = (k: string) => (form.get(k) as string | null) ?? null;
  let m = path.match(/^\/leads\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const cur = eng.sql.one(`SELECT pipeline_status FROM projects WHERE id=?`, id);
    if (!cur) return new Response("Not found", { status: 404 });
    const st = g("pipeline_status");
    if (st && PIPELINE.includes(st) && st !== cur.pipeline_status) {
      eng.sql.run(`UPDATE projects SET pipeline_status=?, is_read=1 WHERE id=?`, st, id);
      eng.sql.run(`INSERT INTO pipeline_history (project_id, from_status, to_status, changed_at) VALUES (?,?,?,?)`, id, cur.pipeline_status, st, nowIso());
    }
    if (g("notes") !== null) eng.sql.run(`UPDATE projects SET notes=? WHERE id=?`, String(g("notes")).slice(0, 10000), id);
    if (g("is_read") === "0") { eng.sql.run(`UPDATE projects SET is_read=0 WHERE id=?`, id); return redirect("/leads"); }
    return redirect(g("back") === "/pipeline" ? "/pipeline" : `/leads/${id}`);
  }
  if (path === "/saved-searches") {
    const name = g("name"), p = g("path") === "/map" ? "/map" : "/leads";
    if (name) eng.sql.run(`INSERT INTO saved_searches (name, path, qs, created_at) VALUES (?,?,?,?)`, name.slice(0, 100), p, String(g("qs") ?? "").slice(0, 2000), nowIso());
    return redirect(`${p}?${g("qs") ?? ""}`);
  }
  m = path.match(/^\/saved-searches\/(\d+)\/delete$/);
  if (m) { eng.sql.run(`DELETE FROM saved_searches WHERE id=?`, Number(m[1])); return redirect(req.headers.get("referer") ?? "/leads"); }
  m = path.match(/^\/sources\/([\w.]+)\/run$/);
  if (m) { eng.sql.run(`UPDATE source_state SET next_run_at=?, circuit_open_until=NULL WHERE source_key=?`, nowIso(), m[1]); return redirect("/health"); }
  if (path === "/run") { eng.sql.run(`UPDATE source_state SET next_run_at=? WHERE run_mode IS NULL`, nowIso()); return redirect("/health"); }
  if (path === "/settings") {
    try {
      for (const k of ["business", "alerts", "scoring", "financing"]) {
        const v = g(k);
        if (v === null) continue;
        const parsed = JSON.parse(v);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${k} must be a JSON object`);
        eng.sql.run(`INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, k, JSON.stringify(parsed), nowIso());
      }
      return settingsPage(eng, "Saved.");
    } catch (e) {
      return settingsPage(eng, `Error: ${String(e)}`);
    }
  }
  if (path === "/reprocess") return settingsPage(eng, await ctx.reprocess());
  return new Response("Not found", { status: 404 });
}
