import Link from "next/link";
import { parseFilters, toQueryString, PROJECT_TYPES } from "@/lib/filters";
import { countLeads, listLeads, neighborhoods } from "@/lib/leads";
import { day, money } from "@/lib/format";
import FilterBar from "@/components/FilterBar";
import SavedSearches from "@/components/SavedSearches";
import { Elig, Fit, Score, Stage } from "@/components/Badges";

export const dynamic = "force-dynamic";
const PAGE = 50;

export default async function Leads({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const f = parseFilters(sp);
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const [{ rows, hasMore }, total, nbhds] = await Promise.all([listLeads(f, PAGE, (page - 1) * PAGE), countLeads(f), neighborhoods()]);
  const qs = toQueryString(f);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Leads</h1>
        <span className="text-sm text-slate-500">{total.toLocaleString()} projects</span>
        <a className="btn-ghost ml-auto" href={`/api/export?${qs}`}>Export CSV</a>
        <Link className="btn-ghost" href={`/map?${qs}`}>View on map</Link>
      </div>
      <FilterBar f={f} neighborhoods={nbhds} action="/leads" />
      <SavedSearches qs={qs} path="/leads" />
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead><tr>
            <th className="th">Project</th><th className="th">Units</th><th className="th">Type</th><th className="th">Stage</th>
            <th className="th">Developer / owner</th><th className="th">Est. loan</th><th className="th">Score</th>
            <th className="th">Filed</th><th className="th">First seen</th><th className="th">Status</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={!r.is_read ? "bg-ice-50/40" : ""}>
                <td className="td max-w-[280px]">
                  <Link href={`/leads/${r.id}`} className="link font-medium">{r.address ?? r.name}</Link>
                  {!r.is_read && <span className="ml-1 text-[10px] font-bold text-ice-600">NEW</span>}
                  <div className="text-xs text-slate-500">{r.neighborhood ?? "—"}{r.parcel_id ? ` · parcel ${r.parcel_id}` : ""}</div>
                </td>
                <td className="td tabular-nums">{r.units_proposed ?? <span className="text-amber-700">unknown</span>}
                  {r.units_confidence === "medium" && <span className="text-[10px] text-slate-500 block">from text</span>}</td>
                <td className="td text-xs">{(r.project_types ?? []).map((t: string) => PROJECT_TYPES[t] ?? t).join(", ") || "—"}</td>
                <td className="td"><Stage v={r.stage} /></td>
                <td className="td text-xs max-w-[220px]">
                  {r.developer ? <div>{r.developer}</div> : r.owner_of_record ? <div className="text-slate-600">Owner: {r.owner_of_record}</div> : <span className="text-slate-400">not published</span>}
                  {r.applicants && <div className="text-slate-500 truncate">Applicant: {r.applicants}</div>}
                </td>
                <td className="td text-xs whitespace-nowrap">
                  {r.est_loan_low != null ? `${money(r.est_loan_low)}–${money(r.est_loan_high)}` : "—"}
                  <div className="mt-0.5"><Fit v={r.financing_fit} /></div>
                </td>
                <td className="td"><Score v={r.score} /></td>
                <td className="td text-xs whitespace-nowrap">{day(r.latest_filing_date)}</td>
                <td className="td text-xs whitespace-nowrap">{day(r.first_seen_at)}</td>
                <td className="td text-xs"><Elig v={r.eligibility} /><div className="text-slate-500 mt-0.5">{r.pipeline_status}</div></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={10}>No projects match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between text-sm">
        {page > 1 ? <Link className="btn-ghost" href={`/leads?${qs}&page=${page - 1}`}>← Newer</Link> : <span />}
        {hasMore && <Link className="btn-ghost" href={`/leads?${qs}&page=${page + 1}`}>Older →</Link>}
      </div>
    </div>
  );
}
