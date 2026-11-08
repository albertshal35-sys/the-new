"""Runs one source: decides the mode/window, performs the conditional check, fetches, processes, and
updates the durable source state (watermark, health, adaptive interval, circuit breaker)."""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

from .adapters.base import FetchContext, SourceAdapter
from .config import Config
from .db import Database, jsonb
from .http import PoliteClient
from .pipeline import Pipeline, RunContext

log = logging.getLogger(__name__)

CIRCUIT_THRESHOLD = 5


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def choose_mode(state: dict, adapter: SourceAdapter, now: datetime) -> str:
    if not state.get("backfill_completed_at"):
        return "backfill"
    last_rec = (state.get("last_run_stats") or {}).get("last_reconcile_at")
    if last_rec:
        last_rec_dt = datetime.fromisoformat(last_rec)
        if now - last_rec_dt >= timedelta(hours=adapter.meta.reconcile_every_h):
            return "reconcile"
    else:
        return "reconcile"
    return "incremental"


def compute_window(mode: str, state: dict, adapter: SourceAdapter, now: datetime, backfill_days: int):
    if mode in ("backfill", "reconcile"):
        return now - timedelta(days=backfill_days), now
    wm = state.get("watermark_ts") or (now - timedelta(days=adapter.meta.lookback_days or 1))
    start = min(wm, now) - timedelta(days=adapter.meta.lookback_days)
    return start, now


def next_interval(state: dict, adapter: SourceAdapter, changed: bool, now: datetime) -> int:
    """Adaptive polling: fast after changes or near the learned publication hour, slower otherwise."""
    m = adapter.meta
    cur = state.get("current_interval_s") or m.min_interval_s
    if changed:
        return m.min_interval_s
    hours = (state.get("last_run_stats") or {}).get("publish_hours_utc") or []
    if hours:
        h = now.hour
        if any(min(abs(h - x), 24 - abs(h - x)) <= 1 for x in hours):
            return m.min_interval_s
    return int(min(m.max_interval_s, max(m.min_interval_s, cur * 1.5)))


