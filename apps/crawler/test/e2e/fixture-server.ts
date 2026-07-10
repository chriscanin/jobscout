/**
 * A REAL local HTTP server for the end-to-end convergence suite (spec 09 §2).
 *
 * This is not a pile of mocks that assert themselves: it is a plain `node:http`
 * server, started on an ephemeral port, that serves the actual captured
 * fixtures at the same API paths the real board/ATS hosts use. The REAL adapter
 * code, the REAL classifier, the REAL notifier and the REAL pipeline run against
 * it — the only thing swapped is the network destination (a routing `fetch` that
 * maps the real hosts onto this server) and the DB (in-process PGlite).
 *
 * Routes (mirroring the real API paths so the real adapters need no changes):
 *
 *   GET  /v1/boards/:token/jobs?content=true            greenhouse board listing
 *   GET  /v1/boards/:token/jobs/:id?questions=true      greenhouse job detail
 *   GET  /v0/postings/:slug?mode=json                   lever postings
 *   GET  /lever-apply/:slug/:id/apply                   lever apply-page HTML (difficulty rule 3)
 *   POST /v1/chat/completions                           fixture-backed LM Studio (OpenAI-compatible)
 *   GET  /v1/models                                     fixture-backed LM Studio /models (doctor)
 *   POST /discord/webhook  (and GET for doctor metadata)
 *   GET  /__requests                                    the recorded request log (test-only)
 *   POST /__control/board                               swap which board variant is served (test-only)
 *
 * Every request is RECORDED (method, path, query, parsed JSON body, timestamp)
 * so tests can assert exactly what Discord and the LLM received.
 *
 * The routing fetch is exposed via `makeRoutingFetch()` and the fixture-backed
 * LLM client via `makeFixtureLlm()`. Both point at this server, so the real
 * HttpClient politeness/retry wrapper and the real classifier prompts are
 * exercised end to end.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpClient, type HttpClient } from "../../src/http.js";
import type { LlmClient, LlmRequest } from "../../src/llm.js";

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

/** One recorded request the server received. */
export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  at: string;
}

/** The RN reference posting id (present in the captured Mattermost board). */
export const RN_JOB_ID = "5238290008";

/** The lever posting whose difficulty falls to the LLM fallback (rule 3). */
export const LEVER_LLM_JOB_ID = "abc12345-0000-0000-0000-000000000002";

/** The lever posting used as the "queued survives expiry" case in scenario 4. */
export const LEVER_QUEUED_JOB_ID = "abc12345-0000-0000-0000-000000000001";

/** Read a fixture file as text. */
function fixtureText(rel: string): string {
  return readFileSync(path.join(FIXTURES_DIR, rel), "utf8");
}

/** Read + parse a JSON fixture file. */
function fixtureJson<T = unknown>(rel: string): T {
  return JSON.parse(fixtureText(rel)) as T;
}

/** A greenhouse board listing (`{ jobs: [...] }`). */
interface GreenhouseBoard {
  jobs: Array<Record<string, unknown>>;
}

/** The handle returned when the server is started. */
export interface FixtureServer {
  /** Base URL, e.g. `http://127.0.0.1:54123`. */
  baseUrl: string;
  /** Every request recorded so far (a fresh copy). */
  requests: () => RecordedRequest[];
  /** Just the recorded Discord webhook POST bodies. */
  discordPosts: () => unknown[];
  /** Just the recorded LM Studio chat-completions request bodies. */
  llmPosts: () => Array<Record<string, unknown>>;
  /** Clear the recorded request log (used between scenario phases). */
  clearRequests: () => void;
  /** Drop a greenhouse posting from the served board (scenario 4 mutation). */
  dropGreenhouseJob: (externalId: string) => void;
  /** Drop a lever posting from the served board (scenario 4 mutation). */
  dropLeverJob: (externalId: string) => void;
  /** Restore the full greenhouse + lever boards. */
  resetBoard: () => void;
  /** A routing fetch (real HttpClient) that maps real hosts onto this server. */
  makeRoutingFetch: () => HttpClient;
  /** A fixture-backed LlmClient whose calls are recorded by the server. */
  makeFixtureLlm: () => LlmClient;
  /** The fixture LM Studio base URL (for the doctor /models check). */
  llmBaseUrl: () => string;
  /** The fixture LM Studio model id (for the doctor /models check). */
  llmModel: () => string;
  /** Stop the server. */
  close: () => Promise<void>;
}

