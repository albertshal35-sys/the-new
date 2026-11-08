"""Command line: migrate | seed | backfill | run-source | worker | dispatch | stats | api | digest"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from .adapters import registry
from .config import get_config
from .db import Database, apply_migrations
from .http import PoliteClient
from .notify.channels import build_channels
from .notify.dispatcher import dispatch_due, enqueue_daily_digest, enqueue_weekly_report
from .runner import run_source
from .settings_store import load_settings
from .worker import enrich_owners, run_pending_backfills, seed, worker_main


async def _with_db(fn):
    cfg = get_config()
    await apply_migrations(cfg.database_url)
    db = Database(cfg.database_url)
    await db.open()
    client = PoliteClient(cfg.user_agent, timeout_s=cfg.http_timeout_s)
    try:
        await seed(db)
        settings = await load_settings(db)
        return await fn(cfg, db, client, settings)
    finally:
        await client.aclose()
        await db.close()


async def stats(db: Database) -> dict:
    by_source = await db.fetch(
        """SELECT f.source_key, count(*) AS filings,
                  count(*) FILTER (WHERE f.eligibility='qualified') AS qualified,
                  count(*) FILTER (WHERE f.eligibility='needs_review') AS needs_review,
                  count(*) FILTER (WHERE f.eligibility='rejected') AS rejected,
                  count(*) FILTER (WHERE f.project_id IS NOT NULL) AS linked,
                  min(f.source_filing_date) AS oldest, max(f.source_filing_date) AS newest
           FROM filings f GROUP BY 1 ORDER BY 1""")
    projects = await db.fetchrow(
        """SELECT count(*) AS total, count(*) FILTER (WHERE eligibility='qualified') AS qualified,
                  count(*) FILTER (WHERE eligibility='needs_review') AS needs_review,
                  count(*) FILTER (WHERE eligibility='rejected') AS rejected,
                  count(*) FILTER (WHERE financing_fit='likely') AS fit_likely,
                  count(*) FILTER (WHERE financing_fit='uncertain') AS fit_uncertain,
                  count(*) FILTER (WHERE financing_fit='outside_scope') AS fit_outside,
                  count(*) FILTER (WHERE has_contact) AS with_contact,
                  count(*) FILTER (WHERE developer_entity_id IS NOT NULL) AS with_developer
           FROM projects""")
    multi = await db.fetchrow(
        """SELECT count(*) AS n FROM (SELECT project_id FROM filings WHERE project_id IS NOT NULL
           GROUP BY project_id HAVING count(DISTINCT source_key) > 1) x""")
    events = await db.fetch(
        "SELECT event_type, alertable, coalesce(suppressed_reason,'-') AS suppressed, count(*) AS n "
        "FROM project_events GROUP BY 1,2,3 ORDER BY 1")
    notes = await db.fetch("SELECT channel, kind, status, count(*) AS n FROM notifications GROUP BY 1,2,3 ORDER BY 1")
    raw = await db.fetch("SELECT source_key, count(*) AS n, sum(version-1) AS revisions FROM raw_records GROUP BY 1")
    return {"filings_by_source": by_source, "projects": projects, "projects_linked_across_sources": multi["n"],
            "raw_records": raw, "events": events, "notifications": notes}


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(prog="icecap")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    sub.add_parser("seed")
    sub.add_parser("backfill", help="run pending initial 365-day backfills in dependency order")
    rs = sub.add_parser("run-source")
    rs.add_argument("key", choices=sorted(registry.BY_KEY))
    rs.add_argument("--mode", choices=["backfill", "incremental", "reconcile"])
    rp = sub.add_parser("reprocess", help="re-apply normalization/eligibility rules to stored raw records (no alerts)")
    rp.add_argument("keys", nargs="*", help="source keys (default: all)")
    sub.add_parser("worker")
    sub.add_parser("dispatch")
    sub.add_parser("enrich")
    sub.add_parser("stats")
    dg = sub.add_parser("digest")
    dg.add_argument("--weekly", action="store_true")
    ap = sub.add_parser("api")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = p.parse_args(argv)
    cfg = get_config()

    if args.cmd == "migrate":
        print(asyncio.run(apply_migrations(cfg.database_url)) or "up to date")
    elif args.cmd == "seed":
        asyncio.run(_with_db(lambda c, db, cl, s: asyncio.sleep(0)))
    elif args.cmd == "backfill":
        out = asyncio.run(_with_db(lambda c, db, cl, s: run_pending_backfills(db, cl, c, s)))
        print(json.dumps(out, indent=2, default=str))
    elif args.cmd == "run-source":
        out = asyncio.run(_with_db(lambda c, db, cl, s: run_source(db, cl, c, s, registry.get(args.key), args.mode)))
        print(json.dumps(out, indent=2, default=str))
    elif args.cmd == "reprocess":
        from .pipeline import reprocess
        unknown = set(args.keys) - set(registry.BY_KEY)
        if unknown:
            p.error(f"unknown source(s): {sorted(unknown)}")
        keys = args.keys or [a.meta.key for a in sorted(registry.ADAPTERS, key=lambda a: a.meta.backfill_order)]
        out = asyncio.run(_with_db(lambda c, db, cl, s: reprocess(db, s, c, keys)))
        print(json.dumps(out, indent=2, default=str))
    elif args.cmd == "worker":
        asyncio.run(worker_main(cfg))
    elif args.cmd == "dispatch":
        out = asyncio.run(_with_db(lambda c, db, cl, s: dispatch_due(db, build_channels(c, cl), limit=500)))
        print(out)
    elif args.cmd == "enrich":
        out = asyncio.run(_with_db(lambda c, db, cl, s: enrich_owners(db, cl, s, c, limit=500)))
        print(f"enriched {out} parcels")
    elif args.cmd == "digest":
        from datetime import datetime, timezone
        fn = enqueue_weekly_report if args.weekly else enqueue_daily_digest
        asyncio.run(_with_db(lambda c, db, cl, s: fn(db, c, datetime.now(timezone.utc))))
    elif args.cmd == "stats":
        out = asyncio.run(_with_db(lambda c, db, cl, s: stats(db)))
        print(json.dumps(out, indent=2, default=str))
    elif args.cmd == "api":
        import uvicorn
        uvicorn.run("icecap.api:app", host=args.host, port=args.port, log_level="info")
    else:
        p.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
