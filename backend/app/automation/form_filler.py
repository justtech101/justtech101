"""
Orchestrates a Playwright browser-fill run for a single application.

Hard safety rules enforced here (not just documented -- actually enforced in
code):
  1. Refuses to run at all unless `application.human_approved` is True.
  2. Any field whose label matches STOP_FIELD_PATTERNS (attestations,
     signatures, SSNs, legal certifications, CAPTCHA-adjacent fields) is
     never filled -- it's recorded as `stopped_fields` for a human to handle.
  3. Never clicks a submit/finalize button. There is no code path in this
     module that does so, by construction -- `field_map` entries are only
     ever `fill`/`select`/`check`/`upload`, and the run always ends by
     handing control back to a human via the `awaiting_human_review` status.
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

# Any field label matching these patterns is NEVER auto-filled, regardless
# of whether an answer exists for it. Case-insensitive substring/regex match.
STOP_FIELD_PATTERNS = [
    r"\bsignature\b",
    r"\bi\s+(certify|attest|swear|affirm)\b",
    r"\bunder penalty of perjury\b",
    r"\blegal(ly)?\s+(binding|attestation)\b",
    r"\bsocial security\b",
    r"\bssn\b",
    r"\bdate of birth\b",
    r"\bcaptcha\b",
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
    status: Literal["awaiting_human_review", "stopped_captcha", "error"]
    filled_fields: list[str] = dataclasses.field(default_factory=list)
    missing_fields: list[str] = dataclasses.field(default_factory=list)
    stopped_fields: list[str] = dataclasses.field(default_factory=list)
    screenshots: list[str] = dataclasses.field(default_factory=list)
    error: str | None = None


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
                if _STOP_PATTERN.search(field.label):
                    result.stopped_fields.append(field.label)
                    shot = await browser.screenshot(
                        application_id=str(application.id), step=f"stopped_{field.label}"
                    )
                    result.screenshots.append(str(shot))
                    logger.info("Stopped at sensitive/legal field: %s", field.label)
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
        finally:
            await browser.close()

        return result
