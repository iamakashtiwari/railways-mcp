/**
 * Ranks travel options from live availability. Pure functions: callers fetch
 * availability and timetable connections, this module only orders them.
 *
 * Tiers (lower is better):
 *   0 direct, every leg confirmed-available
 *   1 change of trains, every leg available
 *   2 alternative destination, available
 *   3 direct RAC
 *   4 change of trains, worst leg RAC
 *   5 direct waitlist
 *   6 alternative destination, RAC or waitlist
 *   7 change of trains, worst leg waitlist
 * Within a tier: smaller RAC/waitlist number, then higher confirmation
 * chance, then preferred class (order of the requested classes), then
 * shorter travel time.
 * Not-available and unknown statuses are never ranked as options.
 */
import type { RouteClassAvailability, RouteTrainAvailability } from "./types.js";

export type OptionKind = "direct" | "alternative_destination" | "connection";

export interface OptionLeg {
  train_number: string;
  train_name: string;
  from_code: string;
  to_code: string;
  /** Boarding date of this leg (YYYY-MM-DD). */
  date: string;
  departure_time: string | null;
  arrival_time: string | null;
  class_code: string;
  status: string;
  category: RouteClassAvailability["category"];
  count: number | null;
  fare_inr: number | null;
  confirm_chance: RouteClassAvailability["confirm_chance"];
}

export interface TravelOption {
  kind: OptionKind;
  tier: number;
  /** Worst status across legs: available < rac < waitlist. */
  worst_category: "available" | "rac" | "waitlist";
  legs: OptionLeg[];
  /** Sum of leg fares; null when any leg's fare is unknown. */
  total_fare_inr: number | null;
  /** Door-to-door minutes when known (timetable for connections, source duration for direct trains). */
  total_minutes: number | null;
  /** Change station and scheduled layover for connections. */
  transfer?: { station_code: string; layover_minutes: number };
}

const CATEGORY_RANK: Record<string, number> = { available: 0, rac: 1, waitlist: 2 };
const CHANCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
export const DEFAULT_CLASS_ORDER = ["3A", "2A", "1A", "3E", "SL", "CC", "EC", "2S", "EA", "FC", "EV", "VS", "VC"];

const rankable = (c: RouteClassAvailability) => c.category in CATEGORY_RANK;

/** Best requested class of a train: lowest category rank, then class preference, then smaller number. */
export function bestClass(t: RouteTrainAvailability, classes: string[]): RouteClassAvailability | null {
  const pref = (code: string) => classes.indexOf(code);
  const usable = t.classes.filter((c) => pref(c.class_code) >= 0 && rankable(c));
  usable.sort(
    (a, b) =>
      CATEGORY_RANK[a.category]! - CATEGORY_RANK[b.category]! || pref(a.class_code) - pref(b.class_code) || (a.count ?? 0) - (b.count ?? 0),
  );
  return usable[0] ?? null;
}

export function toLeg(t: RouteTrainAvailability, c: RouteClassAvailability, date: string): OptionLeg {
  return {
    train_number: t.train_number,
    train_name: t.train_name,
    from_code: t.from_code,
    to_code: t.to_code,
    date,
    departure_time: t.departure_time,
    arrival_time: t.arrival_time,
    class_code: c.class_code,
    status: c.status,
    category: c.category,
    count: c.count,
    fare_inr: c.fare_inr,
    confirm_chance: c.confirm_chance,
  };
}

function worst(legs: OptionLeg[]): TravelOption["worst_category"] {
  const r = Math.max(...legs.map((l) => CATEGORY_RANK[l.category] ?? 2));
  return (["available", "rac", "waitlist"] as const)[r]!;
}

function tierOf(kind: OptionKind, w: TravelOption["worst_category"]): number {
  if (kind === "direct") return w === "available" ? 0 : w === "rac" ? 3 : 5;
  if (kind === "connection") return w === "available" ? 1 : w === "rac" ? 4 : 7;
  return w === "available" ? 2 : 6;
}

export function makeOption(
  kind: OptionKind,
  legs: OptionLeg[],
  totalMinutes: number | null,
  transfer?: TravelOption["transfer"],
): TravelOption {
  const w = worst(legs);
  const fares = legs.map((l) => l.fare_inr);
  return {
    kind,
    tier: tierOf(kind, w),
    worst_category: w,
    legs,
    total_fare_inr: fares.every((f) => f !== null) ? fares.reduce((a, b) => a! + b!, 0) : null,
    total_minutes: totalMinutes,
    ...(transfer ? { transfer } : {}),
  };
}

/** Direct (or alternative-destination) options: every requested, rankable class of every train running that day. */
export function directOptions(
  trains: RouteTrainAvailability[],
  classes: string[],
  date: string,
  kind: "direct" | "alternative_destination" = "direct",
): TravelOption[] {
  const out: TravelOption[] = [];
  for (const t of trains) {
    if (!t.runs_on_date) continue;
    for (const c of t.classes) {
      if (!classes.includes(c.class_code) || !rankable(c)) continue;
      out.push(makeOption(kind, [toLeg(t, c, date)], t.duration_minutes));
    }
  }
  return out;
}

export function rankOptions(options: TravelOption[], classes: string[]): TravelOption[] {
  const classPref = (o: TravelOption) => Math.max(...o.legs.map((l) => classes.indexOf(l.class_code)));
  const worstCount = (o: TravelOption) => Math.max(...o.legs.map((l) => (l.category === "available" ? 0 : (l.count ?? 9999))));
  const worstChance = (o: TravelOption) => Math.max(...o.legs.map((l) => (l.confirm_chance ? CHANCE_RANK[l.confirm_chance]! : 3)));
  return [...options].sort(
    (a, b) =>
      a.tier - b.tier ||
      worstCount(a) - worstCount(b) ||
      worstChance(a) - worstChance(b) ||
      classPref(a) - classPref(b) ||
      (a.total_minutes ?? Infinity) - (b.total_minutes ?? Infinity),
  );
}