/**
 * Compute the deterministic scoring response for a scoring-batch prompt. The
 * prompt (built by the REAL classifier `buildScorePrompt`) carries a `JOBS
 * (JSON)` array of `{ id, title, ... }`. We score each real job so that:
 *   - a react-native title  → role_category react-native, score 88 (>= notify_min, > 70 band)
 *   - a react/frontend title → role_category frontend, score 82
 *   - anything else         → score 5 (well below the notify threshold)
 * All scores fall OUTSIDE the 40–70 sonnet re-score band, so no sonnet call is
 * ever made — exactly as spec 09 §2 requires.
 */
function scoreResponseFor(prompt: string): string {
  const jobs = extractJobsFromPrompt(prompt);
  const rows = jobs.map((j) => {
    const title = String(j.title ?? "").toLowerCase();
    const isReactNative =
      title.includes("react native") ||
      title.includes("mobile") ||
      title.includes("expo") ||
      title.includes("ios ") ||
      title.includes("android");
    const isWeb =
      title.includes("react") ||
      title.includes("frontend") ||
      title.includes("front-end") ||
      title.includes("front end") ||
      title.includes("ui engineer") ||
      title.includes("web developer");
    if (isReactNative) {
      return {
        id: j.id,
        role_category: "react-native",
        match_score: 88,
        match_reasons: ["title matches react native", "remote us"],
        // The react-native fixture job is remote/US so scenario 2 still notifies.
        remote_us_ok: true,
      };
    }
    if (isWeb) {
      return {
        id: j.id,
        role_category: "frontend",
        match_score: 82,
        match_reasons: ["title matches frontend keyword"],
        remote_us_ok: true,
      };
    }
    return {
      id: j.id,
      role_category: "other",
      match_score: 5,
      match_reasons: ["no strong keyword match"],
      remote_us_ok: false,
    };
  });
  return JSON.stringify(rows);
}

