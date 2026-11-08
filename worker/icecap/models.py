"""Core data structures shared by adapters and the pipeline."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

RECORD_CLASSES = (
    "planning_project",          # Article 80 project record (planning review)
    "planning_document",         # Records Library document (filing, presentation, vote, agreement …)
    "permit_application",        # building-permit application (submitted, not necessarily issued)
    "issued_permit",             # issued building permit
    "certificate_of_occupancy",  # completion record
    "zoning_appeal",             # Zoning Board of Appeal case
)

FILING_KINDS = (
    "project_record", "developer_filing", "approval", "community_engagement", "administrative",
    "application", "permit", "appeal", "completion",
)


@dataclass
class RawRecord:
    source_key: str
    source_record_id: str
    payload: dict[str, Any]
    source_url: str | None = None
    source_filing_date: date | None = None
    source_updated_at: datetime | None = None


@dataclass
class Party:
    role: str              # developer | proponent | applicant | owner_of_record | architect | contact_person | planning_staff | zba_contact …
    name: str
    source_field: str      # where it came from, e.g. "Developer" field or "description (text)"
    evidence: str | None = None


@dataclass
class ContactPoint:
    kind: str              # phone | email | mailing_address
    value: str
    role_label: str        # whose contact this is, as attributed by the source
    source_field: str
    is_city_staff: bool = False


@dataclass
class NormalizedFiling:
    source_key: str
    source_record_id: str
    record_class: str
    filing_kind: str
    title: str | None = None
    doc_type: str | None = None
    address: str | None = None
    parcel_id: str | None = None
    neighborhood: str | None = None
    zip: str | None = None
    lat: float | None = None
    lon: float | None = None
    units_proposed: int | None = None
    units_existing: int | None = None
    units_source: str | None = None        # e.g. "structured:TotalResidentialUnits" or "text:explicit_unit_count"
    units_is_range: bool = False
    gross_sqft: int | None = None
    retail_sqft: int | None = None
    land_sqft: int | None = None
    declared_valuation: float | None = None
    proposed_cost: float | None = None
    project_types: list[str] = field(default_factory=list)
    is_mixed_use: bool | None = None
    nonres_signals: list[str] = field(default_factory=list)
    residential_signal: bool = False
    ordinary_work: bool = False
    status: str | None = None
    stage: str | None = None
    description: str | None = None
    people: list[Party] = field(default_factory=list)
    contacts: list[ContactPoint] = field(default_factory=list)
    related_ids: dict[str, Any] = field(default_factory=dict)
    document_url: str | None = None
    source_url: str | None = None
    project_url: str | None = None
    source_filing_date: date | None = None
    source_updated_at: datetime | None = None
    in_window: bool = True                 # whether this record has activity inside the monitoring window
    can_create_project: bool = True        # enrichment-only records never create projects
    link_by_official_id_only: bool = False # enrichment records attach only via an official project id

    # Set by eligibility classification
    eligibility: str = "needs_review"
    eligibility_reasons: list[str] = field(default_factory=list)

    def material_values(self) -> list[Any]:
        """Fields whose change constitutes a *material* update (drives alerts)."""
        return [
            self.record_class, self.filing_kind, self.doc_type, self.units_proposed, self.units_existing,
            self.status, self.stage, self.declared_valuation, self.proposed_cost,
            str(self.source_filing_date) if self.source_filing_date else None, self.document_url,
            sorted(self.project_types),
        ]
