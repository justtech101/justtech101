import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/core (or dist/core) -> package root. Prompts and config are read from
// the source tree in both dev and built mode.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONFIG_PATH = resolve(ROOT, "config/business.json");
export const PROMPTS_DIR = resolve(ROOT, "src/prompts");
export const MIGRATIONS_DIR = resolve(ROOT, "migrations");
