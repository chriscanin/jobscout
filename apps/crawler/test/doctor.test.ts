/**
 * Doctor tests — spec 07 Scenarios 5–6.
 *
 * Discipline: NO network, NO real DB. Every dependency the network/db checks
 * touch is injected (env, makeDb, fetchImpl, makeAnthropic), so the whole doctor
 * run is offline and deterministic. The Discord check is GET-only (never POSTs).
 *
 * The LLM check is provider-aware: with LLM_PROVIDER=lmstudio (the default) it
 * GETs `${LMSTUDIO_BASE_URL}/models`; with LLM_PROVIDER=anthropic it makes a
 * 1-token haiku call. Both are exercised offline via the injected fetchImpl /
 * makeAnthropic.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkEnv,
  runDoctor,
  printDoctor,
  REQUIRED_ENV_VARS,
  llmRequiredEnvVars,
  type DoctorDeps,
} from "../src/cli.js";
import type { Db, Logger } from "@jobscout/core";
import type { AnthropicLike, MessageResponse } from "../src/anthropic.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");

async function loadJson<T>(rel: string): Promise<T> {
  return JSON.parse(await readFile(path.join(FIX, rel), "utf8")) as T;
}

/** A logger that captures every line for assertions. */
function capturingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (m: string, ...a: unknown[]) =>
      lines.push(`${level} ${m} ${a.map((x) => String(x)).join(" ")}`.trim());
  return {
    lines,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

/** A Db stub whose four tables + criteria row all "exist". */
function healthyDb(): Db {
  return {
    async query(text: string) {
      if (/from criteria where id = 1/.test(text)) return { rows: [{ "?column?": 1 }] };
      return { rows: [{ "?column?": 1 }] };
    },
  };
}

/** A GET-only Discord fetch that returns the captured webhook-get metadata. */
function discordGetFetch(meta: { id: string; token: string }): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requests: { method: string; url: string }[];
} {
  const requests: { method: string; url: string }[] = [];
  return {
    requests,
    fetchImpl: async (input, init) => {
      requests.push({
        method: (init?.method ?? "GET").toUpperCase(),
        url: String(input),
      });
      return new Response(JSON.stringify(meta), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

/**
 * A fetch that answers BOTH the Discord GET (webhook metadata) and the LM Studio
 * GET /models (returns a list containing `modelId`). Records every request so
 * tests can assert the doctor never POSTs and hits /models exactly once.
 */
function lmStudioAndDiscordFetch(
  meta: { id: string; token: string },
  modelId: string,
): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requests: { method: string; url: string }[];
} {
  const requests: { method: string; url: string }[] = [];
  return {
    requests,
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({ method: (init?.method ?? "GET").toUpperCase(), url });
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Discord webhook metadata.
      return new Response(JSON.stringify(meta), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

/** An Anthropic stub that returns the captured 1-token ping response. */
function anthropicStub(ping: MessageResponse): {
  makeAnthropic: NonNullable<DoctorDeps["makeAnthropic"]>;
  calls: { model: string; max_tokens: number }[];
} {
  const calls: { model: string; max_tokens: number }[] = [];
  const client: AnthropicLike = {
    messages: {
      async create(params) {
        calls.push({ model: params.model, max_tokens: params.max_tokens });
        return ping;
      },
    },
  };
  return { calls, makeAnthropic: () => client };
}

/** The default (lmstudio provider) full env. */
const FULL_ENV: NodeJS.ProcessEnv = {
  SUPABASE_DB_URL: "postgres://user:pw@localhost:5432/jobscout",
  LLM_PROVIDER: "lmstudio",
  LMSTUDIO_BASE_URL: "http://localhost:1234/v1",
  LMSTUDIO_MODEL: "qwen2.5-32b-instruct",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
};

/** The anthropic-provider full env. */
const ANTHROPIC_ENV: NodeJS.ProcessEnv = {
  SUPABASE_DB_URL: "postgres://user:pw@localhost:5432/jobscout",
  LLM_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-ant-test",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
};

// ---------------------------------------------------------------------------
// checkEnv unit test (env-var check is unit-testable in isolation).
// ---------------------------------------------------------------------------

describe("checkEnv", () => {
  it("passes when all required vars are set (lmstudio default)", () => {
    const c = checkEnv(FULL_ENV);
    expect(c.ok).toBe(true);
    expect(c.name).toBe("env");
  });

  it("does NOT require ANTHROPIC_API_KEY when provider is lmstudio (default)", () => {
    // No ANTHROPIC_API_KEY set at all — still passes.
    const c = checkEnv(FULL_ENV);
    expect(c.ok).toBe(true);
  });

  it("names each missing var and fails (lmstudio)", () => {
    const c = checkEnv({
      SUPABASE_DB_URL: "x",
      LLM_PROVIDER: "lmstudio",
      LMSTUDIO_BASE_URL: "http://localhost:1234/v1",
      LMSTUDIO_MODEL: "qwen2.5-32b-instruct",
    });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("DISCORD_WEBHOOK_URL");
  });

  it("requires the LM Studio vars when provider is lmstudio", () => {
    const c = checkEnv({
      SUPABASE_DB_URL: "x",
      DISCORD_WEBHOOK_URL: "y",
      LLM_PROVIDER: "lmstudio",
      // LMSTUDIO_BASE_URL / LMSTUDIO_MODEL missing.
    });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("LMSTUDIO_BASE_URL");
    expect(c.detail).toContain("LMSTUDIO_MODEL");
  });

  it("requires ANTHROPIC_API_KEY when provider is anthropic", () => {
    const c = checkEnv({
      SUPABASE_DB_URL: "x",
      DISCORD_WEBHOOK_URL: "y",
      LLM_PROVIDER: "anthropic",
      // ANTHROPIC_API_KEY missing.
    });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("treats an empty string as missing", () => {
    const c = checkEnv({ ...FULL_ENV, LMSTUDIO_MODEL: "  " });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("LMSTUDIO_MODEL");
  });

  it("lists the always-required env vars (provider vars are added separately)", () => {
    expect([...REQUIRED_ENV_VARS]).toEqual([
      "SUPABASE_DB_URL",
      "DISCORD_WEBHOOK_URL",
    ]);
    expect([...llmRequiredEnvVars("lmstudio")]).toEqual([
      "LMSTUDIO_BASE_URL",
      "LMSTUDIO_MODEL",
    ]);
    expect([...llmRequiredEnvVars("anthropic")]).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Doctor names a missing env var and exits 1
// ---------------------------------------------------------------------------

describe("Scenario 5 — missing DISCORD_WEBHOOK_URL", () => {
  it("exits 1, names DISCORD_WEBHOOK_URL, runs all four checks, zero Discord requests", async () => {
    const env: NodeJS.ProcessEnv = {
      SUPABASE_DB_URL: FULL_ENV.SUPABASE_DB_URL,
      LLM_PROVIDER: "lmstudio",
      LMSTUDIO_BASE_URL: FULL_ENV.LMSTUDIO_BASE_URL,
      LMSTUDIO_MODEL: FULL_ENV.LMSTUDIO_MODEL,
      // DISCORD_WEBHOOK_URL intentionally unset.
    };
    const net = lmStudioAndDiscordFetch({ id: "1", token: "t" }, "qwen2.5-32b-instruct");

    const result = await runDoctor({
      env,
      makeDb: () => healthyDb(),
      fetchImpl: net.fetchImpl,
    });

    expect(result.exitCode).toBe(1);

    // All four checks are reported (nothing short-circuits).
    const names = result.checks.map((c) => c.name);
    expect(names).toEqual(["env", "supabase", "discord", "llm"]);

    // The output names the missing var.
    const logger = capturingLogger();
    const code = printDoctor(result, logger);
    expect(code).toBe(1);
    expect(logger.lines.join("\n")).toContain("DISCORD_WEBHOOK_URL");

    // Discord check short-circuits on the unset URL → no Discord GET was issued.
    expect(net.requests.filter((r) => r.url.includes("/discord"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Doctor green path checks without posting (lmstudio default)
// ---------------------------------------------------------------------------

describe("Scenario 6 — green path, GET-only Discord, LM Studio /models", () => {
  it("exits 0; Discord GET only (no POST); llm check GETs /models once", async () => {
    const meta = await loadJson<{ id: string; token: string }>("discord/webhook-get.json");
    const net = lmStudioAndDiscordFetch(meta, "qwen2.5-32b-instruct");

    const result = await runDoctor({
      env: FULL_ENV,
      makeDb: () => healthyDb(),
      fetchImpl: net.fetchImpl,
    });

    expect(result.exitCode).toBe(0);
    for (const c of result.checks) expect(c.ok).toBe(true);

    // Exactly one Discord GET, zero POSTs.
    const discordReqs = net.requests.filter((r) => r.url.includes("/discord"));
    expect(discordReqs).toHaveLength(1);
    expect(discordReqs[0].method).toBe("GET");
    expect(discordReqs.filter((r) => r.method === "POST")).toHaveLength(0);

    // The llm check GETs the LM Studio /models endpoint exactly once.
    const modelsReqs = net.requests.filter((r) => r.url.endsWith("/models"));
    expect(modelsReqs).toHaveLength(1);
    expect(modelsReqs[0].method).toBe("GET");
    expect(modelsReqs[0].url).toBe("http://localhost:1234/v1/models");

    // The llm check names the base URL + model.
    const llmCheck = result.checks.find((c) => c.name === "llm")!;
    expect(llmCheck.detail).toContain("http://localhost:1234/v1");
    expect(llmCheck.detail).toContain("qwen2.5-32b-instruct");
  });

  it("fails the llm check when the configured model is not loaded", async () => {
    const meta = await loadJson<{ id: string; token: string }>("discord/webhook-get.json");
    // /models returns a DIFFERENT model than LMSTUDIO_MODEL.
    const net = lmStudioAndDiscordFetch(meta, "some-other-model");

    const result = await runDoctor({
      env: FULL_ENV,
      makeDb: () => healthyDb(),
      fetchImpl: net.fetchImpl,
    });

    const llmCheck = result.checks.find((c) => c.name === "llm")!;
    expect(llmCheck.ok).toBe(false);
    expect(llmCheck.detail).toContain("not loaded");
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Anthropic-provider branch — 1-token haiku call, no LM Studio /models GET
// ---------------------------------------------------------------------------

describe("llm check — anthropic provider", () => {
  it("exits 0; Anthropic called once with haiku + max_tokens 1; no /models GET", async () => {
    const meta = await loadJson<{ id: string; token: string }>("discord/webhook-get.json");
    const discord = discordGetFetch(meta);
    const ping = await loadJson<MessageResponse>("anthropic/messages-ping.json");
    const anth = anthropicStub(ping);

    const result = await runDoctor({
      env: ANTHROPIC_ENV,
      makeDb: () => healthyDb(),
      fetchImpl: discord.fetchImpl,
      makeAnthropic: anth.makeAnthropic,
    });

    expect(result.exitCode).toBe(0);
    for (const c of result.checks) expect(c.ok).toBe(true);

    // Exactly one Anthropic call: claude-haiku-4-5, max_tokens 1.
    expect(anth.calls).toHaveLength(1);
    expect(anth.calls[0].model).toBe("claude-haiku-4-5");
    expect(anth.calls[0].max_tokens).toBe(1);

    // No LM Studio /models GET in the anthropic branch.
    expect(discord.requests.filter((r) => r.url.endsWith("/models"))).toHaveLength(0);
  });
});
