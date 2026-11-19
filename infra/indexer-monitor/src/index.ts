/**
 * Off-host receiver and Health Check target for the indexer monitor
 * (docs/INDEXER-MONITOR.md). Pure rules are in `status.ts`.
 *
 * Routes:
 * - `POST /report`: bearer-authenticated report from the production monitor.
 *   Bodies are at most 16 KiB and are validated; nothing in them is echoed.
 * - `GET /observations`, `GET /monitor`: fixed-prefix text answers for the two
 *   Health Checks.
 *
 * State lives in one SQLite Durable Object so concurrent reports are applied
 * in order. A failed state read answers `503` on both routes: unknown state is
 * never reported as healthy.
 */
import { DurableObject } from "cloudflare:workers";
import { CANARY_EXPECTED, EXPECTED } from "./chains";
import {
  apply,
  emptyState,
  monitor,
  observations,
  parseReport,
  sameDigest,
  type Answer,
  type Report,
  type State,
} from "./status";

const STATE_KEY = "state";
const MAX_BODY_BYTES = 16 * 1024;

interface Env {
  STATE: DurableObjectNamespace<MonitorState>;
  REPORT_TOKEN: string;
  CANARY?: string;
}

export class MonitorState extends DurableObject<Env> {
  async read(): Promise<State> {
    return (await this.ctx.storage.get<State>(STATE_KEY)) ?? emptyState();
  }

  async record(report: Report): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const state = (await txn.get<State>(STATE_KEY)) ?? emptyState();
      await txn.put(STATE_KEY, apply(state, report));
    });
  }
}

function reply({ status, body }: Answer | { status: number; body: string }) {
  return new Response(`${body}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  if (!env.REPORT_TOKEN || !header.startsWith("Bearer ")) return false;
  const [given, expected] = await Promise.all([
    digest(header.slice(7)),
    digest(env.REPORT_TOKEN),
  ]);
  return sameDigest(given, expected);
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function receive(request: Request, env: Env, state: MonitorStub) {
  if (!(await authorized(request, env)))
    return reply({ status: 401, body: "unauthorized" });
  const report = parseReport(await readJson(request), Date.now());
  if (!report) return reply({ status: 400, body: "invalid report" });
  await state.record(report);
  return reply({ status: 202, body: "accepted" });
}

type MonitorStub = DurableObjectStub<MonitorState>;

async function status(path: string, env: Env, state: MonitorStub) {
  const expected = env.CANARY ? CANARY_EXPECTED : EXPECTED;
  let current: State;
  try {
    current = await state.read();
  } catch {
    return reply({ status: 503, body: "indexer-monitor-state-unavailable" });
  }
  return reply(
    path === "/observations"
      ? observations(current, expected)
      : monitor(current, expected, Date.now()),
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const state = env.STATE.getByName("indexer");
    if (url.search) return reply({ status: 404, body: "not found" });
    if (request.method === "POST" && url.pathname === "/report")
      return receive(request, env, state);
    if (
      request.method === "GET" &&
      (url.pathname === "/observations" || url.pathname === "/monitor")
    )
      return status(url.pathname, env, state);
    return reply({ status: 404, body: "not found" });
  },
} satisfies ExportedHandler<Env>;
