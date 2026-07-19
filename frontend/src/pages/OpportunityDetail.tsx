import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import ProfileSelect from "../components/ProfileSelect";
import ScoreBadge from "../components/ScoreBadge";
import StatusBadge from "../components/StatusBadge";
import type { Opportunity, ScoreBreakdown } from "../types";

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

function ScoreBreakdownTable({ breakdown }: { breakdown: ScoreBreakdown }) {
  const rows = Object.entries(breakdown).filter(
    ([key, value]) => typeof value === "object" && value !== null && "points" in (value as object) && key !== "total",
  ) as [string, { ratio: number; weight: number; points: number; detail: string }][];

  if (rows.length === 0) return <p className="muted">No score breakdown available yet.</p>;

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Component</th>
          <th>Points</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key}>
            <td>{key.replace(/_/g, " ")}</td>
            <td>
              {value.points} / {value.weight}
            </td>
            <td className="muted">{value.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function OpportunityDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      setOpportunity(await api.getOpportunity(id));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load opportunity.");
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleStatusChange(status: string) {
    if (!id) return;
    try {
      setOpportunity(await api.updateOpportunityStatus(id, status));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to update status.");
    }
  }

  async function handleRescore() {
    if (!id || !selectedProfileId) return;
    setBusy(true);
    try {
      setError(null);
      setOpportunity(await api.rescoreOpportunity(id, selectedProfileId));
      setNotice("Rescored against the selected profile.");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to rescore.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateApplication() {
    if (!id || !selectedProfileId) return;
    setBusy(true);
    try {
      setError(null);
      const application = await api.createApplication(id, selectedProfileId, dryRun);
      navigate(`/applications/${application.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to create application.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    if (!window.confirm("Delete this opportunity? This cannot be undone.")) return;
    try {
      await api.deleteOpportunity(id);
      navigate("/opportunities");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to delete opportunity.");
    }
  }

  if (error && !opportunity) {
    return (
      <div className="page">
        <p className="error-text">{error}</p>
        <Link to="/opportunities">&larr; Back to opportunities</Link>
      </div>
    );
  }
  if (!opportunity) return <div className="page">Loading…</div>;

  const bestBreakdown = opportunity.score_breakdown?.best;

  return (
    <div className="page page-wide">
      <Link to="/opportunities">&larr; Back to opportunities</Link>
      <h1>{opportunity.title}</h1>
      <div className="meta-row">
        <StatusBadge status={opportunity.status} />
        <ScoreBadge score={opportunity.score} />
        <span className="muted">{opportunity.type}</span>
        <span className="muted">source: {opportunity.source}</span>
      </div>
      {notice && <p className="notice-text">{notice}</p>}
      {error && <p className="error-text">{error}</p>}

      <div className="detail-grid">
        <section className="detail-panel">
          <h2>Details</h2>
          <dl className="detail-list">
            <dt>Organization</dt>
            <dd>{opportunity.organization ?? "—"}</dd>
            <dt>Location</dt>
            <dd>
              {opportunity.location ?? "—"} {opportunity.remote ? "(remote)" : ""}
            </dd>
            <dt>Deadline</dt>
            <dd>{opportunity.deadline ? new Date(opportunity.deadline).toLocaleString() : "—"}</dd>
            <dt>Salary</dt>
            <dd>
              {opportunity.salary_min || opportunity.salary_max
                ? `${opportunity.salary_currency} ${opportunity.salary_min ?? "?"} – ${opportunity.salary_max ?? "?"}`
                : "—"}
            </dd>
            <dt>Award amount</dt>
            <dd>{opportunity.award_amount ? `${opportunity.salary_currency} ${opportunity.award_amount}` : "—"}</dd>
            <dt>Required documents</dt>
            <dd>{opportunity.required_documents.length ? opportunity.required_documents.join(", ") : "—"}</dd>
            <dt>Eligibility</dt>
            <dd>
              {Object.keys(opportunity.eligibility ?? {}).length
                ? JSON.stringify(opportunity.eligibility)
                : "not stated by source"}
            </dd>
            <dt>Source URL</dt>
            <dd>
              {opportunity.source_url ? (
                <a href={opportunity.source_url} target="_blank" rel="noreferrer">
                  {opportunity.source_url}
                </a>
              ) : (
                "—"
              )}
            </dd>
          </dl>

          {opportunity.missing_fields.length > 0 && (
            <div>
              {opportunity.missing_fields.map((f) => (
                <span key={f} className="missing-tag">
                  missing: {f}
                </span>
              ))}
            </div>
          )}

          <h3>Description</h3>
          <p className="description-text">{opportunity.description || "No description extracted."}</p>

          {opportunity.application_questions.length > 0 && (
            <>
              <h3>Application questions found in posting</h3>
              <ul>
                {opportunity.application_questions.map((q, i) => (
                  <li key={i}>{q.question}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="detail-panel">
          <h2>Actions</h2>
          <div className="form-grid">
            <label>
              Status
              <select value={opportunity.status} onChange={(e) => handleStatusChange(e.target.value)}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Profile
              <ProfileSelect value={selectedProfileId} onChange={setSelectedProfileId} includeEmptyOption="Select a profile…" />
            </label>
            <button type="button" disabled={!selectedProfileId || busy} onClick={handleRescore}>
              Rescore against this profile
            </button>
            <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              Dry run (recommended)
            </label>
            <button type="button" disabled={!selectedProfileId || busy} onClick={handleCreateApplication}>
              Create application for this profile
            </button>
            <button type="button" onClick={handleDelete} className="danger-button">
              Delete opportunity
            </button>
          </div>

          <h3>Score breakdown</h3>
          {bestBreakdown ? <ScoreBreakdownTable breakdown={bestBreakdown} /> : <p className="muted">Not scored yet.</p>}
        </section>
      </div>
    </div>
  );
}
