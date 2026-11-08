"""Boston Planning Department Article 80 Records Library.

The public page https://apps.bostonplans.org/recordslibrary/ is a React app. Its bundled JavaScript calls a
public, unauthenticated JSON API (discovered from main.*.js, not guessed):

    GET https://sire.bostonplans.org/api/documentSearch/getMetadataWithProjects
        ?ft_docType=&ft_projID=&ft_neighborhood=&ft_Search=&ft_startDate=YYYY-MM-DD&ft_endDate=YYYY-MM-DD
        &ft_page=N&ft_next_marker=<opaque marker from previous page>

Response: {metadataObj:[{boxMetadata:{documentDate, type, subtype, projectName, neighborhood, id, url,
$parent:"file_<box id>"}, shareLink}], totalcount, next_marker}.  50 documents per page.
`type` distinguishes Developer Filing / Vote / Community Engagement / Executed Documents.
No browser automation is needed; no authentication or CAPTCHA is involved.
"""
from __future__ import annotations

import re
from datetime import timedelta

from ...models import NormalizedFiling, RawRecord
from ...normalize import clean_str, parse_date
from ..base import FetchContext, SourceAdapter, SourceMeta
from .a80 import project_slug

API = "https://sire.bostonplans.org/api/documentSearch"

APPROVAL_SUBTYPES = re.compile(
    r"(determination|approval|certification of approval|scoping|adequacy|board vote|"
    r"cooperation agreement|development plan|certificate of compliance)", re.I)
PLAN_FILING_SUBTYPES = re.compile(
    r"(project notification form|pnf|small project review application|spra|letter of intent|loi|"
    r"draft project impact report|dpir|final project impact report|fpir|notice of project change|npc|"
    r"expanded pnf|project impact report|planned development area|pda|institutional master plan|"
    r"additional information|supplemental|project fact sheet|application)", re.I)


def classify_document(doc_type: str | None, subtype: str | None) -> tuple[str, str | None]:
    """Return (filing_kind, stage) for a Records Library document."""
    t = (doc_type or "").lower()
    s = subtype or ""
    if t == "developer filing":
        if re.search(r"letter of intent|\bloi\b", s, re.I):
            return "developer_filing", "letter_of_intent"
        return "developer_filing", "planning_filing"
    if t == "vote":
        return "approval", "board_approved"
    if t == "community engagement":
        return "community_engagement", None
    if t == "executed documents":
        if APPROVAL_SUBTYPES.search(s):
            return "approval", "board_approved"
        return "administrative", None
    if PLAN_FILING_SUBTYPES.search(s):
        return "developer_filing", "planning_filing"
    return "administrative", None


class RecordsLibraryAdapter(SourceAdapter):
    meta = SourceMeta(
        key="boston.records_library",
        city_id="boston",
        name="Boston Planning Dept. Article 80 Records Library",
        record_class="planning_document",
        official_url="https://apps.bostonplans.org/recordslibrary/",
        api_url=f"{API}/getMetadataWithProjects",
        description="Article 80 documents (PNF, SPRA, LOI, NPC, DPIR, board votes, agreements, presentations, "
                    "videos, public comments) with document date, category, project and Box share link.",
        limitations="documentDate is a date without time and can be back-dated relative to when the document "
                    "appears; a 21-day overlapping lookback re-scans recent dates on every poll. Document "
                    "contents (PDFs on Box) are linked, not parsed. No ETag/Last-Modified support.",
        publication_cadence="Documents appear on business days at irregular times.",
        min_interval_s=600, max_interval_s=1800, lookback_days=21, reconcile_every_h=24, backfill_order=20,
    )

    async def fetch(self, client, ctx: FetchContext):
        start = ctx.window_start.date().isoformat()
        end = (ctx.window_end + timedelta(days=1)).date().isoformat()
        page, marker = 1, ""
        seen_markers = set()
        while True:
            r = await client.get_json(f"{API}/getMetadataWithProjects", params={
                "ft_docType": "", "ft_projID": "", "ft_neighborhood": "", "ft_Search": "",
                "ft_startDate": start, "ft_endDate": end, "ft_page": page, "ft_next_marker": marker,
            })
            ctx.pages += 1
            data = r.data or {}
            out = []
            for item in data.get("metadataObj") or []:
                bm = item.get("boxMetadata") or {}
                rid = bm.get("$parent") or item.get("shareLink")
                if not rid:
                    continue
                payload = {"boxMetadata": bm, "shareLink": item.get("shareLink")}
                out.append(RawRecord(
                    source_key=self.meta.key, source_record_id=str(rid), payload=payload,
                    source_url=item.get("shareLink") or self.meta.official_url,
                    source_filing_date=parse_date(bm.get("documentDate")),
                ))
            if out:
                yield out
            marker = data.get("next_marker") or ""
            if not marker or marker in seen_markers or not data.get("metadataObj"):
                return
            seen_markers.add(marker)
            page += 1

    def normalize(self, raw: RawRecord) -> NormalizedFiling:
        bm = raw.payload.get("boxMetadata") or {}
        subtype = clean_str(bm.get("subtype")) or clean_str((bm.get("subtypeSelect") or [None])[0])
        doc_type = clean_str(bm.get("type"))
        kind, stage = classify_document(doc_type, subtype)
        project_name = clean_str(bm.get("projectName"))
        url = clean_str(bm.get("url"))
        return NormalizedFiling(
            source_key=self.meta.key, source_record_id=raw.source_record_id,
            record_class="planning_document", filing_kind=kind,
            title=f"{project_name or 'Unknown project'} — {subtype or doc_type or 'Document'}",
            doc_type=subtype or doc_type, address=project_name, neighborhood=clean_str(bm.get("neighborhood")),
            stage=stage, status=doc_type,
            related_ids={"salesforce_project_id": bm.get("id"), "project_slug": project_slug(url),
                         "document_category": doc_type, "box_file": raw.source_record_id},
            document_url=clean_str(raw.payload.get("shareLink")), source_url=self.meta.official_url,
            project_url=url, source_filing_date=parse_date(bm.get("documentDate")),
            can_create_project=(kind == "developer_filing"),
        )
