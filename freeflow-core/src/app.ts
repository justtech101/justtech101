import express from "express";
import { ClaudeAi, DisabledAi } from "./core/ai.js";
import { loadBusinessConfig, loadEnv, type Env } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { NullMailer, SmtpMailer } from "./core/notify.js";
import { createPool } from "./core/store.js";
import { GmailApi } from "./core/gmail.js";
import { NoTelephony, TwilioTelephony } from "./core/telephony.js";
import { actionRoutes } from "./routes/actions.js";
import { leadRoutes } from "./routes/leads.js";
import { smsRoutes } from "./routes/sms.js";
import { voiceRoutes } from "./routes/voice.js";
import { webhookRoutes } from "./routes/webhooks.js";

export function buildDeps(env: Env = loadEnv()): Deps {
  const googleVoice = env.CHANNEL === "google_voice";
  return {
    db: createPool(env.DATABASE_URL, env.DATABASE_SSL),
    // Google Voice mode has no automated SMS path at all: every text is a draft a person sends.
    telephony: googleVoice ? new NoTelephony() : new TwilioTelephony(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_PHONE_NUMBER),
    gmail:
      env.GMAIL_REFRESH_TOKEN
        ? new GmailApi({ clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, refreshToken: env.GMAIL_REFRESH_TOKEN, address: env.GMAIL_ADDRESS })
        : undefined,
    ai: env.AI_DISABLED || !env.ANTHROPIC_API_KEY ? new DisabledAi() : new ClaudeAi(env.ANTHROPIC_API_KEY, env.AI_MODEL),
    mailer:
      env.SMTP_HOST && env.SUMMARY_EMAIL_TO
        ? new SmtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: env.SUMMARY_EMAIL_FROM || env.SMTP_USER, to: env.SUMMARY_EMAIL_TO })
        : new NullMailer(),
    config: loadBusinessConfig(),
    env,
    clock: () => new Date(),
  };
}

export function buildApp(deps: Deps) {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.urlencoded({ extended: false })); // Twilio webhooks are form-encoded
  app.use(express.json());
  app.get("/health", async (_req, res) => {
    try {
      await deps.db.query("SELECT 1");
      res.json({ ok: true, env: deps.env.DEPLOY_ENV });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.use(actionRoutes(deps));
  app.use(voiceRoutes(deps));
  app.use(smsRoutes(deps));
  app.use(webhookRoutes(deps));
  app.use(leadRoutes(deps));
  return app;
}
