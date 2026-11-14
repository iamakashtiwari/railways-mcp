import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_TOOLS, DailyReadCap, SECURITY_HEADERS, createLocalApp, httpStatusFor, type LocalAppOptions } from "../src/app.js";
import { buildContext, loadConfig } from "../src/config.js";
import { RailError } from "../src/core/errors.js";
import { addDays, todayInIndia } from "../src/core/time.js";
import type { RouteAvailability, RouteTrainAvailability } from "../src/core/types.js";
import { TtlCache } from "../src/lib/cache.js";
import type { RouteAvailabilityQuery, RouteAvailabilitySource } from "../src/providers/types.js";
import { RailYatriProvider } from "../src/providers/unofficial/railyatri.js";
import { sampleProvider } from "./helpers.js";

const D = addDays(todayInIndia(), 7);

/** Synthetic live listing (no real train data). */
const TRAIN: RouteTrainAvailability = {
  train_number: "55555",
  train_name: "Train 55555",
  from_code: "AAA",
  to_code: "DDD",
  departure_time: "10:00",
  arrival_time: "20:00",
  duration_minutes: 600,
  runs_on_date: true,
  next_run: null,
  classes: [{ class_code: "3A", status: "12 Available", category: "available", count: 12, fare_inr: 1000, confirm_chance: null }],
};

/**
 * Fake route_availability provider. Like railyatri, it calls the beforeRead hook only on a
 * real "page read" and serves repeats from its own cache. Behaviour per route via `errors`.
 */
class FakeRoute implements RouteAvailabilitySource {
  readonly info = {
    id: "fake-live",
    name: "Fake live",
    kind: "unofficial_api" as const,
    capabilities: [],
    dataAsOf: null,
    possiblyOutdated: false,
  };
  readonly reads: string[] = [];
  errors: Record<string, RailError> = {};
  private readonly cache = new Map<string, RouteAvailability>();

  constructor(private readonly beforeRead?: () => void) {}

  async routeAvailability(q: RouteAvailabilityQuery): Promise<RouteAvailability> {
    const key = `${q.from}|${q.to}|${q.date}`;
    const err = this.errors[`${q.from}|${q.to}`];
    if (err) throw err;
    const hit = this.cache.get(key);
    if (hit) return hit;
    this.beforeRead?.();
    this.reads.push(key);
    const value: RouteAvailability = {
      from_code: q.from,
      to_code: q.to,
      date: q.date,
      quota: "GN",
      trains: [{ ...TRAIN, from_code: q.from, to_code: q.to }],
      observed_at: "2026-01-01T00:00:00.000Z",
    };
    this.cache.set(key, value);
    return value;
  }
}

interface Started {
  port: number;
  fake: FakeRoute;
  cap: DailyReadCap;
}

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start(opts: { limit?: number; capNow?: () => Date } & Partial<Omit<LocalAppOptions, "cap">> = {}): Promise<Started> {
  const cap = new DailyReadCap(opts.limit ?? 150, opts.capNow);
  const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
  const fake = new FakeRoute(cap.beforeRead);
  ctx.registry.register("route_availability", fake);
  const app = createLocalApp(ctx, { ...opts, cap });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return { port: (server.address() as AddressInfo).port, fake, cap };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}

