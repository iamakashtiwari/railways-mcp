import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailError } from "../../src/core/errors.js";
import type { RouteAvailability } from "../../src/core/types.js";
import { TtlCache } from "../../src/lib/cache.js";
import { RailYatriProvider, pageUrl, parseRoutePage, parseStatus, shownDate } from "../../src/providers/unofficial/railyatri.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/railyatri/${name}`, import.meta.url), "utf8");
const NOW = () => new Date("2026-11-14T06:00:00Z");
const provider = () =>
  new RailYatriProvider({ apiKey: "test-key", minIntervalMs: 0, retries: 0, now: NOW, cache: new TtlCache<RouteAvailability>() });

function stubFetch(reply: () => { body: string; status?: number }) {
  const fn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const { body, status = 200 } = reply();
    return new Response(body, { status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const firecrawlOk = (markdown: string) => JSON.stringify({ success: true, data: { markdown, metadata: { statusCode: 200 } } });

async function railError(p: Promise<unknown>): Promise<RailError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RailError);
    return e as RailError;
  }
  throw new Error("expected a RailError");
}

afterEach(() => vi.unstubAllGlobals());

describe("parseStatus", () => {
  it.each([
    ["12 Available", "available", 12],
    ["AVAILABLE-0042", "available", 42],
    ["RAC 3", "rac", 3],
    ["7 RAC", "rac", 7],
    ["40 Waitlist", "waitlist", 40],
    ["GNWL45/WL20", "waitlist", 45],
    ["Regret", "not_available", null],
    ["Not Available", "not_available", null],
    ["Invalid train", "not_available", null],
    ["Tap to refresh", "unknown", null],
    ["Something new", "unknown", null],
  ])("%s → %s", (raw, category, count) => {
    expect(parseStatus(raw)).toEqual({ category, count });
  });
});

describe("page parsing", () => {
  const md = fixture("route-ndls-cpr.md");

  it("reads the journey date the page shows", () => {
    expect(shownDate(md)).toBe("18 Nov");
    expect(shownDate(fixture("route-no-date.md"))).toBeNull();
  });

  it("parses trains, stations, times, classes, fares and chances", () => {
    const trains = parseRoutePage(md);
    expect(trains.map((t) => t.train_number)).toEqual(["12345", "23456", "04567", "34567"]);
    const t = trains[0]!;
    expect(t).toMatchObject({
      train_name: "Sample Superfast Express",
      from_code: "NDLS",
      to_code: "CPR",
      departure_time: "21:15",
      arrival_time: "12:45",
      duration_minutes: 930,
      runs_on_date: true,
      next_run: null,
    });
    expect(t.classes).toEqual([
      { class_code: "SL", status: "88 Waitlist", category: "waitlist", count: 88, fare_inr: 530, confirm_chance: "low" },
      { class_code: "3A", status: "12 Available", category: "available", count: 12, fare_inr: 1360, confirm_chance: null },
      { class_code: "2A", status: "RAC 3", category: "rac", count: 3, fare_inr: 1915, confirm_chance: null },
      { class_code: "1A", status: "2 Waitlist", category: "waitlist", count: 2, fare_inr: 3200, confirm_chance: "medium" },
    ]);
  });

  it("keeps the boarding terminal of trains from nearby stations and marks unknown cells", () => {
    const trains = parseRoutePage(md);
    expect(trains[1]).toMatchObject({ from_code: "ANVT", departure_time: "16:30" });
    expect(trains[1]!.classes.find((c) => c.class_code === "SL")).toMatchObject({ category: "not_available", fare_inr: null });
    expect(trains[2]!.classes.map((c) => [c.class_code, c.category, c.fare_inr])).toEqual([
      ["3A", "unknown", null],
      ["2A", "unknown", 1830],
    ]);
  });

  it("marks trains listed for other days with their next run", () => {
    const t = parseRoutePage(md)[3]!;
    expect(t).toMatchObject({ train_number: "34567", runs_on_date: false, next_run: "Thu, Nov 19" });
  });

  it("builds the page URL with DD-MM-YYYY", () => {
    expect(pageUrl("NDLS", "CPR", "2026-11-18")).toBe(
      "https://www.railyatri.in/booking/trains-between-stations?from_code=NDLS&to_code=CPR&journey_date=18-11-2026",
    );
  });
});

