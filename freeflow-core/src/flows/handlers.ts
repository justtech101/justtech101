import type { JobHandlers } from "../core/jobs.js";
import { runFollowupStep } from "./followup.js";
import { runCallbackReminder, runConversationSummary } from "./receptionist.js";
import { runDailySummaryJob } from "./summary.js";

export const jobHandlers: JobHandlers = {
  followup_step: runFollowupStep,
  summary: runDailySummaryJob,
  callback: runCallbackReminder,
  conversation_summary: runConversationSummary,
};
