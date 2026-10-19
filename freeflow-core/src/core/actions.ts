import { createHmac, timingSafeEqual } from "node:crypto";
import type { Deps } from "./deps.js";

/** One-tap links in owner emails ("I sent it", "Pause this lead"). Signed and expiring. */
export type ActionKind = "sent" | "pause" | "reset";
export interface ActionPayload {
  do: ActionKind;
  lead: number;
  message?: number;
  exp: number; // epoch ms
}

const TTL_MS = 14 * 24 * 3_600_000;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mac(secret: string, data: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

export function signAction(secret: string, p: Omit<ActionPayload, "exp">, now: Date): string {
  const data = b64url(JSON.stringify({ ...p, exp: now.getTime() + TTL_MS }));
  return `${data}.${mac(secret, data)}`;
}

export function verifyAction(secret: string, token: string, now: Date): ActionPayload | null {
  const [data, sig] = token.split(".");
  if (!data || !sig || !secret) return null;
  const want = mac(secret, data);
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as ActionPayload;
    return p.exp > now.getTime() ? p : null;
  } catch {
    return null;
  }
}

export function actionUrl(deps: Deps, p: Omit<ActionPayload, "exp">): string {
  return `${deps.env.PUBLIC_BASE_URL}/a/${signAction(deps.env.ACTION_SECRET, p, deps.clock())}`;
}
