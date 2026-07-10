/**
 * Thin injectable Anthropic client wrapper.
 *
 * Lanes 04 (discovery) and 05 (classifier) will inject fakes in tests.
 * No prompt logic lives here — that belongs in classifier.ts / discovery.ts.
 *
 * CONTRACT §Stack: Anthropic API for classification (claude-haiku-4-5 default,
 * claude-sonnet-4-6 for ambiguous cases) and web-search-based discovery.
 */

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
 * Injectable interface for the Anthropic client used by this project.
 * Lanes 04/05 inject a fake that satisfies this interface.
 */
export interface AnthropicLike {
  messages: {
    create(params: MessageCreateParams): Promise<MessageResponse>;
  };
}

/**
 * Build the real Anthropic client lazily (imported only when actually called,
 * so tests that inject a fake never touch the SDK or the network).
 *
 * @param apiKey Defaults to process.env.ANTHROPIC_API_KEY.
 */
export function createAnthropicClient(
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
