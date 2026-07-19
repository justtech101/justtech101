import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { IngestionSource } from "../types";

const EMPTY_FORM = { name: "", source_type: "rss", opportunity_type: "job", config: "{}" };

export default function IngestionSources() {
  const [sources, setSources] = useState<IngestionSource[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [webhookSecret, setWebhookSecret] = useState(() => localStorage.getItem("justtech_webhook_secret") ?? "");

  async function refresh() {
    try {
      setError(null);
      setSources(await api.listIngestionSources());
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load ingestion sources.");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function saveSecret(value: string) {
    setWebhookSecret(value);
    localStorage.setItem("justtech_webhook_secret", value);
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(form.config || "{}");
    } catch {
      setError("Config must be valid JSON, e.g. {\"url\": \"https://...\"}");
      return;
    }
    try {
      setError(null);
      await api.createIngestionSource({
        name: form.name,
        source_type: form.source_type,
        opportunity_type: form.opportunity_type,
        config,
        enabled: true,
      });
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to create source.");
    }
  }

  async function toggleEnabled(source: IngestionSource) {
    try {
      setError(null);
      await api.updateIngestionSource(source.id, { enabled: !source.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to update source.");
    }
  }

  async function deleteSource(id: string) {
    if (!window.confirm("Delete this ingestion source?")) return;
    try {
      setError(null);
      await api.deleteIngestionSource(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to delete source.");
    }
  }

  async function runNow(id: string) {
    if (!webhookSecret) {
      setError("Enter the server's N8N_WEBHOOK_SHARED_SECRET below first — the run endpoints require it.");
      return;
    }
    try {
      setError(null);
      setNotice(null);
      const result = await api.triggerIngestionRunOne(id, webhookSecret);
      setNotice(`Run complete: ${JSON.stringify(result)}`);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to run source.");
    }
  }

  async function runAll() {
    if (!webhookSecret) {
      setError("Enter the server's N8N_WEBHOOK_SHARED_SECRET below first — the run endpoints require it.");
      return;
    }
    try {
      setError(null);
      setNotice(null);
      const result = await api.triggerIngestionRunAll(webhookSecret);
      setNotice(`Run complete: ${JSON.stringify(result)}`);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to run sources.");
    }
  }

  return (
    <div className="page page-wide">
      <h1>Ingestion Sources</h1>
      <p className="page-subtitle">RSS feeds, public APIs, and email inboxes that feed the discovery pipeline.</p>

      <label>
        Server webhook secret (matches <code>N8N_WEBHOOK_SHARED_SECRET</code> in the backend's .env — required to trigger a run)
        <input type="password" value={webhookSecret} onChange={(e) => saveSecret(e.target.value)} style={{ maxWidth: 320 }} />
      </label>

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="notice-text">{notice}</p>}

      <div style={{ margin: "10px 0" }}>
        <button type="button" onClick={runAll}>
          Run all enabled sources now
        </button>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Source type</th>
            <th>Opportunity type</th>
            <th>Enabled</th>
            <th>Last run</th>
            <th>Last status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.source_type}</td>
              <td>{s.opportunity_type}</td>
              <td>
                <button type="button" onClick={() => toggleEnabled(s)}>
                  {s.enabled ? "enabled" : "disabled"}
                </button>
              </td>
              <td className="muted">{s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "never"}</td>
              <td className="muted" title={s.last_error ?? ""}>
                {s.last_status ?? "—"}
              </td>
              <td>
                <button type="button" onClick={() => runNow(s.id)}>
                  Run now
                </button>
                <button type="button" className="danger-button" onClick={() => deleteSource(s.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {sources.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No ingestion sources configured yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Add a source</h2>
      <form className="form-grid" onSubmit={handleCreate}>
        <label>
          Name
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="RemoteOK" />
        </label>
        <label>
          Source type
          <select value={form.source_type} onChange={(e) => setForm({ ...form, source_type: e.target.value })}>
            <option value="rss">rss</option>
            <option value="api">api</option>
            <option value="email">email</option>
          </select>
        </label>
        <label>
          Opportunity type
          <select value={form.opportunity_type} onChange={(e) => setForm({ ...form, opportunity_type: e.target.value })}>
            <option value="job">job</option>
            <option value="grant">grant</option>
          </select>
        </label>
        <label>
          Config (JSON)
          <textarea
            rows={3}
            value={form.config}
            onChange={(e) => setForm({ ...form, config: e.target.value })}
            placeholder='{"provider": "remoteok"}  or  {"url": "https://..."}'
          />
        </label>
        <p className="muted">
          Examples — RSS: <code>{"{\"url\": \"https://weworkremotely.com/categories/remote-programming-jobs.rss\"}"}</code>
          &nbsp;· RemoteOK: <code>{"{\"provider\": \"remoteok\"}"}</code> &nbsp;· Grants.gov:{" "}
          <code>{"{\"provider\": \"grants_gov\", \"keyword\": \"technology\"}"}</code>
        </p>
        <button type="submit">Create source</button>
      </form>
    </div>
  );
}
