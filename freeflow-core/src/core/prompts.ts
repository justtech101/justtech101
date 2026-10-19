import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROMPTS_DIR } from "./paths.js";

/**
 * Prompt files are markdown split into sections by "## name" headings. Each
 * section is either a system prompt for the model or a fixed message template.
 * Templates use {{placeholders}} filled from business.json or the lead — facts
 * never get hard-coded into a prompt.
 */
export type PromptFile = Record<string, string>;

const cache = new Map<string, PromptFile>();

export function loadPrompt(name: "textback" | "receptionist" | "followup"): PromptFile {
  const hit = cache.get(name);
  if (hit) return hit;
  const text = readFileSync(resolve(PROMPTS_DIR, `${name}.md`), "utf8");
  const sections: PromptFile = {};
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) sections[current] = buf.join("\n").trim();
  };
  for (const line of text.split("\n")) {
    const m = /^## (\S+)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1];
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  cache.set(name, sections);
  return sections;
}

export function section(file: PromptFile, key: string): string {
  const s = file[key];
  if (s === undefined) throw new Error(`Prompt section "${key}" is missing`);
  return s;
}

/**
 * Google Voice co-pilot mode: the owner sends every text personally, so
 * first-person "_gv" variants of a section win when they exist.
 */
export function variant(file: PromptFile, key: string, channel: string): string {
  if (channel === "google_voice" && file[`${key}_gv`] !== undefined) return file[`${key}_gv`];
  return section(file, key);
}

export function render(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null) throw new Error(`Template variable "${k}" has no value`);
    return v;
  });
}
