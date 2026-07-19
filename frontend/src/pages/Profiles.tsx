import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Profile } from "../types";

const EMPTY_FORM = { display_name: "", full_name: "", email: "", phone: "" };

export default function Profiles() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function refresh() {
    try {
      setError(null);
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
      setError(null);
      const created = await api.createProfile({
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
      navigate(`/profiles/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to create profile.");
    }
  }

  return (
    <div className="page">
      <h1>Applicant Profiles</h1>
      <p className="page-subtitle">
        Multiple applicants can be tracked side by side. Click a profile to add skills, eligibility, work history, and
        verified reusable answers — all of which drive scoring, drafting, and auto-fill.
      </p>
      {error && <p className="error-text">{error}</p>}

      <ul className="profile-list">
        {profiles.map((p) => (
          <li key={p.id}>
            <Link to={`/profiles/${p.id}`}>
              <strong>{p.display_name}</strong> — {p.email} {p.is_active ? "" : "(inactive)"}
            </Link>
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
