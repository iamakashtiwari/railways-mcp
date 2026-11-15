import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { RailError } from "../src/core/errors.js";
import { addDays, todayInIndia } from "../src/core/time.js";
import type { RouteAvailability, RouteTrainAvailability } from "../src/core/types.js";
import { createMcpServer } from "../src/mcp.js";
import type { TimetableFile } from "../src/providers/timetable/format.js";
import { LocalTimetableProvider } from "../src/providers/timetable/local-timetable.js";
import type { RouteAvailabilityQuery, RouteAvailabilitySource } from "../src/providers/types.js";
import { train } from "./helpers.js";

/**
 * Synthetic network (invented trains; NDLS and ANVT stand for two terminals of one city):
 *
 *   NDLS ─90001─▶ HUBF ─90002─▶ DST     fastest, but one train each way
 *   ANVT ─91001/2/3─▶ HUBA ─92001/2/3─▶ DST   three trains each way, from the other terminal
 */
const ALL = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
const network: TimetableFile = {
  meta: {
    id: "test-official",
    name: "Test official timetable",
    kind: "official_timetable",
    source: "test",
    data_as_of: "2026-07-01",
    possibly_outdated: false,
    built_at: "2026-07-01T00:00:00Z",
    notes: [],
  },
  stations: [
    ["NDLS", "Capital Main", "State", "NR", 28.6, 77.2],
    ["ANVT", "Capital East", "State", "NR", 28.65, 77.3],
    ["HUBF", "Fast Halt", "State", "NR", 27.4, 80.0],
    ["HUBA", "Busy Junction", "State", "NR", 27.2, 80.3],
    ["DST", "Destination", "State", "NR", 26.0, 83.0],
  ],
  trains: [
    train(
      "90001",
      [
        ["NDLS", "Capital Main", null, "06:00", 1, 0],
        ["HUBF", "Fast Halt", "10:00", null, 1, 300],
      ],
      [...ALL],
    ),
    train(
      "90002",
      [
        ["HUBF", "Fast Halt", null, "13:00", 1, 0],
        ["DST", "Destination", "15:00", null, 1, 200],
      ],
      [...ALL],
    ),
    ...["91001", "91002", "91003"].map((n, i) =>
      train(
        n,
        [
          ["ANVT", "Capital East", null, `0${7 + i}:00`, 1, 0],
          ["HUBA", "Busy Junction", `1${2 + i}:00`, null, 1, 320],
        ],
        [...ALL],
      ),
    ),
    ...["92001", "92002", "92003"].map((n, i) =>
      train(
        n,
        [
          ["HUBA", "Busy Junction", null, `1${6 + i}:00`, 1, 0],
          ["DST", "Destination", `2${0 + i}:00`, null, 1, 260],
        ],
        [...ALL],
      ),
    ),
  ],
};

const D = addDays(todayInIndia(), 7);

/** Live pages built from the timetable; like RailYatri, a page from NDLS also lists trains from ANVT. */
class FakeLive implements RouteAvailabilitySource {
  readonly info = {
    id: "fake-live",
    name: "Fake live",
    kind: "unofficial_api" as const,
    capabilities: [],
    dataAsOf: null,
    possiblyOutdated: false,
  };
  calls: string[] = [];
  /** Routes ("FROM|TO") the source refuses, as Firecrawl does when rate-limited. */
  refuse = new Set<string>();
  constructor(private readonly tt: LocalTimetableProvider) {}
  async routeAvailability(q: RouteAvailabilityQuery): Promise<RouteAvailability> {
    this.calls.push(`${q.from}|${q.to}|${q.date}`);
    if (this.refuse.has(`${q.from}|${q.to}`)) throw new RailError("RATE_LIMITED", "railyatri rate limit exceeded (HTTP 429)", "fake-live");
    const froms = q.from === "NDLS" ? ["NDLS", "ANVT"] : [q.from];
    const trains: RouteTrainAvailability[] = [];
    for (const f of froms) {
      for (const l of await this.tt.trainsBetween({ from: f, to: q.to, date: q.date })) {
        trains.push({
          train_number: l.train_number,
          train_name: l.train_name,
          from_code: l.from_code,
          to_code: l.to_code,
          departure_time: l.departure.time,
          arrival_time: l.arrival.time,
          duration_minutes: l.duration_minutes,
          runs_on_date: true,
          next_run: null,
          classes: [{ class_code: "SL", status: "5 Available", category: "available", count: 5, fare_inr: 400, confirm_chance: null }],
        });
      }
    }
    if (!trains.length) throw new RailError("NOT_FOUND", `no trains ${q.from}→${q.to}`, "fake-live");
    return { from_code: q.from, to_code: q.to, date: q.date, quota: "GN", trains, observed_at: "2026-01-01T00:00:00.000Z" };
  }
}

const parse = (r: any) => JSON.parse(r.content[0].text);
let client: Client;
let fake: FakeLive;

beforeAll(async () => {
  const tt = new LocalTimetableProvider(network);
  const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [tt] });
  fake = new FakeLive(tt);
  ctx.registry.register("route_availability", fake);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([createMcpServer(ctx).connect(serverT), client.connect(clientT)]);
});

const plan = async (extra: Record<string, unknown>) =>
  parse(
    await client.callTool({
      name: "plan_journey",
      arguments: { from: "NDLS", to: "DST", date: D, classes: ["SL"], connections: "always", max_change_stations: 1, ...extra },
    }),
  );

