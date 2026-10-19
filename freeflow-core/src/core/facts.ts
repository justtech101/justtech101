import type { BusinessConfig } from "./config.js";

/**
 * Renders business.json into the "facts" block every system prompt receives.
 * The model may state only what appears here; null values are spelled out as
 * unknown so the model defers instead of guessing.
 */
export function factsBlock(config: BusinessConfig): string {
  const unknown = `UNKNOWN — do not state; say ${config.owner_name} will confirm`;
  const services = config.services.length
    ? config.services
        .map((s) => `- ${s.name}${s.notes ? ` — ${s.notes}` : ""} | price: ${s.price ?? unknown}`)
        .join("\n")
    : "- (no service list configured — record what the customer needs in their own words)";
  const hours = config.hours
    ? Object.entries(config.hours)
        .map(([d, h]) => `${d}: ${h ? `${h[0]}-${h[1]}` : "closed"}`)
        .join(", ")
    : unknown;
  const windows = config.callback_windows
    ? config.callback_windows.map((w) => `${w.days.join("/")} ${w.start}-${w.end}`).join("; ")
    : unknown;
  const turnaround = config.turnaround_times.length
    ? config.turnaround_times.map((t) => `${t.service}: ${t.turnaround}`).join("; ")
    : unknown;
  return [
    `Business: ${config.business_name}${config.parent_brand ? ` (${config.parent_brand})` : ""}`,
    `Owner: ${config.owner_name}`,
    `Website: ${config.website ?? unknown}`,
    `Service area: ${config.service_area.description ?? unknown}`,
    `Remote service available: ${config.service_area.remote_available === null ? unknown : config.service_area.remote_available ? "yes" : "no"}`,
    `Hours (${config.timezone}): ${hours}`,
    `Callback windows: ${windows}`,
    `Booking link: ${config.booking_link ?? unknown}`,
    `Same-day service: ${config.same_day_available === true ? "available" : "NOT confirmed — never promise same-day"}`,
    `Turnaround times: ${turnaround}`,
    `Policies (may be stated as written):\n${config.policies.length ? config.policies.map((x) => `- ${x}`).join("\n") : "- (none)"}`,
    `Services:\n${services}`,
  ].join("\n");
}

/** Price strings approved in config, normalised for comparison ("$75" -> "75"). */
export function approvedAmounts(config: BusinessConfig): Set<string> {
  const out = new Set<string>();
  for (const s of config.services) {
    if (!s.price) continue;
    for (const m of s.price.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(m[0].replace(/,/g, ""));
  }
  return out;
}
