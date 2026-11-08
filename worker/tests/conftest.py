import json
import os
from pathlib import Path

import psycopg
import pytest
import pytest_asyncio

from icecap.config import Config
from icecap.db import Database, apply_migrations
from icecap.settings_store import DEFAULTS

FIXTURES = Path(__file__).parent / "fixtures"
TEST_DB_URL = os.environ.get("TEST_DATABASE_URL", "postgresql://icecap:icecap@localhost:5432/icecap_test")


def load_fixture(name: str):
    return json.loads((FIXTURES / name).read_text())


def ckan_records(name: str) -> list[dict]:
    return load_fixture(name)["result"]["records"]


@pytest.fixture
def settings():
    import copy
    return copy.deepcopy(DEFAULTS)


@pytest.fixture
def config():
    return Config(database_url=TEST_DB_URL, telegram_bot_token=None, telegram_chat_id=None, smtp_host=None,
                  notify_channels=("telegram", "email"), dashboard_url="http://dash")


def _db_available() -> bool:
    try:
        with psycopg.connect(TEST_DB_URL, connect_timeout=3):
            return True
    except Exception:
        return False


@pytest_asyncio.fixture
async def db():
    if not _db_available():
        pytest.skip("test database not available (set TEST_DATABASE_URL)")
    async with await psycopg.AsyncConnection.connect(TEST_DB_URL, autocommit=True) as conn:
        await conn.execute("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;")
    await apply_migrations(TEST_DB_URL)
    d = Database(TEST_DB_URL, max_size=4)
    await d.open()
    from icecap.worker import seed
    await seed(d)
    yield d
    await d.close()
