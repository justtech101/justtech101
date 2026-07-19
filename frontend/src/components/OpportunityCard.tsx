import { Link } from "react-router-dom";
import type { BoardCard } from "../types";
import ScoreBadge from "./ScoreBadge";

export default function OpportunityCard({ card }: { card: BoardCard }) {
  const linkTo = card.application_id ? `/applications/${card.application_id}` : `/opportunities/${card.opportunity_id}`;

  return (
    <Link to={linkTo} className="opportunity-card">
      <h3>{card.title}</h3>
      <div className="meta">
        {card.organization ?? "Unknown org"} &middot; {card.type}
        {card.deadline ? ` · due ${new Date(card.deadline).toLocaleDateString()}` : ""}
      </div>
      <ScoreBadge score={card.score} />
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