/** Extract the `JOBS (JSON): [...]` array the real score prompt embeds. */
function extractJobsFromPrompt(prompt: string): Array<{ id: string; title?: string }> {
  const marker = "JOBS (JSON):";
  const idx = prompt.indexOf(marker);
  if (idx === -1) return [];
  const after = prompt.slice(idx + marker.length);
  // The JSON array is the first [...] span after the marker.
  const start = after.indexOf("[");
  if (start === -1) return [];
  // Find the matching close bracket by depth.
  let depth = 0;
  for (let i = start; i < after.length; i++) {
    const ch = after[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(after.slice(start, i + 1)) as Array<{
            id: string;
            title?: string;
          }>;
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/**
 * The canned difficulty-fallback response (loaded from the captured Anthropic
 * fixture) but forced to `medium` so the served Lever apply page classifies to
 * `medium` deterministically, matching spec 09 §S1.
 */
function difficultyResponseText(): string {
  return JSON.stringify({
    difficulty: "medium",
    difficulty_reasons: [
      "custom screening questions on the apply form",
      "salary expectation and visa-status fields beyond the standard set",
    ],
  });
}

/** The fixture LM Studio model id (both tiers map to it). */
const FIXTURE_LLM_MODEL = "qwen2.5-32b-instruct";

/** Build an OpenAI chat-completions envelope around an assistant text body. */
function chatCompletionEnvelope(text: string): Record<string, unknown> {
  return {
    id: `chatcmpl_fixture_${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion",
    model: FIXTURE_LLM_MODEL,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

/** Start the fixture server on an ephemeral port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];

  const fullBoard = fixtureJson<GreenhouseBoard>("greenhouse/mattermost-board.json");
  const jobDetail = fixtureJson<Record<string, unknown>>(
    "greenhouse/mattermost-job-5238290008.json",
  );
  const fullLeverPostings = fixtureJson<Array<Record<string, unknown>>>(
    "lever/board-postings.json",
  );
  const leverApplyHtml = leverApplyPageHtml();

  // Mutable sets of external ids currently dropped from each board.
  const droppedGreenhouse = new Set<string>();
  const droppedLever = new Set<string>();

  function currentBoard(): GreenhouseBoard {
    if (droppedGreenhouse.size === 0) return fullBoard;
    return {
      jobs: fullBoard.jobs.filter(
        (j) => !droppedGreenhouse.has(String(j["id"])),
      ),
    };
  }

  function currentLeverPostings(): Array<Record<string, unknown>> {
    if (droppedLever.size === 0) return fullLeverPostings;
    return fullLeverPostings.filter((p) => !droppedLever.has(String(p["id"])));
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const pathname = url.pathname;
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    const rawBody = await readBody(req);
    let parsedBody: unknown = undefined;
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }

    requests.push({
      method,
      path: pathname,
      query,
      body: parsedBody,
      at: new Date().toISOString(),
    });

    // --- test-only control + inspection routes ---
    if (pathname === "/__requests" && method === "GET") {
      return json(res, 200, requests);
    }
    if (pathname === "/__control/board" && method === "POST") {
      const b = (parsedBody ?? {}) as { drop?: string; reset?: boolean };
      if (b.reset) droppedGreenhouse.clear();
      if (typeof b.drop === "string") droppedGreenhouse.add(b.drop);
      return json(res, 200, { ok: true, dropped: [...droppedGreenhouse] });
    }

    // --- greenhouse board API ---
    // GET /v1/boards/:token/jobs                (listing, content=true)
    // GET /v1/boards/:token/jobs/:id            (detail, questions=true)
    const ghList = pathname.match(/^\/v1\/boards\/([^/]+)\/jobs\/?$/);
    if (ghList && method === "GET") {
      const token = ghList[1];
      if (token === "mattermost") return json(res, 200, currentBoard());
      // Unknown greenhouse token (e.g. seeded "airbyte") → empty board.
      return json(res, 200, { jobs: [] });
    }
    const ghDetail = pathname.match(/^\/v1\/boards\/([^/]+)\/jobs\/([^/]+)$/);
    if (ghDetail && method === "GET") {
      const id = ghDetail[2];
      if (id === RN_JOB_ID) return json(res, 200, jobDetail);
      // Detail is only fetched for prescreen-passing jobs; the RN job is the
      // only such posting in the captured board.
      return json(res, 404, { error: "not found" });
    }

    // --- lever postings API ---
    const leverList = pathname.match(/^\/v0\/postings\/([^/]+)\/?$/);
    if (leverList && method === "GET") {
      return json(res, 200, currentLeverPostings());
    }
    // --- greenhouse apply/posting page (difficulty rule 3 input) ---
    if (pathname.startsWith("/greenhouse-apply/") && method === "GET") {
      return html(res, 200, greenhouseApplyPageHtml());
    }
    // --- lever apply page (difficulty rule 3 input) ---
    if (pathname.startsWith("/lever-apply/") && method === "GET") {
      return html(res, 200, leverApplyHtml);
    }
    // jobs.lever.co apply URLs are rewritten to this server root path
    // `/exampleco/:id/apply`; serve the same apply HTML for any *.apply path.
    if (pathname.endsWith("/apply") && method === "GET") {
      return html(res, 200, leverApplyHtml);
    }

    // --- LM Studio /models (doctor readiness check) ---
    if (pathname === "/v1/models" && method === "GET") {
      return json(res, 200, {
        object: "list",
        data: [{ id: FIXTURE_LLM_MODEL, object: "model" }],
      });
    }

    // --- LM Studio chat completions (fixture-backed classification) ---
    if (pathname === "/v1/chat/completions" && method === "POST") {
      const body = (parsedBody ?? {}) as {
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const prompt = firstUserText(body.messages ?? []);
      // Difficulty fallback prompts carry the rubric marker "Ulta Beauty".
      if (prompt.includes("Ulta Beauty")) {
        return json(res, 200, chatCompletionEnvelope(difficultyResponseText()));
      }
      // Otherwise it is the scoring batch (carries the serialized criteria JSON).
      return json(res, 200, chatCompletionEnvelope(scoreResponseFor(prompt)));
    }

    // --- Discord webhook ---
    if (pathname === "/discord/webhook") {
      if (method === "GET") {
        // Doctor GET: webhook metadata.
        return json(res, 200, { id: "fixture-webhook-id", token: "fixture-token" });
      }
      // POST: record body (already recorded above) and return 204.
      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "no fixture route", path: pathname }));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("fixture server failed to bind an ephemeral port");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  /**
   * A routing fetch: the REAL HttpClient (politeness/retry) but with a transport
   * that rewrites the real board/ATS hosts onto this fixture server. Any host we
   * do not know throws FIXTURE_MODE_ESCAPE so an accidental real request fails
   * loudly (spec 09 §Fixture mode).
   */
  function makeRoutingFetch(): HttpClient {
    return createHttpClient({
      // Waive politeness spacing for the fixture host.
      minSpacingMs: 0,
      transport: (target: string, init?: RequestInit) => {
        const rewritten = rewriteUrl(target, baseUrl);
        if (rewritten === null) {
          return Promise.reject(
            new Error(`FIXTURE_MODE_ESCAPE: ${target}`),
          );
        }
        return globalThis.fetch(rewritten, init);
      },
    });
  }

  // The LM Studio base URL served by this fixture (OpenAI-compatible under /v1).
  const llmBaseUrl = `${baseUrl}/v1`;

  /**
   * A fixture-backed LlmClient. Every `complete` is POSTed to the server's
   * `/v1/chat/completions` route (OpenAI-compatible) so it lands in the recorded
   * request log (tests assert on the scoring-batch body and the difficulty-rubric
   * body). The server computes the deterministic response and honors the
   * `jsonSchema` by returning valid JSON in the message content.
   */
  function makeFixtureLlm(): LlmClient {
    return {
      label: `lmstudio:${FIXTURE_LLM_MODEL}`,
      async complete(req: LlmRequest): Promise<string> {
        const messages: Array<{ role: "system" | "user"; content: string }> = [];
        if (req.system) messages.push({ role: "system", content: req.system });
        messages.push({ role: "user", content: req.user });
        const body: Record<string, unknown> = {
          model: FIXTURE_LLM_MODEL,
          messages,
          temperature: 0,
          max_tokens: req.maxTokens ?? 2048,
        };
        if (req.jsonSchema) {
          body.response_format = {
            type: "json_schema",
            json_schema: { name: "out", strict: true, schema: req.jsonSchema },
          };
        }
        const r = await globalThis.fetch(`${llmBaseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await r.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = json.choices?.[0]?.message?.content;
        return typeof content === "string" ? content : "";
      },
    };
  }

  return {
    baseUrl,
    requests: () => requests.map((r) => ({ ...r })),
    discordPosts: () =>
      requests
        .filter((r) => r.path === "/discord/webhook" && r.method === "POST")
        .map((r) => r.body),
    llmPosts: () =>
      requests
        .filter((r) => r.path === "/v1/chat/completions" && r.method === "POST")
        .map((r) => (r.body ?? {}) as Record<string, unknown>),
    clearRequests: () => {
      requests.length = 0;
    },
    dropGreenhouseJob: (externalId: string) => {
      droppedGreenhouse.add(externalId);
    },
    dropLeverJob: (externalId: string) => {
      droppedLever.add(externalId);
    },
    resetBoard: () => {
      droppedGreenhouse.clear();
      droppedLever.clear();
    },
    makeRoutingFetch,
    makeFixtureLlm,
    llmBaseUrl: () => llmBaseUrl,
    llmModel: () => FIXTURE_LLM_MODEL,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Rewrite a real board/ATS URL onto the fixture base. Returns null for unknown
 * hosts (→ FIXTURE_MODE_ESCAPE). The fixture host itself is passed through.
 */
export function rewriteUrl(target: string, baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const base = new URL(baseUrl);

  // Already pointed at the fixture server.
  if (host === base.hostname) return target;

  // Greenhouse board API: boards-api.greenhouse.io/v1/boards/...
  if (host === "boards-api.greenhouse.io") {
    return `${baseUrl}${u.pathname}${u.search}`;
  }
  // Greenhouse apply/posting pages: job-boards.greenhouse.io/<board>/jobs/<id>.
  // These are the `apply_url`s the greenhouse adapter copies from `absolute_url`;
  // a difficulty LLM fallback on a greenhouse job whose detail was not fetched
  // would fetch this page. Route it to a generic greenhouse apply-page HTML.
  if (host === "job-boards.greenhouse.io") {
    return `${baseUrl}/greenhouse-apply${u.pathname}`;
  }
  // Lever postings API: api.lever.co/v0/postings/...
  if (host === "api.lever.co") {
    return `${baseUrl}${u.pathname}${u.search}`;
  }
  // Lever apply pages: jobs.lever.co/<slug>/<id>/apply
  if (host === "jobs.lever.co") {
    return `${baseUrl}/lever-apply${u.pathname}`;
  }
  return null;
}

/** Extract the first user message's text from OpenAI chat-completions messages. */
function firstUserText(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text?: unknown }).text ?? "") : ""))
        .join("");
    }
  }
  return "";
}

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Write a JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Write an HTML response. */
function html(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

/**
 * The Lever apply-page HTML served for difficulty rule 3. Deliberately a
 * "medium" apply-in-place form (custom screening questions), so the fixture
 * Anthropic classifies it `medium` per the rubric. Kept inline (small,
 * self-documenting) rather than as a separate empty fixture file.
 */
function leverApplyPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Apply — Frontend Engineer</title></head>
<body>
  <main>
    <h1>Apply for Frontend Engineer</h1>
    <form action="/apply" method="post">
      <label>Full name<input name="name" required></label>
      <label>Email<input name="email" type="email" required></label>
      <label>Phone<input name="phone"></label>
      <label>Resume<input name="resume" type="file"></label>
      <label>LinkedIn<input name="urls[LinkedIn]"></label>
      <!-- Custom / personal screening questions push this to "medium". -->
      <label>Why do you want to work here?<textarea name="cards[why]"></textarea></label>
      <label>What are your salary expectations?<input name="cards[salary]"></label>
      <label>Are you legally authorized to work in the US?<input name="cards[visa]"></label>
      <button type="submit">Submit application</button>
    </form>
  </main>
</body>
</html>`;
}

/**
 * A generic Greenhouse apply-page HTML served for any greenhouse posting whose
 * difficulty falls to the LLM fallback (a greenhouse job whose detail was not
 * fetched, so no `raw.questions` to apply the deterministic rule). It presents a
 * standard apply-in-place form, which the fixture Anthropic classifies `medium`.
 */
function greenhouseApplyPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Apply — Greenhouse</title></head>
<body>
  <main>
    <h1>Apply</h1>
    <form action="/apply" method="post" enctype="multipart/form-data">
      <input name="first_name" required>
      <input name="last_name" required>
      <input name="email" type="email" required>
      <input name="phone">
      <input name="resume" type="file">
      <textarea name="cover_letter"></textarea>
    </form>
  </main>
</body>
</html>`;
}
