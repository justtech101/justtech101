import type { BoardCard } from "../types";

function scoreClass(score: number | null): string {
  if (score === null) return "score-mid";
  if (score >= 70) return "score-high";
  if (score >= 40) return "score-mid";
  return "score-low";
}

export default function OpportunityCard({ card }: { card: BoardCard }) {
  return (
    <div className="opportunity-card">
      <h3>{card.title}</h3>
      <div className="meta">
        {card.organization ?? "Unknown org"} &middot; {card.type}
        {card.deadline ? ` · due ${new Date(card.deadline).toLocaleDateString()}` : ""}
      </div>
      {card.score !== null && (
        <span className={`score-badge ${scoreClass(card.score)}`}>{card.score}/100</span>
      )}
      {card.dry_run !== undefined && (
        <span className="dry-run-tag" style={{ marginLeft: 6 }}>
          {card.dry_run ? "dry run" : "live"}
        </span>
      )}
      <div>
        {card.missing_fields.map((field) => (
          <span key={field} className="missing-tag">
            missing: {field}
          </span>
        ))}
      </div>
    </div>
  );
}
