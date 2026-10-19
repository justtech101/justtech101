import { Router, type NextFunction, type Request, type Response } from "express";
import type { Deps } from "../core/deps.js";
import { alertOwner } from "../core/notify.js";
import { isOptOutError } from "../core/outbound.js";
import { prettyPhone } from "../core/phone.js";
import { getLead, logEvent, updateLead } from "../core/store.js";
import { validTwilioSignature } from "../core/telephony.js";

/** Rejects webhook calls that aren't signed by Twilio (unless validation is disabled for local dev). */
export function twilioAuth(deps: Deps) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!deps.env.TWILIO_VALIDATE_SIGNATURES) return next();
    const url = `${deps.env.PUBLIC_BASE_URL}${req.originalUrl}`;
    if (validTwilioSignature(deps.env.TWILIO_AUTH_TOKEN, req.header("X-Twilio-Signature"), url, req.body ?? {})) return next();
    res.status(403).send("invalid signature");
  };
}

/** Twilio delivery-status callbacks for every outbound text. */
export function webhookRoutes(deps: Deps): Router {
  const r = Router();
  r.post("/webhooks/sms-status", twilioAuth(deps), async (req, res) => {
    const { MessageSid, MessageStatus, ErrorCode } = req.body ?? {};
    try {
      const { rows } = await deps.db.query(
        `UPDATE messages SET status = $2, error = COALESCE($3, error) WHERE provider_sid = $1 RETURNING *`,
        [MessageSid, MessageStatus, ErrorCode ? `twilio ${ErrorCode}` : null],
      );
      const msg = rows[0];
      if (!msg || !["failed", "undelivered"].includes(MessageStatus)) return;
      const now = deps.clock();
      const lead = await getLead(deps.db, Number(msg.lead_id));
      if (!lead) return;
      await logEvent(deps.db, lead.id, "error", `delivery ${MessageStatus} (${msg.kind}): twilio ${ErrorCode ?? "?"}`, now);
      if (isOptOutError(String(ErrorCode))) {
        await updateLead(deps.db, lead.id, { opted_out_at: now, status: "closed", flow: null });
        await logEvent(deps.db, lead.id, "stop", "carrier reports number opted out (21610)", now);
        return;
      }
      if (msg.kind === "opener") {
        // Landline or non-SMS number: the text never arrived — tell Jesse it's a plain missed call.
        await updateLead(deps.db, lead.id, { flow: null });
        await alertOwner(deps, `Missed call from ${prettyPhone(lead.phone)} — text-back didn't deliver (likely landline). Please call them.`, lead.id);
      } else {
        await alertOwner(deps, `Text to ${prettyPhone(lead.phone)} (${msg.kind}) failed to deliver (twilio ${ErrorCode ?? "?"}).`, lead.id);
      }
    } catch (err) {
      console.error("[sms-status]", err);
    } finally {
      res.type("text/xml").send("<Response/>");
    }
  });
  return r;
}
