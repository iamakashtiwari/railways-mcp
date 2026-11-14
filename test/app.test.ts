import { type Server, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_TOOLS, DailyCap, createLocalApp } from "../src/app.js";
import { buildContext, loadConfig } from "../src/config.js";
import { RailError } from "../src/core/errors.js";
import { addDays, todayInIndia } from "../src/core/time.js";
import type { RouteAvailability } from "../src/core/types.js";
import type { RouteAvailabilityQuery } from "../src/providers/types.js";
import { sampleProvider } from "./helpers.js";

const D = addDays(todayInIndia(), 5);
let server: Server;
let base: string;
let port: number;
const cap = new DailyCap(2);

const fakeLive = {
  info: { id: "fake-live", name: "Fake live", kind: "unofficial_api" as const, capabilities: [], dataAsOf: null, possiblyOutdated: false },
  async routeAvailability(q: RouteAvailabilityQuery): Promise<RouteAvailability> {
    cap.take();
    return {
      from_code: q.from,
      to_code: q.to,
      date: q.date,
      quota: "GN",
      observed_at: "2026-01-01T00:00:00.000Z",
      trains: [
        {
          train_number: "11111",
          train_name: "Sample <b>Express</b>",
          from_code: q.from,
          to_code: q.to,
          departure_time: "20:00",
          arrival_time: "02:00",
          duration_minutes: 360,
          runs_on_date: true,
          next_run: null,
          classes: [{ class_code: "3A", status: "5 Available", category: "available", count: 5, fare_inr: 900, confirm_chance: null }],
        },
      ],
    };
  },
};

beforeAll(async () => {
  const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
  ctx.registry.register("route_availability", fakeLive);
  // Bind first to learn the port, then build the app for that port.
  const probe = (await createLocalApp(ctx, { port: 1, cap })).listen(0, "127.0.0.1");
  await new Promise<void>((r) => probe.once("listening", () => r()));
  port = (probe.address() as AddressInfo).port;
  probe.close();
  const app = await createLocalApp(ctx, { port, cap, perMinute: 50 });
  server = app.listen(port, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => server?.close());

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app": "railways", ...headers },
    body: JSON.stringify(body),
  });

describe("local app", () => {
  it("serves the page with strict security headers", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Rail Seat Finder");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("rejects requests addressed to another host name (DNS rebinding)", async () => {
    // fetch() can't override Host, so send a raw request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("rejects API calls without the app header or from another origin", async () => {
    const noHeader = await fetch(`${base}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "search_stations", args: { query: "aaa" } }),
    });
    expect(noHeader.status).toBe(403);
    expect((await post({ tool: "search_stations", args: { query: "aaa" } }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ tool: "search_stations", args: { query: "aaa" } }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("only runs allow-listed read-only tools", async () => {
    expect(APP_TOOLS.has("get_route_availability")).toBe(true);
    const res = await post({ tool: "get_train_schedule", args: { train_number: "11111" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_INPUT");
  });

  it("returns tool results and maps tool errors to HTTP status codes", async () => {
    const ok = await post({ tool: "get_route_availability", args: { from: "AAA", to: "DDD", date: D } });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.availability.trains[0].train_name).toBe("Sample <b>Express</b>");
    const bad = await post({ tool: "get_route_availability", args: { from: "AAA", to: "DDD", date: "2001-01-01" } });
    expect(bad.status).toBe(400);
  });

  it("enforces the daily live-check cap", async () => {
    const status = await (await fetch(`${base}/api/status`, { headers: { "x-app": "railways" } })).json();
    expect(status).toMatchObject({ live: true, reads_today: { limit: 2 } });
    await post({ tool: "get_route_availability", args: { from: "AAA", to: "CCC", date: D } });
    const over = await post({ tool: "get_route_availability", args: { from: "AAA", to: "BBB", date: D } });
    expect(over.status).toBe(429);
    expect((await over.json()).error.message).toContain("Daily limit");
  });
});

describe("DailyCap", () => {
  it("resets on a new India day", () => {
    let day = "2026-01-01";
    const c = new DailyCap(1, () => day);
    c.take();
    expect(() => c.take()).toThrow(RailError);
    day = "2026-01-02";
    expect(() => c.take()).not.toThrow();
    expect(c.status()).toEqual({ used: 1, limit: 1 });
  });
});
