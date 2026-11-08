import Link from "next/link";
import { notFound } from "next/navigation";
import { one, q } from "@/lib/db";
import { ROLE_LABELS, SOURCE_LABELS, day } from "@/lib/format";
import { Elig, Pill, Stage } from "@/components/Badges";

export const dynamic = "force-dynamic";

export default async function Entity({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const e = await one("SELECT * FROM entities WHERE id=$1", [id]);
  if (!e) notFound();
  const projects = await q(
    `SELECT p.id, p.address, p.neighborhood, p.units_proposed, p.stage, p.eligibility, p.latest_filing_date, p.first_seen_at,
            pe.role, pe.source_key, pe.evidence
       FROM project_entities pe JOIN projects p ON p.id=pe.project_id WHERE pe.entity_id=$1
      ORDER BY p.latest_filing_date DESC NULLS LAST`, [id]);
  const filings = await q(
    `SELECT f.source_filing_date, f.title, f.record_class, f.project_id, f.document_url, f.source_url
       FROM filings f WHERE f.project_id IN (SELECT project_id FROM project_entities WHERE entity_id=$1)
      ORDER BY f.source_filing_date DESC NULLS LAST LIMIT 100`, [id]);
  return (
    <div className="space-y-4">
      <div><div className="text-xs"><Link className="link" href="/developers">Developers</Link></div>
        <h1 className="text-2xl font-semibold">{e.name}</h1><div className="text-sm text-slate-500">{e.kind} · {projects.length} linked project role(s)</div></div>
      <div className="card overflow-x-auto"><table className="w-full"><thead><tr>
        <th className="th">Project</th><th className="th">Role</th><th className="th">Units</th><th className="th">Stage</th><th className="th">Eligibility</th><th className="th">Last filing</th><th className="th">Attribution</th>
      </tr></thead><tbody>
        {projects.map((p, i) => (
          <tr key={i}><td className="td"><Link className="link" href={`/leads/${p.id}`}>{p.address}</Link><div className="text-xs text-slate-500">{p.neighborhood}</div></td>
            <td className="td"><Pill>{ROLE_LABELS[p.role] ?? p.role}</Pill></td><td className="td">{p.units_proposed ?? "?"}</td>
            <td className="td"><Stage v={p.stage} /></td><td className="td"><Elig v={p.eligibility} /></td><td className="td text-xs">{day(p.latest_filing_date)}</td>
            <td className="td text-[11px] text-slate-500">{SOURCE_LABELS[p.source_key] ?? p.source_key}: {p.evidence}</td></tr>
        ))}
      </tbody></table></div>
      <section className="card p-4"><h2 className="font-semibold mb-2">Filing history across linked projects</h2>
        <ul className="text-sm space-y-1">{filings.map((f, i) => (
          <li key={i}><span className="text-xs text-slate-500 tabular-nums">{day(f.source_filing_date)}</span> <Link className="link" href={`/leads/${f.project_id}`}>{f.title}</Link>
            {f.document_url && <> · <a className="link text-xs" href={f.document_url} target="_blank" rel="noreferrer">document</a></>}</li>
        ))}</ul></section>
    </div>
  );
}
