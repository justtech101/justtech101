"""
Rule-based 0-100 scoring engine. Deliberately not an LLM call: scores must be
explainable and reproducible, so every point awarded is traceable in
`score_breakdown`. Weights sum to 100 and can be tuned per-deployment via the
WEIGHTS dict below.
"""
from datetime import datetime, timezone
from typing import Any

from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile

WEIGHTS = {
    "skill_match": 35,
    "eligibility_match": 25,
    "deadline_urgency": 15,
    "compensation_fit": 15,
    "data_completeness": 10,
}


def _normalize_tokens(values: list[str]) -> set[str]:
    return {v.strip().lower() for v in values if v and v.strip()}


def _score_skill_match(opportunity: Opportunity, profile: ApplicantProfile) -> tuple[float, str]:
    profile_skills = _normalize_tokens(profile.skills or [])
    if not profile_skills:
        return 0.0, "profile has no skills listed"

    haystack = " ".join(
        filter(None, [opportunity.title, opportunity.description, opportunity.organization])
    ).lower()
    matched = {skill for skill in profile_skills if skill in haystack}
    if not profile_skills:
        ratio = 0.0
    else:
        ratio = len(matched) / len(profile_skills)
    detail = f"matched {len(matched)}/{len(profile_skills)} profile skills in posting text: {sorted(matched) or 'none'}"
    return ratio, detail


def _score_eligibility_match(opportunity: Opportunity, profile: ApplicantProfile) -> tuple[float, str]:
    required = opportunity.eligibility or {}
    if not required:
        return 1.0, "no eligibility requirements stated by source"

    profile_elig = profile.eligibility or {}
    total = 0
    met = 0
    unmet_keys: list[str] = []
    for key, required_value in required.items():
        total += 1
        profile_value = profile_elig.get(key)
        if profile_value is None:
            unmet_keys.append(key)
            continue
        if isinstance(required_value, bool):
            if profile_value == required_value:
                met += 1
            else:
                unmet_keys.append(key)
        elif isinstance(required_value, (list, tuple)):
            if profile_value in required_value:
                met += 1
            else:
                unmet_keys.append(key)
        else:
            if str(profile_value).lower() == str(required_value).lower():
                met += 1
            else:
                unmet_keys.append(key)

    ratio = met / total if total else 1.0
    detail = f"met {met}/{total} eligibility criteria" + (f"; unmet: {unmet_keys}" if unmet_keys else "")
    return ratio, detail


def _score_deadline_urgency(opportunity: Opportunity) -> tuple[float, str]:
    if not opportunity.deadline:
        return 0.5, "no deadline provided -- neutral score"

    now = datetime.now(timezone.utc)
    deadline = opportunity.deadline
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)

    days_remaining = (deadline - now).total_seconds() / 86400
    if days_remaining < 0:
        return 0.0, "deadline has already passed"
    if days_remaining <= 3:
        return 0.4, f"deadline in {days_remaining:.1f} days -- very tight turnaround"
    if days_remaining <= 14:
        return 1.0, f"deadline in {days_remaining:.1f} days -- comfortable, actionable window"
    if days_remaining <= 45:
        return 0.85, f"deadline in {days_remaining:.1f} days"
    return 0.6, f"deadline in {days_remaining:.1f} days -- far out, lower priority for now"


def _score_compensation_fit(opportunity: Opportunity, profile: ApplicantProfile) -> tuple[float, str]:
    preferences = profile.preferences or {}
    min_expected = preferences.get("min_salary") if opportunity.type == "job" else preferences.get("min_award")

    value = opportunity.salary_max or opportunity.salary_min if opportunity.type == "job" else opportunity.award_amount
    if value is None:
        return 0.5, "no compensation/award amount stated by source -- neutral score"
    if min_expected is None:
        return 0.75, f"posting states {value}; no profile minimum set to compare against"

    if float(value) >= float(min_expected):
        return 1.0, f"{value} meets or exceeds profile minimum of {min_expected}"
    return 0.2, f"{value} is below profile minimum of {min_expected}"


def _score_data_completeness(opportunity: Opportunity) -> tuple[float, str]:
    fields = [
        opportunity.deadline,
        opportunity.description,
        opportunity.required_documents,
        opportunity.application_questions,
        opportunity.eligibility,
        (opportunity.salary_min or opportunity.salary_max or opportunity.award_amount),
    ]
    present = sum(1 for f in fields if f)
    ratio = present / len(fields)
    return ratio, f"{present}/{len(fields)} key fields present from source"


def score_opportunity(opportunity: Opportunity, profile: ApplicantProfile) -> tuple[int, dict[str, Any]]:
    """Returns (score 0-100, score_breakdown dict) -- never mutates inputs."""
    components = {
        "skill_match": _score_skill_match(opportunity, profile),
        "eligibility_match": _score_eligibility_match(opportunity, profile),
        "deadline_urgency": _score_deadline_urgency(opportunity),
        "compensation_fit": _score_compensation_fit(opportunity, profile),
        "data_completeness": _score_data_completeness(opportunity),
    }

    breakdown: dict[str, Any] = {}
    total = 0.0
    for key, (ratio, detail) in components.items():
        weight = WEIGHTS[key]
        points = round(ratio * weight, 1)
        total += points
        breakdown[key] = {"ratio": round(ratio, 2), "weight": weight, "points": points, "detail": detail}

    final_score = max(0, min(100, round(total)))
    breakdown["total"] = final_score
    breakdown["profile_id"] = str(profile.id)
    return final_score, breakdown
