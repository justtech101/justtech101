import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { AuditLogEntry } from "../types";

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      setEntries(await api.listAuditLog({ entity_type: entityType || undefined, entity_id: entityId || undefined, limit: 200 }));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load audit log.");
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="page page-wide">
      <h1>Audit Log</h1>
      <p className="page-subtitle">Every state-changing action, with actor and timestamp — nothing here is deletable.</p>

      <div className="filter-bar">
        <label>
          Entity type
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">All</option>
            <option value="opportunity">opportunity</option>
            <option value="application">application</option>
            <option value="profile">profile</option>
            <option value="credential">credential</option>
          </select>
        </label>
        <label>
          Entity ID
          <input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="uuid" style={{ width: 260 }} />
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
            <th>When</th>
            <th>Entity</th>
            <th>Event</th>
            <th>Actor</th>
            <th>Payload</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="muted">{new Date(e.created_at).toLocaleString()}</td>
              <td>
                {e.entity_type} <span className="muted">{e.entity_id.slice(0, 8)}…</span>
              </td>
              <td>{e.event_type}</td>
              <td>
                {e.actor_type}
                {e.actor ? ` (${e.actor})` : ""}
              </td>
              <td className="muted mono-cell">{Object.keys(e.payload).length ? JSON.stringify(e.payload) : "—"}</td>
            </tr>
          ))}
          {entries.length === 0 && !loading && (
            <tr>
              <td colSpan={5} className="muted">
                No audit entries match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
