import time
from unittest.mock import AsyncMock

import pytest

from app.automation import session_registry
from app.automation.session_registry import PausedSession


@pytest.mark.asyncio
async def test_store_and_get_roundtrip():
    browser = AsyncMock()
    session = PausedSession(browser=browser, pending_fields=[], dry_run=True)
    await session_registry.store("app-a", session)

    fetched = await session_registry.get("app-a")
    assert fetched is session

    await session_registry.discard("app-a")
    assert await session_registry.get("app-a") is None


@pytest.mark.asyncio
async def test_close_and_discard_closes_the_browser():
    browser = AsyncMock()
    await session_registry.store("app-b", PausedSession(browser=browser, pending_fields=[], dry_run=True))

    await session_registry.close_and_discard("app-b")

    browser.close.assert_awaited_once()
    assert await session_registry.get("app-b") is None


@pytest.mark.asyncio
async def test_expired_sessions_are_swept_and_closed_on_access():
    browser = AsyncMock()
    session = PausedSession(browser=browser, pending_fields=[], dry_run=True)
    # Backdate creation so it's already past the TTL.
    session.created_at = time.monotonic() - session_registry.SESSION_TTL_SECONDS - 5
    await session_registry.store("app-c", session)

    fetched = await session_registry.get("app-c")

    assert fetched is None
    browser.close.assert_awaited_once()
