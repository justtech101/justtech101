// Google Voice co-pilot setup (run on your own computer, it opens a browser):
//   npm run gmail -- auth        one-time sign-in; prints GMAIL_REFRESH_TOKEN
//   npm run gmail -- inspect [n] show how the last n Google Voice emails parse (checks the parser on YOUR emails)
//   npm run gmail -- test        send a test email to the owner address
// Needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET from a Google Cloud "Desktop app" OAuth client.
import "./core/load-env.js";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { loadEnv } from "./core/config.js";
import { isMain } from "./core/paths.js";
import { GmailApi } from "./core/gmail.js";
import { normalizePhone } from "./core/phone.js";
import { parseVoiceEmail } from "./core/voice-email.js";

// gmail.modify covers reading, labelling and sending — and nothing destructive.
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

/** Best effort: open the sign-in page in the default browser (the URL is printed either way). */
function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    // no browser available — the printed URL still works
  }
}

export async function gmailAuth(clientId: string, clientSecret: string, opts: { print?: boolean } = {}): Promise<string> {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent",
  })}`;
  console.log(`Open this URL, sign in with the Google account that owns Google Voice, and allow access:\n\n${url}\n`);
  openBrowser(url);
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT);
      const c = u.searchParams.get("code");
      res.end(c ? "Done — you can close this tab and go back to the terminal." : `Sign-in failed: ${u.searchParams.get("error") ?? "no code"}`);
      server.close();
      c ? resolve(c) : reject(new Error(u.searchParams.get("error") ?? "no code"));
    }).listen(PORT, "127.0.0.1");
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
  });
  const j: any = await res.json();
  if (!j.refresh_token) throw new Error(`No refresh token returned: ${JSON.stringify(j)}`);
  if (opts.print !== false) {
    console.log("Put this in the hosting dashboard (never in git or chat):\n");
    console.log(`GMAIL_REFRESH_TOKEN=${j.refresh_token}\n`);
    console.log("If your OAuth consent screen is still in \"Testing\", this token expires in 7 days. Set it to \"In production\" (see README).");
  }
  return j.refresh_token;
}

/** Print how the most recent Google Voice emails parse. Returns [parsed, unknown] counts. */
export async function inspectVoiceEmails(gmail: GmailApi, voiceNumber: string, n: number): Promise<[number, number]> {
  const ids = await gmail.search("from:(voice-noreply@google.com OR txt.voice.google.com)", n);
  if (!ids.length) console.log("No Google Voice emails found. Turn on email notifications in Google Voice settings (README step 1).");
  let unknown = 0;
  for (const id of ids) {
    const m = await gmail.get(id);
    const ev = parseVoiceEmail(m, normalizePhone(voiceNumber));
    if (ev.kind === "unknown") unknown++;
    console.log(`\n${m.date.toISOString()}  ${m.subject}\n  from: ${m.from}\n  parsed: ${JSON.stringify(ev)}`);
  }
  console.log("\nEvery line should say sms / missed_call / voicemail with the right number and text. If one says \"unknown\" or reads wrong, send the email (with the number blacked out) so the parser can be fixed.");
  return [ids.length - unknown, unknown];
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const env = loadEnv({ DATABASE_URL: "unused", ...process.env });
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) throw new Error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first (see README: Google Voice mode).");
  if (cmd === "auth") return void (await gmailAuth(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET));
  if (!env.GMAIL_REFRESH_TOKEN) throw new Error("Run `npm run gmail -- auth` first and set GMAIL_REFRESH_TOKEN.");
  const gmail = new GmailApi({ clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, refreshToken: env.GMAIL_REFRESH_TOKEN, address: env.GMAIL_ADDRESS });

  if (cmd === "inspect") return void (await inspectVoiceEmails(gmail, env.GOOGLE_VOICE_NUMBER, Number(arg ?? 10)));
  if (cmd === "test") {
    const to = env.OWNER_ALERT_EMAIL || env.GMAIL_ADDRESS;
    await gmail.send(to, "FreeFlow test", "Test from freeflow-core. If you can read this, owner emails work.");
    console.log(`Sent to ${to}.`);
    return;
  }
  console.log("Usage: npm run gmail -- auth | inspect [n] | test");
}

if (isMain(import.meta.url)) main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
