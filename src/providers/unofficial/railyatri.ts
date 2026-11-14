/**
 * RailYatri adapter via Firecrawl (OPT-IN, unofficial).
 *
 * Reads RailYatri's public "trains between stations" page, which lists every
 * train on a route for a date with live per-class availability, fare and a
 * confirmation-chance label. The page renders availability in the browser, so
 * it is fetched through Firecrawl (https://firecrawl.dev, or a self-hosted
 * Firecrawl) with the operator's own API key (FIRECRAWL_API_KEY). One page
 * read covers every train and class on the route for that date.
 *
 * Upstream behaviour verified against live pages (Nov 2026):
 *  - URL: /booking/trains-between-stations?from_code=NDLS&to_code=CPR&journey_date=DD-MM-YYYY
 *  - The page converts journey_date with the BROWSER's time zone. Rendered
 *    outside IST it shows the previous day. Requests therefore ask Firecrawl
 *    for an Indian location, and the parser checks the date the page shows
 *    and refuses a mismatch instead of returning another day's data.
 *  - Trains running on another weekday follow a line "There are N trains for
 *    alternative days of run", each preceded by "Next run on <day>, <Mon> <d>".
 *  - The page shows general-quota availability only.
 *  - Cells still loading show "Tap to refresh"; they are reported as unknown.
 *  - The search includes trains from nearby terminals (ANVT, DLI for NDLS);
 *    each train carries the boarding/alighting codes the page shows.
 */
import { RailError } from "../../core/errors.js";
import type {
  AvailabilityDay,
  RouteAvailability,
  RouteClassAvailability,
  RouteTrainAvailability,
  SeatAvailability,
} from "../../core/types.js";
import { isValidIsoDate, todayInIndia } from "../../core/time.js";
import { TtlCache } from "../../lib/cache.js";
import { httpPost, RateLimiter } from "../../lib/http.js";
import type { AvailabilityQuery, AvailabilitySource, ProviderInfo, RouteAvailabilityQuery, RouteAvailabilitySource } from "../types.js";
import { normStationCode } from "./shared.js";

const PROVIDER = "railyatri";
const PAGE = "https://www.railyatri.in/booking/trains-between-stations";
const DEFAULT_API_URL = "https://api.firecrawl.dev";
/** Short: availability moves fast, and a repeat call within a tool call should not cost another page read. */
const ROUTE_TTL_MS = 90_000;

const CLASS_CODES = new Set(["1A", "2A", "3A", "3E", "SL", "CC", "EC", "2S", "FC", "EA", "EV", "VS", "VC"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NOISE = new Set(["Refresh", "Book Now", "Get Confirm Seat", "Fastest", "Top choice", "New", "View Future Availability"]);

export interface RailYatriOptions {
  apiKey: string;
  /** Firecrawl base URL (self-hosted instances work too). */
  apiUrl?: string;
  /** Milliseconds Firecrawl waits for availability to render before reading the page. */
  waitMs?: number;
  minIntervalMs?: number;
  retries?: number;
  timeoutMs?: number;
  cache?: TtlCache<RouteAvailability>;
  /** Clock for observed_at; tests pin it. */
  now?: () => Date;
  /** Called before each Firecrawl page read (not on cache hits); throwing stops the read, e.g. a daily cap. */
  beforeRead?: () => void;
}

/** DD-MM-YYYY, the page's journey_date format. */
function pageDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

export function pageUrl(from: string, to: string, isoDate: string): string {
  return `${PAGE}?from_code=${from}&to_code=${to}&journey_date=${pageDate(isoDate)}`;
}

/** Status text → category and the number it states. Unknown text stays unknown; nothing is guessed. */
export function parseStatus(raw: string): Pick<RouteClassAvailability, "category" | "count"> {
  const s = raw.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+)\s+Available$/i)) || (m = s.match(/^(?:AVAILABLE|AVL)[\s-]*0*(\d+)$/i)))
    return { category: "available", count: Number(m[1]) };
  if ((m = s.match(/^(\d+)\s+RAC$/i)) || (m = s.match(/^RAC\s*(\d+)$/i))) return { category: "rac", count: Number(m[1]) };
  if ((m = s.match(/^(\d+)\s+Wait\s*list$/i)) || (m = s.match(/^(?:[A-Z]{2})?WL\s*(\d+)/i)))
    return { category: "waitlist", count: Number(m[1]) };
  if (/^(Regret|Not Available|NOT AVAILABLE|Train Departed|Booking Closed|Invalid train)$/i.test(s))
    return { category: "not_available", count: null };
  return { category: "unknown", count: null };
}

