export type OpportunityType = "job" | "grant";

export type BoardBucket =
  | "new"
  | "qualified"
  | "missing_info"
  | "ready_for_review"
  | "submitted"
  | "rejected"
  | "follow_up";

export interface BoardCard {
  opportunity_id: string;
  type: OpportunityType;
  title: string;
  organization: string | null;
  score: number | null;
  deadline: string | null;
  missing_fields: string[];
  source: string;
  status: string;
  application_id?: string;
  application_status?: string;
  dry_run?: boolean;
  human_approved?: boolean;
  submitted_at?: string | null;
}

export type Board = Record<BoardBucket, BoardCard[]>;

export interface Profile {
  id: string;
  display_name: string;
  full_name: string;
  email: string;
  phone: string | null;
  address: Record<string, unknown>;
  links: Record<string, unknown>;
  skills: string[];
  education: Record<string, unknown>[];
  work_history: Record<string, unknown>[];
  eligibility: Record<string, unknown>;
  preferences: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Opportunity {
  id: string;
  type: OpportunityType;
  source: string;
  source_url: string | null;
  external_id: string | null;
  title: string;
  organization: string | null;
  description: string | null;
  location: string | null;
  remote: boolean | null;
  deadline: string | null;
  eligibility: Record<string, unknown>;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  award_amount: number | null;
  required_documents: string[];
  application_questions: Record<string, unknown>[];
  status: string;
  score: number | null;
  score_breakdown: Record<string, unknown>;
  missing_fields: string[];
  discovered_at: string;
  updated_at: string;
}
