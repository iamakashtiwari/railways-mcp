// Rail Seat Finder: page 1 (Search), header counter and routing.
// Plain ES module, no dependencies. Every server string goes in with textContent.

const CLASSES = ["1A", "2A", "3A", "3E", "SL", "CC", "2S"];
const DEFAULT_CLASSES = ["3A", "2A", "1A"];
const DEBOUNCE_MS = 160;
const RECENT_MAX = 6;
const KEYS = {
  classes: "rsf.classes",
  recent: "rsf.recent",
  stations: "rsf.stations",
  coords: "rsf.coords",
  nearby: "rsf.nearby",
  overnight: "rsf.overnight",
};

// ---------- small helpers ----------

/** Creates an element with a class and optional text (always textContent). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const $ = (id) => document.getElementById(id);

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the page still works without it */
  }
}

const isCode = (s) => typeof s === "string" && /^[A-Z0-9]{1,6}$/.test(s);
const isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Today's date in India (IST, UTC+5:30) as YYYY-MM-DD. */
function todayIst() {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateParts(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { weekday: WEEKDAYS[dt.getUTCDay()], day: d, month: MONTHS[m - 1] };
}

/** "Wed 18 Nov" */
function shortDate(iso) {
  const p = dateParts(iso);
  return `${p.weekday} ${p.day} ${p.month}`;
}

// ---------- API ----------

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function api(path, { body, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { "x-app": "railways" } : { "x-app": "railways", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError("NETWORK", "The app server isn't answering.");
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (json && json.live_checks) showLiveChecks(json.live_checks);
  if (!res.ok) {
    const err = json && json.error;
    throw new ApiError(
      err && err.code ? String(err.code) : "HTTP_" + res.status,
      err && err.message ? String(err.message) : "Request failed.",
    );
  }
  return json ? json.data : null;
}

const callTool = (name, args, signal) => api(`tools/${name}`, { body: args, signal });

// ---------- header: live checks counter ----------

let liveUsed = null;
let liveLimit = null;

function showLiveChecks(lc) {
  const used = Number(lc.used);
  if (Number.isFinite(used)) liveUsed = used;
  if (Number.isFinite(Number(lc.limit))) liveLimit = Number(lc.limit);
  const limit = Number(lc.limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return;
  const node = $("live-count");
  node.textContent = `${used}/${limit} live checks today`;
  const meter = $("live-meter");
  meter.max = Math.max(1, limit);
  meter.value = Math.min(used, limit);
  node.parentElement.classList.toggle("is-low", limit > 0 && limit - used <= Math.max(5, Math.round(limit * 0.1)));
}

async function refreshLiveChecks() {
  try {
    await api("status");
  } catch {
    $("live-count").textContent = "Live checks: unavailable";
  }
}

// ---------- station names remembered in this browser ----------

function rememberStation(s) {
  const map = load(KEYS.stations, {});
  if (map[s.code] !== s.name) {
    map[s.code] = s.name;
    const keys = Object.keys(map);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete map[k];
    save(KEYS.stations, map);
  }
  if (typeof s.lat === "number" && typeof s.lon === "number") {
    const coords = load(KEYS.coords, {});
    coords[s.code] = [s.lat, s.lon];
    const keys = Object.keys(coords);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete coords[k];
    save(KEYS.coords, coords);
  }
}

/** [lat, lon] of a station this browser has seen, or null. */
function knownCoords(code) {
  const c = load(KEYS.coords, {})[code];
  return Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number" ? c : null;
}

/** Straight-line distance in km between two stations, when both positions are known. */
function distanceKm(a, b) {
  const p = knownCoords(a);
  const q = knownCoords(b);
  if (!p || !q) return null;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(q[0] - p[0]);
  const dLon = rad(q[1] - p[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(p[0])) * Math.cos(rad(q[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)));
}

export function knownStationName(code) {
  const map = load(KEYS.stations, {});
  return typeof map[code] === "string" ? map[code] : null;
}

// ---------- station autocomplete ----------

const stationLabel = (s) => `${s.name} (${s.code})`;

/**
 * Wires a combobox input + listbox to search_stations.
 * Returns { get(), set(station|null) } for the picked station.
 */
function stationField(input, list, onChange) {
  let picked = null;
  let options = [];
  let active = -1;
  let timer = 0;
  let seq = 0;
  let controller = null;

  const open = (yes) => {
    list.hidden = !yes;
    input.setAttribute("aria-expanded", String(yes));
    if (!yes) {
      active = -1;
      input.removeAttribute("aria-activedescendant");
    }
  };

  const setActive = (i) => {
    const items = list.querySelectorAll(".suggestion");
    items.forEach((node, j) => node.setAttribute("aria-selected", String(j === i)));
    active = i;
    if (i >= 0 && items[i]) {
      input.setAttribute("aria-activedescendant", items[i].id);
      items[i].scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const set = (station) => {
    picked = station;
    input.value = station ? stationLabel(station) : "";
    input.classList.toggle("is-picked", Boolean(station));
    if (station) rememberStation(station);
    onChange();
  };

  const choose = (i) => {
    const s = options[i];
    if (!s) return;
    set(s);
    open(false);
  };

  const message = (text) => {
    list.replaceChildren(el("li", "suggestion-empty", text));
    options = [];
    open(true);
  };

  const render = () => {
    list.replaceChildren();
    options.forEach((s, i) => {
      const li = el("li", "suggestion");
      li.id = `${list.id}-opt-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      const name = el("span", "suggestion-name");
      name.append(el("span", "suggestion-code", s.code), document.createTextNode(s.name));
      li.append(name);
      const meta = [s.state, s.trains_halting != null ? `${s.trains_halting} trains` : null].filter(Boolean).join(" · ");
      if (meta) li.append(el("span", "suggestion-meta", meta));
      // pointerdown keeps focus in the input (no blur before the pick)
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        choose(i);
      });
      list.append(li);
    });
    open(true);
    setActive(options.length ? 0 : -1);
  };

  const search = async (query) => {
    const mine = ++seq;
    if (controller) controller.abort();
    controller = new AbortController();
    try {
      const data = await callTool("search_stations", { query, limit: 8 }, controller.signal);
      if (mine !== seq || document.activeElement !== input) return;
      options = (data && Array.isArray(data.stations) ? data.stations : [])
        .filter((s) => s && isCode(s.code) && typeof s.name === "string")
        .map((s) => ({
          code: s.code,
          name: s.name,
          state: typeof s.state === "string" ? s.state : null,
          trains_halting: typeof s.trains_halting === "number" ? s.trains_halting : null,
          lat: typeof s.lat === "number" ? s.lat : null,
          lon: typeof s.lon === "number" ? s.lon : null,
        }));
      if (options.length) render();
      else message("No stations match.");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      if (mine !== seq) return;
      message(e && e.code === "NOT_FOUND" ? "No stations match." : "Couldn't load stations. Keep typing to retry.");
    }
  };

  input.addEventListener("input", () => {
    if (picked) {
      picked = null;
      input.classList.remove("is-picked");
      onChange();
    }
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      seq++;
      if (controller) controller.abort();
      open(false);
      return;
    }
    timer = setTimeout(() => search(q), DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (e) => {
    const visible = !list.hidden && options.length > 0;
    if (e.key === "ArrowDown") {
      if (!visible) return;
      e.preventDefault();
      setActive((active + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      if (!visible) return;
      e.preventDefault();
      setActive((active - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      if (visible && active >= 0) {
        e.preventDefault();
        choose(active);
      } else if (!picked) {
        e.preventDefault(); // don't submit a half-typed station
      }
    } else if (e.key === "Escape") {
      if (!list.hidden) {
        e.preventDefault();
        open(false);
      }
    }
  });

  input.addEventListener("focus", () => {
    if (picked) input.select();
  });

  input.addEventListener("blur", () => {
    open(false);
    // leaving a half-typed field restores the picked station, if any
    if (picked && input.value !== stationLabel(picked)) input.value = stationLabel(picked);
  });

  return { get: () => picked, set };
}

// ---------- search form ----------

const state = { date: todayIst(), classes: [] };
let fromField;
let toField;

function savedClasses() {
  const saved = load(KEYS.classes, null);
  const valid = Array.isArray(saved) ? CLASSES.filter((c) => saved.includes(c)) : [];
  return valid.length ? valid : [...DEFAULT_CLASSES];
}

function renderDateChips() {
  const box = $("date-chips");
  box.replaceChildren();
  const today = todayIst();
  for (let i = 0; i < 6; i++) {
    const iso = addDays(today, i);
    const p = dateParts(iso);
    const chip = el("button", "chip");
    chip.type = "button";
    chip.dataset.date = iso;
    chip.setAttribute("aria-pressed", String(iso === state.date));
    chip.append(
      el("span", "chip-day", i === 0 ? "Today" : i === 1 ? "Tmrw" : p.weekday),
      el("span", "chip-num", p.day),
      el("span", "chip-month", p.month),
    );
    chip.setAttribute("aria-label", i === 0 ? `Today, ${shortDate(iso)}` : i === 1 ? `Tomorrow, ${shortDate(iso)}` : shortDate(iso));
    chip.addEventListener("click", () => setDate(iso));
    box.append(chip);
  }
  const picker = $("date-input");
  picker.min = today;
  picker.value = state.date;
  const inChips = [...box.children].some((c) => c.dataset.date === state.date);
  picker.classList.toggle("is-picked", !inChips);
}

function setDate(iso) {
  if (!isIsoDate(iso) || iso < todayIst()) iso = todayIst();
  state.date = iso;
  renderDateChips();
}

function renderClassChips() {
  const box = $("class-chips");
  box.replaceChildren();
  for (const c of CLASSES) {
    const chip = el("button", "chip", c);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(state.classes.includes(c)));
    chip.addEventListener("click", () => {
      const on = state.classes.includes(c);
      if (on && state.classes.length === 1) return; // keep at least one class
      state.classes = on ? state.classes.filter((x) => x !== c) : CLASSES.filter((x) => x === c || state.classes.includes(x));
      save(KEYS.classes, state.classes);
      renderClassChips();
    });
    box.append(chip);
  }
}

function updateButton() {
  const ready = Boolean(fromField.get() && toField.get());
  const same = ready && fromField.get().code === toField.get().code;
  $("check-btn").disabled = !ready || same;
  $("check-hint").textContent = same
    ? "From and To are the same station."
    : ready
      ? "A fresh live check takes 15 to 25 seconds."
      : "Pick both stations to check seats.";
}

function resultsHash(from, to, date, classes) {
  return `#/r/${from}/${to}/${date}?c=${classes.join(",")}`;
}

function addRecent(entry) {
  const key = (r) => `${r.from.code}|${r.to.code}|${r.date}|${r.classes.join(",")}`;
  const list = load(KEYS.recent, []).filter((r) => r && r.from && r.to && key(r) !== key(entry));
  list.unshift(entry);
  save(KEYS.recent, list.slice(0, RECENT_MAX));
}

function validRecent(r) {
  return (
    r &&
    r.from &&
    r.to &&
    isCode(r.from.code) &&
    isCode(r.to.code) &&
    typeof r.from.name === "string" &&
    typeof r.to.name === "string" &&
    isIsoDate(r.date) &&
    Array.isArray(r.classes) &&
    r.classes.every((c) => CLASSES.includes(c))
  );
}

function renderRecent() {
  const list = load(KEYS.recent, []).filter(validRecent).slice(0, RECENT_MAX);
  const box = $("recent-list");
  box.replaceChildren();
  $("recent").hidden = list.length === 0;
  const today = todayIst();
  for (const r of list) {
    const li = el("li");
    const btn = el("button", "recent-item");
    btn.type = "button";
    const codes = el("span", "recent-codes");
    codes.append(el("span", null, r.from.code), el("span", "arrow", "→"), el("span", null, r.to.code));
    btn.append(codes, el("span", "recent-names", `${r.from.name} → ${r.to.name}`));
    const past = r.date < today;
    btn.append(el("span", "recent-meta", `${past ? "Past date" : shortDate(r.date)} · ${r.classes.join(" ")}`));
    btn.addEventListener("click", () => {
      fromField.set(r.from);
      toField.set(r.to);
      state.classes = r.classes.length ? [...r.classes] : savedClasses();
      save(KEYS.classes, state.classes);
      renderClassChips();
      setDate(past ? today : r.date);
      if (past) {
        $("check-btn").focus();
        return; // the date moved to today: let me check before running
      }
      runSearch();
    });
    li.append(btn);
    box.append(li);
  }
}

function runSearch() {
  const from = fromField.get();
  const to = toField.get();
  if (!from || !to || from.code === to.code) return;
  const classes = CLASSES.filter((c) => state.classes.includes(c));
  addRecent({ from, to, date: state.date, classes });
  location.hash = resultsHash(from.code, to.code, state.date, classes);
}

function initSearch() {
  fromField = stationField($("from-input"), $("from-list"), updateButton);
  toField = stationField($("to-input"), $("to-list"), updateButton);

  $("swap").addEventListener("click", () => {
    const a = fromField.get();
    const b = toField.get();
    const aText = $("from-input").value;
    const bText = $("to-input").value;
    fromField.set(b);
    toField.set(a);
    if (!b) $("from-input").value = bText;
    if (!a) $("to-input").value = aText;
  });

  $("date-input").addEventListener("change", (e) => setDate(e.target.value));

  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch();
  });

  state.classes = savedClasses();
  renderDateChips();
  renderClassChips();
  updateButton();
}

// ---------- results page ----------

const IRCTC_URL = "https://www.irctc.co.in/nget/train-search";
const OPEN_KEY = "rsf.open";

/** RailYatri's page for a route and date (the page this app reads). */
function railYatriUrl(from, to, iso) {
  const [y, m, d] = iso.split("-");
  const q = new URLSearchParams({ from_code: from, to_code: to, journey_date: `${d}-${m}-${y}` });
  return `https://www.railyatri.in/booking/trains-between-stations?${q.toString()}`;
}

const ERROR_TEXT = {
  DAILY_LIMIT: ["Today's live checks are used up", "The daily limit protects your Firecrawl credits. It resets at midnight IST."],
  BUSY: ["Another live check is still running", "To protect your live checks, only two run at once. Wait a few seconds, then try again."],
  TOO_MANY_REQUESTS: ["Too many requests", "The app allows 120 requests a minute. Wait a moment, then try again."],
  RATE_LIMITED: ["The seat source is busy", "RailYatri or Firecrawl is limiting requests right now, or the Firecrawl credits are used up."],
  UPSTREAM_UNAVAILABLE: [
    "Couldn't read live seats",
    "The RailYatri page didn't load or looked different from usual. This is often temporary.",
  ],
  UPSTREAM_AUTH: ["Firecrawl rejected the key", "Check FIRECRAWL_API_KEY in .env, then restart the app."],
  NOT_FOUND: ["No trains found", "RailYatri lists no trains between these stations on this date. Try another date or a nearby station."],
  UNSUPPORTED: [
    "Live seats are switched off",
    "Set ENABLE_UNOFFICIAL_SOURCES=railyatri and FIRECRAWL_API_KEY in .env, then restart the app.",
  ],
  INVALID_INPUT: ["This search can't be checked", "The date may be in the past, or a station code isn't recognised."],
  NETWORK: ["The app isn't answering", "Make sure npm run app is still running in Terminal."],
  FORBIDDEN: ["Request blocked", "Open the app at http://127.0.0.1:4321/ and try again."],
  BAD_HOST: ["Request blocked", "Open the app at http://127.0.0.1:4321/ and try again."],
  INTERNAL: ["Something went wrong in the app", "Try again. If it keeps happening, check the Terminal running npm run app."],
};

const results = {
  route: null, // { from, to, date, classes }
  data: null, // get_route_availability payload
  seatsOnly: false,
  allClasses: false,
  seq: 0,
  controller: null,
  timer: 0,
};

const routeKey = (r) => `${r.from}|${r.to}|${r.date}|${r.classes.join(",")}`;

/** "HH:MM" → minutes after midnight, or null. */
function clockMinutes(t) {
  const m = typeof t === "string" ? t.match(/^(\d{2}):(\d{2})$/) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Days after the departure day that the train arrives (0 = same day). */
function daysLater(t) {
  const dep = clockMinutes(t.departure_time);
  const arr = clockMinutes(t.arrival_time);
  if (dep !== null && typeof t.duration_minutes === "number") return Math.floor((dep + t.duration_minutes) / 1440);
  if (dep !== null && arr !== null && arr < dep) return 1;
  return 0;
}

function durationText(min) {
  if (typeof min !== "number") return "";
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

function istClock(isoTime) {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16);
}

const rupees = (n) => (typeof n === "number" ? `₹${n.toLocaleString("en-IN")}` : null);

/** The class cells shown for a train: the searched classes in that order, or all of them. */
function shownClasses(t) {
  const cells = Array.isArray(t.classes) ? t.classes : [];
  if (results.allClasses) return cells;
  return results.route.classes.map((c) => cells.find((x) => x.class_code === c)).filter(Boolean);
}

const hasSeats = (cells) => cells.some((c) => c.category === "available");

/** Sort key: confirmed first, then smallest RAC, then smallest waitlist, then departure time. */
function sortKey(t) {
  const cells = shownClasses(t);
  const min = (cat) => Math.min(...cells.filter((c) => c.category === cat).map((c) => (typeof c.count === "number" ? c.count : 9999)));
  let group = 3;
  let num = 0;
  if (hasSeats(cells)) group = 0;
  else if (cells.some((c) => c.category === "rac")) [group, num] = [1, min("rac")];
  else if (cells.some((c) => c.category === "waitlist")) [group, num] = [2, min("waitlist")];
  const dep = clockMinutes(t.departure_time);
  return [group, num, dep === null ? 9999 : dep];
}

function compareTrains(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return String(a.train_number).localeCompare(String(b.train_number));
}

// ----- dates with confirmed seats, remembered per route -----

/** Stores, per route and date, which trains had confirmed seats in each class. */
function rememberOpen(r, trains) {
  const map = load(OPEN_KEY, {});
  const byClass = {};
  for (const t of trains) {
    for (const c of Array.isArray(t.classes) ? t.classes : []) {
      if (c.category !== "available" || !CLASSES.includes(c.class_code)) continue;
      (byClass[c.class_code] ||= []).push(String(t.train_number));
    }
  }
  map[`${r.from}|${r.to}|${r.date}`] = { byClass, at: Date.now() };
  const today = todayIst();
  const entries = Object.entries(map).filter(([k]) => (k.split("|")[2] || "") >= today);
  entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  save(OPEN_KEY, Object.fromEntries(entries.slice(0, 300)));
}

/** Trains with confirmed seats in any of `classes` the last time this date was checked, or null if never. */
function openCount(from, to, date, classes) {
  const entry = load(OPEN_KEY, {})[`${from}|${to}|${date}`];
  if (!entry || typeof entry.byClass !== "object" || entry.byClass === null) return null;
  const trains = new Set();
  for (const c of classes) for (const n of Array.isArray(entry.byClass[c]) ? entry.byClass[c] : []) trains.add(n);
  return trains.size;
}

// ----- rendering -----

function renderTitle(r) {
  const name = (code) => knownStationName(code) || code;
  $("results-title").textContent = `${name(r.from)} to ${name(r.to)}`;
  $("route-from-code").textContent = r.from;
  $("route-to-code").textContent = r.to;
  $("route-from-name").textContent = knownStationName(r.from) || "";
  $("route-to-name").textContent = knownStationName(r.to) || "";
  $("results-sub").textContent = `${shortDate(r.date)} · ${r.classes.join(" ")}`;
  document.title = `${r.from} → ${r.to} · Rail Seat Finder`;
}

/** Looks up station names this browser hasn't seen yet. */
async function lookupNames(r) {
  for (const code of [r.from, r.to]) {
    if (knownStationName(code) && (code !== r.to || knownCoords(code))) continue;
    try {
      const data = await callTool("search_stations", { query: code, limit: 5 });
      const hit = (data && Array.isArray(data.stations) ? data.stations : []).find((s) => s && s.code === code);
      if (hit && typeof hit.name === "string") rememberStation({ code, name: hit.name, lat: hit.lat, lon: hit.lon });
    } catch {
      /* the code is shown instead */
    }
  }
  if (results.route && routeKey(results.route) === routeKey(r)) {
    renderTitle(r);
    renderNearby();
  }
}

function renderDayRow(r) {
  const box = $("day-row");
  box.replaceChildren();
  const today = todayIst();
  let start = addDays(r.date, -3);
  if (start < today) start = today;
  for (let i = 0; i < 7; i++) {
    const iso = addDays(start, i);
    const p = dateParts(iso);
    const a = el("a", "day");
    a.href = resultsHash(r.from, r.to, iso, r.classes);
    if (iso === r.date) a.setAttribute("aria-current", "date");
    a.append(el("span", "day-week", iso === today ? "Today" : p.weekday), el("span", "day-num", p.day));
    const n = openCount(r.from, r.to, iso, r.classes);
    if (n) a.append(el("span", "day-open", `${n} open`));
    a.setAttribute("aria-label", `${shortDate(iso)}${n ? `, ${n} trains had seats when last checked` : ""}`);
    box.append(a);
  }
}

function setBusy(busy) {
  for (const id of ["toggle-seats", "toggle-all", "refresh-btn"]) $(id).disabled = busy;
}

function startLoading() {
  const started = Date.now();
  $("loading").hidden = false;
  $("results-error").hidden = true;
  $("results-empty").hidden = true;
  $("no-seats").hidden = true;
  $("train-list").replaceChildren();
  $("status-line").textContent = "Checking…";
  setBusy(true);
  clearInterval(results.timer);
  const tick = () => {
    $("loading-counter").textContent = `Checking live seats… ${Math.floor((Date.now() - started) / 1000)} s`;
  };
  tick();
  results.timer = setInterval(tick, 1000);
}

function stopLoading() {
  clearInterval(results.timer);
  $("loading").hidden = true;
  setBusy(false);
}

/** A plain-language error card with a Try again button. */
function errorCard(e, onRetry) {
  const code = e && e.code ? String(e.code) : "INTERNAL";
  const [title, body] = ERROR_TEXT[code] || ERROR_TEXT.INTERNAL;
  const card = el("div", "error-card");
  card.setAttribute("role", "alert");
  card.append(el("h2", null, title), el("p", null, body));
  if (e && e.message) card.append(el("p", "error-detail", `Details: ${e.message} (${code})`));
  const retry = el("button", "primary", "Try again");
  retry.type = "button";
  retry.addEventListener("click", onRetry);
  card.append(retry);
  return card;
}

/** The "no seats" prompt above the train list; null hides it. */
function showNoSeats(title) {
  const box = $("no-seats");
  box.hidden = !title;
  if (title) $("no-seats-title").textContent = title;
}

function showError(e) {
  if (e && e.code === "NOT_FOUND") showNoSeats("No direct trains on this date");
  const card = errorCard(e, () => loadResults(true));
  const box = $("results-error");
  box.replaceChildren(card);
  box.hidden = false;
  $("status-line").textContent = "";
}

function classBox(c) {
  const kind =
    c.category === "available" ? "is-available" : c.category === "rac" ? "is-rac" : c.category === "waitlist" ? "is-waitlist" : "is-none";
  const li = el("li", `class-box ${kind}`);
  const status = c.category === "unknown" ? "Not loaded" : c.status || "Unknown";
  li.append(el("span", "cls", c.class_code), el("span", "status", status));
  const chance = c.confirm_chance ? `${c.confirm_chance[0].toUpperCase()}${c.confirm_chance.slice(1)} chance` : null;
  const meta = [rupees(c.fare_inr), chance].filter(Boolean).join(" · ");
  if (meta) li.append(el("span", "meta", meta));
  return li;
}

function timeBlock(time, code, plusDays, end) {
  const box = el("div", `time-block${end ? " end" : ""}`);
  const t = el("span", "time", time || "--:--");
  if (plusDays > 0) {
    const tag = el("span", "plus-day", `+${plusDays}`);
    tag.setAttribute("aria-label", plusDays === 1 ? "next day" : `${plusDays} days later`);
    t.append(tag);
  }
  box.append(t, el("span", "time-code", code));
  return box;
}

/** The best status among the shown classes, for the card's summary pill. */
function bestFlag(cells) {
  if (cells.some((c) => c.category === "available")) return ["is-available", "Seats available"];
  const rac = cells.filter((c) => c.category === "rac");
  if (rac.length) return ["is-rac", "RAC"];
  if (cells.some((c) => c.category === "waitlist")) return ["is-waitlist", "Waitlist"];
  return null;
}

function trainCard(t, searched) {
  const cells = shownClasses(t);
  const li = el("li", hasSeats(cells) ? "train has-seats" : "train");
  const head = el("div", "train-head");
  head.append(el("span", "train-no", t.train_number), el("span", "train-name", t.train_name));
  const flag = bestFlag(cells);
  if (flag) head.append(el("span", `seat-flag ${flag[0]}`, flag[1]));
  li.append(head);

  const times = el("div", "train-times");
  const dur = el("div", "duration");
  dur.append(el("span", null, durationText(t.duration_minutes)));
  times.append(timeBlock(t.departure_time, t.from_code, 0, false), dur, timeBlock(t.arrival_time, t.to_code, daysLater(t), true));
  li.append(times);

  const notes = [];
  if (t.from_code && t.from_code !== searched.from) notes.push(`Boards at ${t.from_code}, not ${searched.from}.`);
  if (t.to_code && t.to_code !== searched.to) notes.push(`Arrives at ${t.to_code}, not ${searched.to}.`);
  if (notes.length) li.append(el("p", "station-note", notes.join(" ")));

  if (cells.length) {
    const boxes = el("ul", "class-boxes");
    for (const c of cells) boxes.append(classBox(c));
    li.append(boxes);
  } else {
    li.append(el("p", "no-classes", `No ${results.route.classes.join(" / ")} on this train. Turn on All classes to see the others.`));
  }

  const links = el("div", "train-links");
  const irctc = el("a", "link-primary", "Book on IRCTC");
  irctc.href = IRCTC_URL;
  const ry = el("a", "link-ghost", "RailYatri");
  ry.href = railYatriUrl(searched.from, searched.to, searched.date);
  for (const a of [irctc, ry]) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  links.append(irctc, ry);
  li.append(links);
  return li;
}

function renderResults() {
  const r = results.route;
  const data = results.data;
  if (!r || !data) return;
  const av = data.availability || {};
  const searched = { from: av.from_code || r.from, to: av.to_code || r.to, date: av.date || r.date };
  const all = (Array.isArray(av.trains) ? av.trains : []).filter((t) => t && t.runs_on_date !== false);

  const withSeats = all.filter((t) => hasSeats(shownClasses(t)));
  const notLoaded = [
    ...new Set(
      all.flatMap((t) =>
        shownClasses(t)
          .filter((c) => c.category === "unknown")
          .map((c) => c.class_code),
      ),
    ),
  ];

  const status = $("status-line");
  status.replaceChildren();
  const parts = [
    [String(all.length), all.length === 1 ? " train" : " trains"],
    [String(withSeats.length), " with confirmed seats"],
  ];
  parts.forEach(([n, text], i) => {
    if (i) status.append(document.createTextNode(" · "));
    status.append(el("strong", null, n), document.createTextNode(text));
  });
  const at = av.observed_at ? istClock(av.observed_at) : null;
  if (at) status.append(document.createTextNode(` · checked ${at} IST`));
  if (notLoaded.length) status.append(document.createTextNode(` · didn't load: ${notLoaded.join(", ")}`));

  const shown = (results.seatsOnly ? withSeats : all).slice().sort(compareTrains);
  const list = $("train-list");
  list.replaceChildren(...shown.map((t) => trainCard(t, searched)));
  showNoSeats(all.length > 0 && withSeats.length === 0 ? `No confirmed seats in ${r.classes.join(" ")} on direct trains` : null);
  const empty = $("results-empty");
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    empty.textContent = all.length
      ? "No train has confirmed seats in these classes. Turn off Seats only to see waitlist and RAC."
      : "No trains run on this date.";
  }
}

async function loadResults(force = false) {
  const r = results.route;
  if (!r) return;
  const mine = ++results.seq;
  if (results.controller) results.controller.abort();
  results.controller = new AbortController();
  if (!force && results.data) return renderResults();
  results.data = null;
  startLoading();
  try {
    const data = await callTool("get_route_availability", { from: r.from, to: r.to, date: r.date }, results.controller.signal);
    if (mine !== results.seq) return;
    stopLoading();
    results.data = data;
    const trains = (data && data.availability && Array.isArray(data.availability.trains) ? data.availability.trains : []).filter(
      (t) => t && t.runs_on_date !== false,
    );
    rememberOpen(r, trains);
    renderDayRow(r);
    renderResults();
  } catch (e) {
    if (e && e.name === "AbortError") return;
    if (mine !== results.seq) return;
    stopLoading();
    if (e && e.code === "NOT_FOUND") {
      rememberOpen(r, []);
      renderDayRow(r);
    }
    showError(e);
  }
}

function showResults(r) {
  const same = results.route && routeKey(results.route) === routeKey(r);
  if (!same) {
    results.route = r;
    results.data = null;
  }
  renderTitle(r);
  renderDayRow(r);
  lookupNames(r);
  if (!same) resetOther();
  renderNearby();
  if (!same || !results.data) loadResults(true);
}

function leaveResults() {
  results.seq++;
  if (results.controller) results.controller.abort();
  stopOther();
  clearInterval(results.timer);
}

function initResults() {
  const toggle = (id, key) => {
    $(id).addEventListener("click", () => {
      results[key] = !results[key];
      $(id).setAttribute("aria-pressed", String(results[key]));
      renderResults();
    });
  };
  toggle("toggle-seats", "seatsOnly");
  toggle("toggle-all", "allClasses");
  $("refresh-btn").addEventListener("click", () => loadResults(true));
  initOther();
}

// ---------- other ways to go ----------

const NEARBY_MAX_ON = 3;
const NEARBY_MAX_SAVED = 8;

const other = { seq: 0, controller: null, timer: 0 };
let nearbyField;

/** Nearby stations I added for a destination: [{ code, name, on }]. */
function nearbyFor(dest) {
  const list = load(KEYS.nearby, {})[dest];
  return (Array.isArray(list) ? list : []).filter((s) => s && isCode(s.code) && typeof s.name === "string").slice(0, NEARBY_MAX_SAVED);
}

function saveNearby(dest, list) {
  const map = load(KEYS.nearby, {});
  if (list.length) map[dest] = list.slice(0, NEARBY_MAX_SAVED);
  else delete map[dest];
  save(KEYS.nearby, map);
}

function renderNearby() {
  const r = results.route;
  if (!r) return;
  const list = nearbyFor(r.to);
  const onCount = list.filter((s) => s.on).length;
  const box = $("nearby-list");
  box.replaceChildren();
  for (const s of list) {
    const li = el("li", "nearby-chip");
    const toggle = el("button", "nearby-toggle", s.name);
    toggle.type = "button";
    toggle.setAttribute("aria-pressed", String(Boolean(s.on)));
    toggle.disabled = !s.on && onCount >= NEARBY_MAX_ON;
    const km = distanceKm(r.to, s.code);
    toggle.append(el("span", "nearby-km", km === null ? s.code : `${s.code} · ${km} km`));
    toggle.addEventListener("click", () => {
      const next = nearbyFor(r.to).map((x) => (x.code === s.code ? { ...x, on: !x.on } : x));
      if (next.filter((x) => x.on).length > NEARBY_MAX_ON) return;
      saveNearby(r.to, next);
      renderNearby();
    });
    const remove = el("button", "nearby-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${s.name}`);
    remove.addEventListener("click", () => {
      saveNearby(
        r.to,
        nearbyFor(r.to).filter((x) => x.code !== s.code),
      );
      renderNearby();
    });
    li.append(toggle, remove);
    box.append(li);
  }
  renderOtherCost();
  $("nearby-help").textContent = list.length
    ? `${onCount} of ${NEARBY_MAX_ON} selected. Selected stations are checked as destinations instead of ${knownStationName(r.to) || r.to}.`
    : `None added. Add up to ${NEARBY_MAX_ON} stations near ${knownStationName(r.to) || r.to} to check them as destinations too.`;
}

function addNearby(station) {
  const r = results.route;
  if (!r) return;
  if (station.code === r.to || station.code === r.from) {
    $("nearby-help").textContent = "That's already the From or To station.";
    return;
  }
  const list = nearbyFor(r.to).filter((x) => x.code !== station.code);
  const on = list.filter((x) => x.on).length < NEARBY_MAX_ON;
  list.push({ code: station.code, name: station.name, on });
  while (list.length > NEARBY_MAX_SAVED) {
    const i = list.findIndex((x) => !x.on);
    list.splice(i >= 0 ? i : 0, 1);
  }
  saveNearby(r.to, list);
  renderNearby();
  if (!on) $("nearby-help").textContent = `Added, but switched off: ${NEARBY_MAX_ON} stations are already selected.`;
}

function hoursText(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function optionCard(o, dest) {
  const li = el("li", "option");
  const top = el("div", "option-top");
  const legs = Array.isArray(o.legs) ? o.legs : [];
  const last = legs[legs.length - 1];
  let badge;
  if (o.kind === "connection" && o.transfer) {
    const at = knownStationName(o.transfer.station_code) || o.transfer.station_code;
    badge = el("span", "badge", `Change at ${at}, ${hoursText(o.transfer.layover_minutes)} wait`);
  } else {
    const code = last ? last.to_code : "";
    const km = distanceKm(dest, code);
    const name = knownStationName(code) || code;
    badge = el("span", "badge is-alt", km === null ? `Ends at ${name}` : `Ends at ${name}, ${km} km away`);
  }
  const fare = el("span", "option-fare", o.total_fare_inr == null ? "Fare unknown" : rupees(o.total_fare_inr));
  if (o.total_fare_inr != null) fare.append(el("span", "meta", " total"));
  top.append(badge, fare);
  li.append(top);

  const list = el("ol", "legs");
  for (const l of legs) {
    const row = el("li", "leg");
    const info = el("div");
    const train = el("div", "leg-train");
    train.append(el("span", "train-no", l.train_number), el("span", "leg-name", l.train_name || ""));
    const when = `${shortDate(l.date)} · ${l.from_code} ${l.departure_time || "--:--"} → ${l.to_code} ${l.arrival_time || "--:--"}`;
    info.append(train, el("div", "leg-route", when));
    row.append(info, classBox(l));
    list.append(row);
  }
  li.append(list);

  if (o.kind === "connection") {
    li.append(
      el(
        "p",
        "ticket-warning",
        "Two separate tickets. If the first train runs late and you miss the second, the second ticket is not protected.",
      ),
    );
  }
  return li;
}

/** Hides the loading state (the finished request stays current). */
function finishOther() {
  clearInterval(other.timer);
  $("other-loading").hidden = true;
  $("other-btn").disabled = false;
}

/** Cancels any request in flight. */
function stopOther() {
  other.seq++;
  if (other.controller) other.controller.abort();
  finishOther();
}

function resetOther() {
  stopOther();
  $("other-error").hidden = true;
  $("other-summary").hidden = true;
  $("option-list").replaceChildren();
}

async function findOtherWays() {
  const r = results.route;
  if (!r) return;
  resetOther();
  const mine = ++other.seq;
  other.controller = new AbortController();
  const usedBefore = liveUsed;
  const started = Date.now();
  $("other-btn").disabled = true;
  $("other-loading").hidden = false;
  const tick = () => {
    $("other-counter").textContent = `Checking other ways… ${Math.floor((Date.now() - started) / 1000)} s`;
  };
  tick();
  other.timer = setInterval(tick, 1000);

  const alts = nearbyFor(r.to)
    .filter((s) => s.on)
    .slice(0, NEARBY_MAX_ON)
    .map((s) => s.code);
  const args = {
    from: r.from,
    to: r.to,
    date: r.date,
    classes: r.classes,
    connections: "always",
    max_change_stations: HUBS_CHECKED,
    hub_selection: "well_connected",
    include_city_terminals: true,
    // direct trains are already listed above, so ask for room to show 12 others
    limit: 30,
  };
  if (load(KEYS.overnight, false) === true) args.max_layover_minutes = OVERNIGHT_MAX_WAIT;
  if (alts.length) args.alternative_destinations = alts;

  try {
    const data = await callTool("plan_journey", args, other.controller.signal);
    if (mine !== other.seq) return;
    finishOther();
    const options = (data && Array.isArray(data.options) ? data.options : []).filter((o) => o && o.kind !== "direct").slice(0, 12);
    const via = (data && data.considered && Array.isArray(data.considered.change_stations) ? data.considered.change_stations : [])
      .map((h) => h && h.code)
      .filter(isCode);
    const hubs = [...via, ...options.filter((o) => o.kind === "connection" && o.transfer).map((o) => o.transfer.station_code)];
    $("option-list").replaceChildren(...options.map((o) => optionCard(o, r.to)));
    // change-station names for the badges, looked up once
    const unknown = [...new Set(hubs)].filter((c) => !knownStationName(c));
    if (unknown.length) {
      Promise.all(
        unknown.map((code) =>
          callTool("search_stations", { query: code, limit: 5 })
            .then((d) => {
              const hit = (d && Array.isArray(d.stations) ? d.stations : []).find((s) => s && s.code === code);
              if (hit) rememberStation({ code, name: hit.name, lat: hit.lat, lon: hit.lon });
            })
            .catch(() => {}),
        ),
      ).then(() => {
        if (mine !== other.seq) return;
        $("option-list").replaceChildren(...options.map((o) => optionCard(o, r.to)));
        renderSummary();
      });
    }

    const used = usedBefore !== null && liveUsed !== null ? liveUsed - usedBefore : null;
    const problems = (Array.isArray(data.notes) ? data.notes : []).filter(
      (n) => typeof n === "string" && /^(Could not read|No timetable|The timetable has no|\d+ of \d+ timetable connections)/.test(n),
    );
    function renderSummary() {
      const parts = [
        options.length ? `${options.length} other ${options.length === 1 ? "way" : "ways"} found` : "No other ways found in these classes",
        used === null ? null : `used ${used} live ${used === 1 ? "check" : "checks"}`,
        typeof data.lookups_used === "number" ? `${data.lookups_used} routes read` : null,
      ].filter(Boolean);
      const summary = $("other-summary");
      summary.replaceChildren(document.createTextNode(parts.join(" · ") + "."));
      if (via.length)
        summary.append(el("br"), document.createTextNode(`Changes checked at: ${via.map((c) => knownStationName(c) || c).join(", ")}.`));
      for (const n of problems) summary.append(el("br"), document.createTextNode(n));
      summary.hidden = false;
      renderOtherCost();
    }
    renderSummary();
  } catch (e) {
    if (e && e.name === "AbortError") return;
    if (mine !== other.seq) return;
    finishOther();
    const box = $("other-error");
    box.replaceChildren(errorCard(e, findOtherWays));
    box.hidden = false;
  }
}

const HUBS_CHECKED = 5;
const OVERNIGHT_MAX_WAIT = 900;

/** Estimated live checks for one press: the direct route (often cached), each selected nearby destination, two per change station. */
function renderOtherCost() {
  const r = results.route;
  if (!r) return;
  const alts = nearbyFor(r.to).filter((s) => s.on).length;
  const estimate = 1 + alts + HUBS_CHECKED * 2;
  const left = liveUsed !== null && liveLimit !== null ? liveLimit - liveUsed : null;
  $("other-cost").textContent =
    `Uses up to about ${estimate} live checks` +
    (left === null ? "." : left < estimate ? ` — only ${left} left today, so some routes may not be checked.` : ` (${left} left today).`);
}

function setOvernight(on) {
  save(KEYS.overnight, on);
  $("wait-normal").setAttribute("aria-pressed", String(!on));
  $("wait-overnight").setAttribute("aria-pressed", String(on));
}

function initOther() {
  setOvernight(load(KEYS.overnight, false) === true);
  $("wait-normal").addEventListener("click", () => setOvernight(false));
  $("wait-overnight").addEventListener("click", () => setOvernight(true));
  $("no-seats-btn").addEventListener("click", () => {
    $("other-ways").scrollIntoView({ behavior: "smooth", block: "start" });
    if (!$("other-btn").disabled) findOtherWays();
  });
  nearbyField = stationField($("nearby-input"), $("nearby-suggestions"), () => {
    const s = nearbyField && nearbyField.get();
    if (!s) return;
    addNearby(s);
    nearbyField.set(null);
  });
  $("other-btn").addEventListener("click", findOtherWays);
}

// ---------- routing ----------

/** Parses #/r/FROM/TO/DATE?c=3A,2A into a route, or null. */
function parseResultsHash(hash) {
  const m = hash.match(/^#\/r\/([A-Za-z0-9]{1,6})\/([A-Za-z0-9]{1,6})\/(\d{4}-\d{2}-\d{2})(?:\?c=([A-Za-z0-9,]*))?$/);
  if (!m) return null;
  const want = (m[4] || "").toUpperCase().split(",");
  const classes = want.filter((c, i) => CLASSES.includes(c) && want.indexOf(c) === i);
  return { from: m[1].toUpperCase(), to: m[2].toUpperCase(), date: m[3], classes: classes.length ? classes : [...DEFAULT_CLASSES] };
}

function route() {
  const r = parseResultsHash(location.hash);
  $("view-search").hidden = Boolean(r);
  $("view-results").hidden = !r;
  if (r) {
    showResults(r);
  } else {
    leaveResults();
    document.title = "Rail Seat Finder";
    renderDateChips(); // "Today" may have moved on since the page loaded
    renderRecent();
  }
  window.scrollTo(0, 0);
}

initSearch();
initResults();
window.addEventListener("hashchange", route);
route();
refreshLiveChecks();
