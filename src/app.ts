/**
 * Private local web app: a search page for live seat availability and
 * journey alternatives, served only on this computer's loopback address.
 *
 *   npm run app        → http://127.0.0.1:4321
 *
 * Safety model (personal use, one machine):
 *  - Listens on 127.0.0.1 only; other devices on the network cannot connect.
 *  - Host header must be 127.0.0.1/localhost on this port (blocks DNS rebinding).
 *  - API calls need a custom header and a same-origin request; other websites
 *    open in the same browser cannot call the API (no CORS is ever granted).
 *  - Strict Content-Security-Policy: only this app's own files run; no third-party
 *    scripts, fonts or trackers.
 *  - Only a fixed list of read-only tools can be called.
 *  - A per-minute request limit and a daily cap on live page reads protect the
 *    Firecrawl key's credits. The key stays in .env on this machine.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type AppContext, buildContext, loadConfig } from "./config.js";
import { RailError } from "./core/errors.js";
import { todayInIndia } from "./core/time.js";
import { createMcpServer } from "./mcp.js";

export const APP_HOST = "127.0.0.1";
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const WEB_DIR_BUILT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");

/** Read-only tools the page may call. */
export const APP_TOOLS = new Set(["search_stations", "find_nearby_stations", "get_route_availability", "plan_journey", "get_data_sources"]);

const STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UNSUPPORTED: 501,
  UPSTREAM_AUTH: 502,
  UPSTREAM_UNAVAILABLE: 502,
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Counts live page reads per India calendar day and refuses reads past the cap. */
export class DailyCap {
  private day = "";
  private used = 0;
  constructor(
    readonly limit: number,
    private readonly today: () => string = () => todayInIndia(),
  ) {}
  take(): void {
    this.roll();
    if (this.used >= this.limit) {
      throw new RailError(
        "RATE_LIMITED",
        `Daily limit of ${this.limit} live checks reached (APP_DAILY_PAGE_READS). It resets at midnight IST.`,
      );
    }
    this.used++;
  }
  status(): { used: number; limit: number } {
    this.roll();
    return { used: this.used, limit: this.limit };
  }
  private roll(): void {
    const d = this.today();
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
    }
  }
}

/** Sliding one-minute window. */
class MinuteLimit {
  private hits: number[] = [];
  constructor(private readonly perMinute: number) {}
  allow(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < 60_000);
    if (this.hits.length >= this.perMinute) return false;
    this.hits.push(now);
    return true;
  }
}

export interface LocalAppOptions {
  port: number;
  cap: DailyCap;
  perMinute?: number;
  webDir?: string;
}

export async function createLocalApp(ctx: AppContext, opts: LocalAppOptions): Promise<Express> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "local-app", version: "1" });
  await Promise.all([createMcpServer(ctx).connect(serverT), client.connect(clientT)]);

  const hosts = new Set([`${APP_HOST}:${opts.port}`, `localhost:${opts.port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const limiter = new MinuteLimit(opts.perMinute ?? 120);
  const live = ctx.registry.providers("route_availability").length > 0;

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", "strong");

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.set({
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Cache-Control": "no-store",
    });
    if (!hosts.has(req.headers.host ?? "")) {
      res.status(403).type("text/plain").send("Forbidden host");
      return;
    }
    next();
  });

  const api = express.Router();
  api.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    const sameOrigin = (!origin || origins.has(origin)) && (!site || site === "same-origin" || site === "none");
    if (!sameOrigin || req.headers["x-app"] !== "railways") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Only this app's own page can call the API" } });
      return;
    }
    if (!limiter.allow()) {
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests; wait a minute" } });
      return;
    }
    next();
  });
  api.use(express.json({ limit: "16kb" }));

  api.get("/status", (_req, res) => {
    res.json({ live, reads_today: opts.cap.status(), today: todayInIndia() });
  });

  api.post("/call", async (req: Request, res: Response) => {
    const { tool, args } = (req.body ?? {}) as { tool?: unknown; args?: unknown };
    if (typeof tool !== "string" || !APP_TOOLS.has(tool) || (args !== undefined && (typeof args !== "object" || args === null))) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Unknown tool or bad arguments" } });
      return;
    }
    try {
      const r = (await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> })) as {
        isError?: boolean;
        content: { type: string; text?: string }[];
      };
      const text = r.content.find((c) => c.type === "text")?.text ?? "{}";
      const body = JSON.parse(text) as { error?: { code?: string } };
      res.status(r.isError ? (STATUS[body.error?.code ?? ""] ?? 500) : 200).json(body);
    } catch (e) {
      console.error("tool call failed:", e);
      res.status(500).json({ error: { code: "INTERNAL", message: "Unexpected error" } });
    }
  });

  app.use("/api", api);
  app.use(express.static(opts.webDir ?? WEB_DIR, { index: "index.html", etag: true, lastModified: false, dotfiles: "deny" }));
  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });
  return app;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const port = Number(process.env.APP_PORT ?? 4321);
  const limit = Number(process.env.APP_DAILY_PAGE_READS ?? 150);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("APP_PORT must be 1024-65535");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("APP_DAILY_PAGE_READS must be a positive integer");
  const cap = new DailyCap(limit);
  const ctx = buildContext(cfg, { beforePageRead: () => cap.take() });
  // tsx runs src/app.ts (web/ is one level up); the build runs dist/src/app.js (two levels up).
  const webDir = [WEB_DIR, WEB_DIR_BUILT].find((d) => existsSync(join(d, "index.html")));
  if (!webDir) throw new Error("web/index.html not found");
  const app = await createLocalApp(ctx, { port, cap, webDir });
  app.listen(port, APP_HOST, () => {
    const live = ctx.registry.providers("route_availability").length > 0;
    console.log(`Rail Seat Finder: http://${APP_HOST}:${port}  (this computer only)`);
    if (!live) console.log("Live seats are OFF: set ENABLE_UNOFFICIAL_SOURCES=railyatri and FIRECRAWL_API_KEY in .env");
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
