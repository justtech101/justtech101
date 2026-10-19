import { DateTime } from "luxon";
import type { BusinessConfig } from "./config.js";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Day = (typeof DAYS)[number];

function local(config: BusinessConfig, at: Date): DateTime {
  return DateTime.fromJSDate(at, { zone: config.timezone });
}

function dayKey(dt: DateTime): Day {
  return DAYS[dt.weekday - 1];
}

function atClock(dt: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(":").map(Number);
  return dt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

function fmtTime(dt: DateTime): string {
  return dt.toFormat(dt.minute === 0 ? "h a" : "h:mm a");
}

// --- Business hours -----------------------------------------------------------

/** null when hours are not configured (unknown — the systems say nothing about hours). */
export function isOpen(config: BusinessConfig, at: Date): boolean | null {
  if (!config.hours) return null;
  const now = local(config, at);
  const today = config.hours[dayKey(now)];
  if (!today) return false;
  return now >= atClock(now, today[0]) && now < atClock(now, today[1]);
}

/** "8 AM", "9 AM tomorrow", "9 AM Monday", or null when hours are unknown. */
export function nextOpenText(config: BusinessConfig, at: Date): string | null {
  if (!config.hours) return null;
  const now = local(config, at);
  for (let i = 0; i < 8; i++) {
    const d = now.plus({ days: i });
    const hours = config.hours[dayKey(d)];
    if (!hours) continue;
    const open = atClock(d, hours[0]);
    if (open <= now) continue;
    if (i === 0) return fmtTime(open);
    if (i === 1) return `${fmtTime(open)} tomorrow`;
    return `${fmtTime(open)} ${open.toFormat("cccc")}`;
  }
  return null;
}

// --- Quiet hours (follow-up sends) -------------------------------------------

export function isQuietHours(config: BusinessConfig, at: Date): boolean {
  const now = local(config, at);
  const start = atClock(now, config.followup.quiet_hours.start); // e.g. 20:00
  const end = atClock(now, config.followup.quiet_hours.end); // e.g. 08:00
  if (start > end) return now >= start || now < end; // window crosses midnight
  return now >= start && now < end;
}

/** The next moment quiet hours end (e.g. the next 8:00 AM Eastern). */
export function quietHoursEnd(config: BusinessConfig, at: Date): Date {
  const now = local(config, at);
  let end = atClock(now, config.followup.quiet_hours.end);
  if (end <= now) end = end.plus({ days: 1 });
  return end.toJSDate();
}

// --- Callback windows ----------------------------------------------------------

export interface CallbackWindow {
  start: Date;
  end: Date;
  text: string; // "today between 5 and 6 PM"
}

/** Next configured callback window at least `leadMinutes` from now, or null if none configured. */
export function nextCallbackWindow(config: BusinessConfig, at: Date, leadMinutes = 30): CallbackWindow | null {
  if (!config.callback_windows || config.callback_windows.length === 0) return null;
  const now = local(config, at);
  const earliest = now.plus({ minutes: leadMinutes });
  let best: { start: DateTime; end: DateTime } | null = null;
  for (let i = 0; i < 8 && !best; i++) {
    const d = now.plus({ days: i });
    const candidates = config.callback_windows
      .filter((w) => w.days.includes(dayKey(d)))
      .map((w) => ({ start: atClock(d, w.start), end: atClock(d, w.end) }))
      .filter((w) => w.start >= earliest)
      .sort((a, b) => a.start.toMillis() - b.start.toMillis());
    if (candidates.length) best = candidates[0];
  }
  if (!best) return null;
  const dayDiff = Math.round(best.start.startOf("day").diff(now.startOf("day"), "days").days);
  const dayText = dayDiff === 0 ? "today" : dayDiff === 1 ? "tomorrow" : best.start.toFormat("cccc");
  return {
    start: best.start.toJSDate(),
    end: best.end.toJSDate(),
    text: `${dayText} between ${fmtTime(best.start)} and ${fmtTime(best.end)}`,
  };
}

// --- Daily summary -------------------------------------------------------------

/** The next daily-summary time (today's if still ahead, else tomorrow's) and its date key. */
export function nextDailyTime(config: BusinessConfig, at: Date): { runAt: Date; dateKey: string } {
  const now = local(config, at);
  let run = atClock(now, config.summary.daily_time);
  if (run <= now) run = run.plus({ days: 1 });
  return { runAt: run.toJSDate(), dateKey: run.toISODate()! };
}

export function localDayBounds(config: BusinessConfig, at: Date): { start: Date; end: Date } {
  const now = local(config, at);
  return { start: now.startOf("day").toJSDate(), end: now.endOf("day").toJSDate() };
}

export function fmtLocal(config: BusinessConfig, at: Date): string {
  return local(config, at).toFormat("ccc LLL d, h:mm a");
}
