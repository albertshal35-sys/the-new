/** Alert formatting, delivery channels (Telegram, email via Resend, mock), retry queue and digests. */
import { stageLabel } from "./logic";
import { nowIso, pj, type Row, type Sql } from "./sql";

const TZ = "America/New_York";
const HEADLINES: Record<string, string> = {
  new_project: "NEW DEVELOPMENT FILING", new_plan_submission: "NEW PLAN SUBMISSION — EXISTING PROJECT",
  units_changed: "REVISED UNIT COUNT", approval: "APPROVAL RECORDED", permit_issued: "CONSTRUCTION PERMIT ISSUED",
  status_changed: "STATUS CHANGE", new_filing: "NEW FILING — EXISTING PROJECT",
};
const TYPE_LABELS: Record<string, string> = {
  new_construction: "New construction", demolition_rebuild: "Demolition / rebuild", conversion: "Conversion",
  substantial_rehab: "Substantial rehab", addition: "Addition", adds_units: "Adds units", mixed_use: "Mixed-use",
};
export const CLASS_LABELS: Record<string, string> = {
  planning_project: "Article 80 planning record", planning_document: "Planning document",
  permit_application: "Building permit APPLICATION (not yet an issued permit)", issued_permit: "ISSUED building permit",
  certificate_of_occupancy: "Certificate of occupancy", zoning_appeal: "Zoning Board of Appeal case",
};

export function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "unknown";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}
export function fmtDt(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleString("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
}

export function formatAlert(ev: Row, p: Row, filing: Row | null, parties: Row[], dashboardUrl: string) {
  const headline = HEADLINES[ev.event_type] ?? "DEVELOPMENT UPDATE";
  const addr = p.address ?? p.name ?? "Address not published";
  const devs = parties.filter((x) => x.role === "developer" || x.role === "proponent");
  const others = parties.filter((x) => ["owner_of_record", "applicant", "zba_contact"].includes(x.role));
  const devLine = devs.length ? devs.slice(0, 3).map((x) => `${x.name} (${x.role})`).join("; ")
    : others.length ? "Not published. Named: " + others.slice(0, 3).map((x) => `${x.name} (${x.role.replace(/_/g, " ")})`).join("; ") : "Not published";
  const u = p.units_proposed;
  let unitsLine = u !== null && u !== undefined ? String(u) : "UNKNOWN (needs review)";
  if (u != null && p.units_confidence === "medium") unitsLine += " (from official description text)";
  let types = pj<string[]>(p.project_types, []).map((t) => TYPE_LABELS[t] ?? t).join(", ") || "Not determined";
  if (filing) types += ` | Record: ${CLASS_LABELS[filing.record_class] ?? filing.record_class}${filing.doc_type ? ` — ${filing.doc_type}` : ""}`;
  const fin: string[] = [];
  if (p.proposed_cost) fin.push(`official project cost ${money(p.proposed_cost)}`);
  if (p.declared_valuation) fin.push(`declared construction valuation ${money(p.declared_valuation)} (not a loan request)`);
  if (p.est_loan_low != null) fin.push(`est. loan ${money(p.est_loan_low)}–${money(p.est_loan_high)} [${pj<any>(p.financing_basis, {}).method ?? "estimate"}]`);
  fin.push(`fit: ${p.financing_fit ?? "uncertain"}`);
  const url = filing?.document_url ?? filing?.source_url ?? p.project_url ?? "n/a";
  const missing = pj<string[]>(p.missing_data, []).join(", ") || "none";
  const base = dashboardUrl ? dashboardUrl.replace(/\/$/, "") : "";
  const body = [
    headline, `${addr} / ${p.neighborhood ?? "neighborhood unknown"}`, `Developer / Proponent: ${devLine}`, `Residential units: ${unitsLine}`,
    `Project type: ${types}`, `Stage: ${stageLabel(p.stage)}`, `Source filing date: ${ev.source_filing_date ?? "unknown"}`,
    `First detected: ${fmtDt(ev.detected_at)}`, `Estimated cost / financing fit: ${fin.join("; ")}`, `Filing / document: ${url}`,
    `Confidence: ${p.confidence ?? "low"} | Missing: ${missing}`,
    `Score: ${p.score ?? "n/a"}/100 (research priority, not a financing need)`, `Update: ${ev.summary}`,
    base ? `Dashboard: ${base}/leads/${p.id}` : `Dashboard lead #${p.id}`,
  ].join("\n");
  return { subject: `[IceCap] ${headline}: ${addr}${u != null ? ` — ${u} units` : ""}`, body };
}

function localParts(d: Date, tz: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return { minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday) };
}

