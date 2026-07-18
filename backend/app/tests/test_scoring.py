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
