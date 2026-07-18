"""
Deduplication: an exact-match content hash (fast, DB-enforced via a unique
constraint) plus a fuzzy pass to catch the same posting appearing on two
different sources (e.g. a job cross-posted to LinkedIn and the company's
own careers page).
"""
import hashlib
import re

from rapidfuzz import fuzz
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.opportunity import Opportunity

FUZZY_TITLE_THRESHOLD = 90  # 0-100, rapidfuzz token_sort_ratio
FUZZY_LOOKBACK_LIMIT = 500  # only compare against the most recent N opportunities of the same type, for speed


def _normalize(text: str | None) -> str:
    if not text:
        return ""
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9\s]", "", text)
    text = re.sub(r"\s+", " ", text)
    return text


def compute_content_hash(*, type_: str, organization: str | None, title: str, source: str) -> str:
    normalized = f"{type_}|{_normalize(organization)}|{_normalize(title)}|{source.lower().strip()}"
    return hashlib.sha256(normalized.encode()).hexdigest()


async def find_exact_duplicate(db: AsyncSession, content_hash: str) -> Opportunity | None:
    result = await db.execute(select(Opportunity).where(Opportunity.content_hash == content_hash))
    return result.scalar_one_or_none()


async def find_fuzzy_duplicate(
    db: AsyncSession, *, type_: str, organization: str | None, title: str
) -> Opportunity | None:
    """Cross-source duplicate detection: same normalized org + a very close
    title match among recently discovered opportunities of the same type."""
    result = await db.execute(
        select(Opportunity)
        .where(Opportunity.type == type_)
        .order_by(Opportunity.discovered_at.desc())
        .limit(FUZZY_LOOKBACK_LIMIT)
    )
    candidates = result.scalars().all()
    norm_org = _normalize(organization)
    norm_title = _normalize(title)
    if not norm_title:
        return None

    for candidate in candidates:
        if _normalize(candidate.organization) != norm_org:
            continue
        similarity = fuzz.token_sort_ratio(norm_title, _normalize(candidate.title))
        if similarity >= FUZZY_TITLE_THRESHOLD:
            return candidate
    return None
