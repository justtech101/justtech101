// One-command setup for Google Voice co-pilot mode. Run it on your own computer:
//   cd freeflow-core && npm install && npm run setup
// It fills in freeflow-core/.env (git-ignored), signs in to Gmail, checks your real
// Google Voice emails, sends you a test email and checks the AI. Safe to re-run:
// anything already done is skipped, and Enter keeps the current value.
import "./core/load-env.js";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { ENV_PATH, parseEnv, upsertEnvLine } from "./core/dotenv.js";
import { GmailApi } from "./core/gmail.js";
import { ROOT } from "./core/paths.js";
import { normalizePhone } from "./core/phone.js";
import { gmailAuth, inspectVoiceEmails } from "./setup-gmail.js";

// Queue every typed/pasted line so none are lost between questions.
const rl = createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
const lines: string[] = [];
const waiting: ((l: string) => void)[] = [];
let closed = false;
rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
rl.on("close", () => {
  closed = true;
  while (waiting.length) waiting.shift()!("\u0000");
});
async function question(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const line = lines.length ? lines.shift()! : closed ? "\u0000" : await new Promise<string>((r) => waiting.push(r));
  if (line === "\u0000") throw new Error("input ended");
  if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
  return line;
}
const done: string[] = [];
const todo: string[] = [];

function env(): Record<string, string> {
  return existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, "utf8")) : {};
}
function save(key: string, value: string) {
  writeFileSync(ENV_PATH, upsertEnvLine(readFileSync(ENV_PATH, "utf8"), key, value));
  process.env[key] = value;
}
function heading(s: string) {
  console.log(`\n=== ${s} ${"=".repeat(Math.max(0, 60 - s.length))}`);
}

/** Ask for a value; Enter keeps the current one (or the suggestion). */
async function ask(key: string, prompt: string, opts: { suggest?: string; secret?: boolean; validate?: (v: string) => string | null; optional?: boolean } = {}) {
  const current = env()[key];
  const shown = current ? (opts.secret ? `${current.slice(0, 4)}…(set)` : current) : opts.suggest;
  for (;;) {
    const raw = (await question(`${prompt}${shown ? ` [${shown}]` : ""}: `)).trim();
    const value = raw || current || opts.suggest || "";
    if (!value) {
      if (opts.optional) return "";
      console.log("  (needed — paste the value, or Ctrl+C to stop and come back later)");
      continue;
    }
    const err = opts.validate?.(value);
    if (err) {
      console.log(`  ${err}`);
      continue;
    }
    save(key, value);
    return value;
  }
}