async def run_source(db: Database, client: PoliteClient, config: Config, settings: dict, adapter: SourceAdapter,
                     force_mode: str | None = None) -> dict:
    key = adapter.meta.key
    state = await db.fetchrow("SELECT * FROM source_state WHERE source_key=%s", key)
    now = utcnow()
    mode = force_mode or choose_mode(state, adapter, now)
    run = await db.fetchrow(
        "INSERT INTO ingestion_runs (source_key, mode) VALUES (%s,%s) RETURNING id", key, mode)
    run_id = run["id"]
    t0 = time.monotonic()
    req0 = client.request_count
    stats_base = dict(state.get("last_run_stats") or {})
    try:
        upstream = await adapter.check_upstream(client)
        changed_upstream = bool(upstream and upstream.version and upstream.version != state.get("upstream_version"))
        if mode == "incremental" and upstream and upstream.version and not changed_upstream:
            interval = next_interval(state, adapter, False, now)
            await db.execute(
                """UPDATE source_state SET last_check_at=now(), last_success_at=now(), consecutive_failures=0,
                       circuit_open_until=NULL, current_interval_s=%s, next_run_at=now() + make_interval(secs => %s),
                       lease_owner=NULL, lease_expires_at=NULL, last_error=NULL WHERE source_key=%s""",
                interval, interval, key)
            await db.execute(
                """UPDATE ingestion_runs SET finished_at=now(), status='unchanged', http_requests=%s, duration_ms=%s
                   WHERE id=%s""", client.request_count - req0, int((time.monotonic() - t0) * 1000), run_id)
            return {"source": key, "mode": mode, "status": "unchanged"}

        window_start, window_end = compute_window(mode, state, adapter, now, config.backfill_days)
        ctx = FetchContext(mode=mode, window_start=window_start, window_end=window_end, upstream=upstream)
        rc = RunContext(mode=mode, alerts_enabled=(mode != "backfill"),
                        source_published_at=upstream.updated_at if upstream else None)
        pipeline = Pipeline(db, settings, config)
        async for page in adapter.fetch(client, ctx):
            await pipeline.process_page(adapter, page, rc)
        if ctx.is_full_snapshot:
            await db.execute(
                """UPDATE raw_records SET removed_upstream_at=now()
                   WHERE source_key=%s AND last_seen_at < %s AND removed_upstream_at IS NULL""", key, now)
        agg = await db.fetchrow(
            """SELECT max(source_filing_date) AS newest, count(*) AS n FROM raw_records
               WHERE source_key=%s AND removed_upstream_at IS NULL""", key)
        changed = rc.stats["inserted"] + rc.stats["changed"] > 0 or changed_upstream
        if changed_upstream and upstream.updated_at:
            hours = list(stats_base.get("publish_hours_utc") or [])
            hours.append(upstream.updated_at.astimezone(timezone.utc).hour)
            stats_base["publish_hours_utc"] = hours[-20:]
        if mode in ("backfill", "reconcile"):
            stats_base["last_reconcile_at"] = now.isoformat()
        stats_base["last_run"] = {**rc.stats, "mode": mode, "window_start": window_start.isoformat(),
                                  "window_end": window_end.isoformat(), "pages": ctx.pages}
        interval = next_interval(state, adapter, changed, now)
        newest = agg["newest"]
        await db.execute(
            """UPDATE source_state SET watermark_ts=%s, upstream_version=COALESCE(%s, upstream_version),
                   upstream_updated_at=COALESCE(%s, upstream_updated_at), last_check_at=now(), last_success_at=now(),
                   last_change_detected_at = CASE WHEN %s THEN now() ELSE last_change_detected_at END,
                   consecutive_failures=0, circuit_open_until=NULL, last_error=NULL,
                   newest_record_at=%s, records_total=%s, last_run_stats=%s, current_interval_s=%s,
                   next_run_at=now() + make_interval(secs => %s), lease_owner=NULL, lease_expires_at=NULL,
                   backfill_completed_at = CASE WHEN %s THEN COALESCE(backfill_completed_at, now()) ELSE backfill_completed_at END,
                   backfill_window_start = CASE WHEN %s THEN %s ELSE backfill_window_start END
               WHERE source_key=%s""",
            window_end, upstream.version if upstream else None, upstream.updated_at if upstream else None, changed,
            datetime(newest.year, newest.month, newest.day, tzinfo=timezone.utc) if newest else None,
            agg["n"], jsonb(stats_base), interval, interval, mode == "backfill", mode == "backfill", window_start, key)
        s = rc.stats
        await db.execute(
            """UPDATE ingestion_runs SET finished_at=now(), status='success', window_start=%s, window_end=%s,
                   pages=%s, fetched=%s, inserted=%s, changed=%s, unchanged=%s, qualified=%s, needs_review=%s,
                   rejected=%s, events=%s, http_requests=%s, duration_ms=%s,
                   error=CASE WHEN %s > 0 THEN %s ELSE NULL END WHERE id=%s""",
            window_start, window_end, ctx.pages, s["fetched"], s["inserted"], s["changed"], s["unchanged"],
            s["qualified"], s["needs_review"], s["rejected"], s["events"], client.request_count - req0,
            int((time.monotonic() - t0) * 1000), s["errors"], f"{s['errors']} record(s) failed processing", run_id)
        log.info("source %s %s done: %s", key, mode, s)
        return {"source": key, "mode": mode, "status": "success", **s}
    except Exception as exc:
        log.exception("source %s run failed", key)
        failures = (state.get("consecutive_failures") or 0) + 1
        backoff = min(adapter.meta.min_interval_s * (2 ** min(failures, 6)), 6 * 3600)
        circuit = failures >= CIRCUIT_THRESHOLD
        await db.execute(
            """UPDATE source_state SET last_check_at=now(), last_error_at=now(), last_error=%s,
                   consecutive_failures=%s,
                   circuit_open_until = CASE WHEN %s THEN now() + make_interval(secs => %s) ELSE NULL END,
                   next_run_at=now() + make_interval(secs => %s), lease_owner=NULL, lease_expires_at=NULL
               WHERE source_key=%s""",
            str(exc)[:2000], failures, circuit, backoff, backoff, key)
        await db.execute(
            """UPDATE ingestion_runs SET finished_at=now(), status='error', error=%s, http_requests=%s,
                   duration_ms=%s WHERE id=%s""",
            str(exc)[:2000], client.request_count - req0, int((time.monotonic() - t0) * 1000), run_id)
        return {"source": key, "mode": mode, "status": "error", "error": str(exc)}
