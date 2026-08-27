from datetime import datetime, timedelta, timezone

from app.models.opportunity import Opportunity
from app.models.profile import ApplicantProfile
from app.services.scoring import score_opportunity


def make_profile(**overrides) -> ApplicantProfile:
    defaults = dict(
        display_name="Jane Doe",
        full_name="Jane Doe",
        email="jane@example.com",
        skills=["python", "fastapi", "postgresql"],
        eligibility={"work_authorization": "us_citizen"},
        preferences={"min_salary": 90000},
    )
    defaults.update(overrides)
    return ApplicantProfile(**defaults)


def make_opportunity(**overrides) -> Opportunity:
    defaults = dict(
        type="job",
        source="test",
        content_hash="abc123",
        title="Senior Python Engineer",
        organization="Acme Corp",
        description="Looking for a Python and FastAPI expert to build our postgresql-backed API.",
        eligibility={"work_authorization": "us_citizen"},
        salary_min=100000,
        salary_max=130000,
        deadline=datetime.now(timezone.utc) + timedelta(days=10),
        required_documents=["resume"],
        application_questions=[],
        remote=True,
    )
    defaults.update(overrides)
    return Opportunity(**defaults)


def test_strong_match_scores_high():
    profile = make_profile()
    opportunity = make_opportunity()
    score, breakdown = score_opportunity(opportunity, profile)
    assert score >= 70
    assert breakdown["total"] == score
    assert breakdown["skill_match"]["ratio"] > 0.5
    assert "speed_to_cash" in breakdown


def test_score_is_between_0_and_100():
    profile = make_profile(skills=[], eligibility={}, preferences={})
    opportunity = make_opportunity(description=None, eligibility={}, deadline=None, salary_min=None, salary_max=None, required_documents=[])
    score, _ = score_opportunity(opportunity, profile)
    assert 0 <= score <= 100


def test_past_deadline_penalizes_score():
    profile = make_profile()
    fresh = make_opportunity(deadline=datetime.now(timezone.utc) + timedelta(days=10))
    expired = make_opportunity(deadline=datetime.now(timezone.utc) - timedelta(days=5))

    fresh_score, _ = score_opportunity(fresh, profile)
    expired_score, _ = score_opportunity(expired, profile)
    assert expired_score < fresh_score


def test_below_minimum_salary_lowers_compensation_score():
    profile = make_profile(preferences={"min_salary": 150000})
    opportunity = make_opportunity(salary_min=60000, salary_max=70000)
    _, breakdown = score_opportunity(opportunity, profile)
    assert breakdown["compensation_fit"]["ratio"] < 0.5


def test_higher_pay_beats_floor_pay():
    profile = make_profile(preferences={"min_salary": 100000})
    floor = make_opportunity(salary_min=100000, salary_max=100000)
    premium = make_opportunity(salary_min=160000, salary_max=180000)

    _, floor_breakdown = score_opportunity(floor, profile)
    _, premium_breakdown = score_opportunity(premium, profile)
    assert premium_breakdown["compensation_fit"]["ratio"] > floor_breakdown["compensation_fit"]["ratio"]


def test_contract_lean_posting_boosts_speed_to_cash():
    profile = make_profile(preferences={"min_salary": 90000, "prefer_contract": True})
    heavy = make_opportunity(
        eligibility={"work_authorization": "us_citizen"},
        required_documents=["resume", "cover_letter", "transcript", "portfolio", "writing_sample"],
        application_questions=[{"question": q} for q in ["a?", "b?", "c?", "d?", "e?", "f?", "g?"]],
        remote=False,
    )
    fast = make_opportunity(
        eligibility={"work_authorization": "us_citizen", "employment_type": "contract"},
        required_documents=["resume"],
        application_questions=[],
        remote=True,
    )

    _, heavy_breakdown = score_opportunity(heavy, profile)
    _, fast_breakdown = score_opportunity(fast, profile)
    assert fast_breakdown["speed_to_cash"]["ratio"] > heavy_breakdown["speed_to_cash"]["ratio"]


def test_employment_type_not_required_for_eligibility_gate():
    profile = make_profile(eligibility={"work_authorization": "us_citizen"})
    opportunity = make_opportunity(eligibility={"employment_type": "contract"})
    _, breakdown = score_opportunity(opportunity, profile)
    assert breakdown["eligibility_match"]["ratio"] == 1.0
