"""Database access helpers (psycopg 3, async)."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent.parent / "db" / "migrations"
if not MIGRATIONS_DIR.exists():  # inside the Docker image migrations are copied next to the package
    MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def jsonb(v: Any) -> Jsonb:
    return Jsonb(v, dumps=lambda o: json.dumps(o, default=str))


class Database:
    def __init__(self, url: str, min_size: int = 1, max_size: int = 8):
        self.url = url
        self.pool = AsyncConnectionPool(url, min_size=min_size, max_size=max_size, open=False,
                                        kwargs={"row_factory": dict_row, "autocommit": False})

    async def open(self) -> None:
        await self.pool.open(wait=True, timeout=30)

    async def close(self) -> None:
        await self.pool.close()

    @asynccontextmanager
    async def tx(self) -> AsyncIterator[psycopg.AsyncConnection]:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                yield conn

    async def fetch(self, sql: str, *args: Any) -> list[dict]:
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, args or None)
            rows = await cur.fetchall() if cur.description else []
            await conn.commit()
            return rows

    async def fetchrow(self, sql: str, *args: Any) -> dict | None:
        rows = await self.fetch(sql, *args)
        return rows[0] if rows else None

    async def execute(self, sql: str, *args: Any) -> None:
        async with self.pool.connection() as conn:
            await conn.execute(sql, args or None)
            await conn.commit()


async def apply_migrations(url: str) -> list[str]:
    """Apply db/migrations/*.sql in order, once each. Returns versions applied."""
    applied: list[str] = []
    async with await psycopg.AsyncConnection.connect(url, autocommit=True) as conn:
        await conn.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())""")
        cur = await conn.execute("SELECT version FROM schema_migrations")
        done = {r[0] for r in await cur.fetchall()}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            version = path.stem
            if version in done:
                continue
            sql = path.read_text()
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO schema_migrations(version) VALUES (%s) ON CONFLICT DO NOTHING", (version,))
            applied.append(version)
    return applied
