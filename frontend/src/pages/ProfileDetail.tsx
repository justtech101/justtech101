import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import ChipInput from "../components/ChipInput";
import KeyValueEditor from "../components/KeyValueEditor";
import type { EducationEntry, Profile, ReusableAnswer, WorkHistoryEntry } from "../types";

export default function ProfileDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [answers, setAnswers] = useState<ReusableAnswer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [newQuestion, setNewQuestion] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newVerified, setNewVerified] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const [p, a] = await Promise.all([api.getProfile(id), api.listReusableAnswers(id)]);
      setProfile(p);
      setAnswers(a);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load profile.");
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function patchProfile(patch: Partial<Profile>) {
    setProfile((p) => (p ? { ...p, ...patch } : p));
  }

  async function handleSave() {
    if (!id || !profile) return;
    setSaving(true);
    try {
      setError(null);
      await api.updateProfile(id, {
        display_name: profile.display_name,
        full_name: profile.full_name,
        email: profile.email,
        phone: profile.phone,
        address: profile.address,
        links: profile.links,
        skills: profile.skills,
        education: profile.education,
        work_history: profile.work_history,
        eligibility: profile.eligibility,
        preferences: profile.preferences,
        is_active: profile.is_active,
      });
      setNotice("Profile saved.");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    if (!window.confirm("Delete this profile? Applications tied to it will also be removed.")) return;
    try {
      await api.deleteProfile(id);
      navigate("/profiles");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to delete profile.");
    }
  }

  function updateEducation(index: number, patch: Partial<EducationEntry>) {
    patchProfile({ education: (profile?.education ?? []).map((e, i) => (i === index ? { ...e, ...patch } : e)) });
  }
  function removeEducation(index: number) {
    patchProfile({ education: (profile?.education ?? []).filter((_, i) => i !== index) });
  }
  function addEducation() {
    patchProfile({ education: [...(profile?.education ?? []), {}] });
  }

  function updateWorkHistory(index: number, patch: Partial<WorkHistoryEntry>) {
    patchProfile({ work_history: (profile?.work_history ?? []).map((w, i) => (i === index ? { ...w, ...patch } : w)) });
  }
  function removeWorkHistory(index: number) {
    patchProfile({ work_history: (profile?.work_history ?? []).filter((_, i) => i !== index) });
  }
  function addWorkHistory() {
    patchProfile({ work_history: [...(profile?.work_history ?? []), {}] });
  }

  async function handleAddAnswer() {
    if (!id || !newQuestion.trim() || !newAnswer.trim()) return;
    try {
      setError(null);
      await api.upsertReusableAnswer(id, {
        question_text: newQuestion.trim(),
        answer_text: newAnswer.trim(),
        category: newCategory.trim() || undefined,
        verified: newVerified,
      });
      setNewQuestion("");
      setNewAnswer("");
      setNewCategory("");
      setNewVerified(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to save answer.");
    }
  }

  async function handleDeleteAnswer(answerId: string) {
    if (!id) return;
    try {
      await api.deleteReusableAnswer(id, answerId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to delete answer.");
    }
  }

  if (error && !profile) {
    return (
      <div className="page">
        <p className="error-text">{error}</p>
        <Link to="/profiles">&larr; Back to profiles</Link>
      </div>
    );
  }
  if (!profile) return <div className="page">Loading…</div>;

  return (
    <div className="page page-wide">
      <Link to="/profiles">&larr; Back to profiles</Link>
      <h1>{profile.display_name}</h1>
      {notice && <p className="notice-text">{notice}</p>}
      {error && <p className="error-text">{error}</p>}

      <div className="detail-grid">
        <section className="detail-panel">
          <h2>Basics</h2>
          <div className="form-grid">
            <label>
              Display name
              <input value={profile.display_name} onChange={(e) => patchProfile({ display_name: e.target.value })} />
            </label>
            <label>
              Full legal name
              <input value={profile.full_name} onChange={(e) => patchProfile({ full_name: e.target.value })} />
            </label>
            <label>
              Email
              <input type="email" value={profile.email} onChange={(e) => patchProfile({ email: e.target.value })} />
            </label>
            <label>
              Phone
              <input value={profile.phone ?? ""} onChange={(e) => patchProfile({ phone: e.target.value })} />
            </label>
            <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={profile.is_active} onChange={(e) => patchProfile({ is_active: e.target.checked })} />
              Active (used for automatic scoring on new opportunities)
            </label>
          </div>

          <h3>Skills</h3>
          <ChipInput values={profile.skills} onChange={(skills) => patchProfile({ skills })} placeholder="e.g. python" />

          <h3>Address</h3>
          <KeyValueEditor values={profile.address as Record<string, string>} onChange={(address) => patchProfile({ address })} />

          <h3>Links</h3>
          <KeyValueEditor values={profile.links as Record<string, string>} onChange={(links) => patchProfile({ links })} />
        </section>

        <section className="detail-panel">
          <h2>Scoring inputs</h2>
          <p className="muted">These directly drive the eligibility-match and compensation-fit portions of the 0-100 score.</p>
          <h3>Eligibility (e.g. work_authorization, org_type, 501c3)</h3>
          <KeyValueEditor
            values={profile.eligibility as Record<string, string>}
            onChange={(eligibility) => patchProfile({ eligibility })}
          />
          <h3>Preferences (e.g. min_salary, min_award, mission_statement)</h3>
          <KeyValueEditor
            values={profile.preferences as Record<string, string>}
            onChange={(preferences) => patchProfile({ preferences })}
          />
        </section>

        <section className="detail-panel detail-panel-wide">
          <h2>Work history</h2>
          {profile.work_history.map((w, i) => (
            <div className="entry-card" key={i}>
              <div className="form-grid form-grid-inline">
                <input placeholder="Employer" value={w.employer ?? ""} onChange={(e) => updateWorkHistory(i, { employer: e.target.value })} />
                <input placeholder="Title" value={w.title ?? ""} onChange={(e) => updateWorkHistory(i, { title: e.target.value })} />
                <input placeholder="Start (e.g. 2021)" value={w.start ?? ""} onChange={(e) => updateWorkHistory(i, { start: e.target.value })} />
                <input placeholder="End (e.g. present)" value={w.end ?? ""} onChange={(e) => updateWorkHistory(i, { end: e.target.value })} />
              </div>
              <textarea
                placeholder="Summary of responsibilities / achievements"
                value={w.summary ?? ""}
                onChange={(e) => updateWorkHistory(i, { summary: e.target.value })}
                rows={2}
              />
              <button type="button" className="danger-button" onClick={() => removeWorkHistory(i)}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addWorkHistory}>
            + Add role
          </button>
        </section>

        <section className="detail-panel detail-panel-wide">
          <h2>Education</h2>
          {profile.education.map((e, i) => (
            <div className="entry-card" key={i}>
              <div className="form-grid form-grid-inline">
                <input placeholder="School" value={e.school ?? ""} onChange={(ev) => updateEducation(i, { school: ev.target.value })} />
                <input placeholder="Degree" value={e.degree ?? ""} onChange={(ev) => updateEducation(i, { degree: ev.target.value })} />
                <input placeholder="Field" value={e.field ?? ""} onChange={(ev) => updateEducation(i, { field: ev.target.value })} />
                <input placeholder="Start" value={e.start ?? ""} onChange={(ev) => updateEducation(i, { start: ev.target.value })} />
                <input placeholder="End" value={e.end ?? ""} onChange={(ev) => updateEducation(i, { end: ev.target.value })} />
              </div>
              <button type="button" className="danger-button" onClick={() => removeEducation(i)}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addEducation}>
            + Add education
          </button>
        </section>

        <section className="detail-panel detail-panel-wide">
          <h2>Save changes</h2>
          <button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save profile"}
          </button>
          <button type="button" className="danger-button" onClick={handleDelete} style={{ marginLeft: 8 }}>
            Delete profile
          </button>
        </section>

        <section className="detail-panel detail-panel-wide">
          <h2>Verified reusable answers</h2>
          <p className="muted">
            Only answers marked verified are eligible for browser auto-fill via <code>answer:&lt;question_hash&gt;</code>.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Question</th>
                <th>Answer</th>
                <th>Category</th>
                <th>Verified</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {answers.map((a) => (
                <tr key={a.id}>
                  <td>{a.question_text}</td>
                  <td>{a.answer_text}</td>
                  <td className="muted">{a.category ?? "—"}</td>
                  <td>{a.verified ? "✅" : "—"}</td>
                  <td>
                    <button type="button" className="danger-button" onClick={() => handleDeleteAnswer(a.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {answers.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No reusable answers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h3>Add an answer</h3>
          <div className="form-grid">
            <label>
              Question
              <input value={newQuestion} onChange={(e) => setNewQuestion(e.target.value)} placeholder="Are you authorized to work in the US?" />
            </label>
            <label>
              Answer
              <input value={newAnswer} onChange={(e) => setNewAnswer(e.target.value)} placeholder="Yes" />
            </label>
            <label>
              Category
              <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="work_auth" />
            </label>
            <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={newVerified} onChange={(e) => setNewVerified(e.target.checked)} />
              Verified (safe to auto-fill)
            </label>
            <button type="button" onClick={handleAddAnswer}>
              Save answer
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
