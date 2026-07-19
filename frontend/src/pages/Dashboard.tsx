import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import OpportunityCard from "../components/OpportunityCard";
import ProfileSelect from "../components/ProfileSelect";
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
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getBoard(profileId || undefined);
      setBoard(data);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to reach the backend API.");
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div>
      <div className="dashboard-toolbar">
        <label>
          Filter applications by profile
          <ProfileSelect value={profileId} onChange={setProfileId} includeEmptyOption="All profiles" />
        </label>
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </div>
      <div style={{ padding: "0 20px" }}>
        {error && <p className="error-text">{error} — is the backend running at the URL in VITE_API_BASE_URL?</p>}
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
