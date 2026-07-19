const LABELS: Record<string, string> = {
  new: "New",
  qualified: "Qualified",
  missing_info: "Missing Information",
  ready_for_review: "Ready for Review",
  submitted: "Submitted",
  rejected: "Rejected",
  follow_up: "Follow-up",
  duplicate: "Duplicate",
  archived: "Archived",
};

const CLASSES: Record<string, string> = {
  new: "status-new",
  qualified: "status-qualified",
  missing_info: "status-missing",
  ready_for_review: "status-review",
  submitted: "status-submitted",
  rejected: "status-rejected",
  follow_up: "status-followup",
  duplicate: "status-neutral",
  archived: "status-neutral",
};

export default function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${CLASSES[status] ?? "status-neutral"}`}>{LABELS[status] ?? status}</span>;
}
