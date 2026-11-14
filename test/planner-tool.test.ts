import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { RailError } from "../src/core/errors.js";
import { addDays, todayInIndia } from "../src/core/time.js";
import type { RouteAvailability, RouteClassAvailability, RouteTrainAvailability } from "../src/core/types.js";
import { createMcpServer } from "../src/mcp.js";
import type { RouteAvailabilityQuery, RouteAvailabilitySource } from "../src/providers/types.js";
import { sampleProvider } from "./helpers.js";

const D = addDays(todayInIndia(), 7);
const D1 = addDays(D, 1);

const c = (class_code: string, category: RouteClassAvailability["category"], count: number | null, fare: number | null = 1000) => ({
  class_code,
  status: category === "available" ? `${count} Available` : category === "waitlist" ? `${count} Waitlist` : "Regret",
  category,
  count,
  fare_inr: fare,
  confirm_chance: null,
});
const t = (n: string, from: string, to: string, classes: RouteClassAvailability[], runs = true): RouteTrainAvailability => ({
  train_number: n,
  train_name: `Train ${n}`,
  from_code: from,
  to_code: to,
  departure_time: null,
  arrival_time: null,
  duration_minutes: 600,
  runs_on_date: runs,
  next_run: runs ? null : "Mon, Jan 1",
  classes,
});

/** Synthetic live listings keyed by from|to|date. */
const LISTINGS: Record<string, RouteTrainAvailability[]> = {
  [`AAA|DDD|${D}`]: [
    t("55555", "AAA", "DDD", [c("3A", "waitlist", 30), c("2A", "waitlist", 6)]),
    t("99999", "AAA", "DDD", [c("3A", "available", 9)], false),
  ],
  [`AAA|EEE|${D}`]: [t("77777", "AAA", "EEE", [c("2A", "available", 4, 1500)])],
  [`AAA|CCC|${D}`]: [t("11111", "AAA", "CCC", [c("3A", "available", 5, 800)])],
  [`CCC|DDD|${D1}`]: [t("44444", "CCC", "DDD", [c("3A", "available", 2, 300)])],
};

class FakeRoute implements RouteAvailabilitySource {
  readonly info = {
    id: "fake-live",
    name: "Fake live",
    kind: "unofficial_api" as const,
    capabilities: [],
    dataAsOf: null,
    possiblyOutdated: false,
  };
  calls: string[] = [];
  async routeAvailability(q: RouteAvailabilityQuery): Promise<RouteAvailability> {
    const key = `${q.from}|${q.to}|${q.date}`;
    this.calls.push(key);
    const trains = LISTINGS[key];
    if (!trains) throw new RailError("NOT_FOUND", `no listing for ${key}`, "fake-live");
    return { from_code: q.from, to_code: q.to, date: q.date, quota: "GN", trains, observed_at: "2026-01-01T00:00:00.000Z" };
  }
}

const parse = (r: any) => JSON.parse(r.content[0].text);
let client: Client;
const fake = new FakeRoute();

beforeAll(async () => {
  const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
  ctx.registry.register("route_availability", fake);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([createMcpServer(ctx).connect(serverT), client.connect(clientT)]);
});

describe("get_route_availability", () => {
  it("lists trains running on the date with a summary", async () => {
    const r = parse(await client.callTool({ name: "get_route_availability", arguments: { from: "AAA", to: "DDD", date: D } }));
    expect(r.availability.trains.map((x: any) => x.train_number)).toEqual(["55555"]);
    expect(r.summary).toMatchObject({ trains_running: 1, waitlist: 2, available: 0 });
    const all = parse(
      await client.callTool({
        name: "get_route_availability",
        arguments: { from: "AAA", to: "DDD", date: D, include_other_days: true, classes: ["3A"] },
      }),
    );
    expect(all.availability.trains).toHaveLength(2);
    expect(all.availability.trains[0].classes.map((x: any) => x.class_code)).toEqual(["3A"]);
  });

  it("is UNSUPPORTED without a live source", async () => {
    const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const bare = new Client({ name: "t", version: "1" });
    await Promise.all([createMcpServer(ctx).connect(b), bare.connect(a)]);
    const r = await bare.callTool({ name: "get_route_availability", arguments: { from: "AAA", to: "DDD", date: D } });
    expect(r.isError).toBe(true);
    expect(parse(r).error.code).toBe("UNSUPPORTED");
  });
});

describe("plan_journey", () => {
  it("ranks a fully confirmed one-change journey above a direct waitlist, with correct leg dates", async () => {
    fake.calls = [];
    const r = parse(
      await client.callTool({
        name: "plan_journey",
        arguments: { from: "AAA", to: "DDD", date: D, classes: ["3A", "2A"], min_layover_minutes: 30, max_change_stations: 1 },
      }),
    );
    const top = r.options[0];
    expect(top).toMatchObject({ kind: "connection", worst_category: "available", total_fare_inr: 1100, transfer: { station_code: "CCC" } });
    expect(top.legs.map((l: any) => [l.train_number, l.date])).toEqual([
      ["11111", D],
      ["44444", D1],
    ]);
    expect(r.options.slice(1).map((o: any) => [o.kind, o.legs[0].class_code, o.legs[0].count])).toEqual([
      ["direct", "2A", 6],
      ["direct", "3A", 30],
    ]);
    expect(r.lookups_used).toBe(new Set(fake.calls).size);
  });

  it("checks alternative destinations and skips connections when asked", async () => {
    fake.calls = [];
    const r = parse(
      await client.callTool({
        name: "plan_journey",
        arguments: { from: "AAA", to: "DDD", date: D, alternative_destinations: ["EEE"], connections: "never" },
      }),
    );
    expect(r.options[0]).toMatchObject({ kind: "alternative_destination", worst_category: "available" });
    expect(r.options[0].legs[0]).toMatchObject({ train_number: "77777", to_code: "EEE" });
    expect(r.considered.connections_checked).toBe(0);
    expect(fake.calls.sort()).toEqual([`AAA|DDD|${D}`, `AAA|EEE|${D}`]);
  });
});