/** Raw HTTP request (node:http lets tests set any Host header). Same-origin page headers by default. */
function call(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<Reply> {
  const base: Record<string, string | undefined> = {
    host: `127.0.0.1:${port}`,
    "x-app": "railways",
    origin: `http://127.0.0.1:${port}`,
    "sec-fetch-site": "same-origin",
  };
  const headers = Object.fromEntries(Object.entries({ ...base, ...opts.headers }).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
  const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const tool = (port: number, name: string, args: unknown, headers?: Record<string, string | undefined>) =>
  call(port, "POST", `/api/tools/${name}`, { body: args, headers });

function expectSecurityHeaders(r: Reply): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers[k.toLowerCase()]).toBe(v);
  expect(r.headers["x-powered-by"]).toBeUndefined();
  expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
}

describe("security headers", () => {
  it("are set on the page, API answers, errors and unknown paths, with no X-Powered-By or CORS headers", async () => {
    const { port } = await start();
    const page = await call(port, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Rail Seat Finder");
    for (const r of [
      page,
      await call(port, "GET", "/api/status"),
      await tool(port, "search_stations", { query: "alpha" }),
      await call(port, "GET", "/nope"),
      await call(port, "GET", "/", { headers: { host: "evil.example" } }),
      await call(port, "OPTIONS", "/api/tools/search_stations", {
        headers: { origin: "http://evil.example", "access-control-request-method": "POST" },
      }),
    ]) {
      expectSecurityHeaders(r);
    }
    expect(page.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  });
});

describe("Host header (DNS rebinding)", () => {
  it.each([
    "evil.example",
    "evil.example:PORT",
    "127.0.0.1",
    "127.0.0.1:1",
    "localhost:1",
    "0.0.0.0:PORT",
    "[::1]:PORT",
    "127.0.0.1:PORT.evil.example",
  ])("rejects %s", async (h) => {
    const { port } = await start();
    for (const path of ["/", "/api/status"]) {
      const r = await call(port, "GET", path, { headers: { host: h.replace("PORT", String(port)) } });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("BAD_HOST");
    }
  });

  it("accepts 127.0.0.1:PORT and localhost:PORT", async () => {
    const { port } = await start();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const r = await call(port, "GET", "/api/status", { headers: { host, origin: `http://${host}` } });
      expect(r.status).toBe(200);
    }
  });
});

describe("same-origin API", () => {
  it("rejects requests without x-app: railways", async () => {
    const { port } = await start();
    for (const v of [undefined, "", "other"]) {
      const r = await tool(port, "search_stations", { query: "alpha" }, { "x-app": v });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("FORBIDDEN");
    }
    expect((await call(port, "GET", "/api/status", { headers: { "x-app": undefined } })).status).toBe(403);
  });

  it("rejects another Origin and cross-site fetch metadata", async () => {
    const { port, fake } = await start();
    for (const headers of [
      { origin: "http://evil.example" },
      { origin: "null" },
      { origin: `https://127.0.0.1:${port}` },
      { origin: `http://localhost:${port}` }, // other host than the one in Host
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const r = await tool(port, "get_route_availability", { from: "AAA", to: "DDD", date: D }, headers);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("FORBIDDEN");
    }
    expect(fake.reads).toEqual([]);
  });

  it("answers a same-origin call from the page", async () => {
    const { port } = await start();
    const r = await tool(port, "search_stations", { query: "alpha" });
    expect(r.status).toBe(200);
    expect(r.json.data.stations[0]).toMatchObject({ code: "AAA" });
    expect(r.json.live_checks).toEqual({ used: 0, limit: 150 });
  });
});

describe("tool allow-list", () => {
  it("is exactly the five read-only tools in the spec", () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual([
      "find_nearby_stations",
      "get_data_sources",
      "get_route_availability",
      "plan_journey",
      "search_stations",
    ]);
  });

  it.each(["find_trains_between", "get_seat_availability", "get_fare", "get_train_schedule", "nonexistent", "__proto__"])(
    "rejects %s",
    async (name) => {
      const { port } = await start();
      const r = await tool(port, name, {});
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("TOOL_NOT_ALLOWED");
    },
  );
});

describe("tool errors → HTTP status", () => {
  it("maps codes to statuses", () => {
    expect(httpStatusFor("INVALID_INPUT")).toBe(400);
    expect(httpStatusFor("NOT_FOUND")).toBe(404);
    expect(httpStatusFor("RATE_LIMITED")).toBe(429);
    expect(httpStatusFor("UNSUPPORTED")).toBe(501);
    expect(httpStatusFor("UPSTREAM_UNAVAILABLE")).toBe(502);
    expect(httpStatusFor("UPSTREAM_AUTH")).toBe(502);
    expect(httpStatusFor("DAILY_LIMIT")).toBe(429);
  });

  it("returns the tool's error code with its HTTP status", async () => {
    const { port, fake } = await start();
    fake.errors["AAA|DDD"] = new RailError("NOT_FOUND", "no trains on this synthetic route", "fake-live");
    fake.errors["AAA|CCC"] = new RailError("UPSTREAM_UNAVAILABLE", "synthetic outage", "fake-live");
    fake.errors["BBB|DDD"] = new RailError("RATE_LIMITED", "synthetic quota", "fake-live", 30);

    const nf = await tool(port, "get_route_availability", { from: "AAA", to: "DDD", date: D });
    expect(nf.status).toBe(404);
    expect(nf.json.error).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("synthetic route") });

    const up = await tool(port, "get_route_availability", { from: "AAA", to: "CCC", date: D });
    expect(up.status).toBe(502);
    expect(up.json.error.code).toBe("UPSTREAM_UNAVAILABLE");

    const rl = await tool(port, "get_route_availability", { from: "BBB", to: "DDD", date: D });
    expect(rl.status).toBe(429);
    expect(rl.json.error.code).toBe("RATE_LIMITED");
    expect(rl.headers["retry-after"]).toBe("30");
  });

  it("returns 400 INVALID_INPUT for bad arguments and bad JSON", async () => {
    const { port } = await start();
    const badDate = await tool(port, "get_route_availability", { from: "AAA", to: "DDD", date: "2026-13-45" });
    expect(badDate.status).toBe(400);
    expect(badDate.json.error.code).toBe("INVALID_INPUT");
    const badJson = await call(port, "POST", "/api/tools/search_stations", { body: "{not json" });
    expect(badJson.status).toBe(400);
    expect(badJson.json.error.code).toBe("INVALID_INPUT");
  });

  it("never sends a configured secret back", async () => {
    const secret = "fc-synthetic-secret-123";
    const { port, fake } = await start({ secrets: [secret] });
    fake.errors["AAA|DDD"] = new RailError("UPSTREAM_AUTH", `key ${secret} was rejected`, "fake-live");
    const r = await tool(port, "get_route_availability", { from: "AAA", to: "DDD", date: D });
    expect(r.status).toBe(502);
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain("[redacted]");
  });
});

