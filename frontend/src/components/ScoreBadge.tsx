function scoreClass(score: number | null): string {
  if (score === null) return "score-mid";
  if (score >= 70) return "score-high";
  if (score >= 40) return "score-mid";
  return "score-low";
}

export default function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="badge badge-neutral">unscored</span>;
  return <span className={`score-badge ${scoreClass(score)}`}>{score}/100</span>;
}
