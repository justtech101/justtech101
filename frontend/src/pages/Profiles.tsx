import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Profile } from "../types";

const EMPTY_FORM = { display_name: "", full_name: "", email: "", phone: "" };

export default function Profiles() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setProfiles(await api.listProfiles());
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load profiles.");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      await api.createProfile({
        ...form,
        skills: [],
        education: [],
        work_history: [],
        eligibility: {},
        preferences: {},
        address: {},
        links: {},
      });
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to create profile.");
    }
  }

  return (
    <div className="page">
      <h1>Applicant Profiles</h1>
      {error && <p style={{ color: "#ae2e24" }}>{error}</p>}

      <ul className="profile-list">
        {profiles.map((p) => (
          <li key={p.id}>
            <strong>{p.display_name}</strong> — {p.email} {p.is_active ? "" : "(inactive)"}
          </li>
        ))}
        {profiles.length === 0 && <li>No profiles yet — add one below.</li>}
      </ul>

      <h2>Add a profile</h2>
      <form className="form-grid" onSubmit={handleSubmit}>
        <label>
          Display name
          <input
            required
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
          />
        </label>
        <label>
          Full legal name
          <input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </label>
        <label>
          Email
          <input
            required
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label>
          Phone
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
        <button type="submit">Create profile</button>
      </form>
    </div>
  );
}