describe("RailYatriProvider", () => {
  it("asks Firecrawl for a fresh, India-located read of the right page", async () => {
    const f = stubFetch(() => ({ body: firecrawlOk(fixture("route-ndls-cpr.md")) }));
    const r = await provider().routeAvailability({ from: "ndls", to: "CPR", date: "2026-11-18" });
    expect(r.trains).toHaveLength(4);
    expect(r.observed_at).toBe("2026-11-14T06:00:00.000Z");
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://api.firecrawl.dev/v2/scrape");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ maxAge: 0, location: { country: "IN" }, formats: ["markdown"] });
    expect(body.url).toContain("journey_date=18-11-2026");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer test-key");
  });

  it("discards a page that shows another date", async () => {
    stubFetch(() => ({ body: firecrawlOk(fixture("route-ndls-cpr.md")) }));
    const e = await railError(provider().routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-19" }));
    expect(e.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(e.message).toContain("18 Nov instead of 19 Nov");
  });

  it("treats an unrecognised layout as a failure, not as 'no trains'", async () => {
    stubFetch(() => ({ body: firecrawlOk("Date\n\n18 Nov, Wed\n\nSomething else entirely") }));
    expect((await railError(provider().routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" }))).code).toBe(
      "UPSTREAM_UNAVAILABLE",
    );
  });

  it("maps Firecrawl failures to typed errors", async () => {
    stubFetch(() => ({ body: "{}", status: 402 }));
    expect((await railError(provider().routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" }))).code).toBe("RATE_LIMITED");
    stubFetch(() => ({ body: "{}", status: 401 }));
    expect((await railError(provider().routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" }))).code).toBe("UPSTREAM_AUTH");
    stubFetch(() => ({ body: JSON.stringify({ success: false, error: "blocked" }) }));
    const e = await railError(provider().routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" }));
    expect(e.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(e.message).toContain("blocked");
  });

  it("rejects past dates without a request", async () => {
    const f = stubFetch(() => ({ body: "" }));
    expect((await railError(provider().routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-01" }))).code).toBe("INVALID_INPUT");
    expect(f).not.toHaveBeenCalled();
  });

  it("serves repeat reads of the same route and date from cache", async () => {
    const f = stubFetch(() => ({ body: firecrawlOk(fixture("route-ndls-cpr.md")) }));
    const p = provider();
    await p.routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" });
    await p.routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("answers single-train availability for general quota only", async () => {
    stubFetch(() => ({ body: firecrawlOk(fixture("route-ndls-cpr.md")) }));
    const p = provider();
    const a = await p.availability({ trainNumber: "23456", from: "NDLS", to: "CPR", date: "2026-11-18", classCode: "2A", quota: "GN" });
    expect(a).toMatchObject({ train_number: "23456", from_code: "ANVT", class_code: "2A", quota: "GN" });
    expect(a.days).toEqual([
      { date: "2026-11-18", status: "5 Waitlist", category: "waitlist", confirm_probability_percent: null, confirm_chance: "high" },
    ]);
    expect(
      (await railError(p.availability({ trainNumber: "23456", from: "NDLS", to: "CPR", date: "2026-11-18", classCode: "2A", quota: "TQ" })))
        .code,
    ).toBe("UNSUPPORTED");
    expect(
      (await railError(p.availability({ trainNumber: "34567", from: "NDLS", to: "CPR", date: "2026-11-18", classCode: "3A", quota: "GN" })))
        .code,
    ).toBe("NOT_FOUND");
  });
});

describe("Firecrawl pacing and refusals", () => {
  const md = fixture("route-ndls-cpr.md"); // shows 18 Nov
  const okBody = () => firecrawlOk(md);
  const make = (extra: Partial<ConstructorParameters<typeof RailYatriProvider>[0]> = {}) =>
    new RailYatriProvider({
      apiKey: "test-key",
      minIntervalMs: 0,
      retries: 0,
      now: NOW,
      cache: new TtlCache<RouteAvailability>(),
      maxRetryAfterSeconds: 2,
      ...extra,
    });

  it("runs at most maxConcurrent page reads at once", async () => {
    let running = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return new Response(okBody(), { status: 200 });
      }),
    );
    const p = make({ maxConcurrent: 2 });
    const routes = ["CPR", "DDD", "EEE", "FFF", "GGG"].map((to) =>
      p.routeAvailability({ from: "NDLS", to, date: "2026-11-18" }).catch(() => null),
    );
    await Promise.all(routes);
    expect(peak).toBe(2);
  });

  it("after a rate-limit 429 waits for Retry-After, tries once more, and keeps the read counted once", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429, headers: { "retry-after": "1" } })
        : new Response(okBody(), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);
    const before = vi.fn();
    const refused = vi.fn();
    const t0 = Date.now();
    const r = await make({ beforeRead: before, onReadRefused: refused }).routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" });
    expect(r.trains.length).toBeGreaterThan(0);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(before).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it("gives the counted read back when Firecrawl still refuses, or refuses for credits or quota", async () => {
    for (const [status, body, headers, calls] of [
      [429, { error: "Rate limit exceeded" }, { "retry-after": "1" }, 2],
      [429, { error: "Rate limit exceeded" }, { "retry-after": "120" }, 1], // longer than we wait
      [429, { error: "Monthly quota exceeded" }, {}, 1],
      [402, { error: "Insufficient credits" }, {}, 1],
    ] as const) {
      const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));
      vi.stubGlobal("fetch", fn);
      const refused = vi.fn();
      const e = await railError(make({ onReadRefused: refused }).routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" }));
      expect(e.code).toBe("RATE_LIMITED");
      expect(fn).toHaveBeenCalledTimes(calls);
      expect(refused).toHaveBeenCalledTimes(1);
    }
  });

  it("does not refund other failures or the daily cap's own refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 })),
    );
    const refused = vi.fn();
    expect(
      (await railError(make({ onReadRefused: refused }).routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" }))).code,
    ).toBe("UPSTREAM_UNAVAILABLE");
    const capErr = new RailError("RATE_LIMITED", "daily cap", "app");
    const p = make({
      onReadRefused: refused,
      beforeRead: () => {
        throw capErr;
      },
    });
    expect(await railError(p.routeAvailability({ from: "NDLS", to: "CPR", date: "2026-11-18" }))).toBe(capErr);
    expect(refused).not.toHaveBeenCalled();
  });
});
