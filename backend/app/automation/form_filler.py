"""
Orchestrates a Playwright browser-fill run for a single application.

Hard safety rules enforced here (not just documented -- actually enforced in
code):
  1. Refuses to run at all unless `application.human_approved` is True.
  2. Any field whose label matches STOP_FIELD_PATTERNS (attestations,
     signatures, SSNs, legal certifications, passwords, CAPTCHA-adjacent
     fields) is never auto-filled from profile/answer/document data --
     full stop. Most of these are then offered back to a human as
     `paused_fields`: the browser stays open exactly where it stopped, and
     `POST /api/applications/{id}/resume-fill` lets a human type/check the
     value live, right then, informed by the actual screenshot. That value
     is used once, for that field, and is never stored. CAPTCHA-labeled
     fields are the one exception -- there is no live-value handoff for
     those; see HARD_STOP_PATTERNS below.
  3. Never clicks a submit/finalize button. There is no code path in this
     module that does so, by construction -- `field_map` entries are only
     ever `fill`/`select`/`check`/`upload`, and the run always ends by
     handing control back to a human via the `awaiting_human_review` (or
     `awaiting_human_input`) status.
  4. A screenshot is captured before the run, after every field, at every
     stop point, and at the end -- a complete visual audit trail.
"""
import dataclasses
import logging
import re
from pathlib import Path
from typing import Any, Literal

from app.automation.browser_manager import BrowserManager, CaptchaEncounteredError
from app.models.application import Application
from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile

logger = logging.getLogger(__name__)

FieldType = Literal["fill", "select", "check", "upload"]

# CAPTCHA-labeled fields are a hard stop with no resume path: solving a
# CAPTCHA is an interactive visual challenge that can't be satisfied by
# passing a typed value through an API call, and this tool never attempts
# to work around one -- by field label here, or by DOM widget detection in
# browser_manager.CaptchaEncounteredError. If one is hit, the human must
# complete that step entirely outside this tool.
HARD_STOP_PATTERNS = [
    r"\bcaptcha\b",
]
_HARD_STOP_PATTERN = re.compile("|".join(HARD_STOP_PATTERNS), re.IGNORECASE)

# Fields matching these patterns are NEVER auto-filled from stored
# profile/answer/document data, regardless of value_source -- but unlike
# HARD_STOP_PATTERNS, a human can supply the live value through
# POST /resume-fill once they've reviewed the actual page. Case-insensitive
# substring/regex match.
STOP_FIELD_PATTERNS = [
    r"\bsignature\b",
    r"\bi\s+(certify|attest|swear|affirm)\b",
    r"\bunder penalty of perjury\b",
    r"\blegal(ly)?\s+(binding|attestation)\b",
    r"\bsocial security\b",
    r"\bssn\b",
    r"\bdate of birth\b",
    r"\bi agree to the terms\b",
    r"\bterms (and|&) conditions\b",
    r"\bbackground check\b",
    r"\bdirect deposit\b",
    r"\brouting number\b",
    r"\baccount number\b",
    r"\bpassword\b",
]
_STOP_PATTERN = re.compile("|".join(STOP_FIELD_PATTERNS), re.IGNORECASE)


@dataclasses.dataclass
class FieldMapping:
    selector: str
    label: str
    field_type: FieldType
    value_source: str  # "profile.<dotted.path>" | "answer:<question_hash>" | "document:resume" | "document:cover_letter"


@dataclasses.dataclass
class FillResult:
    status: Literal["awaiting_human_review", "awaiting_human_input", "stopped_captcha", "error"]
    filled_fields: list[str] = dataclasses.field(default_factory=list)
    missing_fields: list[str] = dataclasses.field(default_factory=list)
    stopped_fields: list[str] = dataclasses.field(default_factory=list)
    screenshots: list[str] = dataclasses.field(default_factory=list)
    error: str | None = None
    # Resumable stop-pattern fields (see STOP_FIELD_PATTERNS) a human can
    # supply a live value for via POST /resume-fill. Populated only when
    # status == "awaiting_human_input".
    paused_fields: list[FieldMapping] = dataclasses.field(default_factory=list)
    # The still-open browser, handed back to the caller to register in
    # session_registry so /resume-fill can pick up exactly where this left
    # off. None once the run has closed its own browser (every other
    # status). Not part of any API response schema -- internal handoff only.
    browser: Any = None


def _resolve_dotted(obj: Any, dotted_path: str) -> Any:
    current = obj
    for part in dotted_path.split("."):
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(part)
        else:
            current = getattr(current, part, None)
    return current


def resolve_value(
    value_source: str,
    *,
    profile: ApplicantProfile,
    answers: dict[str, str],
    resume_path: str | None,
    cover_letter_path: str | None,
) -> str | None:
    if value_source.startswith("profile."):
        value = _resolve_dotted(profile, value_source.removeprefix("profile."))
        return None if value is None else str(value)
    if value_source.startswith("answer:"):
        question_hash = value_source.removeprefix("answer:")
        return answers.get(question_hash)
    if value_source == "document:resume":
        return resume_path
    if value_source == "document:cover_letter":
        return cover_letter_path
    return None