function chanceOf(line: string): RouteClassAvailability["confirm_chance"] | undefined {
  const m = line.match(/^(Low|Medium|High) Chance$/i);
  return m ? (m[1]!.toLowerCase() as "low" | "medium" | "high") : undefined;
}

/** Turns Firecrawl markdown into trimmed, non-empty lines without images or zero-width characters. */
function lines(markdown: string): string[] {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\\\|/g, "|")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The journey date the page says it is showing, as "<day> <Mon>" (e.g. "18 Nov"), or null. */
export function shownDate(markdown: string): string | null {
  const ls = lines(markdown);
  for (let i = 0; i < ls.length - 1; i++) {
    if (ls[i] !== "Date") continue;
    const m = ls[i + 1]!.match(/^(\d{1,2}) ([A-Z][a-z]{2}),/);
    if (m) return `${Number(m[1])} ${m[2]}`;
  }
  return null;
}

function expectedShownDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/**
 * Parses the page into trains. Throws UPSTREAM_UNAVAILABLE when the layout
 * isn't recognised, so a changed page never reads as "no trains".
 */
export function parseRoutePage(markdown: string): RouteTrainAvailability[] {
  const ls = lines(markdown);
  const trains: RouteTrainAvailability[] = [];
  let alternativeDays = false;
  let pendingNextRun: string | null = null;
  let cur: RouteTrainAvailability | null = null;
  let cls: RouteClassAvailability | null = null;
  let expect: "dep" | "arr" | null = null;

  const closeClass = () => {
    if (cur && cls) cur.classes.push(cls);
    cls = null;
  };
  const closeTrain = () => {
    closeClass();
    if (cur) trains.push(cur);
    cur = null;
    expect = null;
  };

  for (const line of ls) {
    if (/^There are \d+ trains? for alternative days of run$/i.test(line)) {
      closeTrain();
      alternativeDays = true;
      continue;
    }
    const next = line.match(/^Next run on (.+)$/i);
    if (next) {
      closeTrain();
      pendingNextRun = next[1]!.trim();
      continue;
    }
    const head = line.match(/^\[(\d{4,5})\s+([^\]]+)\]\(https?:\/\/(?:www\.)?railyatri\.in\/time-table\/\d+\)/);
    if (head) {
      closeTrain();
      cur = {
        train_number: head[1]!,
        train_name: head[2]!.trim(),
        from_code: "",
        to_code: "",
        departure_time: null,
        arrival_time: null,
        duration_minutes: null,
        runs_on_date: !alternativeDays,
        next_run: alternativeDays ? pendingNextRun : null,
        classes: [],
      };
      pendingNextRun = null;
      expect = "dep";
      continue;
    }
    if (!cur) continue;
    if (/^Why To Book/i.test(line)) {
      closeTrain();
      break;
    }
    let m: RegExpMatchArray | null;
    if (expect === "dep" && (m = line.match(/^([A-Z0-9]{2,6}),\s*(\d{2}:\d{2})$/))) {
      cur.from_code = m[1]!;
      cur.departure_time = m[2]!;
      expect = "arr";
      continue;
    }
    if ((m = line.match(/^(\d{1,3})\s*h\s*(\d{1,2})\s*m$/))) {
      cur.duration_minutes = Number(m[1]) * 60 + Number(m[2]);
      continue;
    }
    if (expect === "arr" && (m = line.match(/^(\d{2}:\d{2}),\s*([A-Z0-9]{2,6})$/))) {
      cur.arrival_time = m[1]!;
      cur.to_code = m[2]!;
      expect = null;
      continue;
    }
    if (CLASS_CODES.has(line)) {
      closeClass();
      cls = { class_code: line, status: "", category: "unknown", count: null, fare_inr: null, confirm_chance: null };
      continue;
    }
    if (!cls) continue;
    if (NOISE.has(line)) {
      if (line === "View Future Availability") closeClass();
      continue;
    }
    const chance = chanceOf(line);
    if (chance) {
      cls.confirm_chance = chance;
      continue;
    }
    if (/^\d{2,6}$/.test(line) && !cls.status && cls.fare_inr === null) {
      cls.fare_inr = Number(line);
      continue;
    }
    if (!cls.status) {
      cls.status = line;
      Object.assign(cls, parseStatus(line));
    }
  }
  closeTrain();

  const complete = trains.filter((t) => t.from_code && t.to_code);
  if (trains.length && complete.length < trains.length / 2) {
    throw new RailError("UPSTREAM_UNAVAILABLE", "RailYatri page layout was not recognised (train rows without stations)", PROVIDER);
  }
  for (const t of complete) t.classes = t.classes.filter((c) => c.status);
  return complete;
}