/** Now, or the end of the quiet-hours window if now falls inside it. */
export function quietHoursRelease(qh: { start: string; end: string; tz: string } | null | undefined, now: Date): Date {
  if (!qh) return now;
  const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const s = toMin(qh.start), e = toMin(qh.end), cur = localParts(now, qh.tz).minutes;
  const inside = s > e ? cur >= s || cur < e : cur >= s && cur < e;
  if (!inside) return now;
  let delta = e - cur;
  if (delta <= 0) delta += 1440;
  return new Date(Math.floor(now.getTime() / 60000) * 60000 + delta * 60000);
}

/** Next occurrence of `hour:00` local time (optionally on weekday 0=Sun…6=Sat). */
export function nextLocalTime(now: Date, hour: number, tz: string, weekday?: number): Date {
  // Boston's UTC offset is always a whole number of hours, so stepping hour-aligned UTC instants is exact.
  let t = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  for (let i = 0; i < 8 * 24; i++) {
    const lp = localParts(t, tz);
    if (lp.minutes === hour * 60 && (weekday === undefined || lp.weekday === weekday)) return t;
    t = new Date(t.getTime() + 3_600_000);
  }
  return t;
}

// ---------------------------------------------------------------- channels
export interface SendResult { mocked: boolean; id: string | null }
export interface Channel { send(subject: string, body: string): Promise<SendResult> }
export interface NotifyEnv {
  TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; RESEND_API_KEY?: string; ALERT_EMAIL_FROM?: string; ALERT_EMAIL_TO?: string;
}
const mock = (why: string): Channel => ({ send: async () => ({ mocked: true, id: `mock: ${why}` }) });

