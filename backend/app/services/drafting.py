"""
Drafting service: generates resumes, cover letters, and grant narratives
from VERIFIED profile data only. Phase 1 ships a deterministic,
template-based `Drafter` (no LLM call, no invented facts -- every sentence
traces back to a specific profile field). The `Drafter` protocol is the
integration seam for a future LLM-backed implementation (Phase 2+); swap the
implementation passed into the router without touching callers.

Anything the profile doesn't have is listed in `missing_fields` on the
returned `DraftResult` instead of being invented.
"""
from dataclasses import dataclass, field
from typing import Protocol

from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile


@dataclass
class DraftResult:
    document_text: str
    missing_fields: list[str] = field(default_factory=list)


class Drafter(Protocol):
    def draft_cover_letter(self, opportunity: Opportunity, profile: ApplicantProfile) -> DraftResult: ...
    def draft_resume_summary(self, opportunity: Opportunity, profile: ApplicantProfile) -> DraftResult: ...
    def draft_grant_narrative(self, opportunity: Opportunity, profile: ApplicantProfile) -> DraftResult: ...


class TemplateDrafter:
    """Fills fixed templates with verified profile fields only."""

    def draft_cover_letter(self, opportunity: Opportunity, profile: ApplicantProfile) -> DraftResult:
        missing = []
        top_skills = (profile.skills or [])[:5]
        if not top_skills:
            missing.append("profile.skills")
        recent_role = (profile.work_history or [None])[0]
        if not recent_role:
            missing.append("profile.work_history")

        role_line = ""
        if recent_role:
            role_line = f"Most recently, I worked as {recent_role.get('title', '(title missing)')} at {recent_role.get('employer', '(employer missing)')}, where {recent_role.get('summary', '(summary missing -- add to profile)')}\n\n"
        else:
            missing.append("recent_role_summary")

        body = (
            f"Dear Hiring Team at {opportunity.organization or '[organization -- not provided by posting]'},\n\n"
            f"I am writing to apply for the {opportunity.title} position"
            f"{f' at {opportunity.organization}' if opportunity.organization else ''}. "
            f"My background includes {', '.join(top_skills) if top_skills else '[skills -- add to profile]'}.\n\n"
            f"{role_line}"
            f"I would welcome the opportunity to discuss how my experience aligns with this role.\n\n"
            f"Sincerely,\n{profile.full_name}\n"
        )
        return DraftResult(document_text=body, missing_fields=missing)

    def draft_resume_summary(self, opportunity: Opportunity, profile: ApplicantProfile) -> DraftResult:
        missing = []
        if not profile.work_history:
            missing.append("profile.work_history")
        if not profile.education:
            missing.append("profile.education")
        if not profile.skills:
            missing.append("profile.skills")

        lines = [f"{profile.full_name}", f"{profile.email}" + (f" | {profile.phone}" if profile.phone else "")]
        lines.append("")
        lines.append("SKILLS: " + (", ".join(profile.skills) if profile.skills else "[add skills to profile]"))
        lines.append("")
        lines.append("EXPERIENCE:")
        for role in profile.work_history or []:
            lines.append(
                f"- {role.get('title', '[title]')} at {role.get('employer', '[employer]')} "
                f"({role.get('start', '?')}–{role.get('end', 'present')})"
            )
            if role.get("summary"):
                lines.append(f"    {role['summary']}")
        lines.append("")
        lines.append("EDUCATION:")
        for ed in profile.education or []:
            lines.append(f"- {ed.get('degree', '[degree]')}, {ed.get('field', '[field]')} — {ed.get('school', '[school]')}")

        return DraftResult(document_text="\n".join(lines), missing_fields=missing)

    def draft_grant_narrative(self, opportunity: Opportunity, profile: ApplicantProfile) -> DraftResult:
        missing = []
        org_type = (profile.eligibility or {}).get("org_type")
        if not org_type:
            missing.append("profile.eligibility.org_type")
        mission = (profile.preferences or {}).get("mission_statement")
        if not mission:
            missing.append("profile.preferences.mission_statement")

        questions = opportunity.application_questions or []
        if not questions:
            missing.append("opportunity.application_questions (none found in posting -- verify manually)")

        sections = [
            f"Grant Narrative — {opportunity.title}",
            f"Applicant organization: {profile.display_name}"
            + (f" ({org_type})" if org_type else " [organization type not on profile]"),
            "",
            "Statement of need: " + (mission or "[mission statement not on profile -- add before submitting]"),
            "",
        ]
        for q in questions:
            sections.append(f"Q: {q.get('question')}")
            sections.append("A: [DRAFT PLACEHOLDER -- requires a verified reusable answer or manual response]")
            sections.append("")

        return DraftResult(document_text="\n".join(sections), missing_fields=missing)


default_drafter: Drafter = TemplateDrafter()
