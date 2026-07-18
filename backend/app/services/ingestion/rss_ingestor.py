"""
Generic RSS/Atom ingestor. Works for any job or grant board that publishes a
feed (e.g. WeWorkRemotely's RSS, a saved-search RSS export from a job board,
or a grants newsletter's RSS). Configure via an `ingestion_sources` row:

    {
      "name": "WeWorkRemotely - Programming",
      "source_type": "rss",
      "opportunity_type": "job",
      "config": {"url": "https://weworkremotely.com/categories/remote-programming-jobs.rss"}
    }
"""
import asyncio
import logging

import feedparser

from app.schemas.opportunity import OpportunityIngest
from app.services import extraction
from app.services.ingestion.base import Ingestor

logger = logging.getLogger(__name__)


class RSSIngestor(Ingestor):
    def __init__(self, *, name: str, config: dict, opportunity_type: str):
        super().__init__(name=name, config=config)
        self.opportunity_type = opportunity_type
        self.url = config.get("url")
        if not self.url:
            raise ValueError(f"RSS ingestor '{name}' is missing config.url")

    async def fetch(self) -> list[OpportunityIngest]:
        feed = await asyncio.to_thread(feedparser.parse, self.url)
        if feed.bozo and not feed.entries:
            logger.warning("RSS feed '%s' failed to parse: %s", self.name, feed.bozo_exception)
            return []

        results: list[OpportunityIngest] = []
        for entry in feed.entries:
            try:
                results.append(self._map_entry(entry))
            except Exception:
                logger.exception("Skipping malformed RSS entry from '%s'", self.name)
                continue
        return results

    def _map_entry(self, entry) -> OpportunityIngest:
        title = getattr(entry, "title", "").strip()
        link = getattr(entry, "link", None)
        summary = getattr(entry, "summary", "") or getattr(entry, "description", "")
        organization = getattr(entry, "author", None)
        guid = getattr(entry, "id", None) or link

        deadline = extraction.extract_deadline(summary)
        salary_min, salary_max = (None, None)
        award_amount = None
        if self.opportunity_type == "job":
            salary_min, salary_max = extraction.extract_salary_range(summary)
        else:
            award_amount = extraction.extract_award_amount(summary)

        return OpportunityIngest(
            type=self.opportunity_type,
            source=f"rss:{self.name}",
            source_url=link,
            external_id=guid,
            title=title,
            organization=organization,
            description=summary,
            deadline=deadline,
            salary_min=salary_min,
            salary_max=salary_max,
            award_amount=award_amount,
            required_documents=extraction.extract_required_documents(summary),
            application_questions=extraction.extract_application_questions(summary),
            raw_data={"rss_entry": {k: v for k, v in entry.items() if isinstance(v, (str, int, float, bool))}},
        )
