// Try the systems from a terminal, before any Twilio number exists. Real flows,
// real database, real Claude (if ANTHROPIC_API_KEY is set); texts print here instead of sending.
//   DATABASE_URL=... ANTHROPIC_API_KEY=... npm run simulate
// Use a scratch database: the simulator writes real leads/messages/jobs.
import { createInterface } from "node:readline";
import { ClaudeAi, DisabledAi } from "./core/ai.js";
import { loadBusinessConfig, loadEnv } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { runDueJobs } from "./core/jobs.js";
import { NullMailer } from "./core/notify.js";
import { normalizePhone, prettyPhone } from "./core/phone.js";
import { createPool } from "./core/store.js";
import type { Gmail } from "./core/gmail.js";
import type { SendResult, Telephony } from "./core/telephony.js";
import { fmtLocal } from "./core/time.js";
import { findLead, leadLog, todaysQueue } from "./flows/controls.js";
import { jobHandlers } from "./flows/handlers.js";
import { handleInboundSms } from "./flows/inbound.js";
import { sendDailySummary } from "./flows/summary.js";
import { handleMissedCall } from "./flows/textback.js";
import { migrate } from "./migrate.js";

const HELP = `Type a message to text the business as the current customer. Commands:
  /missed           the customer calls and nobody answers (text-back)
  /as <phone>       switch customer (default (706) 555-1234)
  /owner <text>     text the business number from the owner's phone (PAUSE, SAY ..., QUEUE)
  /wait <minutes>   move the clock forward and run due jobs (e.g. /wait 120 for follow-up step 1)
  /log              this customer's full log      /queue   today's scheduled jobs
  /summary          send the daily summary        /quit`;

class ConsoleTelephony implements Telephony {
  n = 0;
  constructor(private owner: string) {}
  async sendSms(to: string, body: string): Promise<SendResult> {
    const who = to === this.owner ? "TO OWNER" : `TO ${prettyPhone(to)}`;
    console.log(`\n  [${who}] ${body.replace(/\n/g, "\n  ")}\n`);
    return { sid: `SMsim${Date.now()}${++this.n}`, status: "sent" };
  }
}

/** Google Voice mode: owner emails (drafts + alerts) print here too. */
class ConsoleGmail implements Gmail {
  async listUnprocessed() { return []; }
  async get(): Promise<never> { throw new Error("not used in the simulator"); }
  async markProcessed() {}
  async send(to: string, subject: string, text: string) {
    console.log(`\n  [EMAIL TO ${to}] ${subject}\n  ${text.replace(/\n/g, "\n  ")}\n`);
  }
}

async function main() {
  const env = loadEnv({ OWNER_ALERT_NUMBER: "+17065550000", GMAIL_ADDRESS: "owner@example.com", ACTION_SECRET: "simulator", DEPLOY_ENV: "simulator", PUBLIC_BASE_URL: "http://simulator", ...process.env });
  let offset = 0;
  const deps: Deps = {
    db: createPool(env.DATABASE_URL, env.DATABASE_SSL),
    telephony: new ConsoleTelephony(normalizePhone(env.OWNER_ALERT_NUMBER)!),
    ai: env.ANTHROPIC_API_KEY && !env.AI_DISABLED ? new ClaudeAi(env.ANTHROPIC_API_KEY, env.AI_MODEL) : new DisabledAi(),
    mailer: new NullMailer(),
    config: loadBusinessConfig(),
    env,
    clock: () => new Date(Date.now() + offset),
    gmail: env.CHANNEL === "google_voice" ? new ConsoleGmail() : undefined,
  };
  await migrate(deps.db);
  console.log(`${HELP}\n\nChannel: ${env.CHANNEL}${env.CHANNEL === "google_voice" ? " (texts print as draft emails to the owner)" : ""}\nAI: ${deps.ai instanceof DisabledAi ? "DISABLED (no ANTHROPIC_API_KEY) — you'll see the fallback paths" : env.AI_MODEL}`);

  let customer = "+17065551234";
  let n = 0;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    rl.setPrompt(`${prettyPhone(customer)} @ ${fmtLocal(deps.config, deps.clock())} > `);
    rl.prompt();
  };
  prompt();
  try {
    // Line-by-line so a piped script (printf '/missed\nhi\n' | npm run simulate) works too.
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        prompt();
        continue;
      }
      const [cmd, ...rest] = line.split(" ");
      const arg = rest.join(" ");
      try {
        if (cmd === "/quit") break;
        else if (cmd === "/help") console.log(HELP);
        else if (cmd === "/missed") console.log(`  (missed call -> ${await handleMissedCall(deps, { from: customer, callSid: `CAsim${++n}` })})`);
        else if (cmd === "/as") customer = normalizePhone(arg) ?? customer;
        else if (cmd === "/owner") await handleInboundSms(deps, { from: env.OWNER_ALERT_NUMBER, body: arg, sid: `SMin${Date.now()}${++n}` });
        else if (cmd === "/wait") {
          offset += Number(arg || 0) * 60_000;
          console.log(`  (ran ${await runDueJobs(deps, jobHandlers)} due job(s))`);
        } else if (cmd === "/log") {
          const lead = await findLead(deps, customer);
          console.log(lead ? (await leadLog(deps, lead)).join("\n") : "  (no lead yet)");
        } else if (cmd === "/queue") console.log((await todaysQueue(deps)).join("\n") || "  (nothing queued today)");
        else if (cmd === "/summary") await sendDailySummary(deps);
        else if (cmd.startsWith("/")) console.log(HELP);
        else await handleInboundSms(deps, { from: customer, body: line, sid: `SMin${Date.now()}${++n}` });
      } catch (err: any) {
        console.error(`  ERROR: ${err?.message ?? err}`);
      }
      prompt();
    }
  } finally {
    rl.close();
    await deps.db.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
