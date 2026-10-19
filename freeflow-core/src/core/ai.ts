import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

export interface AiTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * The single AI wrapper. Every model call goes through `structured`, which
 * returns JSON validated against a zod schema — flows never parse free text.
 */
export interface Ai {
  structured<S extends z.ZodType>(args: { system: string; messages: AiTurn[]; schema: S; maxTokens?: number }): Promise<z.infer<S>>;
}

export class AiError extends Error {}

/** The API wants a user turn first and alternating roles: merge neighbours, pad the start. */
export function normalizeTurns(turns: AiTurn[]): AiTurn[] {
  const out: AiTurn[] = [];
  for (const turn of turns) {
    if (!turn.content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.content += `\n${turn.content}`;
    else out.push({ ...turn });
  }
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: "(conversation start)" });
  return out;
}

export class ClaudeAi implements Ai {
  private client: Anthropic;

  constructor(apiKey: string, private model: string) {
    // A caller is waiting on the line and Twilio gives a webhook 15s: fail fast
    // (no retry) so the voicemail fallback answers in time.
    this.client = new Anthropic({ apiKey, timeout: 10_000, maxRetries: 0 });
  }

  async structured<S extends z.ZodType>(args: { system: string; messages: AiTurn[]; schema: S; maxTokens?: number }): Promise<z.infer<S>> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: args.maxTokens ?? 4000,
      system: args.system,
      messages: normalizeTurns(args.messages),
      // Short conversational turns: low effort keeps latency down for live calls.
      output_config: { effort: "low", format: betaZodOutputFormat(args.schema) },
      // On a policy decline, let the API re-run the request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") {
      throw new AiError(`model declined: ${response.stop_details?.category ?? "unknown"}`);
    }
    if (response.stop_reason === "max_tokens") throw new AiError("model hit max_tokens");
    if (response.parsed_output == null) throw new AiError("model returned no parseable output");
    return response.parsed_output as z.infer<S>;
  }
}

/** Used when AI_DISABLED=true or no key is set: every call fails, exercising the fallbacks. */
export class DisabledAi implements Ai {
  async structured(): Promise<never> {
    throw new AiError("AI layer disabled");
  }
}
