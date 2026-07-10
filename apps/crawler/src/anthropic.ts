/**
 * Anthropic provider — the OPTIONAL fallback for the provider-neutral LLM layer.
 *
 * The crawler classifies with a LOCAL LM Studio model by default (see ./llm.ts).
 * When `LLM_PROVIDER=anthropic`, `createAnthropicClient()` returns an
 * {@link LlmClient} that maps tiers onto the Messages API:
 *   - tier "default" -> claude-haiku-4-5
 *   - tier "strong"  -> claude-sonnet-4-6
 *
 * The raw Messages client (`AnthropicLike` / `createAnthropicMessagesClient`) is
 * still exported for the web-search discovery path (spec 04), which uses the
 * Anthropic-hosted `web_search` tool and cannot run on a local model.
 *
 * CONTRACT §Stack: claude-haiku-4-5 default, claude-sonnet-4-6 for ambiguous
 * cases; web-search-based discovery.
 */

import type { LlmClient, LlmRequest } from "./llm.js";

/** Fixed model IDs (CONTRACT §Stack — exactly these strings). */
const HAIKU_MODEL = "claude-haiku-4-5";
const SONNET_MODEL = "claude-sonnet-4-6";

/**
 * Minimal subset of the Anthropic messages.create parameters that this project
 * uses. Keeps the interface narrow so fakes stay simple.
 */
export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: string; [key: string]: unknown }>;
  }>;
  /** Tool definitions (used for web_search and structured output). */
  tools?: Array<{
    type: string;
    name: string;
    [key: string]: unknown;
  }>;
  system?: string;
}

/** Minimal content block shape returned in a message. */
export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Minimal response shape from messages.create. */
export interface MessageResponse {
  id: string;
  model: string;
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Injectable interface for the raw Anthropic Messages client. The web-search
 * discovery path (spec 04) uses this directly; classification goes through the
 * provider-neutral {@link LlmClient} instead.
 */
export interface AnthropicLike {
  messages: {
    create(params: MessageCreateParams): Promise<MessageResponse>;
  };
}

/**
 * Build the raw Anthropic Messages client lazily (the SDK is imported only when
 * actually called, so tests that inject a fake never touch it or the network).
 *
 * @param apiKey Defaults to process.env.ANTHROPIC_API_KEY.
 */
export function createAnthropicMessagesClient(
  apiKey: string = process.env.ANTHROPIC_API_KEY ?? "",
): AnthropicLike {
  let client: AnthropicLike | null = null;

  const getClient = async (): Promise<AnthropicLike> => {
    if (client) return client;
    // Dynamic import keeps test bundles from pulling in the SDK.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey }) as unknown as AnthropicLike;
    return client;
  };

  return {
    messages: {
      async create(params: MessageCreateParams): Promise<MessageResponse> {
        const c = await getClient();
        return c.messages.create(params);
      },
    },
  };
}

/** Concatenate the text of a Messages API response's content blocks. */
function responseText(res: MessageResponse): string {
  return res.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * The Anthropic-backed {@link LlmClient}. `complete` translates a provider-
 * neutral request to the Messages API (system + single user message), picks the
 * model from `tier`, and returns the first content block's text.
 *
 * A `jsonSchema` is honoured by appending an instruction to the prompt asking
 * for a raw JSON value matching that schema; the classifier already parses JSON
 * out of the returned text tolerantly, so no tool round-trip is needed here.
 *
 * The underlying Messages client is injectable so tests stay offline.
 */
export function createAnthropicClient(
  apiKey: string = process.env.ANTHROPIC_API_KEY ?? "",
  messagesClient: AnthropicLike = createAnthropicMessagesClient(apiKey),
): LlmClient {
  return {
    label: `anthropic:${HAIKU_MODEL}`,
    async complete(req: LlmRequest): Promise<string> {
      const model = req.tier === "strong" ? SONNET_MODEL : HAIKU_MODEL;
      const user = req.jsonSchema
        ? `${req.user}\n\nReturn ONLY a JSON value matching this JSON Schema:\n${JSON.stringify(
            req.jsonSchema,
          )}`
        : req.user;
      const res = await messagesClient.messages.create({
        model,
        max_tokens: req.maxTokens ?? 2048,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: user }],
      });
      return responseText(res);
    },
  };
}
