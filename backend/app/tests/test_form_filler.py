from app.automation.form_filler import _STOP_PATTERN, resolve_value
from app.models.profile import ApplicantProfile


def test_stop_pattern_matches_attestation_language():
    assert _STOP_PATTERN.search("I certify that the information above is true")
    assert _STOP_PATTERN.search("Signature")
    assert _STOP_PATTERN.search("Social Security Number")
    assert _STOP_PATTERN.search("I agree to the Terms and Conditions")
    assert _STOP_PATTERN.search("Please complete the CAPTCHA below")


def test_stop_pattern_does_not_match_normal_fields():
    assert not _STOP_PATTERN.search("First name")
    assert not _STOP_PATTERN.search("Email address")
    assert not _STOP_PATTERN.search("Years of experience")


def test_resolve_value_from_profile_path():
    profile = ApplicantProfile(display_name="Jane", full_name="Jane Doe", email="jane@example.com", phone="555-1234")
    value = resolve_value("profile.phone", profile=profile, answers={}, resume_path=None, cover_letter_path=None)
    assert value == "555-1234"


def test_resolve_value_from_answers():
    profile = ApplicantProfile(display_name="Jane", full_name="Jane Doe", email="jane@example.com")
    value = resolve_value(
        "answer:abc123", profile=profile, answers={"abc123": "Yes, authorized to work in the US"},
        resume_path=None, cover_letter_path=None,
    )
    assert value == "Yes, authorized to work in the US"


def test_resolve_value_missing_returns_none():
    profile = ApplicantProfile(display_name="Jane", full_name="Jane Doe", email="jane@example.com")
    value = resolve_value("profile.nonexistent_field", profile=profile, answers={}, resume_path=None, cover_letter_path=None)
    assert value is None
