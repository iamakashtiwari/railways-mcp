import { describe, expect, it } from "vitest";
import { MAX_DETOUR, detourRatio, haversineKm, rankHubs, type HubCandidate } from "../../src/core/hubs.js";
import { CITY_TERMINALS, cityTerminals } from "../../src/core/terminals.js";

const hub = (code: string, first: number, onward: number, detour: number | null, fastest = 600): HubCandidate => ({
  code,
  journeys: 1,
  first_leg_trains: first,
  onward_trains: onward,
  detour,
  fastest_minutes: fastest,
});

describe("rankHubs", () => {
  it("prefers a station with many trains on both legs over the fastest one", () => {
    const ranked = rankHubs([hub("FAST", 2, 1, 1.0, 500), hub("BUSY", 12, 20, 1.02, 700), hub("ONESIDED", 40, 1, 1.0, 650)]);
    expect(ranked.map((h) => h.code)).toEqual(["BUSY", "ONESIDED", "FAST"]);
  });

  it("drops stations well off the way, keeps ones with unknown positions", () => {
    const ranked = rankHubs([hub("DETOUR", 50, 50, MAX_DETOUR + 0.2), hub("ONWAY", 3, 3, 1.05), hub("UNKNOWN", 3, 3, null)]);
    expect(ranked.map((h) => h.code)).toEqual(["ONWAY", "UNKNOWN"]);
  });

  it("falls back to fastest first when every station is off the way", () => {
    const ranked = rankHubs([hub("B", 9, 9, 2.0, 900), hub("A", 1, 1, 1.9, 800)]);
    expect(ranked.map((h) => h.code)).toEqual(["A", "B"]);
  });

  it("breaks score ties by fastest journey, then code", () => {
    const ranked = rankHubs([hub("Z", 4, 4, 1.0, 600), hub("Y", 4, 4, 1.0, 500), hub("X", 4, 4, 1.0, 500)]);
    expect(ranked.map((h) => h.code)).toEqual(["X", "Y", "Z"]);
  });
});

describe("detourRatio", () => {
  const a = [28.6, 77.2] as const;
  const b = [26.8, 80.9] as const;
  const c = [25.8, 84.7] as const;
  it("is about 1 for a station on the straight line, larger off it, null without positions", () => {
    expect(haversineKm(a, a)).toBe(0);
    const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2] as const;
    expect(detourRatio(a, mid, c)).toBeCloseTo(1, 2);
    expect(detourRatio(a, b, c)!).toBeGreaterThan(1);
    expect(detourRatio(a, [19.0, 72.8], c)!).toBeGreaterThan(MAX_DETOUR);
    expect(detourRatio(null, b, c)).toBeNull();
    expect(detourRatio(a, b, a)).toBeNull();
  });
});

describe("cityTerminals", () => {
  it("lists the station first, then its city's other main terminals that the timetable knows", () => {
    expect(cityTerminals("ANVT")).toEqual(["ANVT", "NDLS", "DLI", "NZM", "DEE"]);
    expect(cityTerminals("NDLS", (c) => c !== "DEE")).toEqual(["NDLS", "DLI", "NZM", "ANVT"]);
  });

  it("returns a station outside the list on its own", () => {
    expect(cityTerminals("CPR")).toEqual(["CPR"]);
  });

  it("never puts a code in two cities", () => {
    const all = CITY_TERMINALS.flatMap((g) => g.codes);
    expect(new Set(all).size).toBe(all.length);
  });
});
