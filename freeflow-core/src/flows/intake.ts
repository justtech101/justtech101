import { z } from "zod";
import type { Deps } from "../core/deps.js";
import { factsBlock } from "../core/facts.js";
import { deferLine, guardReply } from "../core/guard.js";
import { normalizePhone, prettyPhone, spokenPhone } from "../core/phone.js";
import { loadPrompt, render, section, variant } from "../core/prompts.js";
import { logEvent } from "../core/store.js";
import { nextCallbackWindow } from "../core/time.js";

/**
 * The shared intake state machine (System 2). One script, two channels: the
 * voice route and the SMS handler both drive `intakeTurn`. The questions are
 * fixed templates asked by this code in a fixed order — the model only
 * interprets answers, so it cannot improvise new questions.
 */

export type Channel = "voice" | "sms";
export type Step = "need" | "details" | "location" | "urgency" | "name" | "callback_number" | "callback_offer" | "done";
export type Outcome = "booked" | "summary" | "handoff";

export interface IntakeFields {
  need: string | null;
  service_match: string | null;
  details: string | null;
  location: string | null;
  in_service_area: boolean | null;
  urgency: string | null;
  name: string | null;
  callback_number: string | null;
}

export interface IntakeState {
  step: Step;
  fields: IntakeFields;
  pending_number: string | null; // number awaiting read-back confirmation
  number_confirmed: boolean;
  window: { start: string; end: string; text: string } | null;
  human_requests: number;
  off_script: number;
  reasks: number; // re-asks of the current step
  no_input: number;
  outcome: Outcome | null;
  handoff_reason: string | null;
}

const FIELD_STEPS = ["need", "details", "location", "urgency", "name"] as const;

export function newIntake(fromNumber: string | null): IntakeState {
  return {
    step: "need",
    fields: {
      need: null, service_match: null, details: null, location: null, in_service_area: null,
      urgency: null, name: null, callback_number: null,
    },
    pending_number: fromNumber,
    number_confirmed: false,
    window: null,
    human_requests: 0,
    off_script: 0,
    reasks: 0,
    no_input: 0,
    outcome: null,
    handoff_reason: null,
  };
}

export const TurnSchema = z.object({
  intent: z.enum(["answer", "question", "human_request", "upset", "off_script"]),
  extracted: z.object({
    need: z.string().nullable(),
    service_match: z.string().nullable(),
    details: z.string().nullable(),
    location: z.string().nullable(),
    in_service_area: z.boolean().nullable(),
    urgency: z.enum(["today", "this week", "flexible"]).nullable(),
    name: z.string().nullable(),
    callback_number: z.string().nullable(),
    confirm: z.boolean().nullable(),
  }),
  ack: z.string().nullable(),
  answer_to_question: z.string().nullable(),
});
export type TurnOutput = z.infer<typeof TurnSchema>;

function vars(deps: Deps, extra: Record<string, string | null> = {}) {
  return { business_name: deps.config.business_name, owner_name: deps.config.owner_name, ...extra };
}

function t(deps: Deps, key: string, extra: Record<string, string | null> = {}): string {
  return render(variant(loadPrompt("receptionist"), key, deps.env.CHANNEL), vars(deps, extra));
}

function nextStep(s: IntakeState): Step {
  for (const f of FIELD_STEPS) if (!s.fields[f]) return f;
  if (!s.number_confirmed) return "callback_number";
  if (!s.outcome) return "callback_offer";
  return "done";
}

/** The fixed script question for the current step. */
export function questionFor(deps: Deps, s: IntakeState, channel: Channel): string {
  switch (s.step) {
    case "need": return t(deps, "q_need");
    case "details": return t(deps, "q_details");
    case "location": return t(deps, "q_location");
    case "urgency": return t(deps, "q_urgency");
    case "name": return t(deps, "q_name");
    case "callback_number":
      if (!s.pending_number) return t(deps, "q_callback_number_ask");
      if (channel === "sms") return t(deps, "q_callback_number_sms");
      return s.fields.callback_number === null && s.reasks === 0 && s.pending_number
        ? t(deps, "q_callback_number_voice", { spoken_number: spokenPhone(s.pending_number) })
        : t(deps, "q_callback_number_confirm_voice", { spoken_number: spokenPhone(s.pending_number) });
    case "callback_offer":
      return s.window ? t(deps, "q_callback_offer", { window: s.window.text }) : t(deps, "q_callback_offer_no_window");
    case "done": return "";
  }
}

