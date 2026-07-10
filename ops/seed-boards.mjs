#!/usr/bin/env node
// Probe a curated list of real Greenhouse / Lever / Ashby job boards, keep the
// ones that are live and public, and write the validated set to
// apps/crawler/seeds/companies.seed.json. Run: `node ops/seed-boards.mjs`.
//
// Discovery (finding brand-new boards) needs the Anthropic web_search tool,
// which we don't use in the local-only setup — so a good static seed list is
// how the crawler gets a meaningful pool of jobs. Invalid guesses simply 404
// and are dropped here, so the committed seed file stays all-valid.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEED_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../apps/crawler/seeds/companies.seed.json',
);

// Candidate boards — {name, ats, token}. Uncertain ATS guesses are included on
// their most-likely platform; wrong guesses are dropped by validation.
const CANDIDATES = [
  // ── Greenhouse ──────────────────────────────────────────────────────────
  ['Mattermost', 'greenhouse', 'mattermost'],
  ['Airbyte', 'greenhouse', 'airbyte'],
  ['Stripe', 'greenhouse', 'stripe'],
  ['Coinbase', 'greenhouse', 'coinbase'],
  ['Robinhood', 'greenhouse', 'robinhood'],
  ['Instacart', 'greenhouse', 'instacart'],
  ['DoorDash', 'greenhouse', 'doordash'],
  ['GitLab', 'greenhouse', 'gitlab'],
  ['Dropbox', 'greenhouse', 'dropbox'],
  ['Lyft', 'greenhouse', 'lyft'],
  ['Reddit', 'greenhouse', 'reddit'],
  ['Pinterest', 'greenhouse', 'pinterest'],
  ['Cloudflare', 'greenhouse', 'cloudflare'],
  ['Databricks', 'greenhouse', 'databricks'],
  ['Datadog', 'greenhouse', 'datadog'],
  ['Twilio', 'greenhouse', 'twilio'],
  ['Plaid', 'greenhouse', 'plaid'],
  ['Affirm', 'greenhouse', 'affirm'],
  ['Brex', 'greenhouse', 'brex'],
  ['Gusto', 'greenhouse', 'gusto'],
  ['Benchling', 'greenhouse', 'benchling'],
  ['Samsara', 'greenhouse', 'samsara'],
  ['Faire', 'greenhouse', 'faire'],
  ['Retool', 'greenhouse', 'retool'],
  ['Sentry', 'greenhouse', 'sentry'],
  ['Webflow', 'greenhouse', 'webflow'],
  ['Grammarly', 'greenhouse', 'grammarly'],
  ['SoFi', 'greenhouse', 'sofi'],
  ['Opendoor', 'greenhouse', 'opendoor'],
  ['Flexport', 'greenhouse', 'flexport'],
  ['Rippling', 'greenhouse', 'rippling'],
  ['Deel', 'greenhouse', 'deel'],
  ['Gemini', 'greenhouse', 'gemini'],
  ['Betterment', 'greenhouse', 'betterment'],
  ['Thumbtack', 'greenhouse', 'thumbtack'],
  ['Nextdoor', 'greenhouse', 'nextdoor'],
  ['Patreon', 'greenhouse', 'patreon'],
  ['Life360', 'greenhouse', 'life360'],
  ['Discord', 'greenhouse', 'discord'],
  ['Asana', 'greenhouse', 'asana'],
  ['Box', 'greenhouse', 'box'],
  ['HashiCorp', 'greenhouse', 'hashicorp'],
  ['Elastic', 'greenhouse', 'elastic'],
  ['Confluent', 'greenhouse', 'confluent'],
  ['MongoDB', 'greenhouse', 'mongodb'],
  ['DigitalOcean', 'greenhouse', 'digitalocean'],
  ['New Relic', 'greenhouse', 'newrelic'],
  ['PagerDuty', 'greenhouse', 'pagerduty'],
  ['Okta', 'greenhouse', 'okta'],
  ['Segment', 'greenhouse', 'segment'],
  ['Amplitude', 'greenhouse', 'amplitude'],
  ['Airtable', 'greenhouse', 'airtable'],
  ['Cohere', 'greenhouse', 'cohere'],
  ['Weights & Biases', 'greenhouse', 'weightsandbiases'],
  ['Scale AI', 'greenhouse', 'scaleai'],
  ['Whatnot', 'greenhouse', 'whatnot'],
  ['Chime', 'greenhouse', 'chime'],
  ['Attentive', 'greenhouse', 'attentive'],
  ['Ramp', 'greenhouse', 'ramp'],
  // ── Lever ───────────────────────────────────────────────────────────────
  ['Netlify', 'lever', 'netlify'],
  ['Matterport', 'lever', 'matterport'],
  ['Voiceflow', 'lever', 'voiceflow'],
  ['Brave', 'lever', 'brave'],
  ['Kraken', 'lever', 'kraken'],
  ['Palantir', 'lever', 'palantir'],
  ['Mux', 'lever', 'mux'],
  ['Ro', 'lever', 'ro'],
  ['Veho', 'lever', 'veho'],
  ['Alan', 'lever', 'alan'],
  ['Spotify', 'lever', 'spotify'],
  ['Plaid', 'lever', 'plaid'],
  // ── Ashby ───────────────────────────────────────────────────────────────
  ['Ramp', 'ashby', 'ramp'],
  ['Linear', 'ashby', 'linear'],
  ['PostHog', 'ashby', 'posthog'],
  ['Replit', 'ashby', 'replit'],
  ['Hex', 'ashby', 'hex'],
  ['Baseten', 'ashby', 'baseten'],
  ['Runway', 'ashby', 'runway'],
  ['Browserbase', 'ashby', 'browserbase'],
  ['Perplexity', 'ashby', 'perplexity'],
  ['Cartesia', 'ashby', 'cartesia'],
  ['Mercury', 'ashby', 'mercury'],
  ['Watershed', 'ashby', 'watershed'],
  ['Clay', 'ashby', 'clay'],
  ['Sierra', 'ashby', 'sierra'],
  ['Cognition', 'ashby', 'cognition'],
  ['Harvey', 'ashby', 'harvey'],
  ['Ironclad', 'ashby', 'ironclad'],
  ['Vercel', 'ashby', 'vercel'],
  ['Notion', 'ashby', 'notion'],
  ['Supabase', 'ashby', 'supabase'],
  ['Neon', 'ashby', 'neon'],
  ['Clerk', 'ashby', 'clerk'],
  ['WorkOS', 'ashby', 'workos'],
  ['Resend', 'ashby', 'resend'],
  ['Raycast', 'ashby', 'raycast'],
  ['Warp', 'ashby', 'warp'],
  ['Zed', 'ashby', 'zed'],
  ['Anysphere (Cursor)', 'ashby', 'anysphere'],
  ['Together AI', 'ashby', 'together'],
  ['Modal', 'ashby', 'modal'],
  ['Suno', 'ashby', 'suno'],
  ['Dagster', 'ashby', 'dagster'],
  ['Inngest', 'ashby', 'inngest'],
  // ── Remote-first companies (known for remote-US hiring) ──────────────────
  ['GitLab', 'greenhouse', 'gitlab'],
  ['Zapier', 'greenhouse', 'zapier'],
  ['Sourcegraph', 'greenhouse', 'sourcegraph'],
  ['Grafana Labs', 'greenhouse', 'grafanalabs'],
  ['1Password', 'greenhouse', '1password'],
  ['Close', 'greenhouse', 'close'],
  ['CockroachDB', 'greenhouse', 'cockroachlabs'],
  ['Temporal', 'greenhouse', 'temporaltechnologies'],
  ['Render', 'greenhouse', 'render'],
  ['Chainguard', 'greenhouse', 'chainguard'],
  ['Tailscale', 'greenhouse', 'tailscale'],
  ['dbt Labs', 'greenhouse', 'dbtlabs'],
  ['Remote', 'greenhouse', 'remotecom'],
  ['Automattic', 'greenhouse', 'automattic'],
  ['Doist', 'greenhouse', 'doist'],
  ['ClickHouse', 'greenhouse', 'clickhouse'],
  ['Hasura', 'greenhouse', 'hasura'],
  ['Teleport', 'greenhouse', 'goteleport'],
  ['PlanetScale', 'greenhouse', 'planetscale'],
  ['Timescale', 'greenhouse', 'timescale'],
  ['Loom', 'greenhouse', 'loom'],
  ['Calendly', 'greenhouse', 'calendly'],
  ['Vercel', 'greenhouse', 'vercel'],
  ['Toptal', 'greenhouse', 'toptal'],
  ['HashiCorp', 'greenhouse', 'hashicorp'],
  ['Webflow', 'greenhouse', 'webflow'],
  ['Turso', 'ashby', 'turso'],
  ['Neon', 'ashby', 'neon'],
  ['Supabase', 'ashby', 'supabase'],
];

