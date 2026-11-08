import Link from "next/link";
import { notFound } from "next/navigation";
import { one, q } from "@/lib/db";
import { PROJECT_TYPES } from "@/lib/filters";
import { CLASS_LABELS, KIND_LABELS, ROLE_LABELS, SOURCE_LABELS, day, dt, money } from "@/lib/format";
import { Conf, Elig, Fit, Pill, Score, Stage } from "@/components/Badges";
import LeadActions from "@/components/LeadActions";

export const dynamic = "force-dynamic";

export default async function Lead({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isFinite(id)) notFound();
  const p = await one(`SELECT p.*, ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lon FROM projects p WHERE id=$1`, [id]);
  if (!p) notFound();
  const [filings, parties, contacts, events, assess, history, related] = await Promise.all([
    q(`SELECT id, source_key, source_record_id, record_class, filing_kind, title, doc_type, status, stage, units_proposed,
              units_existing, units_source, declared_valuation, document_url, source_url, source_filing_date, first_seen_at,
              last_changed_at, eligibility, eligibility_reasons, description, related_ids
         FROM filings WHERE project_id=$1 ORDER BY source_filing_date DESC NULLS LAST, id DESC`, [id]),
    q(`SELECT pe.role, e.id AS entity_id, e.name, pe.source_key, pe.source_url, pe.evidence
         FROM project_entities pe JOIN entities e ON e.id=pe.entity_id WHERE pe.project_id=$1 ORDER BY pe.role`, [id]),
    q(`SELECT kind, value, role_label, is_city_staff, source_key, source_url, observed_at FROM contacts WHERE project_id=$1`, [id]),
    q(`SELECT id, event_type, summary, source_filing_date, detected_at, alertable, suppressed_reason, alerted_at,
              (SELECT string_agg(channel || ':' || status, ', ') FROM notifications n WHERE n.event_id=e.id) AS deliveries
         FROM project_events e WHERE project_id=$1 ORDER BY detected_at DESC, id DESC`, [id]),
    p.parcel_id ? one(`SELECT * FROM parcel_assessments WHERE parcel_id=$1`, [p.parcel_id]) : Promise.resolve(null),
    q(`SELECT from_status, to_status, changed_at FROM pipeline_history WHERE project_id=$1 ORDER BY changed_at DESC`, [id]),
    q(`SELECT DISTINCT p2.id, p2.address, p2.units_proposed, p2.stage, p2.latest_filing_date, e.name AS entity, pe2.role
         FROM project_entities pe JOIN project_entities pe2 ON pe2.entity_id=pe.entity_id AND pe2.project_id<>pe.project_id
         JOIN projects p2 ON p2.id=pe2.project_id JOIN entities e ON e.id=pe.entity_id
        WHERE pe.project_id=$1 AND pe.role IN ('developer','proponent','owner_of_record') AND pe2.role IN ('developer','proponent','owner_of_record')
        ORDER BY p2.latest_filing_date DESC NULLS LAST LIMIT 25`, [id]),
  ]);
  if (!p.is_read) await q("UPDATE projects SET is_read=true WHERE id=$1", [id]);
  const basis = p.financing_basis ?? {};
  const sb = p.score_breakdown ?? {};
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <div className="text-xs text-slate-500"><Link className="link" href="/leads">Leads</Link> / #{p.id}</div>
          <h1 className="text-2xl font-semibold">{p.address ?? p.name}</h1>
          <div className="text-sm text-slate-600">{p.name && p.name !== p.address ? `${p.name} · ` : ""}{p.neighborhood ?? "Neighborhood unknown"}{p.zip ? ` ${p.zip}` : ""}{p.parcel_id ? ` · Parcel ${p.parcel_id}` : ""}{p.lat ? ` · ${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)}` : ""}</div>
          <div className="flex flex-wrap gap-1.5 mt-2"><Elig v={p.eligibility} /><Stage v={p.stage} /><Fit v={p.financing_fit} /><Conf v={p.confidence} />
            {(p.project_types ?? []).map((t: string) => <Pill key={t}>{PROJECT_TYPES[t] ?? t}</Pill>)}</div>
        </div>
        <div className="ml-auto text-right"><div className="label">Lead score</div><div className="text-3xl font-semibold tabular-nums">{p.score ?? "—"}</div><div className="text-[11px] text-slate-500 max-w-[200px]">Research priority — not evidence of a financing need</div></div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <section className="card p-4 space-y-2">
          <h2 className="font-semibold">Project facts</h2>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
            <dt className="label">Proposed units</dt><dd>{p.units_proposed ?? <span className="text-amber-700">Unknown</span>}{p.units_existing != null && <span className="text-slate-500"> (existing {p.units_existing})</span>}</dd>
            <dt className="label">Unit source</dt><dd className="text-xs break-all">{p.units_source ?? "—"}</dd>
            <dt className="label">Property type</dt><dd>{(p.property_type ?? "unknown").replace(/_/g, " ")}</dd>
            <dt className="label">Mixed-use</dt><dd>{p.is_mixed_use ? "Yes" : "No / unknown"}</dd>
            <dt className="label">Gross floor area</dt><dd>{p.gross_sqft ? `${Number(p.gross_sqft).toLocaleString()} sf` : "—"}</dd>
            <dt className="label">Retail sf</dt><dd>{p.retail_sqft ? `${Number(p.retail_sqft).toLocaleString()} sf` : "—"}</dd>
            <dt className="label">Review status</dt><dd className="text-xs">{p.review_status ?? "—"}</dd>
            <dt className="label">First filing date</dt><dd>{day(p.first_filing_date)}</dd>
            <dt className="label">Latest filing date</dt><dd>{day(p.latest_filing_date)}</dd>
            <dt className="label">First detected</dt><dd className="text-xs">{dt(p.first_seen_at)}</dd>
            <dt className="label">Eligibility reasons</dt><dd className="text-xs">{(p.eligibility_reasons ?? []).join(", ")}</dd>
            <dt className="label">Missing data</dt><dd className="text-xs text-amber-800">{(p.missing_data ?? []).join(", ") || "none"}</dd>
          </dl>
          {p.project_url && <a className="link text-sm" href={p.project_url} target="_blank" rel="noreferrer">Planning Department project page ↗</a>}
          {p.description && <p className="text-sm text-slate-700 border-t pt-2">{p.description}</p>}
        </section>

        <section className="card p-4 space-y-2">
          <h2 className="font-semibold">Financing estimate</h2>
          <p className="text-[11px] text-slate-500">Estimates only. Project cost, construction valuation, total development cost and lending need are different values; none of these is a loan request.</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
            <dt className="label">Official project cost</dt><dd>{money(p.proposed_cost)}</dd>
            <dt className="label">Declared construction valuation</dt><dd>{money(p.declared_valuation)}</dd>
            <dt className="label">Est. total dev. cost</dt><dd>{p.est_tdc_low != null ? `${money(p.est_tdc_low)}–${money(p.est_tdc_high)}` : "—"}</dd>
            <dt className="label">Est. loan range</dt><dd className="font-medium">{p.est_loan_low != null ? `${money(p.est_loan_low)}–${money(p.est_loan_high)}` : "Not estimated"}</dd>
            <dt className="label">Lending category</dt><dd>{(p.lending_category ?? "unknown").replace("_", " ")}</dd>
            <dt className="label">Fit vs $50M cap</dt><dd><Fit v={p.financing_fit} /></dd>
            <dt className="label">Method</dt><dd className="text-xs">{basis.method ?? "—"}</dd>
          </dl>
          <ul className="text-xs text-slate-600 list-disc pl-4">{(basis.assumptions ?? []).map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
          <h3 className="font-semibold pt-2 text-sm">Score breakdown</h3>
          <table className="w-full text-xs"><tbody>
            {Object.entries(sb).map(([k, v]: [string, any]) => (
              <tr key={k}><td className="py-0.5 pr-2 text-slate-500">{k.replace(/_/g, " ")}</td><td className="tabular-nums pr-2">{v.points}/{v.weight}</td><td className="text-slate-600">{v.why}</td></tr>
            ))}
          </tbody></table>
        </section>

        <section className="card p-4 space-y-3">
          <h2 className="font-semibold">Pipeline</h2>
          <LeadActions id={p.id} status={p.pipeline_status} notes={p.notes} isRead={true} />
          {history.length > 0 && <ul className="text-xs text-slate-600">{history.map((h, i) => <li key={i}>{dt(h.changed_at)}: {h.from_status} → {h.to_status}</li>)}</ul>}
        </section>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card p-4">
          <h2 className="font-semibold mb-2">People & organizations (role-labeled)</h2>
          {parties.length === 0 && <p className="text-sm text-slate-500">No developer, proponent, owner or applicant is named in the linked public records.</p>}
          <ul className="space-y-1.5 text-sm">
            {parties.map((r, i) => (
              <li key={i}><Pill>{ROLE_LABELS[r.role] ?? r.role}</Pill> <Link className="link" href={`/developers/${r.entity_id}`}>{r.name}</Link>
                <div className="text-[11px] text-slate-500">Source: {SOURCE_LABELS[r.source_key] ?? r.source_key} — {r.evidence}</div></li>
            ))}
          </ul>
          <h3 className="font-semibold mt-3 mb-1 text-sm">Public contact information</h3>
          {contacts.length === 0 && <p className="text-sm text-slate-500">None published in linked records.</p>}
          <ul className="space-y-1 text-sm">
            {contacts.map((c, i) => (
              <li key={i}><span className="text-slate-500">{c.kind}:</span> {c.value} <span className="text-[11px] text-slate-500">— {c.role_label}; source {SOURCE_LABELS[c.source_key] ?? c.source_key}{c.is_city_staff ? " (city staff)" : ""}</span></li>
            ))}
          </ul>
          {assess && assess.found && (
            <div className="mt-3 text-xs text-slate-600 border-t pt-2">
              <div className="font-semibold text-slate-700">Assessor record (parcel {assess.parcel_id})</div>
              Owner of record: {assess.owner ?? "—"} · Mailing: {assess.mail_address ?? "—"} · Land use: {assess.land_use ?? "—"} · Existing res. units: {assess.res_units ?? "—"} · Assessed value: {money(assess.total_value)} · Built {assess.yr_built ?? "—"}
              <div className="text-[11px]">Owner of record is not necessarily the developer or borrower.</div>
            </div>
          )}
        </section>

        <section className="card p-4">
          <h2 className="font-semibold mb-2">Developer / owner historical activity</h2>
          {related.length === 0 && <p className="text-sm text-slate-500">No other projects linked to the same named developer, proponent or owner of record.</p>}
          <ul className="text-sm space-y-1">
            {related.map((r) => (
              <li key={`${r.id}-${r.entity}`}><Link className="link" href={`/leads/${r.id}`}>{r.address}</Link> <span className="text-xs text-slate-500">— {r.entity} ({ROLE_LABELS[r.role] ?? r.role}), {r.units_proposed ?? "?"} units, last filed {day(r.latest_filing_date)}</span></li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card p-4">
        <h2 className="font-semibold mb-2">Timeline</h2>
        <ol className="relative border-l border-slate-200 ml-2 space-y-2">
          {events.map((e) => (
            <li key={e.id} className="ml-4 text-sm">
              <span className="absolute -left-1.5 mt-1.5 w-3 h-3 rounded-full bg-ice-500" />
              <span className="font-medium">{e.event_type.replace(/_/g, " ")}</span> — {e.summary}
              <div className="text-[11px] text-slate-500">
                filed {day(e.source_filing_date)} · detected {dt(e.detected_at)} · {e.alertable ? `alert queued${e.deliveries ? ` (${e.deliveries})` : ""}${e.alerted_at ? ` · delivered ${dt(e.alerted_at)}` : ""}` : `no alert (${e.suppressed_reason})`}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold p-4 pb-2">Linked public records ({filings.length})</h2>
        <table className="w-full"><thead><tr>
          <th className="th">Date</th><th className="th">Record</th><th className="th">Title / type</th><th className="th">Status</th><th className="th">Units</th><th className="th">Valuation</th><th className="th">Eligibility</th><th className="th">Links</th>
        </tr></thead><tbody>
          {filings.map((f) => (
            <tr key={f.id}>
              <td className="td text-xs whitespace-nowrap">{day(f.source_filing_date)}<div className="text-slate-400">seen {day(f.first_seen_at)}</div></td>
              <td className="td text-xs"><div className="font-medium">{CLASS_LABELS[f.record_class]}</div><div className="text-slate-500">{KIND_LABELS[f.filing_kind]} · {SOURCE_LABELS[f.source_key]} · {f.source_record_id}</div></td>
              <td className="td text-xs max-w-[360px]"><div>{f.title}</div>{f.description && <div className="text-slate-500 line-clamp-2">{f.description}</div>}</td>
              <td className="td text-xs">{f.status ?? "—"}</td>
              <td className="td text-xs">{f.units_proposed ?? "—"}{f.units_source && <div className="text-[10px] text-slate-500">{f.units_source}</div>}</td>
              <td className="td text-xs">{money(f.declared_valuation)}</td>
              <td className="td text-xs"><Elig v={f.eligibility} /><div className="text-slate-500">{(f.eligibility_reasons ?? []).join(", ")}</div></td>
              <td className="td text-xs whitespace-nowrap">
                {f.document_url && <a className="link" href={f.document_url} target="_blank" rel="noreferrer">Document</a>}
                {f.document_url && f.source_url && <br />}
                {f.source_url && <a className="link" href={f.source_url} target="_blank" rel="noreferrer">Source</a>}
              </td>
            </tr>
          ))}
        </tbody></table>
      </section>
    </div>
  );
}
