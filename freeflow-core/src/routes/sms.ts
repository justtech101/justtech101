import { Router } from "express";
import type { Deps } from "../core/deps.js";
import { alertOwner } from "../core/notify.js";
import { getLead, logEvent } from "../core/store.js";
import { processInboundSms, recordInboundSms } from "../flows/inbound.js";
import { handleOwnerSms } from "../flows/owner.js";
import { twilioAuth } from "./webhooks.js";

/**
 * Texts from the same person are processed one at a time, in arrival order, so
 * two quick messages can't race on the same thread state. (Single instance;
 * Phase 1 runs one web service.)
 */
const chains = new Map<string, Promise<void>>();
function serially(key: string, fn: () => Promise<void>): Promise<void> {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

export function smsRoutes(deps: Deps): Router {
  const r = Router();
  r.post("/sms/incoming", twilioAuth(deps), async (req, res) => {
    const sms = { from: String(req.body.From ?? ""), body: String(req.body.Body ?? ""), sid: String(req.body.MessageSid ?? "") };
    let rec;
    try {
      rec = await recordInboundSms(deps, sms); // logged before we acknowledge
    } catch (err) {
      console.error("[sms] failed to record inbound", err);
      res.status(500).send("error"); // Twilio will log the failure; nothing silently dropped
      return;
    }
    // Replies go out through the REST API (logged + idempotent), so the webhook answers empty.
    res.type("text/xml").send("<Response/>");
    if (!rec) return;
    const leadId = "lead" in rec ? rec.lead.id : null;
    await serially(sms.from, async () => {
      try {
        if (leadId === null) await handleOwnerSms(deps, sms.body);
        else {
          const lead = await getLead(deps.db, leadId); // fresh: an earlier text may have changed the thread
          if (lead) await processInboundSms(deps, lead, sms.body);
        }
      } catch (err: any) {
        console.error("[sms] processing failed", err);
        await logEvent(deps.db, leadId, "error", `inbound sms processing failed: ${err?.message ?? err}`, deps.clock());
        await alertOwner(deps, `System error handling a text from ${sms.from}: "${sms.body}". Please check it.`, leadId);
      }
    });
  });
  return r;
}
