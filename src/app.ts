/**
 * Rail Seat Finder: a private local web app (see docs/app/SPEC.md).
 *
 * Serves web/ and a small JSON API on 127.0.0.1 only. The API calls a fixed
 * allow-list of read-only MCP tools in-process (MCP client ↔ InMemoryTransport
 * ↔ createMcpServer), limits calls per minute, and caps real live page reads
 * per day (counted by the railyatri provider's beforeRead hook, so cache hits
 * are free).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type AppContext, buildContext, loadConfig } from "./config.js";
import { RailError } from "./core/errors.js";
import { todayInIndia } from "./core/time.js";
import { packageVersion } from "./lib/version.js";
import { createMcpServer } from "./mcp.js";

/** The only address the app listens on. */
export const LISTEN_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4321;
export const DEFAULT_DAILY_PAGE_READS = 150;
export const DEFAULT_CALLS_PER_MINUTE = 120;

/** The only tools the API may call. All are read-only. */
export const ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "search_stations",
  "find_nearby_stations",
  "get_route_availability",
  "plan_journey",
  "get_data_sources",
]);

/** Tools that can trigger live page reads; refused up front when the daily cap is used up. */
const LIVE_TOOLS: ReadonlySet<string> = new Set(["get_route_availability", "plan_journey"]);

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** Error codes the API returns: the tools' RailError codes plus the app's own. */
export type ApiErrorCode =
  RailError["code"] | "BAD_HOST" | "FORBIDDEN" | "TOOL_NOT_ALLOWED" | "TOO_MANY_REQUESTS" | "DAILY_LIMIT" | "NOT_FOUND_ROUTE" | "INTERNAL";

const STATUS: Record<ApiErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  UNSUPPORTED: 501,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_AUTH: 502,
  RATE_LIMITED: 429,
  BAD_HOST: 403,
  FORBIDDEN: 403,
  TOOL_NOT_ALLOWED: 404,
  TOO_MANY_REQUESTS: 429,
  DAILY_LIMIT: 429,
  NOT_FOUND_ROUTE: 404,
  INTERNAL: 500,
};

/** HTTP status for an API error code (unknown codes count as upstream failures). */
export function httpStatusFor(code: string): number {
  return STATUS[code as ApiErrorCode] ?? 502;
}

/**
 * Daily budget of real live page reads, resetting at midnight IST.
 * `beforeRead` is the railyatri provider hook: it runs only when a page is
 * actually fetched (never on a cache hit) and throws once the budget is used.
 */
export class DailyReadCap {
  private day = "";
  private count = 0;

  constructor(
    readonly limit: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private roll(): void {
    const today = todayInIndia(this.now());
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
  }

  used(): number {
    this.roll();
    return this.count;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.used());
  }

  readonly beforeRead = (): void => {
    this.roll();
    if (this.count >= this.limit) {
      throw new RailError("RATE_LIMITED", `The daily limit of ${this.limit} live checks is used up; it resets at midnight IST.`, "app");
    }
    this.count++;
  };
}

/** Sliding one-minute window over API calls. */
class MinuteLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}

  /** Records a call; returns seconds to wait when over the limit, else 0. */
  take(): number {
    const t = this.now();
    while (this.hits.length && this.hits[0]! <= t - 60_000) this.hits.shift();
    if (this.hits.length >= this.limit) return Math.max(1, Math.ceil((this.hits[0]! + 60_000 - t) / 1000));
    this.hits.push(t);
    return 0;
  }
}

export interface LocalAppOptions {
  /** Daily live-read budget; must be the same object whose beforeRead was given to buildContext. */
  cap: DailyReadCap;
  /** API calls allowed per minute (default 120). */
  callsPerMinute?: number;
  /** Directory with index.html, styles.css, app.js (default: the repository's web/). */
  webDir?: string;
  /** Values that must never appear in a response (e.g. the Firecrawl key); replaced if they do. */
  secrets?: Array<string | undefined>;
  /** Clock for the per-minute limit; tests pin it. */
  nowMs?: () => number;
}

function defaultWebDir(): string {
  // src/app.ts → ../web; dist/src/app.js → ../../web
  for (const rel of ["../web", "../../web"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(dir)) return dir;
  }
  return fileURLToPath(new URL("../web", import.meta.url));
}

interface ApiError {
  code: ApiErrorCode | string;
  message: string;
  next_step?: string;
  retry_after_seconds?: number;
}