async function main() {
  console.log("freeflow-core setup — Google Voice co-pilot mode\nEnter keeps the value in [brackets]. Everything is saved to freeflow-core/.env (never committed).");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node ${process.versions.node} is too old — install Node 20 or newer from nodejs.org.`);

  heading("1. Settings file");
  if (!existsSync(ENV_PATH)) {
    copyFileSync(resolve(ROOT, ".env.example"), ENV_PATH);
    console.log("Created .env from .env.example.");
  }
  save("CHANNEL", "google_voice");
  for (const k of ["ADMIN_API_KEY", "ACTION_SECRET"]) {
    if (!env()[k]) {
      save(k, randomBytes(32).toString("hex"));
      console.log(`Generated ${k}.`);
    }
  }
  done.push("Settings file with generated secrets");

  heading("2. Google Voice");
  console.log(`In Google Voice (voice.google.com → Settings), turn on:
  • Messages → Forward messages to email
  • Calls → Get email alerts for missed calls
  • Voicemail → Get voicemail via email (transcripts on)`);
  await question("Press Enter once those are on... ");
  await ask("GOOGLE_VOICE_NUMBER", "Your Google Voice number", {
    suggest: "+18033806153",
    validate: (v) => (normalizePhone(v) ? null : "That doesn't look like a phone number."),
  });
  save("GOOGLE_VOICE_NUMBER", normalizePhone(env().GOOGLE_VOICE_NUMBER)!);
  await ask("GMAIL_ADDRESS", "Gmail address that gets the Voice emails", { validate: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : "That doesn't look like an email address.") });
  await ask("OWNER_ALERT_EMAIL", "Where should drafts and alerts go (Enter = same address)", { optional: true });

  heading("3. Gmail access");
  if (!env().GMAIL_CLIENT_ID || !env().GMAIL_CLIENT_SECRET) {
    console.log(`One-time Google Cloud setup (about 10 minutes):
  1. console.cloud.google.com → create a project (e.g. "freeflow").
  2. APIs & Services → Library → enable "Gmail API".
  3. OAuth consent screen → External → app name "FreeFlow" → add your Gmail as a test user,
     then PUBLISH APP → "In production" (otherwise sign-in expires after 7 days).
  4. Credentials → Create credentials → OAuth client ID → "Desktop app" → copy the ID and secret.`);
  }
  await ask("GMAIL_CLIENT_ID", "OAuth client ID");
  await ask("GMAIL_CLIENT_SECRET", "OAuth client secret", { secret: true });
  if (!env().GMAIL_REFRESH_TOKEN) {
    console.log("\nSigning in to Gmail. Google will warn the app is unverified — it's yours: Advanced → Go to FreeFlow.");
    save("GMAIL_REFRESH_TOKEN", await gmailAuth(env().GMAIL_CLIENT_ID, env().GMAIL_CLIENT_SECRET, { print: false }));
    console.log("Gmail connected.");
  } else {
    console.log("Gmail already connected (delete GMAIL_REFRESH_TOKEN from .env to redo).");
  }
  const e = env();
  const gmail = new GmailApi({ clientId: e.GMAIL_CLIENT_ID, clientSecret: e.GMAIL_CLIENT_SECRET, refreshToken: e.GMAIL_REFRESH_TOKEN, address: e.GMAIL_ADDRESS });
  done.push("Gmail connected");

  heading("4. Checking your real Google Voice emails");
  const [ok, unknown] = await inspectVoiceEmails(gmail, e.GOOGLE_VOICE_NUMBER, 15);
  if (ok + unknown === 0) todo.push("No Voice emails found yet — check the Google Voice settings in step 2, then call/text your Voice number and re-run setup");
  else if (unknown) todo.push(`${unknown} Voice email(s) didn't parse — send them (numbers blacked out) so the parser can be fixed before going live`);
  else done.push(`All ${ok} recent Voice emails parsed`);

  heading("5. Test email");
  const to = e.OWNER_ALERT_EMAIL || e.GMAIL_ADDRESS;
  await gmail.send(to, "FreeFlow test", "Test from freeflow-core setup. Drafts and alerts will arrive like this.\n\nTip: turn on Gmail notifications on your phone so drafts reach you within seconds.");
  console.log(`Sent to ${to} — check your inbox.`);
  done.push("Test email sent");

  heading("6. AI check");
  const key = await ask("ANTHROPIC_API_KEY", "Anthropic API key (Enter to skip for now)", { secret: true, optional: true });
  if (key) {
    const { runAiCheck } = await import("./ai-check.js");
    const failed = await runAiCheck();
    failed ? todo.push(`AI check: ${failed} FAIL — see above`) : done.push("AI check passed");
  } else {
    todo.push("Add ANTHROPIC_API_KEY and re-run setup (or `npm run ai-check`)");
  }

  heading("7. Database (for deploying)");
  await ask("DATABASE_URL", "Hosted Postgres URL from Neon/Supabase/Render (Enter to skip for now)", { secret: true, optional: true });
  if (!env().DATABASE_URL || env().DATABASE_URL.includes("localhost")) todo.push("Create a hosted Postgres and add DATABASE_URL");

  heading("Summary");
  for (const d of done) console.log(`  ✓ ${d}`);
  for (const t of todo) console.log(`  ✗ ${t}`);
  console.log(`
Next — deploy (Render, using render.yaml):
  1. render.com → New → Blueprint → pick this repo → it creates "freeflow-core-staging".
  2. Copy these values from freeflow-core/.env into the service's Environment tab:
     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_ADDRESS, OWNER_ALERT_EMAIL,
     GOOGLE_VOICE_NUMBER, ANTHROPIC_API_KEY, ADMIN_API_KEY, DATABASE_URL
     and set PUBLIC_BASE_URL to the service's https://….onrender.com address.
  3. Have a friend call (don't answer) and text your Voice number — a draft email should arrive within a minute.
Keep .env private: it holds your keys. Never paste it into chat or commit it.`);
}

main()
  .catch((err) => {
    console.error(`\nSetup stopped: ${err.message ?? err}\nFix that and run \`npm run setup\` again — finished steps are skipped.`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
