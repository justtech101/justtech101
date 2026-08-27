"""
Rule-based 0-100 scoring engine. Deliberately not an LLM call: scores must be
explainable and reproducible, so every point awarded is traceable in
`score_breakdown`. Weights sum to 100 and can be tuned per-deployment via the
WEIGHTS dict below.

Fast-pay bias: compensation above the profile floor and lean/contract-style
postings earn more points so urgent income seekers see cash-relevant roles first.
"""
from datetime import datetime, timezone
from typing import Any

from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile

WEIGHTS = {
    "skill_match": 30,
    "eligibility_match": 20,
    "deadline_urgency": 12,
    "compensation_fit": 22,
    "speed_to_cash": 10,
    "data_completeness": 6,
}

CONTRACT_EMPLOYMENT_TYPES = {
    "contract",
    "contractor",
    "temp",
    "temporary",
    "freelance",
    "freelancer",
    "hourly",
    "gig",
    "contract-to-hire",
    "c2h",
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
    ratio = len(matched) / len(profile_skills)
    detail = f"matched {len(matched)}/{len(profile_skills)} profile skills in posting text: {sorted(matched) or 'none'}"
    return ratio, detail


def _score_eligibility_match(opportunity: Opportunity, profile: ApplicantProfile) -> tuple[float, str]:
    required = opportunity.eligibility or {}
    # employment_type is a soft signal for speed_to_cash, not a hard gate
    required = {k: v for k, v in required.items() if k != "employment_type"}
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
    """Reward pay that clears the floor, and reward pay that clears it by a lot."""
    preferences = profile.preferences or {}
    min_expected = preferences.get("min_salary") if opportunity.type == "job" else preferences.get("min_award")

    value = opportunity.salary_max or opportunity.salary_min if opportunity.type == "job" else opportunity.award_amount
    if value is None:
        return 0.5, "no compensation/award amount stated by source -- neutral score"
    if min_expected is None:
        return 0.75, f"posting states {value}; no profile minimum set to compare against"

    value_f = float(value)
    min_f = float(min_expected)
    if value_f < min_f:
        return 0.2, f"{value} is below profile minimum of {min_expected}"

    ratio_to_min = value_f / min_f if min_f else 1.0
    if ratio_to_min >= 1.5:
        return 1.0, f"{value} is {ratio_to_min:.2f}x profile minimum of {min_expected} -- strong pay"
    if ratio_to_min >= 1.25:
        return 0.9, f"{value} is {ratio_to_min:.2f}x profile minimum of {min_expected}"
    if ratio_to_min >= 1.1:
        return 0.8, f"{value} modestly exceeds profile minimum of {min_expected}"
    return 0.7, f"{value} meets profile minimum of {min_expected}"


def _employment_type(opportunity: Opportunity) -> str | None:
    eligibility = opportunity.eligibility or {}
    raw = eligibility.get("employment_type")
    if raw is None:
        return None
    if isinstance(raw, (list, tuple)):
        return str(raw[0]).strip().lower() if raw else None
    return str(raw).strip().lower() or None


def _score_speed_to_cash(opportunity: Opportunity, profile: ApplicantProfile) -> tuple[float, str]:
    """Lean applications + contract/temp tags = faster path to a paycheck."""
    docs = opportunity.required_documents or []
    questions = opportunity.application_questions or []
    doc_count = len(docs)
    question_count = len(questions)

    if doc_count <= 1 and question_count <= 1:
        lean_ratio = 1.0
        lean_detail = "lean application (≤1 doc, ≤1 question)"
    elif doc_count <= 2 and question_count <= 3:
        lean_ratio = 0.75
        lean_detail = "moderately lean application"
    elif doc_count <= 4 and question_count <= 6:
        lean_ratio = 0.45
        lean_detail = "average application burden"
    else:
        lean_ratio = 0.2
        lean_detail = "heavy application packet -- slower to cash"

    emp = _employment_type(opportunity)
    preferences = profile.preferences or {}
    prefer_contract = bool(preferences.get("prefer_contract"))

    if emp and emp in CONTRACT_EMPLOYMENT_TYPES:
        contract_ratio = 1.0 if prefer_contract else 0.85
        contract_detail = f"employment_type={emp} (faster-pay style)"
    elif emp:
        contract_ratio = 0.55
        contract_detail = f"employment_type={emp}"
    else:
        contract_ratio = 0.55
        contract_detail = "no employment_type tagged"

    remote_ratio = 0.7
    remote_detail = "on-site / unknown"
    if opportunity.remote is True:
        remote_ratio = 0.9
        remote_detail = "remote -- fewer start-date blockers"
    elif opportunity.remote is False:
        remote_ratio = 0.45
        remote_detail = "on-site"

    # Weighted blend inside the speed factor
    ratio = lean_ratio * 0.5 + contract_ratio * 0.35 + remote_ratio * 0.15
    detail = f"{lean_detail}; {contract_detail}; {remote_detail}"
    return ratio, detail


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
        "speed_to_cash": _score_speed_to_cash(opportunity, profile),
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
