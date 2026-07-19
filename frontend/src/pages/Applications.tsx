import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import ProfileSelect from "../components/ProfileSelect";
import StatusBadge from "../components/StatusBadge";
import type { Application } from "../types";

const STATUS_OPTIONS = ["new", "qualified", "missing_info", "ready_for_review", "submitted", "rejected", "follow_up"];

export default function Applications() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [status, setStatus] = useState("");
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      setApplications(await api.listApplications({ status: status || undefined, profile_id: profileId || undefined }));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load applications.");
    } finally {
      setLoading(false);
    }
  }, [status, profileId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="page page-wide">
      <h1>Applications</h1>
      <p className="page-subtitle">Every opportunity a profile has started applying to.</p>

      <div className="filter-bar">
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
          Profile
          <ProfileSelect value={profileId} onChange={setProfileId} includeEmptyOption="All profiles" />
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
            <th>Application</th>
            <th>Status</th>
            <th>Dry run</th>
            <th>Approved</th>
            <th>Submitted</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((a) => (
            <tr key={a.id}>
              <td>
                <Link to={`/applications/${a.id}`}>{a.id.slice(0, 8)}…</Link>
              </td>
              <td>
                <StatusBadge status={a.status} />
              </td>
              <td>{a.dry_run ? "yes" : "no"}</td>
              <td>{a.human_approved ? `yes (${a.human_approved_by})` : "no"}</td>
              <td>{a.submitted_at ? new Date(a.submitted_at).toLocaleString() : "—"}</td>
              <td className="muted">{new Date(a.updated_at).toLocaleString()}</td>
            </tr>
          ))}
          {applications.length === 0 && !loading && (
            <tr>
              <td colSpan={6} className="muted">
                No applications match these filters yet. Start one from an opportunity's detail page.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
