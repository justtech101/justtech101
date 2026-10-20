import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/core (or dist/core) -> package root. Prompts and config are read from
// the source tree in both dev and built mode.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONFIG_PATH = resolve(ROOT, "config/business.json");
export const PROMPTS_DIR = resolve(ROOT, "src/prompts");
export const MIGRATIONS_DIR = resolve(ROOT, "migrations");

/** True when the module is the script node was started with (works with Windows paths too). */
export function isMain(moduleUrl: string): boolean {
  return !!process.argv[1] && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;
}