const ROLE_KEYWORDS = [
  'react native', 'mobile developer', 'mobile engineer', 'expo', 'ios engineer',
  'android engineer', 'react developer', 'react engineer', 'react.js', 'react',
  'frontend', 'front-end', 'front end', 'ui engineer', 'web developer',
  'full stack', 'fullstack', 'full-stack', 'software engineer',
];
const EXCLUDE_TITLE = ['staff', 'principal', 'director', 'manager', 'angular', 'vue', '.net'];

function endpoint(ats, token) {
  if (ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=false`;
  if (ats === 'lever') return `https://api.lever.co/v0/postings/${token}?mode=json`;
  if (ats === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  throw new Error(`unknown ats ${ats}`);
}

function titlesOf(ats, body) {
  if (ats === 'greenhouse') return (body.jobs ?? []).map((j) => j.title ?? '');
  if (ats === 'lever') return (Array.isArray(body) ? body : []).map((j) => j.text ?? '');
  if (ats === 'ashby') return (body.jobs ?? []).map((j) => j.title ?? '');
  return [];
}

function matchCount(titles) {
  return titles.filter((t) => {
    const lower = t.toLowerCase();
    if (EXCLUDE_TITLE.some((k) => lower.includes(k))) return false;
    return ROLE_KEYWORDS.some((k) => lower.includes(k));
  }).length;
}

async function probe([name, ats, token]) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(endpoint(ats, token), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 jobscout-seed-probe' },
    });
    if (!res.ok) return { name, ats, token, ok: false, reason: `http ${res.status}` };
    const body = await res.json();
    const titles = titlesOf(ats, body);
    if (titles.length === 0) return { name, ats, token, ok: false, reason: 'no jobs' };
    return { name, ats, token, ok: true, total: titles.length, matches: matchCount(titles) };
  } catch (err) {
    return { name, ats, token, ok: false, reason: err.name === 'AbortError' ? 'timeout' : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

const careers = (ats, token) =>
  ats === 'greenhouse' ? `https://job-boards.greenhouse.io/${token}`
  : ats === 'lever' ? `https://jobs.lever.co/${token}`
  : `https://jobs.ashbyhq.com/${token}`;

const results = await pool(CANDIDATES, 12, probe);
const live = results.filter((r) => r.ok).sort((a, b) => b.matches - a.matches || b.total - a.total);

// De-dup on (ats, token) — a couple of names appear on multiple ATSes as guesses.
const seen = new Set();
const seed = [];
for (const r of live) {
  const key = `${r.ats}:${r.token}`;
  if (seen.has(key)) continue;
  seen.add(key);
  seed.push({ name: r.name, ats: r.ats, boardToken: r.token, careersUrl: careers(r.ats, r.token) });
}

await writeFile(SEED_PATH, JSON.stringify(seed, null, 2) + '\n');

console.log(`Probed ${CANDIDATES.length} candidates → ${seed.length} live boards written to seeds.`);
console.log(`Total matching (react/frontend/mobile) titles across live boards: ${live.reduce((n, r) => n + r.matches, 0)}`);
console.log('\nTop live boards by matching roles:');
for (const r of live.slice(0, 25)) {
  console.log(`  ${String(r.matches).padStart(3)} match / ${String(r.total).padStart(3)} total  ${r.ats.padEnd(10)} ${r.name}`);
}
const dead = results.filter((r) => !r.ok);
console.log(`\nDropped ${dead.length} (404/empty/timeout): ${dead.map((d) => `${d.token}(${d.reason})`).slice(0, 40).join(', ')}`);
