import type { Board, Opportunity, Profile } from "../types";

// REQUIRED: set VITE_API_BASE_URL in frontend/.env (see .env.example)
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

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
    throw new ApiError(response.status, body || response.statusText);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  getBoard: (profileId?: string) =>
    request<Board>(`/api/dashboard/board${profileId ? `?profile_id=${profileId}` : ""}`),

  getSummary: () => request<Record<string, number>>("/api/dashboard/summary"),

  listProfiles: () => request<Profile[]>("/api/profiles"),

  createProfile: (payload: Partial<Profile>) =>
    request<Profile>("/api/profiles", { method: "POST", body: JSON.stringify(payload) }),

  listOpportunities: (params: { type?: string; status?: string } = {}) => {
    const query = new URLSearchParams(params as Record<string, string>).toString();
    return request<Opportunity[]>(`/api/opportunities${query ? `?${query}` : ""}`);
  },

  updateOpportunityStatus: (id: string, status: string) =>
    request<Opportunity>(`/api/opportunities/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  createApplication: (opportunityId: string, profileId: string, dryRun = true) =>
    request(`/api/applications`, {
      method: "POST",
      body: JSON.stringify({ opportunity_id: opportunityId, profile_id: profileId, dry_run: dryRun }),
    }),

  approveApplication: (applicationId: string, approvedBy: string) =>
    request(`/api/applications/${applicationId}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved_by: approvedBy }),
    }),

  confirmSubmitted: (applicationId: string, confirmedBy: string) =>
    request(`/api/applications/${applicationId}/confirm-submitted`, {
      method: "POST",
      body: JSON.stringify({
        confirmed_by: confirmedBy,
        confirmation_phrase: "I confirm I have manually submitted this application",
      }),
    }),

  triggerIngestionRunAll: (webhookSecret: string) =>
    request(`/api/webhooks/ingestion/run-all`, {
      method: "POST",
      headers: { "X-Webhook-Secret": webhookSecret },
    }),
};

export { ApiError };
