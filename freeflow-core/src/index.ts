import { buildApp, buildDeps } from "./app.js";
import { startPoller } from "./core/jobs.js";
import { jobHandlers } from "./flows/handlers.js";
import { ensureDailySummaryJob } from "./flows/summary.js";
import { migrate } from "./migrate.js";

const deps = buildDeps();
const missing = ["DATABASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "OWNER_ALERT_NUMBER", "ANTHROPIC_API_KEY", "ADMIN_API_KEY"]
  .filter((k) => !(deps.env as any)[k]);
if (missing.length) console.warn(`[startup] missing env: ${missing.join(", ")} — see .env.example`);

await migrate(deps.db);
const app = buildApp(deps);
app.listen(deps.env.PORT, () => console.log(`freeflow-core (${deps.env.DEPLOY_ENV}) listening on :${deps.env.PORT}`));

// One poller runs follow-ups, callback reminders, conversation summaries and the daily summary.
startPoller(deps, jobHandlers, {
  intervalMs: deps.env.JOB_POLL_SECONDS * 1000,
  beforeTick: () => ensureDailySummaryJob(deps),
});
