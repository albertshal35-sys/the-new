import { q, one } from "@/lib/db";
import { SOURCE_LABELS, ago, day, dt, duration, until } from "@/lib/format";
import { Pill } from "@/components/Badges";

export const dynamic = "force-dynamic";

export default async function Health() {
  const [sources, runs, notes, noteAgg, lat, jobs] = await Promise.all([
    q(`SELECT s.key, s.name, s.record_class, s.official_url, s.limitations, s.publication_cadence, s.is_enrichment_only,
              ss.*, EXTRACT(EPOCH FROM (now() - ss.newest_record_at))/60 AS newest_age_min,
              EXTRACT(EPOCH FROM (ss.last_change_detected_at - ss.upstream_updated_at))/60 AS detect_lag_min
         FROM sources s JOIN source_state ss ON ss.source_key=s.key ORDER BY s.is_enrichment_only, s.key`),
    q(`SELECT id, source_key, mode, status, started_at, duration_ms, pages, fetched, inserted, changed, unchanged, qualified,
              needs_review, rejected, events, http_requests, error FROM ingestion_runs ORDER BY id DESC LIMIT 40`),
    q(`SELECT n.id, n.kind, n.channel, n.status, n.attempts, n.last_error, n.created_at, n.sent_at, n.subject, e.project_id
         FROM notifications n LEFT JOIN project_events e ON e.id=n.event_id ORDER BY n.id DESC LIMIT 50`),
    q(`SELECT channel, status, count(*)::int AS n FROM notifications GROUP BY 1,2 ORDER BY 1,2`),
    one(`SELECT
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.detected_at - e.source_published_at))/60)
             FILTER (WHERE e.source_published_at IS NOT NULL AND (e.suppressed_reason IS NULL OR e.suppressed_reason NOT IN ('backfill','reprocess'))) AS pub_to_detect_min,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.detected_at::date - e.source_filing_date) * 1440.0)
             FILTER (WHERE e.source_filing_date IS NOT NULL AND (e.suppressed_reason IS NULL OR e.suppressed_reason NOT IN ('backfill','reprocess'))) AS filing_to_detect_min,
           count(*) FILTER (WHERE (e.suppressed_reason IS NULL OR e.suppressed_reason NOT IN ('backfill','reprocess')))::int AS live_events,
           count(*) FILTER (WHERE e.suppressed_reason IN ('backfill','reprocess'))::int AS backfill_events
         FROM project_events e`),
    q(`SELECT * FROM scheduled_jobs ORDER BY key`),
  ]);
  const notify = await one(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (n.sent_at - e.detected_at))) AS s
                              FROM notifications n JOIN project_events e ON e.id=n.event_id WHERE n.sent_at IS NOT NULL`);
  return (
    <div className="space-y-5">
      <div className="flex items-baseline gap-3"><h1 className="text-lg font-semibold">Source health</h1>
        <span className="text-xs text-slate-500">IceCap only sees records after the City publishes them. Lag figures are measured from the provider's own timestamps where available.</span></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-3"><div className="label">Median provider update → detection</div><div className="text-xl font-semibold">{duration(lat?.pub_to_detect_min)}</div><div className="text-[11px] text-slate-500">live (non-backfill) events with a provider timestamp</div></div>
        <div className="card p-3"><div className="label">Median filing date → detection</div><div className="text-xl font-semibold">{duration(lat?.filing_to_detect_min)}</div><div className="text-[11px] text-slate-500">includes the City's publication delay</div></div>
        <div className="card p-3"><div className="label">Median detection → notification</div><div className="text-xl font-semibold">{notify?.s != null ? `${Math.round(notify.s)} s` : "—"}</div><div className="text-[11px] text-slate-500">sent or mocked</div></div>
        <div className="card p-3"><div className="label">Events</div><div className="text-xl font-semibold">{lat?.live_events ?? 0} live</div><div className="text-[11px] text-slate-500">{lat?.backfill_events ?? 0} recorded silently (backfill / rule reprocessing)</div></div>
      </div>

      <div className="card overflow-x-auto"><table className="w-full"><thead><tr>
        <th className="th">Source</th><th className="th">Last check</th><th className="th">Last success</th><th className="th">Provider updated</th>
        <th className="th">Newest record date</th><th className="th">Records</th><th className="th">Polling</th><th className="th">State</th><th className="th"></th>
      </tr></thead><tbody>
        {sources.map((s) => (
          <tr key={s.key}>
            <td className="td max-w-[360px]"><a className="link font-medium" href={s.official_url} target="_blank" rel="noreferrer">{s.name}</a>
              <div className="text-[11px] text-slate-500">{s.record_class}{s.is_enrichment_only ? " · enrichment only" : ""} · {s.publication_cadence}</div>
              <details className="text-[11px] text-slate-600"><summary className="cursor-pointer">Limitations</summary>{s.limitations}</details></td>
            <td className="td text-xs whitespace-nowrap">{ago(s.last_check_at)}</td>
            <td className="td text-xs whitespace-nowrap">{ago(s.last_success_at)}<div className="text-slate-400">{s.backfill_completed_at ? `backfilled ${day(s.backfill_completed_at)}` : s.record_class === "property_record" ? "on-demand lookups" : "backfill pending"}</div></td>
            <td className="td text-xs whitespace-nowrap">{s.upstream_updated_at ? dt(s.upstream_updated_at) : "not exposed"}{s.detect_lag_min != null && <div className="text-slate-400">ingested +{duration(s.detect_lag_min)} after update</div>}</td>
            <td className="td text-xs whitespace-nowrap">{day(s.newest_record_at)}<div className="text-slate-400">age {duration(s.newest_age_min)}</div></td>
            <td className="td text-xs tabular-nums">{Number(s.records_total).toLocaleString()}</td>
            <td className="td text-xs whitespace-nowrap">every {duration(s.current_interval_s / 60)}<div className="text-slate-400">next run {until(s.next_run_at)}</div></td>
            <td className="td text-xs">
              {s.circuit_open_until && new Date(s.circuit_open_until) > new Date() ? <Pill t="outside_scope">circuit open</Pill>
                : s.consecutive_failures > 0 ? <Pill t="uncertain">{s.consecutive_failures} failure(s)</Pill> : <Pill t="likely">healthy</Pill>}
              {s.last_error && <div className="text-rose-700 text-[11px] max-w-[260px] break-words">{String(s.last_error).slice(0, 200)}</div>}
            </td>
            <td className="td">{!s.is_enrichment_only || s.key !== "boston.property_assessment" ? (
              <form action={`/api/sources/${s.key}/run`} method="post"><button className="btn-ghost text-xs">Run now</button></form>) : null}</td>
          </tr>
        ))}
      </tbody></table></div>

      <h2 id="alerts" className="text-lg font-semibold">Alert delivery</h2>
      <div className="flex flex-wrap gap-2 text-sm">{noteAgg.map((r) => <Pill key={`${r.channel}${r.status}`} t={r.status === "sent" ? "likely" : r.status === "mocked" ? "medium" : r.status === "dead" ? "outside_scope" : "uncertain"}>{r.channel}: {r.status} {r.n}</Pill>)}
        {noteAgg.length === 0 && <span className="text-slate-500">No notifications yet (backfilled records never alert).</span>}</div>
      <p className="text-xs text-slate-500">"mocked" = credentials not configured; the message was written to the worker's mock log and was NOT delivered.</p>
      <div className="card overflow-x-auto"><table className="w-full"><thead><tr>
        <th className="th">Created</th><th className="th">Kind</th><th className="th">Channel</th><th className="th">Status</th><th className="th">Attempts</th><th className="th">Subject</th><th className="th">Sent</th>
      </tr></thead><tbody>
        {notes.map((n) => (
          <tr key={n.id}><td className="td text-xs whitespace-nowrap">{dt(n.created_at)}</td><td className="td text-xs">{n.kind}</td><td className="td text-xs">{n.channel}</td>
            <td className="td text-xs">{n.status}{n.last_error && <div className="text-rose-700">{String(n.last_error).slice(0, 120)}</div>}</td>
            <td className="td text-xs">{n.attempts}</td>
            <td className="td text-xs">{n.project_id ? <a className="link" href={`/leads/${n.project_id}`}>{n.subject}</a> : n.subject}</td>
            <td className="td text-xs whitespace-nowrap">{dt(n.sent_at)}</td></tr>
        ))}
      </tbody></table></div>

      <h2 className="text-lg font-semibold">Recent ingestion runs</h2>
      <div className="card overflow-x-auto"><table className="w-full"><thead><tr>
        <th className="th">Started</th><th className="th">Source</th><th className="th">Mode</th><th className="th">Status</th><th className="th">Duration</th>
        <th className="th">Fetched</th><th className="th">New</th><th className="th">Changed</th><th className="th">Q / R / X</th><th className="th">Events</th><th className="th">HTTP</th>
      </tr></thead><tbody>
        {runs.map((r) => (
          <tr key={r.id}><td className="td text-xs whitespace-nowrap">{dt(r.started_at)}</td><td className="td text-xs">{SOURCE_LABELS[r.source_key] ?? r.source_key}</td>
            <td className="td text-xs">{r.mode}</td><td className="td text-xs">{r.status}{r.error && <div className="text-rose-700 max-w-[240px] break-words">{String(r.error).slice(0, 160)}</div>}</td>
            <td className="td text-xs tabular-nums">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : "running"}</td>
            <td className="td text-xs tabular-nums">{r.fetched}</td><td className="td text-xs tabular-nums">{r.inserted}</td><td className="td text-xs tabular-nums">{r.changed}</td>
            <td className="td text-xs tabular-nums">{r.qualified} / {r.needs_review} / {r.rejected}</td><td className="td text-xs tabular-nums">{r.events}</td><td className="td text-xs tabular-nums">{r.http_requests}</td></tr>
        ))}
      </tbody></table></div>
      <div className="text-xs text-slate-500">Scheduled jobs: {jobs.map((j) => `${j.key} next ${dt(j.next_run_at)} (${j.last_status ?? "not run"})`).join(" · ") || "none yet"}</div>
    </div>
  );
}
