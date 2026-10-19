import { buildApp, buildDeps } from "./app.js";
import { startPoller } from "./core/jobs.js";
import { startGoogleVoicePoller } from "./flows/googlevoice.js";
import { jobHandlers } from "./flows/handlers.js";
import { ensureDailySummaryJob } from "./flows/summary.js";
import { migrate } from "./migrate.js";

const deps = buildDeps();
const googleVoice = deps.env.CHANNEL === "google_voice";
const required = googleVoice
  ? ["DATABASE_URL", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_ADDRESS", "GOOGLE_VOICE_NUMBER", "ACTION_SECRET", "ANTHROPIC_API_KEY", "ADMIN_API_KEY", "PUBLIC_BASE_URL"]
  : ["DATABASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "OWNER_ALERT_NUMBER", "ANTHROPIC_API_KEY", "ADMIN_API_KEY"];
const missing = required.filter((k) => !(deps.env as any)[k]);
if (missing.length) console.warn(`[startup] missing env for CHANNEL=${deps.env.CHANNEL}: ${missing.join(", ")} — see .env.example`);

await migrate(deps.db);
const app = buildApp(deps);
app.listen(deps.env.PORT, () => console.log(`freeflow-core (${deps.env.DEPLOY_ENV}, ${deps.env.CHANNEL}) listening on :${deps.env.PORT}`));

// Google Voice co-pilot: read Voice's notification emails every GV_POLL_SECONDS.
if (googleVoice) startGoogleVoicePoller(deps, deps.env.GV_POLL_SECONDS * 1000);

// One poller runs follow-ups, callback reminders, conversation summaries and the daily summary.
startPoller(deps, jobHandlers, {
  intervalMs: deps.env.JOB_POLL_SECONDS * 1000,
  beforeTick: () => ensureDailySummaryJob(deps),
});
