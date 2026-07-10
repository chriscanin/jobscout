/**
 * LLM layer tests — the provider-neutral abstraction (src/llm.ts).
 *
 * Discipline: NO network. `createLmStudioClient` takes an injected `fetch`, so
 * we assert it POSTs an OpenAI-shaped chat-completions request (with the
 * response_format json_schema when a schema is passed) and returns the assistant
 * message content — all in-process.
 */

import { describe, expect, it } from "vitest";
import {
  createLmStudioClient,
  createLlmClient,
  type FetchLike,
} from "../src/llm.js";

/** A capturing fake fetch that returns a canned chat-completions body. */
function fakeFetch(content: string): {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: RequestInit; body: unknown }>;
} {
  const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, init, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content } }],
      }),
    };
  };
  return { fetch: fetchImpl, calls };
}

describe("createLmStudioClient", () => {
  it("POSTs OpenAI-shaped chat-completions and returns the message content", async () => {
    const { fetch, calls } = fakeFetch("hello from the local model");
    const client = createLmStudioClient({
      baseUrl: "http://localhost:1234/v1",
      model: "qwen2.5-32b-instruct",
      fetch,
    });

    const out = await client.complete({
      system: "you are a scorer",
      user: "score these jobs",
      maxTokens: 512,
    });

    expect(out).toBe("hello from the local model");
    expect(calls).toHaveLength(1);

    // Correct endpoint.
    expect(calls[0].url).toBe("http://localhost:1234/v1/chat/completions");

    // OpenAI-shaped body: model, system+user messages, temperature 0, max_tokens.
    const body = calls[0].body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      max_tokens: number;
      response_format?: unknown;
    };
    expect(body.model).toBe("qwen2.5-32b-instruct");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(512);
    expect(body.messages).toEqual([
      { role: "system", content: "you are a scorer" },
      { role: "user", content: "score these jobs" },
    ]);
    // No schema passed → no response_format.
    expect(body.response_format).toBeUndefined();
  });

  it("sets response_format json_schema when a jsonSchema is passed", async () => {
    const { fetch, calls } = fakeFetch('{"results":[]}');
    const client = createLmStudioClient({ model: "qwen2.5-32b-instruct", fetch });

    const schema = {
      type: "object",
      properties: { results: { type: "array" } },
      required: ["results"],
    };
    const out = await client.complete({ user: "go", jsonSchema: schema });

    expect(out).toBe('{"results":[]}');
    const body = calls[0].body as {
      messages: Array<{ role: string }>;
      response_format?: {
        type: string;
        json_schema: { name: string; strict: boolean; schema: unknown };
      };
    };
    // No system message when none is provided.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    // LM Studio structured-output shape.
    expect(body.response_format).toBeDefined();
    expect(body.response_format!.type).toBe("json_schema");
    expect(body.response_format!.json_schema.name).toBe("out");
    expect(body.response_format!.json_schema.strict).toBe(true);
    expect(body.response_format!.json_schema.schema).toEqual(schema);
  });

  it("defaults baseUrl and model, and labels itself lmstudio:<model>", () => {
    const client = createLmStudioClient({});
    expect(client.label).toBe("lmstudio:qwen2.5-32b-instruct");
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const client = createLmStudioClient({ fetch: fetchImpl });
    await expect(client.complete({ user: "x" })).rejects.toThrow(/HTTP 500/);
  });
});

describe("createLlmClient factory", () => {
  it("defaults to the LM Studio provider", () => {
    const client = createLlmClient({ lmStudio: { model: "m" } });
    expect(client.label).toBe("lmstudio:m");
  });

  it("selects the LM Studio provider explicitly", () => {
    const client = createLlmClient({ provider: "lmstudio", lmStudio: { model: "m" } });
    expect(client.label).toBe("lmstudio:m");
  });

  it("selects the Anthropic provider when provider=anthropic", () => {
    const client = createLlmClient({ provider: "anthropic", anthropicApiKey: "sk-x" });
    expect(client.label).toBe("anthropic:claude-haiku-4-5");
  });
});
