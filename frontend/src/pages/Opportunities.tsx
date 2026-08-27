import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import ScoreBadge from "../components/ScoreBadge";
import StatusBadge from "../components/StatusBadge";
import type { Opportunity } from "../types";

const STATUS_OPTIONS = [
  "new",
  "qualified",
  "missing_info",
  "ready_for_review",
  "submitted",
  "rejected",
  "follow_up",
  "duplicate",
  "archived",
];

export default function Opportunities() {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [minScore, setMinScore] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const data = await api.listOpportunities({
        type: type || undefined,
        status: status || undefined,
        min_score: minScore ? Number(minScore) : undefined,
      });
      setOpportunities(data);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load opportunities.");
    } finally {
      setLoading(false);
    }
  }, [type, status, minScore]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="page page-wide">
      <h1>Opportunities</h1>
      <p className="page-subtitle">Everything discovered by ingestion sources or pushed in via webhook.</p>

      <div className="filter-bar">
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            <option value="job">Job</option>
            <option value="grant">Grant</option>
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Min score
          <input
            type="number"
            min={0}
            max={100}
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            style={{ width: 70 }}
          />
        </label>
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && !error && <p>Loading…</p>}

      <table className="data-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Organization</th>
            <th>Type</th>
            <th>Pay</th>
            <th>Score</th>
            <th>Status</th>
            <th>Deadline</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o) => {
            const pay =
              o.type === "grant"
                ? o.award_amount
                : o.salary_max ?? o.salary_min;
            const payLabel =
              pay == null
                ? "—"
                : new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: o.salary_currency || "USD",
                    maximumFractionDigits: 0,
                  }).format(pay);
            const emp = o.eligibility?.employment_type;
            return (
              <tr key={o.id}>
                <td>
                  <Link to={`/opportunities/${o.id}`}>{o.title}</Link>
                  {typeof emp === "string" && (
                    <span className="fast-pay-tag" style={{ marginLeft: 8 }}>
                      {emp}
                    </span>
                  )}
                </td>
                <td>{o.organization ?? "—"}</td>
                <td>{o.type}</td>
                <td>{payLabel}</td>
                <td>
                  <ScoreBadge score={o.score} />
                </td>
                <td>
                  <StatusBadge status={o.status} />
                </td>
                <td>{o.deadline ? new Date(o.deadline).toLocaleDateString() : "—"}</td>
                <td className="muted">{o.source}</td>
              </tr>
            );
          })}
          {opportunities.length === 0 && !loading && (
            <tr>
              <td colSpan={8} className="muted">
                No opportunities match these filters yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
