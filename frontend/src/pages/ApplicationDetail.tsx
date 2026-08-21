import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, storageUrl } from "../api/client";
import StatusBadge from "../components/StatusBadge";
import type {
  Application,
  DocType,
  DraftResponse,
  FieldMapping,
  FillResponse,
  Opportunity,
  PendingField,
  Profile,
  Screenshot,
} from "../types";

const STATUS_OPTIONS = ["new", "qualified", "missing_info", "ready_for_review", "submitted", "rejected", "follow_up"];
const CONFIRMATION_PHRASE = "I confirm I have manually submitted this application";

function emptyFieldRow(): FieldMapping {
  return { selector: "", label: "", field_type: "fill", value_source: "" };
}

export default function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [application, setApplication] = useState<Application | null>(null);
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [draftType, setDraftType] = useState<DocType>("cover_letter");
  const [draftResult, setDraftResult] = useState<DraftResponse | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);

  const [approvedBy, setApprovedBy] = useState("");
  const [approveBusy, setApproveBusy] = useState(false);

  const [fieldMap, setFieldMap] = useState<FieldMapping[]>([emptyFieldRow()]);
  const [fillResult, setFillResult] = useState<FillResponse | null>(null);
  const [fillBusy, setFillBusy] = useState(false);
  // Live-only values for whatever's currently paused (password/attestation/
  // etc.) -- typed here, sent once, never stored. Cleared right after use.
  const [humanInputDrafts, setHumanInputDrafts] = useState<Record<string, string>>({});
  const [resumeBusy, setResumeBusy] = useState(false);

  const [confirmedBy, setConfirmedBy] = useState("");
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const [notes, setNotes] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const app = await api.getApplication(id);
      setApplication(app);
      setNotes(app.notes ?? "");
      const [opp, prof, shots] = await Promise.all([
        api.getOpportunity(app.opportunity_id),
        api.getProfile(app.profile_id),
        api.listScreenshots(app.id),
      ]);
      setOpportunity(opp);
      setProfile(prof);
      setScreenshots(shots);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load application.");
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleDraft() {
    if (!id) return;
    setDraftBusy(true);
    try {
      setError(null);
      const result = await api.draftDocument(id, draftType, true);
      setDraftResult(result);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to generate draft.");
    } finally {
      setDraftBusy(false);
    }
  }

  async function handleApprove() {
    if (!id || !approvedBy.trim()) return;
    setApproveBusy(true);
    try {
      setError(null);
      await api.approveApplication(id, approvedBy.trim());
      setNotice("Approved. Automation may now run against this application.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to approve.");
    } finally {
      setApproveBusy(false);
    }
  }

  function updateFieldRow(index: number, patch: Partial<FieldMapping>) {
    setFieldMap((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function removeFieldRow(index: number) {
    setFieldMap((rows) => rows.filter((_, i) => i !== index));
  }

  async function handleFill() {
    if (!id) return;
    setFillBusy(true);
    try {
      setError(null);
      setHumanInputDrafts({});
      const usableRows = fieldMap.filter((r) => r.selector.trim() && r.label.trim() && r.value_source.trim());
      const result = await api.fillApplication(id, usableRows, true);
      setFillResult(result);
      const shots = await api.listScreenshots(id);
      setScreenshots(shots);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to run form fill.");
    } finally {
      setFillBusy(false);
    }
  }

  // Sends whatever's currently typed for the paused fields, right now, to
  // fill exactly those fields on the still-open browser page. Nothing here
  // is stored -- humanInputDrafts is cleared the instant this succeeds.
  async function handleResumeFill() {
    if (!id || !fillResult) return;
    const inputs = fillResult.pending_fields
      .filter((f) => (humanInputDrafts[f.selector] ?? "").length > 0)
      .map((f) => ({ selector: f.selector, value: humanInputDrafts[f.selector] }));
    if (inputs.length === 0) return;

    setResumeBusy(true);
    try {
      setError(null);
      const result = await api.resumeFill(id, inputs);
      setFillResult(result);
      setHumanInputDrafts({});
      const shots = await api.listScreenshots(id);
      setScreenshots(shots);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to submit the live value(s).");
    } finally {
      setResumeBusy(false);
    }
  }

  function isPasswordLikeField(field: PendingField): boolean {
    return /password|ssn|social security|account number|routing number/i.test(field.label);
  }

  async function handleConfirmSubmitted() {
    if (!id || !confirmedBy.trim() || !confirmChecked) return;
    setConfirmBusy(true);
    try {
      setError(null);
      await api.confirmSubmitted(id, confirmedBy.trim());
      setNotice("Marked as submitted.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to confirm submission.");
    } finally {
      setConfirmBusy(false);
    }
  }

  async function handleStatusChange(status: string) {
    if (!id) return;
    try {
      setError(null);
      await api.updateApplication(id, { status: status as Application["status"] });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to update status.");
    }
  }

  async function handleSaveNotes() {
    if (!id) return;
    setNotesBusy(true);
    try {
      setError(null);
      await api.updateApplication(id, { notes });
      setNotice("Notes saved.");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to save notes.");
    } finally {
      setNotesBusy(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    if (!window.confirm("Delete this application? This cannot be undone.")) return;
    try {
      await api.deleteApplication(id);
      navigate("/applications");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to delete application.");
    }
  }

  if (error && !application) {
    return (
      <div className="page">
        <p className="error-text">{error}</p>
        <Link to="/applications">&larr; Back to applications</Link>
      </div>
    );
  }
  if (!application || !opportunity || !profile) return <div className="page">Loading…</div>;

  return (
    <div className="page page-wide">
      <Link to="/applications">&larr; Back to applications</Link>
      <h1>
        {opportunity.title} <span className="muted">for {profile.display_name}</span>
      </h1>
      <div className="meta-row">
        <StatusBadge status={application.status} />
        <span className="dry-run-tag">{application.dry_run ? "dry run" : "live"}</span>
        <span className={`dry-run-tag ${application.human_approved ? "approved-tag" : ""}`}>
          {application.human_approved ? `approved by ${application.human_approved_by}` : "not yet approved"}
        </span>
        <Link to={`/opportunities/${opportunity.id}`}>View opportunity &rarr;</Link>
      </div>
      {notice && <p className="notice-text">{notice}</p>}
      {error && <p className="error-text">{error}</p>}
      {application.missing_fields.length > 0 && (
        <div>
          {application.missing_fields.map((f) => (
            <span key={f} className="missing-tag">
              missing: {f}
            </span>
          ))}
        </div>
      )}

      <div className="detail-grid">
        {/* ---- Draft documents ---- */}
        <section className="detail-panel">
          <h2>1. Draft documents</h2>
          <p className="muted">
            Generated from verified profile data only. Anything the profile is missing comes back as a gap instead of being
            invented.
          </p>
          <div className="form-grid">
            <label>
              Document type
              <select value={draftType} onChange={(e) => setDraftType(e.target.value as DocType)}>
                <option value="cover_letter">Cover letter</option>
                <option value="resume">Resume summary</option>
                <option value="grant_narrative">Grant narrative</option>
              </select>
            </label>
            <button type="button" onClick={handleDraft} disabled={draftBusy}>
              {draftBusy ? "Generating…" : "Generate draft"}
            </button>
          </div>
          {draftResult && (
            <>
              <textarea readOnly rows={10} value={draftResult.document_text} className="draft-preview" />
              {draftResult.missing_fields.length > 0 && (
                <div>
                  {draftResult.missing_fields.map((f) => (
                    <span key={f} className="missing-tag">
                      gap: {f}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        {/* ---- Human review + approval ---- */}
        <section className="detail-panel">
          <h2>2. Human review &amp; approval</h2>
          <p className="muted">
            Required before any browser automation can run. Approving is blocked while <code>missing_fields</code> is non-empty.
          </p>
          {application.human_approved ? (
            <p>
              ✅ Approved by <strong>{application.human_approved_by}</strong> at{" "}
              {application.human_approved_at ? new Date(application.human_approved_at).toLocaleString() : ""}
            </p>
          ) : (
            <div className="form-grid">
              <label>
                Your name
                <input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} placeholder="e.g. Jane Doe" />
              </label>
              <button
                type="button"
                onClick={handleApprove}
                disabled={approveBusy || !approvedBy.trim() || application.missing_fields.length > 0}
              >
                Approve for automation
              </button>
              {application.missing_fields.length > 0 && (
                <p className="error-text">Resolve missing fields before approving.</p>
              )}
            </div>
          )}
        </section>

        {/* ---- Browser form fill ---- */}
        <section className="detail-panel detail-panel-wide">
          <h2>3. Browser form fill (Playwright)</h2>
          <p className="muted">
            Never fills attestation/signature/SSN/CAPTCHA-adjacent fields, never clicks submit, and stops immediately if a
            CAPTCHA is detected. Requires approval above. Map each form field to a data source:{" "}
            <code>profile.email</code>, <code>profile.full_name</code>, <code>document:resume</code>,{" "}
            <code>document:cover_letter</code>, or <code>answer:&lt;question_hash&gt;</code>.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>CSS selector</th>
                <th>Label (used for the safety-stop check)</th>
                <th>Type</th>
                <th>Value source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {fieldMap.map((row, i) => (
                <tr key={i}>
                  <td>
                    <input value={row.selector} onChange={(e) => updateFieldRow(i, { selector: e.target.value })} placeholder="#email" />
                  </td>
                  <td>
                    <input
                      value={row.label}
                      onChange={(e) => updateFieldRow(i, { label: e.target.value })}
                      placeholder="Email address"
                    />
                  </td>
                  <td>
                    <select value={row.field_type} onChange={(e) => updateFieldRow(i, { field_type: e.target.value as FieldMapping["field_type"] })}>
                      <option value="fill">fill</option>
                      <option value="select">select</option>
                      <option value="check">check</option>
                      <option value="upload">upload</option>
                    </select>
                  </td>
                  <td>
                    <input
                      value={row.value_source}
                      onChange={(e) => updateFieldRow(i, { value_source: e.target.value })}
                      placeholder="profile.email"
                    />
                  </td>
                  <td>
                    <button type="button" className="danger-button" onClick={() => removeFieldRow(i)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => setFieldMap((rows) => [...rows, emptyFieldRow()])}>
            + Add field
          </button>
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={handleFill} disabled={fillBusy || !application.human_approved}>
              {fillBusy ? "Running…" : "Run form fill"}
            </button>
            {!application.human_approved && <span className="muted"> Approve the application first.</span>}
          </div>

          {fillResult && (
            <div className="fill-result">
              <p>
                Result: <strong>{fillResult.status}</strong>
                {fillResult.error && <span className="error-text"> — {fillResult.error}</span>}
              </p>
              {fillResult.filled_fields.length > 0 && <p>Filled: {fillResult.filled_fields.join(", ")}</p>}
              {fillResult.stopped_fields.length > 0 && (
                <p>
                  🛑 Stopped (never auto-filled): <strong>{fillResult.stopped_fields.join(", ")}</strong>
                </p>
              )}
              {fillResult.missing_fields.length > 0 && <p>No value found for: {fillResult.missing_fields.join(", ")}</p>}
            </div>
          )}

          {fillResult?.status === "awaiting_human_input" && fillResult.pending_fields.length > 0 && (
            <div className="human-input-panel">
              <h3>🔒 Live input needed — nothing here is stored</h3>
              <p className="muted">
                These fields were never auto-filled (see the screenshots below for exactly where things stand). Type or check
                a value here and it's used once, immediately, to fill that field on the page that's still open — it's
                discarded right after, never saved to a profile or reused later.
              </p>
              {fillResult.pending_fields.map((f) => (
                <div className="form-grid" key={f.selector}>
                  <label>
                    {f.label} <span className="muted">({f.selector})</span>
                    {f.field_type === "check" ? (
                      <select
                        value={humanInputDrafts[f.selector] ?? ""}
                        onChange={(e) => setHumanInputDrafts((d) => ({ ...d, [f.selector]: e.target.value }))}
                      >
                        <option value="">— choose —</option>
                        <option value="true">Check it (yes)</option>
                        <option value="false">Leave unchecked (no)</option>
                      </select>
                    ) : (
                      <input
                        type={isPasswordLikeField(f) ? "password" : "text"}
                        value={humanInputDrafts[f.selector] ?? ""}
                        onChange={(e) => setHumanInputDrafts((d) => ({ ...d, [f.selector]: e.target.value }))}
                        autoComplete="off"
                      />
                    )}
                  </label>
                </div>
              ))}
              <button type="button" onClick={handleResumeFill} disabled={resumeBusy}>
                {resumeBusy ? "Continuing…" : "Continue securely"}
              </button>
            </div>
          )}

          {screenshots.length > 0 && (
            <>
              <h3>Screenshots</h3>
              <div className="screenshot-grid">
                {screenshots.map((s) => (
                  <figure key={s.id}>
                    <a href={storageUrl(s.file_path)} target="_blank" rel="noreferrer">
                      <img src={storageUrl(s.file_path)} alt={s.step} />
                    </a>
                    <figcaption>{s.step}</figcaption>
                  </figure>
                ))}
              </div>
            </>
          )}
        </section>

        {/* ---- Confirm submitted ---- */}
        <section className="detail-panel">
          <h2>4. Confirm submission</h2>
          <p className="muted">
            This never submits the form for you. Review the filled-in form on the real site yourself, click submit there, then
            confirm it here.
          </p>
          {application.submitted_at ? (
            <p>✅ Submitted at {new Date(application.submitted_at).toLocaleString()}</p>
          ) : (
            <div className="form-grid">
              <label>
                Your name
                <input value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} />
              </label>
              <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} />
                {CONFIRMATION_PHRASE}
              </label>
              <button
                type="button"
                onClick={handleConfirmSubmitted}
                disabled={confirmBusy || !confirmedBy.trim() || !confirmChecked || !application.human_approved}
              >
                Confirm submitted
              </button>
            </div>
          )}
        </section>

        {/* ---- Tracking ---- */}
        <section className="detail-panel">
          <h2>Tracking</h2>
          <div className="form-grid">
            <label>
              Status
              <select value={application.status} onChange={(e) => handleStatusChange(e.target.value)}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Notes
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <button type="button" onClick={handleSaveNotes} disabled={notesBusy}>
              Save notes
            </button>
            <button type="button" className="danger-button" onClick={handleDelete}>
              Delete application
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