export function closingLine(deps: Deps, s: IntakeState): string {
  const name = s.fields.name ?? "thanks";
  const number = s.fields.callback_number ? prettyPhone(s.fields.callback_number) : "the number you gave";
  if (s.outcome === "booked") {
    return s.window
      ? t(deps, "close_booked", { name, number, window: s.window.text })
      : t(deps, "close_booked_no_window", { name, number });
  }
  if (s.outcome === "handoff") return t(deps, "close_handoff");
  return t(deps, "close_summary");
}

function systemPrompt(deps: Deps, s: IntakeState, channel: Channel): string {
  const collected = JSON.stringify(s.fields);
  return render(section(loadPrompt("receptionist"), "system"), vars(deps, {
    channel: channel === "voice" ? "phone call" : "text message conversation",
    step: s.step,
    question: questionFor(deps, s, channel),
    collected,
    facts: factsBlock(deps.config),
    defer_line: deferLine(deps.config, deps.env.CHANNEL),
  }));
}

export interface TurnContext {
  deps: Deps;
  channel: Channel;
  leadId: number;
  /** Recent turns of this conversation (oldest first), for the model's context. */
  history: { role: "user" | "assistant"; content: string }[];
}

export interface TurnResult {
  state: IntakeState;
  reply: string;
  ended: boolean;
}

function mergeFields(s: IntakeState, x: TurnOutput["extracted"], deps: Deps) {
  const f = s.fields;
  if (x.need && !f.need) f.need = x.need;
  if (x.service_match && !f.service_match && deps.config.services.some((sv) => sv.name === x.service_match)) {
    f.service_match = x.service_match;
  }
  if (x.details && !f.details) f.details = x.details;
  if (x.location && !f.location) f.location = x.location;
  if (x.in_service_area !== null && f.in_service_area === null) f.in_service_area = x.in_service_area;
  if (x.urgency && !f.urgency) f.urgency = x.urgency;
  if (x.name && !f.name) f.name = x.name;
}

async function guarded(ctx: TurnContext, text: string | null): Promise<string | null> {
  if (!text) return null;
  const g = guardReply(text, ctx.deps.config, ctx.deps.env.CHANNEL);
  if (g.violations.length) {
    await logEvent(ctx.deps.db, ctx.leadId, "guardrail", `intake reply blocked: ${g.violations.join("; ")} | original: ${text}`, ctx.deps.clock());
  }
  return g.text;
}

function handoff(s: IntakeState, reason: string): IntakeState {
  return { ...s, outcome: "handoff", handoff_reason: reason, step: "done" };
}

/** Move to the next unanswered step, preparing whatever that step needs. */
function advance(deps: Deps, s: IntakeState): IntakeState {
  const step = nextStep(s);
  if (step !== s.step) s.reasks = 0;
  s.step = step;
  if (step === "callback_offer" && !s.window) {
    const w = nextCallbackWindow(deps.config, deps.clock());
    s.window = w ? { start: w.start.toISOString(), end: w.end.toISOString(), text: w.text } : null;
  }
  return s;
}

/**
 * One caller/customer turn. Throws if the AI layer fails — callers must catch
 * and take the fallback path (voicemail on calls, owner hand-off on SMS).
 */
