import type {
  Application,
  ApplicationStatus,
  AuditLogEntry,
  BillingStatus,
  Board,
  CheckoutSession,
  Credential,
  DocType,
  DraftResponse,
  FieldMapping,
  FillResponse,
  HumanInput,
  IngestionSource,
  Opportunity,
  Profile,
  ReusableAnswer,
  Screenshot,
} from "../types";

// REQUIRED: set VITE_API_BASE_URL in frontend/.env (see .env.example)
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    let message = body || response.statusText;
    try {
      const parsed = JSON.parse(body);
      message = parsed.detail ? (typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail)) : message;
    } catch {
      // body wasn't JSON, use raw text
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const usable = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]),
  );
  const qs = new URLSearchParams(usable).toString();
  return qs ? `?${qs}` : "";
}

/** Builds a browsable URL for a file_path returned by the backend (screenshots, generated documents). */
export function storageUrl(filePath: string): string {
  const cleaned = filePath.replace(/^\.?\/*/, "");
  return `${API_BASE_URL}/${cleaned}`;
}

export const api = {
  // --- Dashboard ---------------------------------------------------------
  getBoard: (profileId?: string) => request<Board>(`/api/dashboard/board${query({ profile_id: profileId })}`),
  getSummary: () => request<Record<string, number>>("/api/dashboard/summary"),

  // --- Profiles ------------------------------------------------------------
  listProfiles: (activeOnly = false) => request<Profile[]>(`/api/profiles${query({ active_only: activeOnly || undefined })}`),
  getProfile: (id: string) => request<Profile>(`/api/profiles/${id}`),
  createProfile: (payload: Record<string, unknown>) =>
    request<Profile>("/api/profiles", { method: "POST", body: JSON.stringify(payload) }),
  updateProfile: (id: string, payload: Record<string, unknown>) =>
    request<Profile>(`/api/profiles/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteProfile: (id: string) => request<void>(`/api/profiles/${id}`, { method: "DELETE" }),

  listReusableAnswers: (profileId: string) => request<ReusableAnswer[]>(`/api/profiles/${profileId}/answers`),
  upsertReusableAnswer: (
    profileId: string,
    payload: { question_text: string; answer_text: string; category?: string; verified: boolean },
  ) => request<ReusableAnswer>(`/api/profiles/${profileId}/answers`, { method: "POST", body: JSON.stringify(payload) }),
  deleteReusableAnswer: (profileId: string, answerId: string) =>
    request<void>(`/api/profiles/${profileId}/answers/${answerId}`, { method: "DELETE" }),

  // --- Opportunities -------------------------------------------------------
  listOpportunities: (params: { type?: string; status?: string; min_score?: number } = {}) =>
    request<Opportunity[]>(`/api/opportunities${query(params)}`),
  getOpportunity: (id: string) => request<Opportunity>(`/api/opportunities/${id}`),
  updateOpportunityStatus: (id: string, status: string) =>
    request<Opportunity>(`/api/opportunities/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  rescoreOpportunity: (id: string, profileId: string) =>
    request<Opportunity>(`/api/opportunities/${id}/score`, { method: "POST", body: JSON.stringify({ profile_id: profileId }) }),
  deleteOpportunity: (id: string) => request<void>(`/api/opportunities/${id}`, { method: "DELETE" }),

  // --- Applications ----------------------------------------------------------
  listApplications: (params: { status?: string; profile_id?: string } = {}) =>
    request<Application[]>(`/api/applications${query(params)}`),
  getApplication: (id: string) => request<Application>(`/api/applications/${id}`),
  createApplication: (opportunityId: string, profileId: string, dryRun = true) =>
    request<Application>(`/api/applications`, {
      method: "POST",
      body: JSON.stringify({ opportunity_id: opportunityId, profile_id: profileId, dry_run: dryRun }),
    }),
  updateApplication: (
    id: string,
    payload: Partial<{ status: ApplicationStatus; notes: string; rejected_reason: string; follow_up_date: string }>,
  ) => request<Application>(`/api/applications/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  approveApplication: (applicationId: string, approvedBy: string) =>
    request<Application>(`/api/applications/${applicationId}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved_by: approvedBy }),
    }),
  confirmSubmitted: (applicationId: string, confirmedBy: string) =>
    request<Application>(`/api/applications/${applicationId}/confirm-submitted`, {
      method: "POST",
      body: JSON.stringify({
        confirmed_by: confirmedBy,
        confirmation_phrase: "I confirm I have manually submitted this application",
      }),
    }),
  deleteApplication: (id: string) => request<void>(`/api/applications/${id}`, { method: "DELETE" }),
  listScreenshots: (applicationId: string) => request<Screenshot[]>(`/api/applications/${applicationId}/screenshots`),

  // --- Drafting + automation -----------------------------------------------
  draftDocument: (applicationId: string, docType: DocType, persist = true) =>
    request<DraftResponse>(`/api/applications/${applicationId}/draft`, {
      method: "POST",
      body: JSON.stringify({ doc_type: docType, persist }),
    }),
  fillApplication: (applicationId: string, fieldMap: FieldMapping[], headless = true) =>
    request<FillResponse>(`/api/applications/${applicationId}/fill`, {
      method: "POST",
      body: JSON.stringify({ field_map: fieldMap, headless }),
    }),
  // Completes exactly the paused fields (password/attestation/etc.) a human
  // is supplying live, right now -- see form_filler.py. These values are
  // never sent anywhere else and never stored; they're used once to fill
  // that field on the already-open browser page.
  resumeFill: (applicationId: string, humanInputs: HumanInput[]) =>
    request<FillResponse>(`/api/applications/${applicationId}/resume-fill`, {
      method: "POST",
      body: JSON.stringify({ human_inputs: humanInputs }),
    }),

  // --- Ingestion sources -----------------------------------------------------
  listIngestionSources: () => request<IngestionSource[]>("/api/ingestion-sources"),
  createIngestionSource: (payload: Record<string, unknown>) =>
    request<IngestionSource>("/api/ingestion-sources", { method: "POST", body: JSON.stringify(payload) }),
  updateIngestionSource: (id: string, payload: Record<string, unknown>) =>
    request<IngestionSource>(`/api/ingestion-sources/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteIngestionSource: (id: string) => request<void>(`/api/ingestion-sources/${id}`, { method: "DELETE" }),
  triggerIngestionRunAll: (webhookSecret: string) =>
    request(`/api/webhooks/ingestion/run-all`, { method: "POST", headers: { "X-Webhook-Secret": webhookSecret } }),
  triggerIngestionRunOne: (sourceId: string, webhookSecret: string) =>
    request(`/api/webhooks/ingestion/run/${sourceId}`, { method: "POST", headers: { "X-Webhook-Secret": webhookSecret } }),

  // --- Credentials --------------------------------------------------------
  listCredentials: (profileId?: string) => request<Credential[]>(`/api/credentials${query({ profile_id: profileId })}`),
  createCredential: (payload: { profile_id: string; site_domain: string; username: string; secret: string }) =>
    request<Credential>("/api/credentials", { method: "POST", body: JSON.stringify(payload) }),
  deleteCredential: (id: string) => request<void>(`/api/credentials/${id}`, { method: "DELETE" }),

  // --- Audit log ----------------------------------------------------------
  listAuditLog: (params: { entity_type?: string; entity_id?: string; limit?: number } = {}) =>
    request<AuditLogEntry[]>(`/api/audit${query(params)}`),

  // --- Billing / Pro -------------------------------------------------------
  getBillingStatus: () => request<BillingStatus>("/api/billing/status"),
  createCheckout: (product: "pro_monthly" | "hosted_setup", customerEmail?: string) =>
    request<CheckoutSession>("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ product, customer_email: customerEmail }),
    }),
  activateLicense: (licenseKey: string) =>
    request<BillingStatus>("/api/billing/activate-license", {
      method: "POST",
      body: JSON.stringify({ license_key: licenseKey }),
    }),
};

export { ApiError };
