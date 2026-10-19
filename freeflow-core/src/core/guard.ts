import type { BusinessConfig } from "./config.js";
import { approvedAmounts } from "./facts.js";

export function deferLine(config: BusinessConfig, channel = "twilio"): string {
  return channel === "google_voice"
    ? "Let me confirm that and get right back to you."
    : `Let me have ${config.owner_name} confirm that and get right back to you.`;
}

export interface GuardResult {
  text: string;
  violations: string[];
}

const MONEY = /(\$\s?\d[\d,]*(?:\.\d+)?)|(\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|bucks|usd)\b)/gi;
const SAME_DAY = /\b(same[- ]day|today|tonight|right now|within the hour)\b/i;
const TURNAROUND = /\b(within|in|takes?|about|around)\s+(an?|\d+|one|two|three|four|five|a few|a couple of)\s*(-\s*\d+\s*)?(minutes?|hours?|hrs?|days?|business days?|weeks?)\b/i;
const DISCOUNT = /\b(\d+\s?%\s?off|discount|free of charge|no charge|on the house)\b/i;

/**
 * Deterministic last line of defence on every AI-written customer message:
 * the model's reply is checked against business.json before it is sent. Any
 * price, discount, same-day promise or turnaround that config does not back
 * replaces the reply with the defer line. Prompts ask for this too; this code
 * makes it true even if the model slips.
 */
export function guardReply(text: string, config: BusinessConfig, channel = "twilio"): GuardResult {
  const violations: string[] = [];
  const allowed = approvedAmounts(config);

  for (const m of text.matchAll(MONEY)) {
    const amount = m[0].replace(/[^\d.]/g, "");
    if (!allowed.has(amount)) violations.push(`price not in config: "${m[0].trim()}"`);
  }
  if (DISCOUNT.test(text)) violations.push("discount/free offer");
  if (config.same_day_available !== true && SAME_DAY.test(text)) {
    violations.push("same-day/now promise without config");
  }
  const t = TURNAROUND.exec(text);
  if (t) {
    const backed = config.turnaround_times.some((tt) => text.toLowerCase().includes(tt.turnaround.toLowerCase()));
    if (!backed) violations.push(`turnaround not in config: "${t[0]}"`);
  }

  if (violations.length) return { text: deferLine(config, channel), violations };
  return { text: text.trim(), violations };
}
