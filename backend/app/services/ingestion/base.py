"""
Every ingestion source (RSS, a public API, an IMAP inbox, a scraped website)
implements this same tiny interface. This is the seam where third-party OSS
scrapers (Career-ops, GrantHunt, etc.) get wrapped in later without touching
the runner, dedup, scoring, or router code.
"""
from abc import ABC, abstractmethod

from app.schemas.opportunity import OpportunityIngest


class Ingestor(ABC):
    #: opportunity_type this ingestor produces -- 'job' or 'grant'
    opportunity_type: str

    def __init__(self, *, name: str, config: dict):
        self.name = name
        self.config = config

    @abstractmethod
    async def fetch(self) -> list[OpportunityIngest]:
        """Return normalized opportunities. Must not raise on a single bad
        item -- skip and log it, don't fail the whole batch."""
        raise NotImplementedError
