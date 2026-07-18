from app.services import extraction


def test_extract_deadline_from_text():
    text = "This opportunity closes on March 15, 2026. Apply now."
    deadline = extraction.extract_deadline(text)
    assert deadline is not None
    assert deadline.year == 2026 and deadline.month == 3 and deadline.day == 15


def test_extract_deadline_returns_none_when_absent():
    assert extraction.extract_deadline("No dates mentioned here.") is None


def test_extract_salary_range():
    low, high = extraction.extract_salary_range("Compensation: $90,000 - $120,000 per year")
    assert low == 90000
    assert high == 120000


def test_extract_award_amount():
    amount = extraction.extract_award_amount("Award amount: $25,000 for selected recipients")
    assert amount == 25000


def test_extract_required_documents():
    text = "Please submit your resume and a cover letter along with a writing sample."
    docs = extraction.extract_required_documents(text)
    assert "resume" in docs
    assert "cover_letter" in docs
    assert "writing_sample" in docs


def test_extract_application_questions():
    text = "1. Why do you want this role?\n2. Describe your leadership experience?\nNot a question line."
    questions = extraction.extract_application_questions(text)
    assert len(questions) == 2
    assert questions[0]["question"].startswith("Why do you want")


def test_compute_missing_fields_flags_everything_absent():
    missing = extraction.compute_missing_fields(
        deadline=None, eligibility={}, required_documents=[], salary_or_award=None, description=None
    )
    assert set(missing) == {"deadline", "eligibility", "required_documents", "compensation_or_award_amount", "description"}
