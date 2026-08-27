"""
Unified Kanban-style dashboard across the opportunity discovery pipeline and
the downstream application pipeline. An opportunity lives in New /
Qualified / Missing Information until a human turns it into an
`Application`, at which point that application's status (Ready for Review /
Submitted / Rejected / Follow-up) becomes the opportunity's effective bucket
on the board.
"""
import uuid
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.application import Application
from app.models.opportunity import Opportunity
from app.services.scoring import CONTRACT_EMPLOYMENT_TYPES

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

OPPORTUNITY_BUCKETS = ["new", "qualified", "missing_info"]
APPLICATION_BUCKETS = ["ready_for_review", "submitted", "rejected", "follow_up"]
ALL_BUCKETS = OPPORTUNITY_BUCKETS + APPLICATION_BUCKETS


@router.get("/summary")
async def dashboard_summary(db: AsyncSession = Depends(get_db)) -> dict[str, int]:
    counts: dict[str, int] = {bucket: 0 for bucket in ALL_BUCKETS}

    opp_result = await db.execute(
        select(Opportunity.status, func.count()).where(Opportunity.status.in_(OPPORTUNITY_BUCKETS)).group_by(Opportunity.status)
    )
    for status, count in opp_result.all():
        counts[status] = count

    app_result = await db.execute(
        select(Application.status, func.count()).where(Application.status.in_(APPLICATION_BUCKETS)).group_by(Application.status)
    )
    for status, count in app_result.all():
        counts[status] = count

    return counts


@router.get("/board")
async def dashboard_board(profile_id: uuid.UUID | None = None, db: AsyncSession = Depends(get_db)) -> dict[str, list[dict[str, Any]]]:
    board: dict[str, list[dict[str, Any]]] = {bucket: [] for bucket in ALL_BUCKETS}

    opp_result = await db.execute(select(Opportunity).where(Opportunity.status.in_(OPPORTUNITY_BUCKETS)))
    for opp in opp_result.scalars().all():
        board[opp.status].append(_opportunity_card(opp))

    app_query = select(Application, Opportunity).join(Opportunity, Application.opportunity_id == Opportunity.id).where(
        Application.status.in_(APPLICATION_BUCKETS)
    )
    if profile_id:
        app_query = app_query.where(Application.profile_id == profile_id)
    app_result = await db.execute(app_query)
    for application, opportunity in app_result.all():
        card = _opportunity_card(opportunity)
        card["application_id"] = str(application.id)
        card["application_status"] = application.status
        card["dry_run"] = application.dry_run
        card["human_approved"] = application.human_approved
        card["submitted_at"] = application.submitted_at.isoformat() if application.submitted_at else None
        board[application.status].append(card)

    for bucket, cards in board.items():
        board[bucket] = sorted(cards, key=_fast_pay_sort_key)

    return board


def _pay_amount(opp: Opportunity) -> float | None:
    if opp.type == "job":
        value = opp.salary_max or opp.salary_min
    else:
        value = opp.award_amount
    return float(value) if value is not None else None


def _fast_pay_signals(opp: Opportunity) -> list[str]:
    signals: list[str] = []
    eligibility = opp.eligibility or {}
    emp = eligibility.get("employment_type")
    if emp and str(emp).lower() in CONTRACT_EMPLOYMENT_TYPES:
        signals.append(str(emp).lower())
    docs = opp.required_documents or []
    questions = opp.application_questions or []
    if len(docs) <= 1 and len(questions) <= 1:
        signals.append("fast apply")
    if opp.remote is True:
        signals.append("remote")
    return signals


def _opportunity_card(opp: Opportunity) -> dict[str, Any]:
    return {
        "opportunity_id": str(opp.id),
        "type": opp.type,
        "title": opp.title,
        "organization": opp.organization,
        "score": opp.score,
        "deadline": opp.deadline.isoformat() if opp.deadline else None,
        "missing_fields": opp.missing_fields,
        "source": opp.source,
        "status": opp.status,
        "salary_min": float(opp.salary_min) if opp.salary_min is not None else None,
        "salary_max": float(opp.salary_max) if opp.salary_max is not None else None,
        "salary_currency": opp.salary_currency or "USD",
        "award_amount": float(opp.award_amount) if opp.award_amount is not None else None,
        "employment_type": (opp.eligibility or {}).get("employment_type"),
        "fast_pay_signals": _fast_pay_signals(opp),
        "remote": opp.remote,
    }


def _fast_pay_sort_key(card: dict[str, Any]) -> tuple:
    """Highest score first, then highest stated pay — favors quick-income chase."""
    score = card.get("score")
    pay = card.get("salary_max") or card.get("salary_min") or card.get("award_amount") or 0
    return (-(score if score is not None else -1), -float(pay))