class FormFiller:
    def __init__(self, *, dry_run: bool, screenshot_dir: Path, headless: bool = True):
        self.dry_run = dry_run
        self.screenshot_dir = screenshot_dir
        self.headless = headless

    async def run(
        self,
        *,
        application: Application,
        opportunity: Opportunity,
        profile: ApplicantProfile,
        field_map: list[FieldMapping],
        resume_path: str | None = None,
        cover_letter_path: str | None = None,
        keep_alive_for_human_input: bool = True,
    ) -> FillResult:
        if not application.human_approved:
            return FillResult(
                status="error",
                error="Refusing to run: application has not been human-approved. "
                "Approve it in Ready for Review before filling.",
            )
        if not opportunity.source_url:
            return FillResult(status="error", error="Opportunity has no source_url to navigate to.")

        result = FillResult(status="awaiting_human_review")
        browser = BrowserManager(dry_run=self.dry_run, screenshot_dir=self.screenshot_dir, headless=self.headless)

        try:
            await browser.start()
            await browser.goto(opportunity.source_url)
            shot = await browser.screenshot(application_id=str(application.id), step="before_fill")
            result.screenshots.append(str(shot))

            for field in field_map:
                if _HARD_STOP_PATTERN.search(field.label):
                    result.stopped_fields.append(field.label)
                    shot = await browser.screenshot(
                        application_id=str(application.id), step=f"stopped_{field.label}"
                    )
                    result.screenshots.append(str(shot))
                    logger.info("Hard-stopped at CAPTCHA-labeled field (no resume path): %s", field.label)
                    continue

                if _STOP_PATTERN.search(field.label):
                    result.stopped_fields.append(field.label)
                    result.paused_fields.append(field)
                    shot = await browser.screenshot(
                        application_id=str(application.id), step=f"stopped_{field.label}"
                    )
                    result.screenshots.append(str(shot))
                    logger.info("Paused at sensitive/legal field, awaiting live human input: %s", field.label)
                    continue

                value = resolve_value(
                    field.value_source,
                    profile=profile,
                    answers=application.answers or {},
                    resume_path=resume_path,
                    cover_letter_path=cover_letter_path,
                )
                if value is None:
                    result.missing_fields.append(field.label)
                    continue

                await browser.check_for_captcha()
                if field.field_type == "fill":
                    await browser.fill_field(field.selector, value)
                elif field.field_type == "select":
                    await browser.select_option(field.selector, value)
                elif field.field_type == "check":
                    await browser.check_checkbox(field.selector, checked=value.lower() in ("true", "yes", "1"))
                elif field.field_type == "upload":
                    await browser.upload_file(field.selector, value)

                result.filled_fields.append(field.label)
                shot = await browser.screenshot(application_id=str(application.id), step=f"filled_{field.label}")
                result.screenshots.append(str(shot))

            if result.paused_fields and keep_alive_for_human_input:
                # Hand the still-open browser back to the caller instead of
                # closing it -- POST /resume-fill will pick up exactly here
                # once a human supplies a live value for each paused field.
                result.status = "awaiting_human_input"
                shot = await browser.screenshot(application_id=str(application.id), step="awaiting_human_input")
                result.screenshots.append(str(shot))
                result.browser = browser
                return result

            final_shot = await browser.screenshot(application_id=str(application.id), step="awaiting_human_review")
            result.screenshots.append(str(final_shot))
            # NOTE: intentionally no submit click anywhere in this method.

        except CaptchaEncounteredError as exc:
            result.status = "stopped_captcha"
            result.error = str(exc)
            logger.warning("Form fill stopped due to CAPTCHA: %s", exc)
        except Exception as exc:  # noqa: BLE001 -- surface any automation failure to the caller
            result.status = "error"
            result.error = str(exc)
            logger.exception("Form fill run failed for application %s", application.id)

        await browser.close()
        return result


@dataclasses.dataclass
class ResumeResult:
    status: Literal["awaiting_human_review", "awaiting_human_input", "error"]
    filled_fields: list[str] = dataclasses.field(default_factory=list)
    remaining_pending: list[FieldMapping] = dataclasses.field(default_factory=list)
    screenshots: list[str] = dataclasses.field(default_factory=list)
    error: str | None = None


async def resume_paused_fields(
    *,
    application_id: str,
    browser: BrowserManager,
    pending_fields: list[FieldMapping],
    human_inputs: dict[str, str],
) -> ResumeResult:
    """Fills exactly the selectors present in `human_inputs`, using only the
    value supplied in *this* call -- never anything stored or resolved from
    profile/answer/document data. Any pending field whose selector isn't in
    `human_inputs` simply stays paused for a later call.

    Callers (see routers/automation.py) are responsible for only invoking
    this with selectors that were already vetted as `pending_fields` by a
    prior FormFiller.run() -- this function trusts the selector/field_type
    pairing it's given, so that check has to happen before this is called.
    """
    result = ResumeResult(status="awaiting_human_input")
    still_pending: list[FieldMapping] = []

    try:
        for field in pending_fields:
            if field.selector not in human_inputs:
                still_pending.append(field)
                continue

            value = human_inputs[field.selector]
            await browser.check_for_captcha()
            if field.field_type == "fill":
                await browser.fill_field(field.selector, value)
            elif field.field_type == "select":
                await browser.select_option(field.selector, value)
            elif field.field_type == "check":
                await browser.check_checkbox(field.selector, checked=value.lower() in ("true", "yes", "1"))
            elif field.field_type == "upload":
                await browser.upload_file(field.selector, value)

            result.filled_fields.append(field.label)
            shot = await browser.screenshot(application_id=application_id, step=f"human_filled_{field.label}")
            result.screenshots.append(str(shot))

        result.remaining_pending = still_pending
        if not still_pending:
            result.status = "awaiting_human_review"
            shot = await browser.screenshot(application_id=application_id, step="awaiting_human_review")
            result.screenshots.append(str(shot))

    except CaptchaEncounteredError as exc:
        result.status = "error"
        result.error = f"CAPTCHA detected mid-resume: {exc}"
        result.remaining_pending = pending_fields
    except Exception as exc:  # noqa: BLE001 -- surface any automation failure to the caller
        result.status = "error"
        result.error = str(exc)
        result.remaining_pending = pending_fields
        logger.exception("Resume-fill failed for application %s", application_id)

    return result
