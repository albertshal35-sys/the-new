import Link from "next/link";
import { q } from "@/lib/db";
import { PIPELINE } from "@/lib/filters";
import { money } from "@/lib/format";
import { Score } from "@/components/Badges";
import PipelineMove from "@/components/PipelineMove";

export const dynamic = "force-dynamic";

export default async function Pipeline() {
  const rows = await q(
    `SELECT id, COALESCE(address, name) AS address, neighborhood, units_proposed, score, pipeline_status, est_loan_low, est_loan_high, financing_fit
       FROM projects
      WHERE pipeline_status <> 'New' OR (eligibility='qualified' AND first_seen_at > now() - interval '30 days')
         OR (eligibility='qualified' AND score >= 60)
      ORDER BY score DESC NULLS LAST LIMIT 600`);
  const cols = Object.fromEntries(PIPELINE.map((p) => [p, rows.filter((r) => r.pipeline_status === p)]));
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3"><h1 className="text-lg font-semibold">Pipeline</h1>
        <span className="text-xs text-slate-500">"New" shows qualified leads first seen in the last 30 days or scoring ≥ 60; any lead can be moved from its detail page.</span></div>
      <div className="grid grid-cols-1 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {PIPELINE.map((p) => (
          <div key={p} className="bg-slate-100 rounded-lg p-2 min-h-[200px]">
            <div className="text-xs font-semibold uppercase text-slate-600 mb-2">{p} <span className="text-slate-400">({cols[p].length})</span></div>
            <div className="space-y-2">
              {cols[p].slice(0, 80).map((r) => (
                <div key={r.id} className="card p-2 text-xs">
                  <Link href={`/leads/${r.id}`} className="link font-medium">{r.address}</Link>
                  <div className="text-slate-500">{r.neighborhood ?? "—"} · {r.units_proposed ?? "?"} units</div>
                  <div className="flex justify-between items-center mt-1"><Score v={r.score} /><span>{r.est_loan_low != null ? `${money(r.est_loan_low)}–${money(r.est_loan_high)}` : ""}</span></div>
                  <PipelineMove id={r.id} status={r.pipeline_status} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
