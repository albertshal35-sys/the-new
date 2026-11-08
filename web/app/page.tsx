import Link from "next/link";
import { q, one } from "@/lib/db";
import { CLASS_LABELS, KIND_LABELS, SOURCE_LABELS, ago, day, dt } from "@/lib/format";
import { Elig, Pill } from "@/components/Badges";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | undefined>>;
const PAGE = 50;

export default async function LiveFeed({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const elig = sp.eligibility ?? "relevant";
  const order = sp.order === "filed" ? "filed" : "seen";
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (elig === "relevant") where.push("f.eligibility IN ('qualified','needs_review')");
  else if (["qualified", "needs_review", "rejected"].includes(elig)) where.push(`f.eligibility = ${p(elig)}`);
  if (sp.class && sp.class in CLASS_LABELS) where.push(`f.record_class = ${p(sp.class)}`);
  if (sp.source && sp.source in SOURCE_LABELS) where.push(`f.source_key = ${p(sp.source)}`);
  else where.push("f.source_key NOT IN (SELECT key FROM sources WHERE is_enrichment_only)");
  if (sp.before) {
    const [ts, id] = sp.before.split("|");
    if (order === "seen") where.push(`(f.first_seen_at, f.id) < (${p(ts)}::timestamptz, ${p(Number(id))})`);
    else where.push(`(COALESCE(f.source_filing_date, '0001-01-01'), f.id) < (${p(ts)}::date, ${p(Number(id))})`);
  }
  const orderSql = order === "seen" ? "f.first_seen_at DESC, f.id DESC" : "COALESCE(f.source_filing_date, '0001-01-01') DESC, f.id DESC";
  const rows = await q(
    `SELECT f.id, f.source_key, f.record_class, f.filing_kind, f.title, f.doc_type, f.address, f.units_proposed,
            f.units_source, f.source_filing_date, f.first_seen_at, f.eligibility, f.eligibility_reasons, f.document_url,
            f.source_url, f.project_id, pr.neighborhood, pr.units_proposed AS project_units, pr.eligibility AS project_eligibility,
            pr.is_read
       FROM filings f LEFT JOIN projects pr ON pr.id = f.project_id
      WHERE ${where.length ? where.join(" AND ") : "TRUE"}
      ORDER BY ${orderSql} LIMIT ${PAGE}`,
    params,
  );
  const stats = await one(
    `SELECT (SELECT count(*) FROM projects WHERE eligibility='qualified') AS qualified,
            (SELECT count(*) FROM projects WHERE eligibility='needs_review') AS needs_review,
            (SELECT count(*) FROM filings) AS filings,
            (SELECT count(*) FROM project_events WHERE detected_at > now() - interval '24 hours' AND (suppressed_reason IS NULL OR suppressed_reason NOT IN ('backfill','reprocess'))) AS events_24h,
            (SELECT count(*) FROM notifications WHERE kind='alert' AND created_at > now() - interval '24 hours') AS alerts_24h,
            (SELECT max(last_success_at) FROM source_state) AS last_success`,
  );
  const last = rows[rows.length - 1];
  const nextCursor = rows.length === PAGE && last
    ? order === "seen" ? `${new Date(last.first_seen_at).toISOString()}|${last.id}` : `${last.source_filing_date ?? "0001-01-01"}|${last.id}`
    : null;
  const qs = (extra: Record<string, string>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ eligibility: elig, order, class: sp.class ?? "", source: sp.source ?? "", ...extra })) if (v) u.set(k, v);
    return `/?${u}`;
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          ["Qualified leads", stats?.qualified, "/leads"],
          ["Needs review", stats?.needs_review, "/leads?eligibility=needs_review"],
          ["Filings stored", stats?.filings, "/?eligibility=all"],
          ["Events (24h)", stats?.events_24h, "/health"],
          ["Alerts queued (24h)", stats?.alerts_24h, "/health#alerts"],
          ["Last successful check", ago(stats?.last_success), "/health"],
        ].map(([label, v, href]) => (
          <Link key={String(label)} href={String(href)} className="card p-3 hover:border-ice-500">
            <div className="label">{label}</div>
            <div className="text-xl font-semibold tabular-nums">{String(v ?? "—")}</div>
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <h1 className="text-lg font-semibold mr-2">Live feed</h1>
        {[["relevant", "Qualified + review"], ["qualified", "Qualified"], ["needs_review", "Needs review"], ["rejected", "Rejected"], ["all", "All"]].map(([k, l]) => (
          <Link key={k} href={qs({ eligibility: k, before: "" })} className={`px-2 py-1 rounded border ${elig === k ? "bg-ice-600 text-white border-ice-600" : "bg-white border-slate-300"}`}>{l}</Link>
        ))}
        <span className="mx-2 text-slate-300">|</span>
        <Link href={qs({ order: "seen", before: "" })} className={order === "seen" ? "font-semibold" : "link"}>Newest first seen</Link>
        <Link href={qs({ order: "filed", before: "" })} className={order === "filed" ? "font-semibold" : "link"}>Newest filing date</Link>
        <form className="ml-auto flex gap-2" action="/" method="get">
          <input type="hidden" name="eligibility" value={elig} />
          <input type="hidden" name="order" value={order} />
          <select name="class" defaultValue={sp.class ?? ""} className="input">
            <option value="">All record types</option>
            {Object.entries(CLASS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select name="source" defaultValue={sp.source ?? ""} className="input">
            <option value="">All sources</option>
            {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn-ghost">Filter</button>
        </form>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">First seen</th><th className="th">Filed / dated</th><th className="th">Record</th>
              <th className="th">Address / title</th><th className="th">Units</th><th className="th">Eligibility</th><th className="th">Links</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.project_id && !r.is_read ? "bg-ice-50/40" : ""}>
                <td className="td whitespace-nowrap text-xs">{dt(r.first_seen_at)}</td>
                <td className="td whitespace-nowrap text-xs">{day(r.source_filing_date)}</td>
                <td className="td text-xs">
                  <div className="font-medium">{CLASS_LABELS[r.record_class] ?? r.record_class}</div>
                  <div className="text-slate-500">{KIND_LABELS[r.filing_kind]} · {SOURCE_LABELS[r.source_key]}</div>
                </td>
                <td className="td">
                  {r.project_id ? <Link href={`/leads/${r.project_id}`} className="link font-medium">{r.address ?? r.title}</Link> : <span className="font-medium">{r.address ?? r.title}</span>}
                  <div className="text-xs text-slate-500 line-clamp-1">{r.doc_type}{r.neighborhood ? ` · ${r.neighborhood}` : ""}</div>
                </td>
                <td className="td tabular-nums">
                  {r.units_proposed ?? (r.project_units != null ? <span title="from linked project">{r.project_units}*</span> : <span className="text-slate-400">?</span>)}
                </td>
                <td className="td">
                  <Elig v={r.eligibility} />
                  <div className="text-[11px] text-slate-500 mt-0.5">{(r.eligibility_reasons ?? []).slice(0, 2).join(", ")}</div>
                </td>
                <td className="td text-xs whitespace-nowrap">
                  {r.document_url && <a className="link" href={r.document_url} target="_blank" rel="noreferrer">Document</a>}
                  {r.document_url && r.source_url && " · "}
                  {r.source_url && <a className="link" href={r.source_url} target="_blank" rel="noreferrer">Source</a>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={7}>No filings match.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-500">* unit count from the linked project. Only publicly accessible records are shown; issued permits are not applications.</span>
        {nextCursor && <Link className="btn-ghost" href={qs({ before: nextCursor })}>Older →</Link>}
      </div>
      <Pill>Feed ordered by when IceCap first detected each record</Pill>
    </div>
  );
}
