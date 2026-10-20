import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./paths.js";

export const ENV_PATH = resolve(ROOT, ".env");

/** Parse KEY=value lines (no interpolation). Quotes around a value are stripped. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Local tools (cli, setup, simulate, ai-check) read freeflow-core/.env if present.
 * Real environment variables win. The deployed service uses the host's env settings only.
 */
export function loadDotEnv(path = ENV_PATH): void {
  if (!existsSync(path)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/** Set KEY=value in an env file, replacing an existing line or appending. */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
}
