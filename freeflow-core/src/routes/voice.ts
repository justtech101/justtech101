import { Router, type Request } from "express";
import twilio from "twilio";
import type { Deps } from "../core/deps.js";
import { alertOwner } from "../core/notify.js";
import { normalizePhone, prettyPhone } from "../core/phone.js";
import { loadPrompt, render, section } from "../core/prompts.js";
import { getLead, insertMessage, listMessages, logEvent, updateLead, upsertLead, type Lead } from "../core/store.js";
import { intakeTurn, newIntake, noInputTurn, questionFor, type IntakeState } from "../flows/intake.js";
import { finalizeIntake } from "../flows/receptionist.js";
import { handleMissedCall } from "../flows/textback.js";
import { twilioAuth } from "./webhooks.js";

const { VoiceResponse } = twilio.twiml;
type Twiml = InstanceType<typeof VoiceResponse>;

interface CallRow {
  call_sid: string;
  lead_id: number;
  from_number: string;
  dial_status: string | null;
  owner_answered: boolean;
  state: IntakeState | Record<string, never>;
  outcome: string | null;
  started_at: Date;
  ended_at: Date | null;
}

const MISSED_DIAL = new Set(["no-answer", "busy", "failed", "canceled"]);
const INTAKE_DONE = new Set(["booked", "summary", "handoff"]);