export async function intakeTurn(ctx: TurnContext, prev: IntakeState, utterance: string): Promise<TurnResult> {
  const { deps, channel } = ctx;
  const cfg = deps.config.receptionist;
  let s: IntakeState = structuredClone(prev);
  s.no_input = 0;

  const out = await deps.ai.structured({
    system: systemPrompt(deps, s, channel),
    messages: [...ctx.history, { role: "user", content: utterance }],
    schema: TurnSchema,
  });

  const done = (state: IntakeState): TurnResult => ({ state, reply: closingLine(deps, state), ended: true });

  if (out.intent === "upset") {
    await logEvent(deps.db, ctx.leadId, "guardrail", "caller upset -> handoff", deps.clock());
    return done(handoff(s, "caller upset"));
  }
  if (out.intent === "human_request") {
    s.human_requests++;
    if (s.human_requests >= cfg.max_human_requests) {
      await logEvent(deps.db, ctx.leadId, "guardrail", `asked for a human ${s.human_requests}x -> handoff`, deps.clock());
      return done(handoff(s, "asked for a human"));
    }
    mergeFields(s, out.extracted, deps);
    s = advance(deps, s);
    return { state: s, reply: `${t(deps, "human_first")} ${questionFor(deps, s, channel)}`, ended: false };
  }
  if (out.intent === "off_script") {
    s.off_script++;
    if (s.off_script >= cfg.max_off_script) {
      await logEvent(deps.db, ctx.leadId, "guardrail", `off-script ${s.off_script}x -> handoff`, deps.clock());
      return done(handoff(s, "conversation went off-script"));
    }
    return { state: s, reply: `${t(deps, "reask_prefix")} ${questionFor(deps, s, channel)}`, ended: false };
  }

  // "answer" or "question": keep anything they told us.
  mergeFields(s, out.extracted, deps);
  const step = s.step;
  const x = out.extracted;

  if (out.intent === "answer") {
    if (step === "callback_number") {
      const stated = x.callback_number ? normalizePhone(x.callback_number) : null;
      if (stated && stated !== s.pending_number) {
        s.pending_number = stated;
        // A newly stated number is always read back before it is accepted.
        if (channel === "sms") {
          s.fields.callback_number = stated;
          s.number_confirmed = true;
        } else {
          s.reasks++;
        }
      } else if ((x.confirm === true || (stated && stated === s.pending_number)) && s.pending_number) {
        s.fields.callback_number = s.pending_number;
        s.number_confirmed = true;
      } else if (x.confirm === false) {
        s.pending_number = null;
        s.reasks++;
      } else {
        s.reasks++;
      }
      if (!s.number_confirmed && s.reasks > 3 && s.pending_number) {
        // Don't loop forever on the read-back: keep the best number we have and flag it.
        s.fields.callback_number = s.pending_number;
        s.number_confirmed = true;
        await logEvent(deps.db, ctx.leadId, "note", "callback number not confirmed after 3 read-backs; using caller ID", deps.clock());
      }
    } else if (step === "callback_offer") {
      if (x.confirm === true) s.outcome = "booked";
      else if (x.confirm === false) s.outcome = "summary";
      else if (++s.reasks >= 2) s.outcome = "summary";
    } else if (step !== "done" && !s.fields[step]) {
      // Didn't get the current field. After two re-asks, record their words verbatim.
      if (++s.reasks > 2) (s.fields as any)[step] = utterance.trim();
    }
  }

  s = advance(deps, s);
  if (s.step === "done") return done(s);

  const lead = out.intent === "question" ? await guarded(ctx, out.answer_to_question) : await guarded(ctx, out.ack);
  const reask = out.intent === "answer" && s.step === step && s.reasks > 0 && step !== "callback_number" ? t(deps, "reask_prefix") : null;
  const reply = [lead, reask, questionFor(deps, s, channel)].filter(Boolean).join(" ");
  return { state: s, reply, ended: false };
}

/** Caller said nothing (voice Gather timed out). */
export function noInputTurn(deps: Deps, prev: IntakeState, channel: Channel): TurnResult {
  const s: IntakeState = structuredClone(prev);
  s.no_input++;
  if (s.no_input >= deps.config.receptionist.max_no_input) {
    s.outcome = "summary";
    s.step = "done";
    return { state: s, reply: t(deps, "close_no_input"), ended: true };
  }
  return { state: s, reply: `${t(deps, "reask_prefix")} ${questionFor(deps, s, channel)}`, ended: false };
}

/** Deterministic one-line next action — no model involved, so nothing invented. */
export function suggestedAction(deps: Deps, f: IntakeFields, outcome: Outcome | null, window: IntakeState["window"]): string {
  const who = f.name ?? "them";
  if (outcome === "handoff") return `Call ${who} personally — automation handed off.`;
  if (outcome === "booked") return `Call ${who} ${window ? window.text : "as soon as you're free"} (booked).`;
  if (f.in_service_area === false) return `Outside ${deps.config.service_area.description ?? "the service area"} — decide on remote help or referral.`;
  if (f.urgency === "today") return `Call ${who} back ASAP — they said it's urgent today.`;
  return `Call ${who} back about ${f.need ?? "their request"}.`;
}

export function summaryText(deps: Deps, phone: string, s: IntakeState, label: string): string {
  const f = s.fields;
  const lines = [
    `${label}: ${f.name ?? "(no name)"} · ${prettyPhone(f.callback_number ?? phone)}`,
    `Need: ${f.need ?? "?"}${f.service_match ? ` [${f.service_match}]` : ""}`,
    f.details ? `Details: ${f.details}` : null,
    `Urgency: ${f.urgency ?? "?"} · Location: ${f.location ?? "?"}${f.in_service_area === false ? " (OUTSIDE AREA)" : ""}`,
    s.handoff_reason ? `Handoff: ${s.handoff_reason}` : null,
    `Next: ${suggestedAction(deps, f, s.outcome, s.window)}`,
  ];
  return lines.filter(Boolean).join("\n");
}
