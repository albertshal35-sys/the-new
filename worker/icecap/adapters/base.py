"""Source adapter contract.

To add a city: implement SourceAdapter subclasses in icecap/adapters/<city>/ and register them in
icecap/adapters/registry.py. Nothing else in the pipeline is city specific.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from datetime import datetime
from typing import AsyncIterator

from ..http import PoliteClient
from ..models import NormalizedFiling, RawRecord


@dataclass(frozen=True)
class SourceMeta:
    key: str
    city_id: str
    name: str
    record_class: str
    official_url: str
    api_url: str
    description: str
    limitations: str
    publication_cadence: str
    min_interval_s: int = 300
    max_interval_s: int = 3600
    lookback_days: int = 14              # overlap window for late publications
    reconcile_every_h: int = 24          # full-window re-scan to catch silent edits on older records
    is_enrichment_only: bool = False
    backfill_order: int = 50             # lower runs first during the initial backfill


@dataclass
class UpstreamVersion:
    """Cheap freshness probe result (provider metadata, ETag …)."""
    version: str | None
    updated_at: datetime | None
    extra: dict = field(default_factory=dict)


@dataclass
class FetchContext:
    mode: str                            # backfill | incremental | reconcile
    window_start: datetime
    window_end: datetime
    etag: str | None = None
    upstream: UpstreamVersion | None = None
    is_full_snapshot: bool = False       # adapter sets True when it returned the complete dataset
    new_etag: str | None = None
    pages: int = 0


class SourceAdapter(abc.ABC):
    meta: SourceMeta

    async def check_upstream(self, client: PoliteClient) -> UpstreamVersion | None:
        """Return provider version info, or None if the source exposes nothing usable."""
        return None

    @abc.abstractmethod
    def fetch(self, client: PoliteClient, ctx: FetchContext) -> AsyncIterator[list[RawRecord]]:
        """Yield pages of raw records whose source dates fall within ctx.window_*."""

    @abc.abstractmethod
    def normalize(self, raw: RawRecord) -> NormalizedFiling | None:
        """Convert one raw record into a normalized filing (no I/O)."""
