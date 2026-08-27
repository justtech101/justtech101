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
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string;
  award_amount?: number | null;
  employment_type?: string | null;
  fast_pay_signals?: string[];
  remote?: boolean | null;
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
  address: Record<string, string>;
  links: Record<string, string>;
  skills: string[];
  education: EducationEntry[];
  work_history: WorkHistoryEntry[];
  eligibility: Record<string, string>;
  preferences: Record<string, string>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EducationEntry {
  school?: string;
  degree?: string;
  field?: string;
  start?: string;
  end?: string;
}

export interface WorkHistoryEntry {
  employer?: string;
  title?: string;
  start?: string;
  end?: string;
  summary?: string;
}

export interface ReusableAnswer {
  id: string;
  profile_id: string;
  question_hash: string;
  question_text: string;
  answer_text: string;
  category: string | null;
  verified: boolean;
  verified_at: string | null;
  created_at: string;
}

export interface ApplicationQuestion {
  question: string;
  required?: boolean;
  answer_type?: string;
}

export interface ScoreComponent {
  ratio: number;
  weight: number;
  points: number;
  detail: string;
}

export interface ScoreBreakdown {
  total?: number;
  skill_match?: ScoreComponent;
  eligibility_match?: ScoreComponent;
  deadline_urgency?: ScoreComponent;
  compensation_fit?: ScoreComponent;
  speed_to_cash?: ScoreComponent;
  data_completeness?: ScoreComponent;
  [key: string]: unknown;
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
  application_questions: ApplicationQuestion[];
  status: string;
  score: number | null;
  score_breakdown: { best?: ScoreBreakdown; by_profile?: Record<string, ScoreBreakdown> };
  missing_fields: string[];
  discovered_at: string;
  updated_at: string;
}

export type ApplicationStatus =
  | "new"
  | "qualified"
  | "missing_info"
  | "ready_for_review"
  | "submitted"
  | "rejected"
  | "follow_up";

export interface Application {
  id: string;
  opportunity_id: string;
  profile_id: string;
  status: ApplicationStatus;
  resume_doc_id: string | null;
  cover_letter_doc_id: string | null;
  narrative_doc_id: string | null;
  answers: Record<string, string>;
  missing_fields: string[];
  dry_run: boolean;
  human_approved: boolean;
  human_approved_by: string | null;
  human_approved_at: string | null;
  submitted_at: string | null;
  rejected_reason: string | null;
  follow_up_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Screenshot {
  id: string;
  application_id: string;
  step: string;
  file_path: string;
  created_at: string;
}

export type DocType = "cover_letter" | "resume" | "grant_narrative";

export interface DraftResponse {
  document_text: string;
  missing_fields: string[];
  document_id: string | null;
}

export type FieldType = "fill" | "select" | "check" | "upload";

export interface FieldMapping {
  selector: string;
  label: string;
  field_type: FieldType;
  value_source: string;
}

export interface PendingField {
  selector: string;
  label: string;
  field_type: FieldType;
}

export interface FillResponse {
  status: "awaiting_human_review" | "awaiting_human_input" | "stopped_captcha" | "error";
  filled_fields: string[];
  missing_fields: string[];
  stopped_fields: string[];
  screenshots: string[];
  error: string | null;
  pending_fields: PendingField[];
}

export interface HumanInput {
  selector: string;
  value: string;
}

export type IngestionSourceType = "rss" | "email" | "api" | "website" | "n8n_webhook";

export interface IngestionSource {
  id: string;
  name: string;
  source_type: IngestionSourceType;
  opportunity_type: OpportunityType;
  config: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
}

export interface Credential {
  id: string;
  profile_id: string;
  site_domain: string;
  created_at: string;
  updated_at: string;
}

export interface AuditLogEntry {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor_type: string;
  actor: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}
