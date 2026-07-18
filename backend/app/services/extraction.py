"""
Field extraction from raw posting text. This module ONLY extracts facts that
are literally present in the source text via pattern matching -- it never
guesses or fills in values that aren't there. Anything not found stays
`None` (or an empty list/dict) and is surfaced later as a "missing field" so
a human can fill it in, per the project's "never invent facts" requirement.
"""
import re
from datetime import datetime

DATE_PATTERNS = [
    # "Deadline: March 15, 2026" / "Applications due 3/15/2026"
    (re.compile(r"(?:deadline|due date|due by|closes?(?: on)?|applications? close)\s*[:\-]?\s*"
                r"([A-Za-z]+ \d{1,2},? \d{4})", re.IGNORECASE), "%B %d, %Y"),
    (re.compile(r"(?:deadline|due date|due by|closes?(?: on)?|applications? close)\s*[:\-]?\s*"
                r"(\d{1,2}/\d{1,2}/\d{4})", re.IGNORECASE), "%m/%d/%Y"),
    (re.compile(r"(?:deadline|due date|due by|closes?(?: on)?|applications? close)\s*[:\-]?\s*"
                r"(\d{4}-\d{2}-\d{2})", re.IGNORECASE), "%Y-%m-%d"),
]

SALARY_RANGE_PATTERN = re.compile(
    r"\$\s?([\d,]+)(?:k|,000)?\s*(?:-|to|–)\s*\$?\s?([\d,]+)(?:k|,000)?", re.IGNORECASE
)
SALARY_SINGLE_PATTERN = re.compile(r"\$\s?([\d,]+)(?:k)?\b")
AWARD_PATTERN = re.compile(
    r"(?:award amount|award|grant amount|funding amount|up to)\s*[:\-]?\s*\$\s?([\d,]+)", re.IGNORECASE
)

REQUIRED_DOC_KEYWORDS = {
    "resume": ["resume", "cv", "curriculum vitae"],
    "cover_letter": ["cover letter"],
    "transcript": ["transcript"],
    "budget_narrative": ["budget narrative", "budget justification"],
    "letters_of_recommendation": ["letter of recommendation", "letters of recommendation", "reference letter"],
    "writing_sample": ["writing sample"],
    "proof_of_501c3": ["501(c)(3)", "501c3", "irs determination letter"],
    "portfolio": ["portfolio", "work samples"],
}

QUESTION_LINE_PATTERN = re.compile(r"^\s*(?:\d+[\).]|\-|\*|Q[:\.])\s*(.+\?)\s*$", re.MULTILINE)


def extract_deadline(text: str) -> datetime | None:
    if not text:
        return None
    for pattern, fmt in DATE_PATTERNS:
        match = pattern.search(text)
        if match:
            raw = match.group(1).replace(",", "")
            try:
                return datetime.strptime(raw, fmt.replace(",", ""))
            except ValueError:
                continue
    return None


def extract_salary_range(text: str) -> tuple[float | None, float | None]:
    if not text:
        return None, None
    match = SALARY_RANGE_PATTERN.search(text)
    if match:
        low = float(match.group(1).replace(",", ""))
        high = float(match.group(2).replace(",", ""))
        if "k" in match.group(0).lower():
            low, high = low * 1000, high * 1000
        return low, high
    single = SALARY_SINGLE_PATTERN.search(text)
    if single:
        value = float(single.group(1).replace(",", ""))
        if "k" in single.group(0).lower():
            value *= 1000
        return value, value
    return None, None


def extract_award_amount(text: str) -> float | None:
    if not text:
        return None
    match = AWARD_PATTERN.search(text)
    if match:
        return float(match.group(1).replace(",", ""))
    return None


def extract_required_documents(text: str) -> list[str]:
    if not text:
        return []
    lowered = text.lower()
    found = []
    for doc_type, keywords in REQUIRED_DOC_KEYWORDS.items():
        if any(kw in lowered for kw in keywords):
            found.append(doc_type)
    return found


def extract_application_questions(text: str) -> list[dict]:
    """Pulls explicit question lines (numbered/bulleted lines ending in '?')
    out of a posting body -- used for narrative-heavy grant RFPs that list
    required essay questions inline."""
    if not text:
        return []
    matches = QUESTION_LINE_PATTERN.findall(text)
    return [{"question": q.strip(), "required": True, "answer_type": "text"} for q in matches]


def compute_missing_fields(*, deadline, eligibility: dict, required_documents: list, salary_or_award, description: str | None) -> list[str]:
    missing = []
    if deadline is None:
        missing.append("deadline")
    if not eligibility:
        missing.append("eligibility")
    if not required_documents:
        missing.append("required_documents")
    if salary_or_award is None:
        missing.append("compensation_or_award_amount")
    if not description:
        missing.append("description")
    return missing
