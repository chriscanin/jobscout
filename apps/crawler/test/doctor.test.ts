/**
 * Doctor tests — spec 07 Scenarios 5–6.
 *
 * Discipline: NO network, NO real DB. Every dependency the network/db checks
 * touch is injected (env, makeDb, fetchImpl, makeAnthropic), so the whole doctor
 * run is offline and deterministic. The Discord check is GET-only (never POSTs).
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
  requests: { method: string }[];
} {
  const requests: { method: string }[] = [];
  return {
    requests,
    fetchImpl: async (_input, init) => {
      requests.push({ method: (init?.method ?? "GET").toUpperCase() });
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

const FULL_ENV: NodeJS.ProcessEnv = {
  SUPABASE_DB_URL: "postgres://user:pw@localhost:5432/jobscout",
  ANTHROPIC_API_KEY: "sk-ant-test",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
};

// ---------------------------------------------------------------------------
// checkEnv unit test (env-var check is unit-testable in isolation).
// ---------------------------------------------------------------------------

describe("checkEnv", () => {
  it("passes when all required vars are set", () => {
    const c = checkEnv(FULL_ENV);
    expect(c.ok).toBe(true);
    expect(c.name).toBe("env");
  });

  it("names each missing var and fails", () => {
    const c = checkEnv({ SUPABASE_DB_URL: "x", ANTHROPIC_API_KEY: "y" });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("DISCORD_WEBHOOK_URL");
  });

  it("treats an empty string as missing", () => {
    const c = checkEnv({ ...FULL_ENV, ANTHROPIC_API_KEY: "  " });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("lists the three required env vars", () => {
    expect([...REQUIRED_ENV_VARS]).toEqual([
      "SUPABASE_DB_URL",
      "ANTHROPIC_API_KEY",
      "DISCORD_WEBHOOK_URL",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Doctor names a missing env var and exits 1
// ---------------------------------------------------------------------------

describe("Scenario 5 — missing DISCORD_WEBHOOK_URL", () => {
  it("exits 1, names DISCORD_WEBHOOK_URL, runs all four checks, zero Discord requests", async () => {
    const env: NodeJS.ProcessEnv = {
      SUPABASE_DB_URL: FULL_ENV.SUPABASE_DB_URL,
      ANTHROPIC_API_KEY: FULL_ENV.ANTHROPIC_API_KEY,
      // DISCORD_WEBHOOK_URL intentionally unset.
    };
    const discord = discordGetFetch({ id: "1", token: "t" });
    const ping = await loadJson<MessageResponse>("anthropic/messages-ping.json");
    const anth = anthropicStub(ping);

    const result = await runDoctor({
      env,
      makeDb: () => healthyDb(),
      fetchImpl: discord.fetchImpl,
      makeAnthropic: anth.makeAnthropic,
    });

    expect(result.exitCode).toBe(1);

    // All four checks are reported (nothing short-circuits).
    const names = result.checks.map((c) => c.name);
    expect(names).toEqual(["env", "supabase", "discord", "anthropic"]);

    // The output names the missing var.
    const logger = capturingLogger();
    const code = printDoctor(result, logger);
    expect(code).toBe(1);
    expect(logger.lines.join("\n")).toContain("DISCORD_WEBHOOK_URL");

    // Discord check short-circuits on the unset URL → zero Discord requests.
    expect(discord.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Doctor green path checks without posting
// ---------------------------------------------------------------------------

describe("Scenario 6 — green path, GET-only Discord, 1-token Anthropic", () => {
  it("exits 0; Discord GET only (no POST); Anthropic called once with haiku + max_tokens 1", async () => {
    const meta = await loadJson<{ id: string; token: string }>("discord/webhook-get.json");
    const discord = discordGetFetch(meta);
    const ping = await loadJson<MessageResponse>("anthropic/messages-ping.json");
    const anth = anthropicStub(ping);

    const result = await runDoctor({
      env: FULL_ENV,
      makeDb: () => healthyDb(),
      fetchImpl: discord.fetchImpl,
      makeAnthropic: anth.makeAnthropic,
    });

    expect(result.exitCode).toBe(0);
    for (const c of result.checks) expect(c.ok).toBe(true);

    // Exactly one Discord request, method GET, zero POSTs.
    expect(discord.requests).toHaveLength(1);
    expect(discord.requests[0].method).toBe("GET");
    expect(discord.requests.filter((r) => r.method === "POST")).toHaveLength(0);

    // Exactly one Anthropic call: claude-haiku-4-5, max_tokens 1.
    expect(anth.calls).toHaveLength(1);
    expect(anth.calls[0].model).toBe("claude-haiku-4-5");
    expect(anth.calls[0].max_tokens).toBe(1);
  });
});
