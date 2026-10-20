// Manual controls (Phase 1 has no admin panel). Usage: npm run cli -- <command> [args]
import "./core/load-env.js";
import { buildDeps } from "./app.js";
import { runDueJobs } from "./core/jobs.js";
import { alertOwner } from "./core/notify.js";
import { normalizePhone } from "./core/phone.js";
import { upsertLead } from "./core/store.js";
import { findLead, leadLog, pauseLead, resetLead, setGlobalPause, todaysQueue } from "./flows/controls.js";
import { jobHandlers } from "./flows/handlers.js";
import { sendDailySummary } from "./flows/summary.js";
import { migrate } from "./migrate.js";

const USAGE = `Commands:
  pause <phone>            Stop automation on one lead (it becomes yours)
  reset <phone>            Back to "new" and re-arm the follow-up sequence
  pause-all | resume-all   Pause / resume ALL automated sends
  queue                    Today's scheduled jobs
  log <phone>              Every message and event for a number
  summary                  Send the daily summary now
  run-jobs                 Run every due job now
  audit [hours]            Checkpoint D: duplicate sends / sends after STOP or reply (default 48h)
  add-lead <phone> --consent "<how they contacted us>" [--name N] [--need "..."] [--followup]
  test-sms ["text"]        Send a test text to OWNER_ALERT_NUMBER`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help") return console.log(USAGE);
  const deps = buildDeps();
  await migrate(deps.db);
  const lead = async () => {
    const l = args[0] ? await findLead(deps, args[0]) : null;
    if (!l) throw new Error(`No lead found for "${args[0] ?? ""}"`);
    return l;
  };
  try {
    switch (cmd) {
      case "pause": console.log((await pauseLead(deps, await lead(), "cli")).status); break;
      case "reset": console.log((await resetLead(deps, await lead(), "cli")).status); break;
      case "pause-all": await setGlobalPause(deps, true, "cli"); console.log("All automation paused."); break;
      case "resume-all": await setGlobalPause(deps, false, "cli"); console.log("Automation resumed."); break;
      case "queue": console.log((await todaysQueue(deps)).join("\n") || "Nothing queued for today."); break;
      case "log": console.log((await leadLog(deps, await lead())).join("\n")); break;
      case "summary": console.log(JSON.stringify(await sendDailySummary(deps), null, 2)); break;
      case "audit": {
        const { audit } = await import("./flows/audit.js");
        const r = await audit(deps, Number(args[0] ?? 48));
        console.log(JSON.stringify(r, null, 2));
        const clean = r.duplicate_sends.length + r.sends_after_stop.length + r.followups_after_reply.length + r.automated_sends_to_owned_leads.length === 0;
        console.log(clean ? "CLEAN" : "PROBLEMS FOUND");
        if (!clean) process.exitCode = 1;
        break;
      }
      case "run-jobs": console.log(`Processed ${await runDueJobs(deps, jobHandlers)} job(s).`); break;
      case "add-lead": {
        const phone = normalizePhone(args[0] ?? "");
        const consent = flag(args, "consent");
        if (!phone || !consent) throw new Error('add-lead needs a phone and --consent "<how they contacted us>"');
        const { lead: l, created } = await upsertLead(deps.db, { phone, source: "manual", consent_source: consent, name: flag(args, "name"), need: flag(args, "need") }, deps.clock());
        if (args.includes("--followup")) {
          const { armFollowup } = await import("./flows/followup.js");
          await armFollowup(deps, l);
        }
        console.log(`${created ? "Created" : "Existing"} lead #${l.id} ${l.phone}`);
        break;
      }
      case "test-sms": console.log((await alertOwner(deps, args[0] ?? `Test from freeflow-core (${deps.env.DEPLOY_ENV})`)) ? "Sent." : "NOT sent — check OWNER_ALERT_NUMBER / Twilio."); break;
      default: console.log(USAGE); process.exitCode = 1;
    }
  } finally {
    await deps.db.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