describe("per-minute limit", () => {
  it("allows the configured number of API calls a minute, then answers 429 with Retry-After", async () => {
    let t = 1_000_000;
    const { port } = await start({ callsPerMinute: 3, nowMs: () => t });
    for (let i = 0; i < 3; i++) expect((await call(port, "GET", "/api/status")).status).toBe(200);
    const r = await call(port, "GET", "/api/status");
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("TOO_MANY_REQUESTS");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    t += 60_001;
    expect((await call(port, "GET", "/api/status")).status).toBe(200);
  });
});

describe("daily live-check cap", () => {
  it("counts only real page reads, refuses once used up, and resets at midnight IST", async () => {
    // 23:00 IST = 17:30 UTC
    let now = new Date("2026-11-20T17:30:00Z");
    const { port, fake } = await start({ limit: 2, capNow: () => now });
    const route = (to: string) => tool(port, "get_route_availability", { from: "AAA", to, date: D });

    expect((await route("DDD")).json.live_checks).toEqual({ used: 1, limit: 2 });
    expect((await route("DDD")).json.live_checks).toEqual({ used: 1, limit: 2 }); // cache hit: not counted
    expect((await route("CCC")).json.live_checks).toEqual({ used: 2, limit: 2 });

    const refused = await route("EEE");
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe("DAILY_LIMIT");
    expect(fake.reads).toHaveLength(2);
    expect((await call(port, "GET", "/api/status")).json.live_checks).toEqual({ used: 2, limit: 2 });

    // non-live tools still work
    expect((await tool(port, "search_stations", { query: "alpha" })).status).toBe(200);

    now = new Date("2026-11-20T18:31:00Z"); // 00:01 IST next day
    const after = await route("EEE");
    expect(after.status).toBe(200);
    expect(after.json.live_checks).toEqual({ used: 1, limit: 2 });
  });

  it("the hook itself refuses a read beyond the cap", () => {
    const cap = new DailyReadCap(1);
    cap.beforeRead();
    expect(() => cap.beforeRead()).toThrow(RailError);
    expect(cap.used()).toBe(1);
  });

  it("railyatri calls beforeRead before a real Firecrawl read, not on a cache hit, and a refusal stops the read", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ success: false, error: "synthetic" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const cap = new DailyReadCap(1);
    const hook = vi.fn(cap.beforeRead);
    const cache = new TtlCache<RouteAvailability>();
    const p = new RailYatriProvider({ apiKey: "test-key", minIntervalMs: 0, retries: 0, cache, beforeRead: hook });

    // a cached route never reaches the hook
    cache.set(`AAA|DDD|${D}`, { from_code: "AAA", to_code: "DDD", date: D, quota: "GN", trains: [TRAIN], observed_at: "x" }, 60_000);
    await p.routeAvailability({ from: "AAA", to: "DDD", date: D });
    expect(hook).not.toHaveBeenCalled();

    // a miss calls the hook, then Firecrawl
    await expect(p.routeAvailability({ from: "AAA", to: "CCC", date: D })).rejects.toBeInstanceOf(RailError);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // over the cap: the hook throws and Firecrawl is not called
    await expect(p.routeAvailability({ from: "AAA", to: "EEE", date: D })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
