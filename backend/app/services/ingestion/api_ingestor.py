"""
Concrete public-API ingestors. These call real, publicly documented,
no-auth-required endpoints so Phase 1 has genuine data flowing through the
pipeline out of the box. Add more by subclassing `Ingestor` the same way.
"""
import logging
from datetime import datetime

import httpx

from app.schemas.opportunity import OpportunityIngest
from app.services import extraction
from app.services.ingestion.base import Ingestor

logger = logging.getLogger(__name__)

HTTP_TIMEOUT = 20.0


class GrantsGovIngestor(Ingestor):
    """https://grants.gov -- public search2 API, no API key required.
    Docs: https://www.grants.gov/api/index.html

    Config:
        {"keyword": "technology", "rows": 25, "oppStatuses": "posted"}
    """

    opportunity_type = "grant"
    ENDPOINT = "https://api.grants.gov/v1/api/search2"

    def __init__(self, *, name: str, config: dict):
        super().__init__(name=name, config=config)
        self.keyword = config.get("keyword", "")
        self.rows = config.get("rows", 25)
        self.opp_statuses = config.get("oppStatuses", "posted")

    async def fetch(self) -> list[OpportunityIngest]:
        payload = {"keyword": self.keyword, "rows": self.rows, "oppStatuses": self.opp_statuses}
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            try:
                resp = await client.post(self.ENDPOINT, json=payload)
                resp.raise_for_status()
            except httpx.HTTPError:
                logger.exception("Grants.gov API request failed for source '%s'", self.name)
                return []
            data = resp.json()

        opportunities = (data.get("data") or {}).get("oppHits") or []
        results: list[OpportunityIngest] = []
        for opp in opportunities:
            try:
                results.append(self._map_item(opp))
            except Exception:
                logger.exception("Skipping malformed Grants.gov item in '%s'", self.name)
                continue
        return results

    def _map_item(self, opp: dict) -> OpportunityIngest:
        opp_id = str(opp.get("id", ""))
        title = (opp.get("title") or "").strip()
        agency = opp.get("agencyName") or opp.get("agencyCode")
        close_date_raw = opp.get("closeDate")  # format: "MM/DD/YYYY"
        deadline = None
        if close_date_raw:
            try:
                deadline = datetime.strptime(close_date_raw, "%m/%d/%Y")
            except ValueError:
                deadline = None

        award_floor = opp.get("awardFloor")
        award_ceiling = opp.get("awardCeiling")
        award_amount = None
        for candidate in (award_ceiling, award_floor):
            if candidate not in (None, "", "0"):
                try:
                    award_amount = float(str(candidate).replace(",", ""))
                    break
                except ValueError:
                    continue

        description = opp.get("description") or opp.get("synopsis") or ""

        return OpportunityIngest(
            type="grant",
            source="api:grants.gov",
            source_url=f"https://www.grants.gov/search-results-detail/{opp_id}" if opp_id else None,
            external_id=opp_id or None,
            title=title,
            organization=agency,
            description=description,
            deadline=deadline,
            eligibility={"eligible_applicants": opp.get("eligibleApplicants")} if opp.get("eligibleApplicants") else {},
            award_amount=award_amount,
            required_documents=extraction.extract_required_documents(description),
            application_questions=extraction.extract_application_questions(description),
            raw_data=opp,
        )


class RemoteOKIngestor(Ingestor):
    """https://remoteok.com/api -- public JSON feed of remote job postings,
    no API key required. Config: {} (no options needed)."""

    opportunity_type = "job"
    ENDPOINT = "https://remoteok.com/api"

    async def fetch(self) -> list[OpportunityIngest]:
        headers = {"User-Agent": "JUSTTECH-Application-Manager/1.0 (+https://github.com/justtech101/justtech101)"}
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, headers=headers) as client:
            try:
                resp = await client.get(self.ENDPOINT)
                resp.raise_for_status()
            except httpx.HTTPError:
                logger.exception("RemoteOK API request failed for source '%s'", self.name)
                return []
            data = resp.json()

        # first element is a legal/notice object, not a job -- skip it
        items = [item for item in data if isinstance(item, dict) and item.get("id")]
        results: list[OpportunityIngest] = []
        for item in items:
            try:
                results.append(self._map_item(item))
            except Exception:
                logger.exception("Skipping malformed RemoteOK item in '%s'", self.name)
                continue
        return results

    def _map_item(self, item: dict) -> OpportunityIngest:
        description = item.get("description") or ""
        salary_min = item.get("salary_min")
        salary_max = item.get("salary_max")
        salary_min = float(salary_min) if salary_min else None
        salary_max = float(salary_max) if salary_max else None
        if salary_min is None and salary_max is None:
            salary_min, salary_max = extraction.extract_salary_range(description)

        tags = item.get("tags") or []
        if not isinstance(tags, list):
            tags = [tags]
        title = (item.get("position") or "").strip()
        employment_type = extraction.extract_employment_type(
            f"{title}\n{description}", tags=[str(t) for t in tags]
        )
        eligibility: dict = {}
        if employment_type:
            eligibility["employment_type"] = employment_type

        return OpportunityIngest(
            type="job",
            source="api:remoteok",
            source_url=item.get("url"),
            external_id=str(item.get("id")),
            title=title,
            organization=item.get("company"),
            description=description,
            location=item.get("location") or "Remote",
            remote=True,
            eligibility=eligibility,
            salary_min=salary_min,
            salary_max=salary_max,
            required_documents=extraction.extract_required_documents(description),
            application_questions=extraction.extract_application_questions(description),
            raw_data=item,
        )
