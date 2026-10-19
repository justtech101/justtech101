import { readFileSync } from "node:fs";
import { z } from "zod";
import { CONFIG_PATH } from "./paths.js";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const day = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const ServiceSchema = z.object({
  name: z.string(),
  notes: z.string().nullable().optional(),
  // null = unknown: the systems defer to Jesse. Never 0 for "unknown".
  price: z.string().nullable().optional(),
});

export const BusinessConfigSchema = z.object({
  business_name: z.string(),
  parent_brand: z.string().nullable().optional(),
  owner_name: z.string(),
  website: z.string().nullable(),
  timezone: z.string(),
  service_area: z.object({
    description: z.string().nullable(),
    remote_available: z.boolean().nullable(),
  }),
  // Days left out (or null) are closed.
  hours: z.partialRecord(day, z.tuple([hhmm, hhmm]).nullable()).nullable(),
  callback_windows: z
    .array(z.object({ days: z.array(day), start: hhmm, end: hhmm }))
    .nullable(),
  booking_link: z.string().nullable(),
  same_day_available: z.boolean().nullable(),
  turnaround_times: z.array(z.object({ service: z.string(), turnaround: z.string() })).default([]),
  services: z.array(ServiceSchema),
  textback: z.object({
    dedupe_hours: z.number().positive(),
    max_exchanges: z.number().int().positive(),
    max_low_signal_attempts: z.number().int().nonnegative(),
    alert_on_missed_call: z.boolean(),
  }),
  receptionist: z.object({
    max_human_requests: z.number().int().positive(),
    max_off_script: z.number().int().positive(),
    max_no_input: z.number().int().positive(),
    sms_silence_summary_minutes: z.number().positive(),
  }),
  voice: z.object({
    ring_owner_seconds: z.number().int().positive(),
    receptionist_enabled: z.boolean(),
    tts_voice: z.string(),
  }),
  followup: z.object({
    steps: z
      .array(z.object({ step: z.number().int().min(1).max(4), offset_minutes: z.number().positive() }))
      .length(4),
    quiet_hours: z.object({ start: hhmm, end: hhmm }),
  }),
  summary: z.object({
    daily_time: hhmm,
    callback_reminder_minutes_before: z.number().int().nonnegative(),
  }),
});

export type BusinessConfig = z.infer<typeof BusinessConfigSchema>;

export function loadBusinessConfig(path = CONFIG_PATH): BusinessConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return BusinessConfigSchema.parse(raw);
}

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

export const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  DEPLOY_ENV: z.string().default("staging"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: bool,
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_PHONE_NUMBER: z.string().default(""),
  TWILIO_VALIDATE_SIGNATURES: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
  OWNER_ALERT_NUMBER: z.string().default(""),
  OWNER_FORWARD_NUMBER: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  AI_MODEL: z.string().optional().transform((v) => v || "claude-opus-5-5"),
  AI_DISABLED: bool,
  ADMIN_API_KEY: z.string().default(""),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  SUMMARY_EMAIL_FROM: z.string().default(""),
  SUMMARY_EMAIL_TO: z.string().default(""),
  JOB_POLL_SECONDS: z.coerce.number().positive().default(60),
  FOLLOWUP_ACCELERATED: bool,
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