/** Express app for the local web UI and API. Listen on LISTEN_HOST only. */
export function createLocalApp(ctx: AppContext, options: LocalAppOptions): Express {
  const { cap } = options;
  const limiter = new MinuteLimiter(options.callsPerMinute ?? DEFAULT_CALLS_PER_MINUTE, options.nowMs ?? Date.now);
  const secrets = (options.secrets ?? []).filter((s): s is string => typeof s === "string" && s.length >= 8);
  const webDir = options.webDir ?? defaultWebDir();

  let clientP: Promise<Client> | null = null;
  const client = (): Promise<Client> =>
    (clientP ??= (async () => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "rail-seat-finder", version: packageVersion() });
      await Promise.all([createMcpServer(ctx).connect(serverT), c.connect(clientT)]);
      return c;
    })().catch((e) => {
      clientP = null;
      throw e;
    }));

  const liveChecks = () => ({ used: cap.used(), limit: cap.limit });

  const send = (res: Response, status: number, body: unknown): void => {
    let text = JSON.stringify(body);
    for (const s of secrets) text = text.split(s).join("[redacted]");
    res.status(status).type("application/json").send(text);
  };
  const sendError = (res: Response, err: ApiError): void => {
    if (err.retry_after_seconds) res.set("Retry-After", String(err.retry_after_seconds));
    send(res, httpStatusFor(err.code), { error: err, live_checks: liveChecks() });
  };

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  // Security headers on every response, including errors and static files.
  app.use((_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  // DNS-rebinding guard: the Host header must name this loopback listener exactly.
  app.use((req, res, next) => {
    const port = req.socket.localPort;
    const host = (req.headers.host ?? "").toLowerCase();
    if (!port || (host !== `${LISTEN_HOST}:${port}` && host !== `localhost:${port}`)) {
      sendError(res, { code: "BAD_HOST", message: "This app only answers on 127.0.0.1 or localhost." });
      return;
    }
    next();
  });

  const api = express.Router();

  // Same-origin only: custom header, matching Origin (when sent), same-origin fetch metadata (when sent). No CORS headers, ever.
  api.use((req, res, next) => {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if (req.headers["x-app"] !== "railways") {
      sendError(res, { code: "FORBIDDEN", message: "Requests must come from the Rail Seat Finder page." });
      return;
    }
    if (origin !== undefined && origin !== `http://${req.headers.host}`) {
      sendError(res, { code: "FORBIDDEN", message: "Cross-origin requests are not allowed." });
      return;
    }
    if (site !== undefined && site !== "same-origin") {
      sendError(res, { code: "FORBIDDEN", message: "Cross-site requests are not allowed." });
      return;
    }
    next();
  });

  api.use((_req, res, next) => {
    const wait = limiter.take();
    if (wait) {
      sendError(res, { code: "TOO_MANY_REQUESTS", message: "Too many requests in the last minute.", retry_after_seconds: wait });
      return;
    }
    next();
  });

  api.use(express.json({ limit: "16kb" }));

  api.get("/status", (_req, res) => {
    send(res, 200, { live_checks: liveChecks(), resets: "midnight IST" });
  });

  api.post("/tools/:name", async (req: Request, res: Response) => {
    const name = String(req.params.name);
    if (!ALLOWED_TOOLS.has(name)) {
      sendError(res, { code: "TOOL_NOT_ALLOWED", message: `The app does not call ${name}.` });
      return;
    }
    const args: unknown = req.body ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      sendError(res, { code: "INVALID_INPUT", message: "The request body must be a JSON object of tool arguments." });
      return;
    }
    if (LIVE_TOOLS.has(name) && cap.remaining() === 0) {
      sendError(res, { code: "DAILY_LIMIT", message: `All ${cap.limit} live checks for today are used; they reset at midnight IST.` });
      return;
    }
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await (await client()).callTool({ name, arguments: args as Record<string, unknown> }, undefined, { timeout: 180_000 });
    } catch (e) {
      console.error(`tool ${name} failed:`, e instanceof Error ? e.message : String(e));
      sendError(res, { code: "INTERNAL", message: "The tool call failed inside the app." });
      return;
    }
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    const text = first && first.type === "text" ? first.text : "";
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (result.isError) {
      const err = (payload as { error?: ApiError } | undefined)?.error;
      if (!err) {
        // The MCP SDK reports argument validation failures as plain text.
        sendError(res, { code: "INVALID_INPUT", message: text || "The tool rejected the input." });
        return;
      }
      if (err.code === "RATE_LIMITED" && LIVE_TOOLS.has(name) && cap.remaining() === 0) {
        sendError(res, { ...err, code: "DAILY_LIMIT" });
        return;
      }
      sendError(res, err);
      return;
    }
    if (payload === undefined) {
      sendError(res, { code: "UPSTREAM_UNAVAILABLE", message: "The tool returned an unreadable answer." });
      return;
    }
    send(res, 200, { data: payload, live_checks: liveChecks() });
  });

  api.use((_req, res) => sendError(res, { code: "NOT_FOUND_ROUTE", message: "No such API endpoint." }));

  // Malformed JSON and other errors raised by middleware.
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      sendError(res, { code: "INVALID_INPUT", message: "The request body could not be read as JSON." });
      return;
    }
    console.error("api error:", err instanceof Error ? err.message : String(err));
    sendError(res, { code: "INTERNAL", message: "Unexpected error." });
  });

  app.use("/api", api);
  app.use(express.static(webDir, { dotfiles: "deny", index: "index.html", etag: false }));
  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });
  return app;
}

/** A non-negative integer setting, or the default when unset or blank. */
function intSetting(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  return n;
}

async function main(): Promise<void> {
  const port = intSetting("APP_PORT", process.env.APP_PORT, DEFAULT_PORT, 1, 65_535);
  const limit = intSetting("APP_DAILY_PAGE_READS", process.env.APP_DAILY_PAGE_READS, DEFAULT_DAILY_PAGE_READS, 0, 100_000);
  const cfg = loadConfig();
  const cap = new DailyReadCap(limit);
  const ctx = buildContext(cfg, { railyatriBeforeRead: cap.beforeRead });
  if (!cfg.unofficial.has("railyatri")) {
    console.warn("railyatri is not enabled (ENABLE_UNOFFICIAL_SOURCES), so live seat checks will be unavailable.");
  }
  const app = createLocalApp(ctx, { cap, secrets: [cfg.firecrawl.apiKey] });
  const server: Server = app.listen(port, LISTEN_HOST);
  server.on("listening", () => console.log(`Rail Seat Finder: http://${LISTEN_HOST}:${port}/ (live checks today: 0/${limit})`));
  server.on("error", (e) => {
    console.error(`Could not listen on ${LISTEN_HOST}:${port}: ${e.message}`);
    process.exit(1);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
