import { describe, expect, it } from "vitest";
import { bestClass, directOptions, makeOption, rankOptions, toLeg } from "../../src/core/planner.js";
import type { RouteClassAvailability, RouteTrainAvailability } from "../../src/core/types.js";

const cls = (
  class_code: string,
  category: RouteClassAvailability["category"],
  count: number | null,
  fare = 1000,
): RouteClassAvailability => ({
  class_code,
  status: `${count ?? ""} ${category}`.trim(),
  category,
  count,
  fare_inr: fare,
  confirm_chance: null,
});
const train = (n: string, classes: RouteClassAvailability[], extra: Partial<RouteTrainAvailability> = {}): RouteTrainAvailability => ({
  train_number: n,
  train_name: `Train ${n}`,
  from_code: "AAA",
  to_code: "DDD",
  departure_time: "10:00",
  arrival_time: "20:00",
  duration_minutes: 600,
  runs_on_date: true,
  next_run: null,
  classes,
  ...extra,
});
const CLASSES = ["3A", "2A", "1A"];

describe("planner", () => {
  it("picks the best requested class of a train", () => {
    const t = train("11111", [
      cls("SL", "available", 50),
      cls("3A", "waitlist", 20),
      cls("2A", "rac", 4),
      cls("1A", "not_available", null),
    ]);
    expect(bestClass(t, CLASSES)?.class_code).toBe("2A");
    expect(bestClass(train("1", [cls("SL", "available", 1)]), CLASSES)).toBeNull();
  });

  it("skips trains not running on the date and unrankable classes", () => {
    const opts = directOptions(
      [
        train("11111", [cls("3A", "available", 5), cls("2A", "unknown", null), cls("1A", "not_available", null)]),
        train("22222", [cls("3A", "available", 9)], { runs_on_date: false }),
      ],
      CLASSES,
      "2026-11-18",
    );
    expect(opts.map((o) => [o.legs[0]!.train_number, o.legs[0]!.class_code])).toEqual([["11111", "3A"]]);
  });

  it("ranks direct confirmed, then connections confirmed, then RAC, then waitlist by number", () => {
    const d = "2026-11-18";
    const directWl40 = directOptions([train("1", [cls("3A", "waitlist", 40)])], CLASSES, d)[0]!;
    const directWl4 = directOptions([train("2", [cls("2A", "waitlist", 4)])], CLASSES, d)[0]!;
    const directRac = directOptions([train("3", [cls("3A", "rac", 9)])], CLASSES, d)[0]!;
    const conn = makeOption(
      "connection",
      [
        toLeg(train("4", [cls("3A", "available", 3, 800)]), cls("3A", "available", 3, 800), d),
        toLeg(train("5", []), cls("3A", "available", 1, 400), "2026-11-19"),
      ],
      900,
      { station_code: "BBB", layover_minutes: 180 },
    );
    const directOk = directOptions([train("6", [cls("1A", "available", 2)])], CLASSES, d)[0]!;
    const ranked = rankOptions([directWl40, conn, directWl4, directRac, directOk], CLASSES);
    expect(ranked.map((o) => o.legs[0]!.train_number)).toEqual(["6", "4", "3", "2", "1"]);
    expect(conn).toMatchObject({ tier: 1, worst_category: "available", total_fare_inr: 1200 });
  });

  it("reports an unknown total fare when a leg's fare is unknown", () => {
    const o = makeOption("connection", [toLeg(train("1", []), { ...cls("3A", "available", 1), fare_inr: null }, "2026-11-18")], null);
    expect(o.total_fare_inr).toBeNull();
  });
});
