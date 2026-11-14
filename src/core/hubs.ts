/**
 * Choosing change stations ("hubs") for one-change journeys.
 *
 * The fastest-first choice tends to pick stations a short way along the line
 * with few onward trains. The "well connected" choice prefers stations that are
 * on the way (small detour) and have many trains both from the origin and on to
 * the destination, so more combinations can be checked live.
 */

export interface HubCandidate {
  code: string;
  /** Timetable journeys found through this station. */
  journeys: number;
  /** Distinct trains from the origin terminal(s) to the hub on the travel date. */
  first_leg_trains: number;
  /** Distinct trains from the hub to the destination terminal(s) on the travel date or the day after. */
  onward_trains: number;
  /** (origin→hub + hub→destination) / origin→destination, straight-line; null when a position is unknown. */
  detour: number | null;
  /** Fastest timetable journey through the hub, in minutes. */
  fastest_minutes: number;
}

/** Hubs further out of the way than this are not considered (when positions are known). */
export const MAX_DETOUR = 1.35;
/** Detour assumed for a hub without coordinates. */
const UNKNOWN_DETOUR = 1.15;

/** Straight-line distance in km. */
export function haversineKm(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function detourRatio(
  from: readonly [number, number] | null,
  hub: readonly [number, number] | null,
  to: readonly [number, number] | null,
): number | null {
  if (!from || !hub || !to) return null;
  const direct = haversineKm(from, to);
  if (direct < 1) return null;
  return (haversineKm(from, hub) + haversineKm(hub, to)) / direct;
}

/** Score: geometric mean of trains on both sides, discounted by the detour. Higher is better. */
export function hubScore(h: HubCandidate): number {
  const detour = h.detour ?? UNKNOWN_DETOUR;
  return Math.sqrt(h.first_leg_trains * h.onward_trains) / detour ** 2;
}

/**
 * Orders hubs best first: within the detour limit, by score, then fastest journey, then code.
 * If every hub is beyond the detour limit, they are ordered by fastest journey instead.
 */
export function rankHubs(candidates: HubCandidate[]): HubCandidate[] {
  const onTheWay = candidates.filter((h) => h.detour === null || h.detour <= MAX_DETOUR);
  if (!onTheWay.length) return [...candidates].sort((a, b) => a.fastest_minutes - b.fastest_minutes || a.code.localeCompare(b.code));
  return onTheWay
    .map((h) => ({ h, s: hubScore(h) }))
    .sort((a, b) => b.s - a.s || a.h.fastest_minutes - b.h.fastest_minutes || a.h.code.localeCompare(b.h.code))
    .map((x) => x.h);
}