describe("plan_journey change stations", () => {
  it("by default checks the fastest journey's change station, from the requested station only", async () => {
    fake.calls = [];
    const r = await plan({});
    expect(r.considered.change_stations).toEqual([{ code: "HUBF" }]);
    const conns = r.options.filter((o: any) => o.kind === "connection");
    expect(conns.map((o: any) => o.legs.map((l: any) => l.train_number))).toEqual([["90001", "90002"]]);
  });

  it("well_connected with city terminals prefers the busier station and starts from the city's other terminal", async () => {
    fake.calls = [];
    const r = await plan({ hub_selection: "well_connected", include_city_terminals: true });
    expect(r.considered.change_stations).toEqual([{ code: "HUBA", first_leg_trains: 3, onward_trains: 3, detour: expect.any(Number) }]);
    const conns = r.options.filter((o: any) => o.kind === "connection");
    expect(conns.length).toBeGreaterThanOrEqual(3);
    for (const o of conns) {
      expect(o.legs[0].from_code).toBe("ANVT");
      expect(o.transfer.station_code).toBe("HUBA");
    }
    // the ANVT leg is read from the requested station's page, which lists the city's other terminals
    expect(fake.calls).toContain(`NDLS|HUBA|${D}`);
    expect(fake.calls.some((c) => c.startsWith("ANVT|"))).toBe(false);
    expect(r.lookups_used).toBe(new Set(fake.calls).size);
  });

  it("never offers a change at another terminal of the same city", async () => {
    const r = await plan({ hub_selection: "well_connected", include_city_terminals: true, max_change_stations: 5 });
    const hubs = r.considered.change_stations.map((h: any) => h.code);
    expect(hubs).not.toContain("NDLS");
    expect(hubs).not.toContain("ANVT");
  });
});

describe("plan_journey when the source starts refusing", () => {
  it("keeps the options from routes that were read and says how many were not", async () => {
    fake.refuse = new Set(["HUBF|DST"]);
    try {
      const r = await plan({ hub_selection: "well_connected", include_city_terminals: true, max_change_stations: 5 });
      expect(r.incomplete).toBe(true);
      expect(r.routes_not_read).toBeGreaterThanOrEqual(1);
      expect(r.notes[0]).toMatch(/^\d+ routes? (was|were) not read because the seat source refused/);
      const conns = r.options.filter((o: any) => o.kind === "connection");
      expect(conns.length).toBeGreaterThan(0);
      expect(conns.every((o: any) => o.transfer.station_code === "HUBA")).toBe(true);
    } finally {
      fake.refuse = new Set();
    }
  });

  it("fails with RATE_LIMITED when even the direct route is refused", async () => {
    fake.refuse = new Set(["NDLS|DST"]);
    try {
      const res: any = await client.callTool({
        name: "plan_journey",
        arguments: { from: "NDLS", to: "DST", date: D, connections: "always" },
      });
      expect(res.isError).toBe(true);
      expect(parse(res).error.code).toBe("RATE_LIMITED");
    } finally {
      fake.refuse = new Set();
    }
  });
});

describe("plan_journey output", () => {
  /** One train from the hub calls at two terminals of the destination city (PPTA, then PNBE). */
  const patna: TimetableFile = {
    ...network,
    stations: [
      ["NDLS", "Capital Main", "State", "NR", 28.6, 77.2],
      ["ANVT", "Capital East", "State", "NR", 28.65, 77.3],
      ["HUBA", "Busy Junction", "State", "NR", 27.2, 80.3],
      ["PPTA", "City West", "State", "EC", 25.62, 85.04],
      ["PNBE", "City Main", "State", "EC", 25.6, 85.14],
    ],
    trains: [
      train(
        "93001",
        [
          ["NDLS", "Capital Main", null, "06:00", 1, 0],
          ["HUBA", "Busy Junction", "12:00", null, 1, 320],
        ],
        [...ALL],
      ),
      train(
        "94001",
        [
          ["HUBA", "Busy Junction", null, "16:00", 1, 0],
          ["PPTA", "City West", "21:00", "21:05", 1, 400],
          ["PNBE", "City Main", "21:30", null, 1, 410],
        ],
        [...ALL],
      ),
      train(
        "95001",
        [
          ["NDLS", "Capital Main", null, "20:00", 1, 0],
          ["PNBE", "City Main", "10:00", null, 2, 1000],
        ],
        [...ALL],
      ),
    ],
  };

  let c2: Client;
  beforeAll(async () => {
    const tt = new LocalTimetableProvider(patna);
    const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [tt] });
    ctx.registry.register("route_availability", new FakeLive(tt));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    c2 = new Client({ name: "test", version: "1" });
    await Promise.all([createMcpServer(ctx).connect(serverT), c2.connect(clientT)]);
  });

  const run = async (extra: Record<string, unknown>) =>
    parse(
      await c2.callTool({
        name: "plan_journey",
        arguments: {
          from: "NDLS",
          to: "PNBE",
          date: D,
          classes: ["SL"],
          connections: "always",
          hub_selection: "well_connected",
          include_city_terminals: true,
          ...extra,
        },
      }),
    );

  it("lists a connection only once when it reaches two terminals of the destination city", async () => {
    const r = await run({});
    const conns = r.options.filter((o: any) => o.kind === "connection");
    const keys = conns.map((o: any) => o.legs.map((l: any) => `${l.train_number}|${l.class_code}`).join(">"));
    expect(keys).toEqual(["93001|SL>94001|SL"]);
  });

  it("omit_direct leaves direct trains out of options but still reads them", async () => {
    const withDirect = await run({});
    expect(withDirect.options.some((o: any) => o.kind === "direct")).toBe(true);
    const r = await run({ omit_direct: true, limit: 1 });
    expect(r.options.map((o: any) => o.kind)).toEqual(["connection"]);
    expect(r.considered.direct_and_alternative_options).toBeGreaterThan(0);
  });
});