export function voiceRoutes(deps: Deps): Router {
  const r = Router();
  const base = deps.env.PUBLIC_BASE_URL;
  const auth = twilioAuth(deps);

  const t = (key: string, extra: Record<string, string | null> = {}) =>
    render(section(loadPrompt("receptionist"), key), {
      business_name: deps.config.business_name,
      owner_name: deps.config.owner_name,
      ...extra,
    });
  const say = (node: { say: Twiml["say"] }, text: string) => node.say({ voice: deps.config.voice.tts_voice as any }, text);
  const send = (res: any, twiml: Twiml) => res.type("text/xml").send(twiml.toString());

  async function getCall(sid: string): Promise<CallRow | null> {
    const { rows } = await deps.db.query("SELECT * FROM calls WHERE call_sid = $1", [sid]);
    return rows[0] ? { ...rows[0], lead_id: Number(rows[0].lead_id) } : null;
  }
  async function saveCall(sid: string, patch: Partial<Pick<CallRow, "dial_status" | "owner_answered" | "state" | "outcome" | "ended_at">>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const vals = keys.map((k) => (k === "state" ? JSON.stringify((patch as any)[k]) : (patch as any)[k]));
    await deps.db.query(`UPDATE calls SET ${sets} WHERE call_sid = $1`, [sid, ...vals]);
  }
  async function transcript(lead: Lead, direction: "inbound" | "outbound", body: string, kind: string) {
    await insertMessage(deps.db, { lead_id: lead.id, direction, channel: "voice-transcript", body, at: deps.clock(), kind });
  }

  function gather(twiml: Twiml, text: string) {
    const g = twiml.gather({
      input: ["speech", "dtmf"],
      action: `${base}/voice/gather`,
      method: "POST",
      speechTimeout: "auto",
      timeout: 6,
      language: "en-US",
      speechModel: "phone_call",
      actionOnEmptyResult: true,
    });
    say(g, text);
  }

  /** Never silence, never a raw error: play the message, take a voicemail, alert Jesse. */
  async function voicemailFallback(twiml: Twiml, lead: Lead | null, sid: string | null, reason: string) {
    say(twiml, t("fallback_voicemail"));
    twiml.record({ action: `${base}/voice/voicemail`, maxLength: 120, playBeep: true, finishOnKey: "#" });
    say(twiml, t("voicemail_thanks"));
    if (sid) await saveCall(sid, { outcome: "voicemail" });
    await logEvent(deps.db, lead?.id ?? null, "error", `voice fallback to voicemail: ${reason}`, deps.clock());
    await alertOwner(deps, `Call from ${lead ? prettyPhone(lead.phone) : "unknown"} hit the voicemail fallback (${reason}).`, lead?.id ?? null);
  }

  async function receptionistStart(twiml: Twiml, call: CallRow, lead: Lead) {
    if (!deps.config.voice.receptionist_enabled) {
      say(twiml, t("owner_unavailable_no_receptionist"));
      twiml.hangup();
      return;
    }
    if (deps.env.AI_DISABLED || !deps.env.ANTHROPIC_API_KEY) return voicemailFallback(twiml, lead, call.call_sid, "AI layer disabled");
    const state = newIntake(lead.phone);
    await saveCall(call.call_sid, { state });
    await logEvent(deps.db, lead.id, "intake_started", "voice", deps.clock());
    const greeting = `${t("greeting_voice")} ${questionFor(deps, state, "voice")}`;
    await transcript(lead, "outbound", greeting, "intake_question");
    gather(twiml, greeting);
  }

  // Inbound call to the business number.
  r.post("/voice/incoming", auth, async (req, res) => {
    const twiml = new VoiceResponse();
    try {
      const sid = String(req.body.CallSid);
      const phone = normalizePhone(String(req.body.From ?? ""));
      if (!phone) {
        // Blocked caller ID: no lead to attach state to — straight to voicemail.
        await voicemailFallback(twiml, null, null, "blocked caller ID");
        return send(res, twiml);
      }
      const now = deps.clock();
      let { lead } = await upsertLead(deps.db, { phone, source: "call", consent_source: "inbound_call" }, now);
      await deps.db.query(
        `INSERT INTO calls (call_sid, lead_id, from_number, started_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [sid, lead.id, phone, now],
      );
      await logEvent(deps.db, lead.id, "call", `inbound call ${sid}`, now);
      if (lead.flow === "textback") {
        // Caller rang again mid-text-thread: voice takes over, the SMS thread notes it.
        const note = render(section(loadPrompt("textback"), "now_on_call"), {});
        await insertMessage(deps.db, { lead_id: lead.id, direction: "note", channel: "sms", body: note, at: now, kind: "note" });
        lead = await updateLead(deps.db, lead.id, { flow: null });
      }
      const call = (await getCall(sid))!;
      if (deps.env.OWNER_FORWARD_NUMBER) {
        const dial = twiml.dial({
          action: `${base}/voice/dial-complete`,
          timeout: deps.config.voice.ring_owner_seconds,
          answerOnBridge: true,
        });
        // Call screening: the owner presses 1 to take it, so a carrier voicemail can't "answer".
        dial.number({ url: `${base}/voice/screen` }, deps.env.OWNER_FORWARD_NUMBER);
      } else {
        await receptionistStart(twiml, call, lead);
      }
    } catch (err: any) {
      console.error("[voice/incoming]", err);
      await voicemailFallback(twiml, null, null, `incoming handler error: ${err?.message ?? err}`).catch(() => undefined);
    }
    send(res, twiml);
  });

  // Whisper to the owner's phone before connecting.
  r.post("/voice/screen", auth, async (_req, res) => {
    const twiml = new VoiceResponse();
    const g = twiml.gather({ numDigits: 1, timeout: 6, action: `${base}/voice/screen-result`, method: "POST" });
    say(g, `${deps.config.business_name} call. Press 1 to take it.`);
    twiml.hangup();
    send(res, twiml);
  });
  r.post("/voice/screen-result", auth, async (req, res) => {
    const twiml = new VoiceResponse();
    if (String(req.body.Digits) !== "1") twiml.hangup();
    send(res, twiml); // empty response = connect the call
  });

  // Result of ringing the owner.
  r.post("/voice/dial-complete", auth, async (req, res) => {
    const twiml = new VoiceResponse();
    try {
      const sid = String(req.body.CallSid);
      const status = String(req.body.DialCallStatus ?? "");
      const call = await getCall(sid);
      const lead = call ? await getLead(deps.db, call.lead_id) : null;
      if (!call || !lead) {
        await voicemailFallback(twiml, lead, null, "unknown call at dial-complete");
        return send(res, twiml);
      }
      await saveCall(sid, { dial_status: status, owner_answered: status === "completed" });
      if (status === "completed") {
        twiml.hangup();
      } else if (MISSED_DIAL.has(status)) {
        await logEvent(deps.db, lead.id, "missed_call", `owner didn't answer (${status})`, deps.clock());
        await receptionistStart(twiml, call, lead);
      } else {
        twiml.hangup();
      }
    } catch (err: any) {
      console.error("[voice/dial-complete]", err);
      await voicemailFallback(twiml, null, null, `dial-complete error: ${err?.message ?? err}`).catch(() => undefined);
    }
    send(res, twiml);
  });

  // One intake turn on the phone.
  r.post("/voice/gather", auth, async (req, res) => {
    const twiml = new VoiceResponse();
    const sid = String(req.body.CallSid);
    let lead: Lead | null = null;
    try {
      const call = await getCall(sid);
      lead = call ? await getLead(deps.db, call.lead_id) : null;
      if (!call || !lead || !("step" in call.state)) {
        await voicemailFallback(twiml, lead, call ? sid : null, "lost call state");
        return send(res, twiml);
      }
      const speech = String(req.body.SpeechResult ?? req.body.Digits ?? "").trim();
      const state = call.state as IntakeState;
      let result;
      if (!speech) {
        result = noInputTurn(deps, state, "voice");
      } else {
        const prior = await listMessages(deps.db, lead.id, { channel: "voice-transcript", since: call.started_at });
        await transcript(lead, "inbound", speech, "caller");
        const history = prior.map((m) => ({ role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const), content: m.body }));
        try {
          result = await intakeTurn({ deps, channel: "voice", leadId: lead.id, history }, state, speech);
        } catch (err: any) {
          await voicemailFallback(twiml, lead, sid, `AI error: ${err?.message ?? err}`);
          return send(res, twiml);
        }
      }
      await saveCall(sid, { state: result.state });
      await transcript(lead, "outbound", result.reply, result.ended ? "intake_close" : "intake_question");
      if (result.ended) {
        say(twiml, result.reply);
        twiml.hangup();
        await saveCall(sid, { outcome: result.state.outcome });
        await finalizeIntake(deps, lead, result.state, "voice");
      } else {
        gather(twiml, result.reply);
      }
    } catch (err: any) {
      console.error("[voice/gather]", err);
      await voicemailFallback(twiml, lead, null, `gather error: ${err?.message ?? err}`).catch(() => undefined);
    }
    send(res, twiml);
  });

  // Voicemail recorded (fallback path).
  r.post("/voice/voicemail", auth, async (req, res) => {
    const twiml = new VoiceResponse();
    say(twiml, t("voicemail_thanks"));
    twiml.hangup();
    try {
      const call = await getCall(String(req.body.CallSid));
      const lead = call ? await getLead(deps.db, call.lead_id) : null;
      const url = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : "(no recording)";
      if (lead) {
        await transcript(lead, "inbound", `[voicemail ${req.body.RecordingDuration ?? "?"}s] ${url}`, "voicemail");
        await logEvent(deps.db, lead.id, "voicemail", url, deps.clock());
      }
      await alertOwner(deps, `Voicemail from ${lead ? prettyPhone(lead.phone) : String(req.body.From ?? "unknown")}: ${url}`, lead?.id ?? null);
    } catch (err) {
      console.error("[voice/voicemail]", err);
    }
    send(res, twiml);
  });

  // Call ended (configure as the number's "call status changes" callback).
  r.post("/voice/status", auth, async (req, res) => {
    try {
      const status = String(req.body.CallStatus ?? "");
      if (!["completed", "busy", "no-answer", "failed", "canceled"].includes(status)) return;
      const sid = String(req.body.CallSid);
      const call = await getCall(sid);
      if (!call || call.ended_at) return;
      await saveCall(sid, { ended_at: deps.clock() });
      if (call.owner_answered || INTAKE_DONE.has(call.outcome ?? "")) return;
      const lead = await getLead(deps.db, call.lead_id);
      if (!lead) return;
      const state = call.state as IntakeState;
      const captured = "fields" in state && Object.values(state.fields).some((v) => v !== null);
      if (captured) {
        // Hung up mid-intake: Jesse gets what we have now; no text-back on top.
        const s: IntakeState = { ...state, outcome: "summary", handoff_reason: "caller hung up mid-intake" };
        await saveCall(sid, { outcome: "summary" });
        await finalizeIntake(deps, lead, s, "voice");
        return;
      }
      // Nobody (human or receptionist) got anything from this caller: System 1 texts them back.
      await handleMissedCall(deps, { from: lead.phone, callSid: sid });
    } catch (err) {
      console.error("[voice/status]", err);
    } finally {
      res.type("text/xml").send("<Response/>");
    }
  });

  // Twilio "primary handler fails" URL: no DB, no AI — just never leave a caller in silence.
  r.post("/voice/fallback", async (_req: Request, res) => {
    const twiml = new VoiceResponse();
    say(twiml, t("fallback_voicemail"));
    twiml.record({ action: `${base}/voice/voicemail`, maxLength: 120, playBeep: true, finishOnKey: "#" });
    send(res, twiml);
  });

  return r;
}
