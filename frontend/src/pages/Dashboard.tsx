import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import OpportunityCard from "../components/OpportunityCard";
import type { Board, BoardBucket } from "../types";

const BUCKETS: { key: BoardBucket; label: string }[] = [
  { key: "new", label: "New" },
  { key: "qualified", label: "Qualified" },
  { key: "missing_info", label: "Missing Information" },
  { key: "ready_for_review", label: "Ready for Review" },
  { key: "submitted", label: "Submitted" },
  { key: "rejected", label: "Rejected" },
  { key: "follow_up", label: "Follow-up" },
];

const EMPTY_BOARD: Board = {
  new: [],
  qualified: [],
  missing_info: [],
  ready_for_review: [],
  submitted: [],
  rejected: [],
  follow_up: [],
};

export default function Dashboard() {
  const [board, setBoard] = useState<Board>(EMPTY_BOARD);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getBoard();
      setBoard(data);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to reach the backend API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div>
      <div style={{ padding: "0 20px" }}>
        {error && (
          <p style={{ color: "#ae2e24" }}>
            {error} — is the backend running at the URL in VITE_API_BASE_URL?
          </p>
        )}
        {loading && !error && <p>Loading…</p>}
      </div>
      <div className="board">
        {BUCKETS.map(({ key, label }) => (
          <section className="board-column" key={key}>
            <h2>
              {label} <span className="count">({board[key]?.length ?? 0})</span>
            </h2>
            <div className="card-list">
              {(board[key] ?? []).map((card) => (
                <OpportunityCard key={card.application_id ?? card.opportunity_id} card={card} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
