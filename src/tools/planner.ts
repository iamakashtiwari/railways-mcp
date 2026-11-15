import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findConnections, type Journey } from "../core/connections.js";
import { detourRatio, haversineKm, rankHubs, type HubCandidate } from "../core/hubs.js";
import { cityTerminals } from "../core/terminals.js";
import { RailError, isRailError } from "../core/errors.js";
import { DEFAULT_CLASS_ORDER, bestClass, directOptions, makeOption, rankOptions, toLeg, type TravelOption } from "../core/planner.js";
import { addDays, parseClock, todayInIndia } from "../core/time.js";
import type { RouteAvailability } from "../core/types.js";
import type { AppContext } from "../config.js";
import { provenanceOf } from "../providers/registry.js";
import { READ_ONLY, classCode, handler, isoDate, ok, requireStation, stationCode } from "./common.js";

const VOLATILE = { status: "not_applicable", reason: "live availability changes minute to minute; see observed_at" } as const;

function requireBookableDate(date: string): void {
  const today = todayInIndia();
  if (date < today) throw new RailError("INVALID_INPUT", `${date} is in the past (today in India is ${today})`);
}

const classList = z.array(classCode).min(1).max(8);

export function registerPlannerTools(server: McpServer, ctx: AppContext): void {
  /** One route read per (from, to, date); repeated within a call they share the provider's cache. */
  const route = async (from: string, to: string, date: string) =>
    ctx.registry.first("route_availability", (p) => p.routeAvailability({ from, to, date }));

  server.registerTool(
    "get_route_availability",
    {
      title: "Live availability for every train on a route",
      description:
        "Live general-quota seat availability for every train between two stations on a date, all classes at once: status as the source shows it (e.g. '12 Available', '40 Waitlist', 'Regret'), a normalised category, the seat/RAC/waitlist number, fare in INR and the source's confirmation-chance label. The source also lists trains from nearby terminals (each train carries its own boarding and alighting codes) and trains that run on other weekdays (runs_on_date false, excluded unless include_other_days is true). Requires the opt-in railyatri source; otherwise returns an UNSUPPORTED error. Not a booking.",
      inputSchema: {
        from: stationCode,
        to: stationCode,
        date: isoDate.describe("Boarding date (YYYY-MM-DD)"),
        classes: classList.optional().describe("Only these classes"),
        include_other_days: z.boolean().default(false).describe("Also list trains that don't run on the date"),
      },
      annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      requireBookableDate(a.date);
      const res = await route(ctx.codes.current(a.from), ctx.codes.current(a.to), a.date);
      const trains = res.data.trains
        .filter((t) => a.include_other_days || t.runs_on_date)
        .map((t) => (a.classes ? { ...t, classes: t.classes.filter((c) => (a.classes as string[]).includes(c.class_code)) } : t));
      const cells = trains.filter((t) => t.runs_on_date).flatMap((t) => t.classes);
      const summary = {
        trains_running: trains.filter((t) => t.runs_on_date).length,
        class_cells: cells.length,
        available: cells.filter((c) => c.category === "available").length,
        rac: cells.filter((c) => c.category === "rac").length,
        waitlist: cells.filter((c) => c.category === "waitlist").length,
        not_available: cells.filter((c) => c.category === "not_available").length,
        not_loaded: cells.filter((c) => c.category === "unknown").length,
      };
      const notes = ["General quota only. Tatkal (TQ) availability is not shown by this source."];
      if (summary.not_loaded)
        notes.push(`${summary.not_loaded} class cells had not loaded on the source page (category unknown); their status is not known.`);
      return ok({ availability: { ...res.data, trains }, summary, verification: VOLATILE, notes, source: res.source });
    }),
  );

  server.registerTool(
    "plan_journey",
    {
      title: "Plan a journey from live availability",
      description:
        "Ranks ways to travel between two stations on a date using live availability: direct trains, optional alternative destination stations, and journeys with one change of train taken from the timetable, each leg checked live. Order: direct confirmed, connection with every leg confirmed, alternative destination confirmed, direct RAC, connection RAC, direct waitlist (smaller number first), then the rest. Each option lists its legs with class, status, fare and boarding date, the total fare, and for connections the change station and scheduled layover. A connection is two separate tickets: a delay on the first train does not protect the second. Change stations are chosen either fastest-journey first (default) or, with hub_selection well_connected, by how many trains run from the origin to the station and on to the destination, excluding stations well off the way; considered.change_stations lists the ones checked. With include_city_terminals, journeys may also start or end at the other main terminals of the same city (for example Anand Vihar or Old Delhi for New Delhi); those legs are read live from the requested stations' pages, which list nearby terminals. Each route read costs one page read on the operator's Firecrawl key; lookups_used reports how many were made. Requires the opt-in railyatri source.",
      inputSchema: {
        from: stationCode,
        to: stationCode,
        date: isoDate.describe("Travel date from `from` (YYYY-MM-DD)"),
        classes: classList.optional().describe("Acceptable classes, most preferred first (default: 3A, 2A, 1A, 3E, SL, CC, EC, 2S)"),
        alternative_destinations: z
          .array(stationCode)
          .max(4)
          .optional()
          .describe("Other stations near the destination to check directly, e.g. a nearby junction"),
        connections: z
          .enum(["auto", "always", "never"])
          .default("auto")
          .describe("auto: check one-change journeys only when no direct train has a confirmed seat"),
        max_change_stations: z.number().int().min(1).max(5).default(3).describe("Distinct change stations to check live"),
        hub_selection: z
          .enum(["fastest", "well_connected"])
          .default("fastest")
          .describe(
            "fastest: change stations of the fastest timetable journeys; well_connected: on-the-way stations with the most trains on both legs",
          ),
        omit_direct: z
          .boolean()
          .default(false)
          .describe(
            "Leave direct trains on the requested route out of options (they are still read); limit then applies to the other options",
          ),
        include_city_terminals: z
          .boolean()
          .default(false)
          .describe("Also plan connections from and to the other main terminals of the origin's and destination's cities"),
        min_layover_minutes: z.number().int().min(30).max(600).default(120),
        max_layover_minutes: z.number().int().min(60).max(1440).default(600),
        limit: z.number().int().min(1).max(30).default(10),
      },
      annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      requireBookableDate(a.date);
      if (a.min_layover_minutes > a.max_layover_minutes)
        throw new RailError("INVALID_INPUT", "min_layover_minutes exceeds max_layover_minutes");
      const from = await requireStation(ctx, a.from);
      const to = await requireStation(ctx, a.to);
      if (from === to) throw new RailError("INVALID_INPUT", "from and to are the same station");
      const classes = a.classes ?? DEFAULT_CLASS_ORDER.slice(0, 8);
      const notes: string[] = [];
      const reads = new Set<string>();
      /** Set once the source refuses for rate or quota after the direct route was read; later routes are skipped. */
      let refused: RailError | null = null;
      const skipped = new Set<string>();
      const read = async (f: string, t: string, d: string, essential = false): Promise<RouteAvailability | null> => {
        const key = `${f}|${t}|${d}`;
        if (refused && !essential) {
          skipped.add(key);
          return null;
        }
        reads.add(key);
        try {
          return (await route(f, t, d)).data;
        } catch (e) {
          if (isRailError(e) && (e.code === "UNSUPPORTED" || e.code === "UPSTREAM_AUTH")) throw e;
          if (isRailError(e) && e.code === "RATE_LIMITED") {
            // Without the direct route there is nothing to compare against; later refusals keep what was read.
            if (essential) throw e;
            if (!refused) refused = e;
            reads.delete(key);
            skipped.add(key);
            return null;
          }
          notes.push(`Could not read ${f}→${t} on ${d}: ${isRailError(e) ? e.message : String(e)}`);
          return null;
        }
      };

      const options: TravelOption[] = [];
      const direct = await read(from, to, a.date, true);
      if (direct) options.push(...directOptions(direct.trains, classes, a.date));

      const alts = await Promise.all(
        (a.alternative_destinations ?? []).map(async (alt) => {
          const code = await requireStation(ctx, alt);
          return code === to ? null : read(from, code, a.date);
        }),
      );
      for (const r of alts) if (r) options.push(...directOptions(r.trains, classes, a.date, "alternative_destination"));

      const directConfirmed = options.some((o) => o.kind === "direct" && o.worst_category === "available");
      let checkedConnections = 0;
      let changeStations: Array<Record<string, unknown>> = [];
      if (a.connections === "always" || (a.connections === "auto" && !directConfirmed)) {
        const tt = ctx.timetables.find((t) => t.callsAt(from, a.date).length > 0 && t.callsAt(to, a.date).length > 0);
        if (!tt) {
          notes.push(`No timetable has trains at both ${from} and ${to}; connections were not searched.`);
        } else {
          const known = (c: string) => tt.hasStation(c);
          const origins = a.include_city_terminals ? cityTerminals(from, known) : [from];
          const dests = a.include_city_terminals ? cityTerminals(to, known) : [to];
          const wellConnected = a.hub_selection === "well_connected";
          // One local timetable search per terminal pair; merged and fastest first.
          const seen = new Set<string>();
          const all: Journey[] = [];
          for (const o of origins) {
            for (const d of dests) {
              if (o === d) continue;
              const r = findConnections(tt.onDate(a.date), {
                from: o,
                to: d,
                maxLegs: 2,
                minLayoverMinutes: a.min_layover_minutes,
                maxLayoverMinutes: a.max_layover_minutes,
                date: a.date,
                limit: wellConnected ? 200 : 20,
              });
              for (const j of r.journeys) {
                const hub = j.transfers[0]?.station_code;
                // changing at another terminal of the same city is not a real alternative
                if (!hub || origins.includes(hub) || dests.includes(hub)) continue;
                const key = j.legs.map((l) => `${l.train_number}@${l.from_code}>${l.to_code}`).join("|");
                if (seen.has(key)) continue;
                seen.add(key);
                all.push(j);
              }
            }
          }
          all.sort((x, y) => x.total_minutes - y.total_minutes);

          const hubs: string[] = [];
          const hubInfo: Array<Pick<HubCandidate, "code" | "first_leg_trains" | "onward_trains" | "detour">> = [];
          if (!wellConnected) {
            for (const j of all) {
              const hub = j.transfers[0]!.station_code;
              if (!hubs.includes(hub) && hubs.length < a.max_change_stations) hubs.push(hub);
            }
          } else {
            const pos = new Map(
              tt
                .allStations()
                .filter((st) => st.lat !== null && st.lon !== null)
                .map((st) => [st.code, [st.lat!, st.lon!] as const]),
            );
            const trainSet = async (fs: string[], ts: string[], dates: string[]) => {
              const set = new Set<string>();
              for (const f of fs)
                for (const t of ts)
                  for (const d of dates) for (const l of await tt.trainsBetween({ from: f, to: t, date: d })) set.add(l.train_number);
              return set.size;
            };
            const byHub = new Map<string, Journey[]>();
            for (const j of all) {
              const hub = j.transfers[0]!.station_code;
              byHub.set(hub, [...(byHub.get(hub) ?? []), j]);
            }
            const candidates: HubCandidate[] = [];
            for (const [hub, js] of byHub) {
              candidates.push({
                code: hub,
                journeys: js.length,
                first_leg_trains: await trainSet(origins, [hub], [a.date]),
                onward_trains: await trainSet([hub], dests, [a.date, addDays(a.date, 1)]),
                detour: detourRatio(pos.get(from) ?? null, pos.get(hub) ?? null, pos.get(to) ?? null),
                km_from_ends: (() => {
                  const h = pos.get(hub);
                  const ends = [pos.get(from), pos.get(to)].filter((p): p is readonly [number, number] => p !== undefined);
                  return h && ends.length === 2 ? Math.min(...ends.map((p) => haversineKm(p, h))) : null;
                })(),
                fastest_minutes: js[0]!.total_minutes,
              });
            }
            for (const h of rankHubs(candidates).slice(0, a.max_change_stations)) {
              hubs.push(h.code);
              hubInfo.push({
                code: h.code,
                first_leg_trains: h.first_leg_trains,
                onward_trains: h.onward_trains,
                detour: h.detour === null ? null : Math.round(h.detour * 100) / 100,
              });
            }
          }
          changeStations = wellConnected ? hubInfo : hubs.map((code) => ({ code }));
          // Well-connected mode checks the fastest few journeys per hub; reads are shared, so the cost is per route and date.
          const perHub = new Map<string, number>();
          const journeys = all.filter((j) => {
            const hub = j.transfers[0]!.station_code;
            if (!hubs.includes(hub)) return false;
            if (!wellConnected) return true;
            const n = perHub.get(hub) ?? 0;
            perHub.set(hub, n + 1);
            return n < 6;
          });
          checkedConnections = journeys.length;
          const legDate = (j: Journey, i: number): string => {
            const start = parseClock(j.legs[0]!.departure.time) ?? 0;
            return addDays(a.date, Math.floor((start + j.legs[i]!.starts_after_minutes) / 1440));
          };
          const evaluated = await Promise.all(
            journeys.map(async (j) => {
              const legs = await Promise.all(
                j.legs.map(async (l, i) => {
                  const d = legDate(j, i);
                  // The requested stations' pages list trains from their city's other terminals too.
                  const rf = i === 0 && origins.includes(l.from_code) ? from : l.from_code;
                  const rt = i === j.legs.length - 1 && dests.includes(l.to_code) ? to : l.to_code;
                  const r = await read(rf, rt, d);
                  const t = r?.trains.find((x) => x.train_number === l.train_number && x.runs_on_date);
                  const c = t ? bestClass(t, classes) : null;
                  return t && c ? toLeg(t, c, d) : null;
                }),
              );
              if (legs.some((l) => l === null)) return null;
              const tr = j.transfers[0]!;
              return makeOption("connection", legs as NonNullable<(typeof legs)[number]>[], j.total_minutes, {
                station_code: tr.station_code,
                layover_minutes: tr.layover_minutes,
              });
            }),
          );
          const usable = evaluated.filter((o): o is TravelOption => o !== null);
          // Journeys to different terminals of the destination city can read back as the same trains and classes.
          const seenOptions = new Set<string>();
          for (const o of usable) {
            const key = o.legs.map((l) => `${l.train_number}|${l.date}|${l.class_code}|${l.from_code}|${l.to_code}`).join(">");
            if (seenOptions.has(key)) continue;
            seenOptions.add(key);
            options.push(o);
          }
          if (journeys.length > usable.length)
            notes.push(
              `${journeys.length - usable.length} of ${journeys.length} timetable connections had a leg with no listed, bookable class in the requested classes.`,
            );
          if (!all.length) notes.push("The timetable has no one-change journeys within the layover limits on this date.");
        }
      }

      const ranked = rankOptions(a.omit_direct ? options.filter((o) => o.kind !== "direct") : options, classes).slice(0, a.limit);
      if (refused) {
        const why = (refused as RailError).message;
        notes.unshift(
          `${skipped.size} route${skipped.size === 1 ? " was" : "s were"} not read because the seat source refused further requests (${why}); the options shown come from the ${reads.size} route${reads.size === 1 ? "" : "s"} that were read.`,
        );
      }
      notes.push(
        "Availability is general quota, read live from the source; it changes minute to minute.",
        "Connections are planned on scheduled times; each leg is a separate ticket and a late first train can miss the second.",
      );
      const providers = ctx.registry.providers("route_availability");
      const ttUsed = ctx.timetables[0];
      return ok({
        options: ranked,
        considered: {
          direct_and_alternative_options: options.filter((o) => o.kind !== "connection").length,
          connections_checked: checkedConnections,
          change_stations: changeStations,
        },
        lookups_used: reads.size,
        incomplete: refused !== null,
        routes_not_read: skipped.size,
        verification: VOLATILE,
        notes,
        source: providers[0] ? provenanceOf(providers[0].info) : null,
        timetable_source: checkedConnections && ttUsed ? provenanceOf(ttUsed.info) : null,
      });
    }),
  );
}
