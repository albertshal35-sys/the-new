import Link from "next/link";
import { q } from "@/lib/db";
import { ROLE_LABELS, day } from "@/lib/format";
import { Pill } from "@/components/Badges";

export const dynamic = "force-dynamic";

export default async function Developers({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const role = sp.role && ["developer", "proponent", "owner_of_record", "applicant", "zba_contact"].includes(sp.role) ? sp.role : null;
  const roles = role ? [role] : ["developer", "proponent", "owner_of_record"];
  const params: unknown[] = [roles];
  let nameSql = "";
  if (sp.q) { params.push(`%${sp.q}%`); nameSql = `AND e.name ILIKE $${params.length}`; }
  const rows = await q(
    `SELECT e.id, e.name, e.kind, array_agg(DISTINCT pe.role) AS roles, count(DISTINCT p.id)::int AS projects,
            count(DISTINCT p.id) FILTER (WHERE p.eligibility='qualified')::int AS qualified,
            sum(DISTINCT p.units_proposed) AS units, max(p.latest_filing_date) AS last_filing,
            count(DISTINCT p.id) FILTER (WHERE p.first_seen_at > now() - interval '90 days')::int AS new_90d
       FROM entities e JOIN project_entities pe ON pe.entity_id=e.id JOIN projects p ON p.id=pe.project_id
      WHERE pe.role = ANY($1) ${nameSql}
      GROUP BY e.id ORDER BY projects DESC, last_filing DESC NULLS LAST LIMIT 300`, params);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-semibold">Developers & entities</h1>
        <form className="flex gap-2 ml-auto" method="get">
          <select name="role" defaultValue={role ?? ""} className="input">
            <option value="">Developer / proponent / owner</option>
            {["developer", "proponent", "owner_of_record", "applicant", "zba_contact"].map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
          <input name="q" defaultValue={sp.q} placeholder="name contains" className="input" />
          <button className="btn-ghost">Filter</button>
        </form>
      </div>
      <p className="text-xs text-slate-500">Entities are grouped by exact normalized name as published in official records, with each role labeled. A named applicant or owner of record is not assumed to be the developer.</p>
      <div className="card overflow-x-auto"><table className="w-full"><thead><tr>
        <th className="th">Entity</th><th className="th">Roles</th><th className="th">Projects</th><th className="th">Qualified</th><th className="th">New (90d)</th><th className="th">Last filing</th>
      </tr></thead><tbody>
        {rows.map((r) => (
          <tr key={r.id}><td className="td"><Link className="link font-medium" href={`/developers/${r.id}`}>{r.name}</Link></td>
            <td className="td">{(r.roles ?? []).map((x: string) => <Pill key={x}>{ROLE_LABELS[x] ?? x}</Pill>)}</td>
            <td className="td tabular-nums">{r.projects}</td><td className="td tabular-nums">{r.qualified}</td><td className="td tabular-nums">{r.new_90d}</td>
            <td className="td text-xs">{day(r.last_filing)}</td></tr>
        ))}
        {rows.length === 0 && <tr><td className="td text-slate-500" colSpan={6}>No entities yet.</td></tr>}
      </tbody></table></div>
    </div>
  );
}