const NO_TRAINS = /(found 0 trains|no trains? (?:found|available)|no direct trains?)/i;

export class RailYatriProvider implements RouteAvailabilitySource, AvailabilitySource {
  readonly info: ProviderInfo = {
    id: PROVIDER,
    name: "RailYatri (read via Firecrawl)",
    kind: "unofficial_api",
    capabilities: ["route_availability", "availability"],
    dataAsOf: null,
    possiblyOutdated: false,
    url: "https://www.railyatri.in",
    upstream: "irctc-availability (via RailYatri, presumed)",
    notes: [
      "Read live from RailYatri's public trains-between-stations page through Firecrawl; unofficial, the page can change without notice.",
      "General quota only. Statuses are as RailYatri shows them (e.g. '40 Waitlist'), not IRCTC's GNWL/RLWL codes.",
    ],
  };

  private readonly apiUrl: string;
  private readonly waitMs: number;
  private readonly limiter: RateLimiter;
  private readonly cache: TtlCache<RouteAvailability>;
  private readonly now: () => Date;

  constructor(private readonly opts: RailYatriOptions) {
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.waitMs = opts.waitMs ?? 10_000;
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 250);
    this.cache = opts.cache ?? new TtlCache<RouteAvailability>(200);
    this.now = opts.now ?? (() => new Date());
  }

  async routeAvailability(q: RouteAvailabilityQuery): Promise<RouteAvailability> {
    const from = normStationCode(q.from, PROVIDER);
    const to = normStationCode(q.to, PROVIDER);
    if (!isValidIsoDate(q.date)) throw new RailError("INVALID_INPUT", `Invalid date ${q.date}`, PROVIDER);
    if (q.date < todayInIndia(this.now())) throw new RailError("INVALID_INPUT", `${q.date} is in the past`, PROVIDER);
    const key = `${from}|${to}|${q.date}`;
    const { value } = await this.cache.getOrLoad(key, ROUTE_TTL_MS, () => this.fetchRoute(from, to, q.date));
    return value;
  }

  async availability(q: AvailabilityQuery): Promise<SeatAvailability> {
    if (q.quota !== "GN") throw new RailError("UNSUPPORTED", `${PROVIDER} shows general quota (GN) only`, PROVIDER);
    const route = await this.routeAvailability({ from: q.from, to: q.to, date: q.date });
    const train = route.trains.find((t) => t.train_number === q.trainNumber && t.runs_on_date);
    if (!train) throw new RailError("NOT_FOUND", `Train ${q.trainNumber} is not listed from ${q.from} to ${q.to} on ${q.date}`, PROVIDER);
    const c = train.classes.find((x) => x.class_code === q.classCode);
    if (!c) throw new RailError("NOT_FOUND", `Class ${q.classCode} is not listed for train ${q.trainNumber}`, PROVIDER);
    const day: AvailabilityDay = {
      date: q.date,
      status: c.status,
      category: c.category,
      confirm_probability_percent: null,
      confirm_chance: c.confirm_chance,
    };
    return {
      train_number: train.train_number,
      from_code: train.from_code,
      to_code: train.to_code,
      class_code: c.class_code,
      quota: "GN",
      days: [day],
      observed_at: route.observed_at,
    };
  }

  private async fetchRoute(from: string, to: string, date: string): Promise<RouteAvailability> {
    this.opts.beforeRead?.();
    const body = JSON.stringify({
      url: pageUrl(from, to, date),
      formats: ["markdown"],
      onlyMainContent: true,
      waitFor: this.waitMs,
      maxAge: 0,
      location: { country: "IN" },
      timeout: Math.max(30_000, this.waitMs + 25_000),
    });
    const res = await httpPost(`${this.apiUrl}/v2/scrape`, body, {
      provider: PROVIDER,
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      timeoutMs: this.opts.timeoutMs ?? this.waitMs + 45_000,
      retries: this.opts.retries ?? 1,
      limiter: this.limiter,
    });
    if (res.status === 402) {
      throw new RailError("RATE_LIMITED", "Firecrawl credits are exhausted for this API key (HTTP 402)", PROVIDER);
    }
    if (res.status !== 200) throw new RailError("UPSTREAM_UNAVAILABLE", `Firecrawl returned HTTP ${res.status}`, PROVIDER);
    let parsed: { success?: boolean; error?: string; data?: { markdown?: string; metadata?: { statusCode?: number } } };
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new RailError("UPSTREAM_UNAVAILABLE", "Firecrawl returned a non-JSON response", PROVIDER);
    }
    const markdown = parsed.data?.markdown;
    if (!parsed.success || typeof markdown !== "string") {
      throw new RailError("UPSTREAM_UNAVAILABLE", `Firecrawl could not read the page${parsed.error ? `: ${parsed.error}` : ""}`, PROVIDER);
    }
    const pageStatus = parsed.data?.metadata?.statusCode;
    if (pageStatus && pageStatus >= 400) {
      throw new RailError("UPSTREAM_UNAVAILABLE", `RailYatri answered HTTP ${pageStatus}`, PROVIDER);
    }
    return this.fromMarkdown(markdown, from, to, date);
  }

  /** Public for tests: validates the shown date and parses the listing. */
  fromMarkdown(markdown: string, from: string, to: string, date: string): RouteAvailability {
    const shown = shownDate(markdown);
    const want = expectedShownDate(date);
    if (shown !== want) {
      throw new RailError(
        "UPSTREAM_UNAVAILABLE",
        shown
          ? `RailYatri showed ${shown} instead of ${want}; the result was discarded`
          : "RailYatri page did not show a journey date; layout not recognised",
        PROVIDER,
      );
    }
    const trains = parseRoutePage(markdown);
    if (!trains.length && !NO_TRAINS.test(markdown)) {
      throw new RailError("UPSTREAM_UNAVAILABLE", "RailYatri page listed no recognisable trains", PROVIDER);
    }
    if (!trains.length) throw new RailError("NOT_FOUND", `RailYatri lists no trains from ${from} to ${to} on ${date}`, PROVIDER);
    return { from_code: from, to_code: to, date, quota: "GN", trains, observed_at: this.now().toISOString() };
  }
}