export function buildChannels(env: NotifyEnv, fetcher: typeof fetch = (...a) => fetch(...a)): Record<string, Channel> {
  const telegram: Channel = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? {
    async send(_s, body) {
      const r = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: body.length > 4000 ? body.slice(0, 3990) + "\n…" : body, disable_web_page_preview: true }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(`Telegram error: ${d.description ?? r.status}`);
      return { mocked: false, id: String(d.result?.message_id ?? "") };
    },
  } : mock("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set");
  const email: Channel = env.RESEND_API_KEY && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO ? {
    async send(subject, body) {
      const r = await fetcher("https://api.resend.com/emails", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
        body: JSON.stringify({ from: env.ALERT_EMAIL_FROM, to: env.ALERT_EMAIL_TO!.split(",").map((s) => s.trim()), subject, text: body }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Resend error: ${d.message ?? r.status}`);
      return { mocked: false, id: d.id ?? null };
    },
  } : mock("RESEND_API_KEY/ALERT_EMAIL_FROM/ALERT_EMAIL_TO not set");
  return { telegram, email };
}

export async function dispatchDue(sql: Sql, channels: Record<string, Channel>, limit = 20) {
  const now = nowIso();
  const due = sql.all(`SELECT * FROM notifications WHERE status IN ('pending','failed','sending') AND next_attempt_at<=? ORDER BY id LIMIT ?`, now, limit);
  const out = { sent: 0, mocked: 0, failed: 0, dead: 0 };
  for (const n of due) {
    sql.run(`UPDATE notifications SET status='sending', attempts=attempts+1, next_attempt_at=? WHERE id=?`, new Date(Date.now() + 600_000).toISOString(), n.id);
    const attempts = n.attempts + 1;
    try {
      const ch = channels[n.channel];
      if (!ch) throw new Error(`unknown channel ${n.channel}`);
      const r = await ch.send(n.subject ?? "", n.body);
      const status = r.mocked ? "mocked" : "sent";
      sql.run(`UPDATE notifications SET status=?, sent_at=?, provider_message_id=?, last_error=NULL WHERE id=?`, status, nowIso(), r.id, n.id);
      if (!r.mocked && n.event_id) sql.run(`UPDATE project_events SET alerted_at=COALESCE(alerted_at, ?) WHERE id=?`, nowIso(), n.event_id);
      out[status]++;
    } catch (e) {
      const dead = attempts >= n.max_attempts;
      sql.run(`UPDATE notifications SET status=?, last_error=?, next_attempt_at=? WHERE id=?`, dead ? "dead" : "failed", String(e).slice(0, 500),
        new Date(Date.now() + Math.min(30_000 * 2 ** attempts, 6 * 3600_000)).toISOString(), n.id);
      out[dead ? "dead" : "failed"]++;
    }
  }
  return out;
}

export function enqueueDailyDigest(sql: Sql, channels: string[], dashboardUrl: string, now: Date): void {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const rows = sql.all(`SELECT p.id, p.address, p.neighborhood, p.units_proposed, p.score, p.financing_fit, e.event_type, e.summary
    FROM project_events e JOIN projects p ON p.id=e.project_id
    WHERE e.detected_at>=? AND (e.suppressed_reason IS NULL OR e.suppressed_reason NOT IN ('backfill','reprocess'))
      AND p.eligibility IN ('qualified','needs_review') AND e.event_type IN ('new_project','new_plan_submission','units_changed','approval','permit_issued')
    ORDER BY p.score DESC LIMIT 60`, since);
  const c = sql.one(`SELECT sum(eligibility='qualified') q, sum(eligibility='needs_review') nr FROM projects`)!;
  const dayStr = now.toLocaleDateString("en-CA", { timeZone: TZ });
  const lines = [`ICECAP DAILY DIGEST — ${dayStr}`, `Activity in the last 24h: ${rows.length} event(s). Pipeline: ${c.q ?? 0} qualified, ${c.nr ?? 0} needs review.`, "",
    ...rows.map((r) => `• [${r.event_type}] ${r.address ?? "?"} (${r.neighborhood ?? "?"}) — ${r.units_proposed ?? "?"} units, score ${r.score}, fit ${r.financing_fit} — ${r.summary}${dashboardUrl ? ` — ${dashboardUrl}/leads/${r.id}` : ""}`)];
  if (!rows.length) lines.push("No new qualifying activity detected in public records in the last 24 hours.");
  for (const ch of channels) sql.run(`INSERT OR IGNORE INTO notifications (kind, channel, dedupe_key, subject, body, next_attempt_at, created_at) VALUES ('daily_digest',?,?,?,?,?,?)`,
    ch, `digest:${dayStr}:${ch}`, `[IceCap] Daily digest ${dayStr}`, lines.join("\n"), nowIso(), nowIso());
}

export function enqueueWeeklyReport(sql: Sql, channels: string[], dashboardUrl: string, now: Date): void {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = sql.all(`SELECT e.id, e.name, pe.role, count(DISTINCT pe.project_id) projects,
      count(DISTINCT CASE WHEN p.first_seen_at>=? THEN p.id END) new_7d, sum(p.units_proposed) units
    FROM entities e JOIN project_entities pe ON pe.entity_id=e.id JOIN projects p ON p.id=pe.project_id
    WHERE pe.role IN ('developer','proponent','owner_of_record') AND p.eligibility<>'rejected'
    GROUP BY e.id, e.name, pe.role ORDER BY new_7d DESC, projects DESC LIMIT 40`, since);
  const wk = now.toLocaleDateString("en-CA", { timeZone: TZ });
  const lines = [`ICECAP WEEKLY DEVELOPER ACTIVITY — week of ${wk}`, "",
    ...rows.map((r) => `• ${r.name} (${String(r.role).replace(/_/g, " ")}): ${r.projects} project(s), ${r.new_7d} new this week, ${r.units ?? 0} known units${dashboardUrl ? ` — ${dashboardUrl}/developers/${r.id}` : ""}`)];
  if (!rows.length) lines.push("No developer-attributed projects yet.");
  for (const ch of channels) sql.run(`INSERT OR IGNORE INTO notifications (kind, channel, dedupe_key, subject, body, next_attempt_at, created_at) VALUES ('weekly_report',?,?,?,?,?,?)`,
    ch, `weekly:${wk}:${ch}`, `[IceCap] Weekly developer activity (${wk})`, lines.join("\n"), nowIso(), nowIso());
}
