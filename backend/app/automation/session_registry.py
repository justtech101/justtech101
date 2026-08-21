"""
Holds Playwright browser sessions that are paused mid-run, waiting on a
human to type/check one specific sensitive field live (a password, an
attestation checkbox, a typed signature). This is what makes the
human-review checkpoint fast: instead of abandoning the whole run and
starting over by hand, the browser stays open exactly where it stopped and
resumes the instant a human supplies that one value through
POST /api/applications/{id}/resume-fill.

Nothing here weakens the safety guarantee -- a paused field is never filled
from stored profile/answer/credential data. It is only ever filled with a
value a human provides in that same request, and only for the exact
selector(s) that were actually paused.

Caveat (documented, not hidden): this is an in-process, single-worker
registry. It works for the default single-uvicorn-worker deployment this
project ships with. A multi-worker or multi-machine deployment would need a
shared store (e.g. Redis) instead -- noted here rather than silently
breaking under load.
"""
import asyncio
import logging
import time
from dataclasses import dataclass, field

from app.automation.browser_manager import BrowserManager
from app.automation.form_filler import FieldMapping

logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 600  # 10 minutes to come back and supply the value


@dataclass
class PausedSession:
    browser: BrowserManager
    pending_fields: list[FieldMapping]
    dry_run: bool
    created_at: float = field(default_factory=time.monotonic)


_sessions: dict[str, PausedSession] = {}
_lock = asyncio.Lock()


async def store(application_id: str, session: PausedSession) -> None:
    async with _lock:
        _sessions[application_id] = session


async def get(application_id: str) -> PausedSession | None:
    await _sweep_expired_locked_free()
    return _sessions.get(application_id)


async def discard(application_id: str) -> None:
    async with _lock:
        _sessions.pop(application_id, None)


async def close_and_discard(application_id: str) -> None:
    async with _lock:
        session = _sessions.pop(application_id, None)
    if session:
        await session.browser.close()


async def _sweep_expired_locked_free() -> None:
    """Closes any session that's been sitting idle past its TTL, so an
    application nobody comes back to doesn't leave an orphaned Chromium
    process running on the 8 GB client."""
    now = time.monotonic()
    expired: list[tuple[str, PausedSession]] = []
    async with _lock:
        for app_id, session in list(_sessions.items()):
            if now - session.created_at > SESSION_TTL_SECONDS:
                expired.append((app_id, session))
                del _sessions[app_id]
    for app_id, session in expired:
        logger.info("Closing expired paused browser session for application %s", app_id)
        try:
            await session.browser.close()
        except Exception:
            logger.exception("Failed to close expired session browser for application %s", app_id)
