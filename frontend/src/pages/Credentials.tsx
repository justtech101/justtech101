import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import ProfileSelect from "../components/ProfileSelect";
import type { Credential } from "../types";

export default function Credentials() {
  const [profileId, setProfileId] = useState("");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [siteDomain, setSiteDomain] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh(pid: string) {
    if (!pid) {
      setCredentials([]);
      return;
    }
    try {
      setError(null);
      setCredentials(await api.listCredentials(pid));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load credentials.");
    }
  }

  useEffect(() => {
    refresh(profileId);
  }, [profileId]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!profileId) {
      setError("Select a profile first.");
      return;
    }
    try {
      setError(null);
      await api.createCredential({ profile_id: profileId, site_domain: siteDomain, username, secret });
      setSiteDomain("");
      setUsername("");
      setSecret("");
      setNotice("Credential encrypted and stored.");
      await refresh(profileId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to save credential.");
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this credential?")) return;
    try {
      setError(null);
      await api.deleteCredential(id);
      await refresh(profileId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to delete credential.");
    }
  }

  return (
    <div className="page">
      <h1>Site Credentials</h1>
      <p className="page-subtitle">
        Encrypted at rest with Fernet (<code>JUSTTECH_ENCRYPTION_KEY</code>). Secrets are never returned by the API once
        saved — only the site domain and timestamps are shown here.
      </p>

      <label>
        Profile
        <ProfileSelect value={profileId} onChange={setProfileId} includeEmptyOption="Select a profile…" />
      </label>

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="notice-text">{notice}</p>}

      {profileId && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Site domain</th>
                <th>Saved</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.id}>
                  <td>{c.site_domain}</td>
                  <td className="muted">{new Date(c.created_at).toLocaleString()}</td>
                  <td>
                    <button type="button" className="danger-button" onClick={() => handleDelete(c.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {credentials.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    No credentials saved for this profile yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h2>Add a credential</h2>
          <form className="form-grid" onSubmit={handleCreate}>
            <label>
              Site domain
              <input required value={siteDomain} onChange={(e) => setSiteDomain(e.target.value)} placeholder="myworkday.com" />
            </label>
            <label>
              Username
              <input required value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label>
              Password / secret
              <input required type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
            <button type="submit">Save (encrypted)</button>
          </form>
        </>
      )}
    </div>
  );
}
