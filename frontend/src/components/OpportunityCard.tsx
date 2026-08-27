import { Link } from "react-router-dom";
import type { BoardCard } from "../types";
import ScoreBadge from "./ScoreBadge";

function formatPay(card: BoardCard): string | null {
  const currency = card.salary_currency || "USD";
  const format = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(n);

  if (card.type === "grant" && card.award_amount != null) {
    return format(card.award_amount);
  }
  if (card.salary_min != null && card.salary_max != null && card.salary_min !== card.salary_max) {
    return `${format(card.salary_min)}–${format(card.salary_max)}`;
  }
  const single = card.salary_max ?? card.salary_min;
  if (single != null) {
    return format(single);
  }
  return null;
}

export default function OpportunityCard({ card }: { card: BoardCard }) {
  const linkTo = card.application_id ? `/applications/${card.application_id}` : `/opportunities/${card.opportunity_id}`;
  const pay = formatPay(card);
  const signals = card.fast_pay_signals ?? [];

  return (
    <Link to={linkTo} className="opportunity-card">
      <h3>{card.title}</h3>
      <div className="meta">
        {card.organization ?? "Unknown org"} &middot; {card.type}
        {card.deadline ? ` · due ${new Date(card.deadline).toLocaleDateString()}` : ""}
      </div>
      {pay && <div className="pay-line">{pay}</div>}
      <ScoreBadge score={card.score} />
      {signals.map((signal) => (
        <span key={signal} className="fast-pay-tag">
          {signal}
        </span>
      ))}
      {card.dry_run !== undefined && (
        <span className="dry-run-tag" style={{ marginLeft: 6 }}>
          {card.dry_run ? "dry run" : "live"}
        </span>
      )}
      {card.human_approved !== undefined && (
        <span className={`dry-run-tag ${card.human_approved ? "approved-tag" : ""}`} style={{ marginLeft: 6 }}>
          {card.human_approved ? "approved" : "pending review"}
        </span>
      )}
      <div>
        {card.missing_fields.map((field) => (
          <span key={field} className="missing-tag">
            missing: {field}
          </span>
        ))}
      </div>
    </Link>
  );
}
