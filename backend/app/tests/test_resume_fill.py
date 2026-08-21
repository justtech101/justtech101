from unittest.mock import AsyncMock

import pytest

from app.automation.form_filler import FieldMapping, resume_paused_fields


def make_browser() -> AsyncMock:
    browser = AsyncMock()
    browser.screenshot.return_value = "storage/screenshots/test.png"
    return browser


@pytest.mark.asyncio
async def test_resume_only_fills_selectors_present_in_human_inputs():
    browser = make_browser()
    pending = [
        FieldMapping(selector="#password", label="Password", field_type="fill", value_source=""),
        FieldMapping(selector="#certify", label="I certify this is true", field_type="check", value_source=""),
    ]

    result = await resume_paused_fields(
        application_id="app-1",
        browser=browser,
        pending_fields=pending,
        human_inputs={"#password": "hunter2-live-value-only"},
    )

    # Only the password field was supplied -- it's the only one filled.
    assert result.filled_fields == ["Password"]
    browser.fill_field.assert_awaited_once_with("#password", "hunter2-live-value-only")
    browser.check_checkbox.assert_not_awaited()

    # The checkbox was never supplied, so it stays paused -- never
    # defaulted, never resolved from anywhere else.
    assert result.status == "awaiting_human_input"
    assert [f.selector for f in result.remaining_pending] == ["#certify"]


@pytest.mark.asyncio
async def test_resume_completes_once_all_pending_fields_are_supplied():
    browser = make_browser()
    pending = [
        FieldMapping(selector="#certify", label="I certify this is true", field_type="check", value_source=""),
    ]

    result = await resume_paused_fields(
        application_id="app-1",
        browser=browser,
        pending_fields=pending,
        human_inputs={"#certify": "true"},
    )

    browser.check_checkbox.assert_awaited_once_with("#certify", checked=True)
    assert result.status == "awaiting_human_review"
    assert result.remaining_pending == []


@pytest.mark.asyncio
async def test_resume_never_invents_a_value_for_an_unsupplied_field():
    browser = make_browser()
    pending = [FieldMapping(selector="#ssn", label="Social Security Number", field_type="fill", value_source="")]

    result = await resume_paused_fields(
        application_id="app-1", browser=browser, pending_fields=pending, human_inputs={},
    )

    browser.fill_field.assert_not_awaited()
    assert result.status == "awaiting_human_input"
    assert len(result.remaining_pending) == 1
