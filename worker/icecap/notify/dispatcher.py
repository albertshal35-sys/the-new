"""Notification queue worker (retries with exponential backoff, dead-lettering) and digests."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from ..config import Config
from ..db import Database
from .formatter import fmt_dt, money

log = logging.getLogger(__name__)


async def dispatch_due(db: Database, channels: dict, limit: int = 20) -> dict:
    rows = await db.fetch(
        """UPDATE notifications SET status='sending', attempts=attempts+1, next_attempt_at=now() + interval '10 minutes'
           WHERE id IN (SELECT id FROM notifications
                        WHERE status IN ('pending','failed','sending') AND next_attempt_at <= now()
                        ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED)
           RETURNING *""", limit)
    out = {"sent": 0, "mocked": 0, "failed": 0, "dead": 0}
    for n in rows:
        ch = channels.get(n["channel"])
        try:
            if ch is None:
                raise RuntimeError(f"unknown channel {n['channel']}")
            res = await ch.send(n["subject"] or "", n["body"])
            status = "mocked" if res.mocked else "sent"
            await db.execute(
                """UPDATE notifications SET status=%s, sent_at=now(), provider_message_id=%s, last_error=NULL
                   WHERE id=%s""", status, res.provider_message_id, n["id"])
            if not res.mocked and n["event_id"]:
                await db.execute(
                    "UPDATE project_events SET alerted_at=COALESCE(alerted_at, now()) WHERE id=%s", n["event_id"])
            out[status] += 1
        except Exception as exc:
            dead = n["attempts"] >= n["max_attempts"]
            delay = min(30 * (2 ** n["attempts"]), 6 * 3600)
            await db.execute(
                """UPDATE notifications SET status=%s, last_error=%s,
                       next_attempt_at=now() + make_interval(secs => %s) WHERE id=%s""",
                "dead" if dead else "failed", str(exc)[:1000], delay, n["id"])
            out["dead" if dead else "failed"] += 1
            log.warning("notification %s via %s failed (attempt %s): %s", n["id"], n["channel"], n["attempts"], exc)
    return out


async def enqueue_daily_digest(db: Database, cfg: Config, day: datetime) -> int:
    since = day - timedelta(days=1)
    rows = await db.fetch(
        """SELECT p.id, p.address, p.neighborhood, p.units_proposed, p.stage, p.score, p.financing_fit,
                  e.event_type, e.summary, e.detected_at
           FROM project_events e JOIN projects p ON p.id=e.project_id
           WHERE e.detected_at >= %s AND (e.suppressed_reason IS NULL OR e.suppressed_reason NOT IN ('backfill','reprocess'))
             AND p.eligibility IN ('qualified','needs_review')
             AND e.event_type IN ('new_project','new_plan_submission','units_changed','approval','permit_issued')
           ORDER BY p.score DESC NULLS LAST, e.detected_at DESC LIMIT 60""", since)
    counts = await db.fetchrow(
        """SELECT count(*) FILTER (WHERE eligibility='qualified') AS q,
                  count(*) FILTER (WHERE eligibility='needs_review') AS nr FROM projects""")
    lines = [f"ICECAP DAILY DIGEST — {day.astimezone(ZoneInfo('America/New_York')):%Y-%m-%d}",
             f"Activity in the last 24h: {len(rows)} event(s). Pipeline: {counts['q']} qualified, {counts['nr']} needs review.",
             ""]
    for r in rows:
        lines.append(f"• [{r['event_type']}] {r['address'] or '?'} ({r['neighborhood'] or '?'}) — "
                     f"{r['units_proposed'] if r['units_proposed'] is not None else '?'} units, score {r['score']}, "
                     f"fit {r['financing_fit']} — {r['summary']} — {cfg.dashboard_url}/leads/{r['id']}")
    if not rows:
        lines.append("No new qualifying activity detected in public records in the last 24 hours.")
    body = "\n".join(lines)
    n = 0
    for ch in cfg.notify_channels:
        await db.execute(
            """INSERT INTO notifications (kind, channel, dedupe_key, subject, body)
               VALUES ('daily_digest', %s, %s, %s, %s) ON CONFLICT (dedupe_key) DO NOTHING""",
            ch, f"digest:{day.date()}:{ch}", f"[IceCap] Daily digest {day.date()}", body)
        n += 1
    return n


async def enqueue_weekly_report(db: Database, cfg: Config, day: datetime) -> int:
    rows = await db.fetch(
        """SELECT e.id, e.name, pe.role, count(DISTINCT pe.project_id) AS projects,
                  count(DISTINCT pe.project_id) FILTER (WHERE p.first_seen_at >= now() - interval '7 days') AS new_7d,
                  sum(p.units_proposed) AS units
           FROM entities e JOIN project_entities pe ON pe.entity_id=e.id JOIN projects p ON p.id=pe.project_id
           WHERE pe.role IN ('developer','proponent','owner_of_record') AND p.eligibility <> 'rejected'
           GROUP BY e.id, e.name, pe.role HAVING count(DISTINCT pe.project_id) >= 1
           ORDER BY new_7d DESC, projects DESC LIMIT 40""")
    iso = day.isocalendar()
    lines = [f"ICECAP WEEKLY DEVELOPER ACTIVITY — {iso.year}-W{iso.week:02d}", ""]
    for r in rows:
        lines.append(f"• {r['name']} ({r['role'].replace('_', ' ')}): {r['projects']} project(s), "
                     f"{r['new_7d']} new this week, {r['units'] or 0} known units — {cfg.dashboard_url}/developers/{r['id']}")
    if not rows:
        lines.append("No developer-attributed projects yet.")
    body = "\n".join(lines)
    for ch in cfg.notify_channels:
        await db.execute(
            """INSERT INTO notifications (kind, channel, dedupe_key, subject, body)
               VALUES ('weekly_report', %s, %s, %s, %s) ON CONFLICT (dedupe_key) DO NOTHING""",
            ch, f"weekly:{iso.year}-{iso.week}:{ch}", f"[IceCap] Weekly developer activity {iso.year}-W{iso.week:02d}", body)
    return len(cfg.notify_channels)


def next_local_time(now: datetime, hour: int, tz: str, weekday: int | None = None) -> datetime:
    z = ZoneInfo(tz)
    local = now.astimezone(z)
    cand = local.replace(hour=hour, minute=0, second=0, microsecond=0)
    while cand <= local or (weekday is not None and cand.weekday() != weekday):
        cand += timedelta(days=1)
    return cand.astimezone(timezone.utc)


__all__ = ["dispatch_due", "enqueue_daily_digest", "enqueue_weekly_report", "next_local_time", "fmt_dt", "money"]
