/**
 * Provider-neutral LLM layer.
 *
 * The crawler classifies with a LOCAL model by default (LM Studio, an
 * OpenAI-compatible server on the user's Mac) so a run costs nothing. Anthropic
 * is an optional fallback provider, selected via `LLM_PROVIDER=anthropic`.
 *
 * Everything above the wire is provider-agnostic: the classifier depends only on
 * `LlmClient.complete(...)`. The two concrete clients (LM Studio here, Anthropic
 * in ./anthropic.ts) translate a `LlmRequest` to their own API.
 *
 * CONTRACT §Stack, §Environment variables.
 */

import { createAnthropicClient } from "./anthropic.js";

/**
 * A single completion request. `complete` returns the assistant message TEXT
 * (callers do their own JSON parsing). `tier` maps to a model class:
 *   - "default" — the everyday/cheap model (haiku on Anthropic).
 *   - "strong"  — the more capable model for ambiguous cases (sonnet on Anthropic).
 * On a local single-model server both tiers map to the one loaded model.
 *
 * `jsonSchema` (when set) asks the provider to constrain output to that JSON
 * Schema (LM Studio structured output / Anthropic tool schema), which makes the
 * returned JSON reliable.
 */
export interface LlmRequest {
  system?: string;
  user: string;
  tier?: "default" | "strong";
  maxTokens?: number;
  jsonSchema?: object;
}

/**
 * The one interface the classifier (and any future LLM caller) depends on.
 * `label` names the provider+model for a single per-run log line.
 */
export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
  readonly label: string;
}

/** Minimal fetch signature used by the LM Studio client (injectable for tests). */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Options for {@link createLmStudioClient}. */
export interface LmStudioOptions {
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1. */
  baseUrl?: string;
  /** The loaded model id (both tiers map to it). */
  model?: string;
  /** Injectable fetch (defaults to global fetch); tests inject a fake. */
  fetch?: FetchLike;
}

/** Default max tokens when a request does not set `maxTokens`. */
const DEFAULT_MAX_TOKENS = 2048;

/** The OpenAI chat-completions response shape we read. */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * LM Studio client (OpenAI-compatible chat completions). POSTs to
 * `${baseUrl}/chat/completions` with a system+user message pair, temperature 0,
 * and — when `jsonSchema` is set — a `response_format` json_schema so the local
 * model returns strict JSON. Returns `choices[0].message.content`.
 *
 * The single loaded model serves BOTH tiers (`default` and `strong`).
 */
export function createLmStudioClient(opts: LmStudioOptions = {}): LlmClient {
  const baseUrl =
    opts.baseUrl ?? process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
  const model =
    opts.model ?? process.env.LMSTUDIO_MODEL ?? "qwen2.5-32b-instruct";
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);

  return {
    label: `lmstudio:${model}`,
    async complete(req: LlmRequest): Promise<string> {
      const messages: Array<{ role: "system" | "user"; content: string }> = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      messages.push({ role: "user", content: req.user });

      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (req.jsonSchema) {
        // LM Studio structured output — strict json_schema constraint.
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "out", strict: true, schema: req.jsonSchema },
        };
      }

      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`lmstudio: HTTP ${res.status}`);
      }
      const json = (await res.json()) as ChatCompletionResponse;
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("lmstudio: missing choices[0].message.content");
      }
      return content;
    },
  };
}

/**
 * The factory the pipeline calls. Reads `LLM_PROVIDER` (default "lmstudio"):
 *   - "lmstudio"  -> {@link createLmStudioClient}
 *   - "anthropic" -> the Anthropic-backed LlmClient (see ./anthropic.ts)
 *
 * `opts` are forwarded to the selected client so tests can inject a fetch/key.
 */
export function createLlmClient(opts?: {
  provider?: string;
  lmStudio?: LmStudioOptions;
  anthropicApiKey?: string;
}): LlmClient {
  const provider = opts?.provider ?? process.env.LLM_PROVIDER ?? "lmstudio";
  if (provider === "anthropic") {
    return createAnthropicClient(opts?.anthropicApiKey);
  }
  return createLmStudioClient(opts?.lmStudio);
}
