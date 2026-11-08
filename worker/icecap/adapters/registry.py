"""Registry of all source adapters. Add new cities here."""
from __future__ import annotations

from .base import SourceAdapter
from .boston.a80 import Article80LegacyAdapter, Article80ProjectsAdapter
from .boston.applications import PermitApplicationsAdapter
from .boston.permits import BuildingPermitsAdapter
from .boston.records_library import RecordsLibraryAdapter
from .boston.zba import ZoningAppealsAdapter

CITIES = {
    "boston": {"name": "Boston", "state": "MA", "timezone": "America/New_York"},
}

ADAPTERS: list[SourceAdapter] = [
    Article80ProjectsAdapter(),
    RecordsLibraryAdapter(),
    PermitApplicationsAdapter(),
    ZoningAppealsAdapter(),
    BuildingPermitsAdapter(),
    Article80LegacyAdapter(),
]

BY_KEY: dict[str, SourceAdapter] = {a.meta.key: a for a in ADAPTERS}


def get(key: str) -> SourceAdapter:
    return BY_KEY[key]
