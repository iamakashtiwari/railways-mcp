// Rail Seat Finder: plain ES module, no dependencies, no build.
// All text from the server is inserted with textContent (never innerHTML).

const CLASSES = ["1A", "2A", "3A", "3E", "SL", "CC", "2S"];
const DEFAULT_CLASSES = ["3A", "2A", "1A"];
const view = document.getElementById("view");
const usageEl = document.getElementById("usage");
const bannerEl = document.getElementById("banner");

// ---------- small helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: keep working without it */
    }
  },
};

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (iso, n) => {
  const d = dateOf(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
};
const today = () => isoOf(new Date());
const fmtDay = (iso) => dateOf(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const fmtDur = (m) => (m == null ? "" : `${Math.floor(m / 60)}h ${pad(m % 60)}m`);
const toMin = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

function railYatriUrl(from, to, iso) {
  const [y, m, d] = iso.split("-");
  return `https://www.railyatri.in/booking/trains-between-stations?from_code=${encodeURIComponent(from)}&to_code=${encodeURIComponent(to)}&journey_date=${d}-${m}-${y}`;
}
const IRCTC = "https://www.irctc.co.in/nget/train-search";
const ext = (href, label) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label, " ↗");

// ---------- API ----------

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function call(tool, args) {
  let res;
  try {
    res = await fetch("/api/call", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app": "railways" },
      body: JSON.stringify({ tool, args }),
    });
  } catch {
    throw new ApiError("OFFLINE", "Can't reach the app. Is it still running on this computer?");
  } finally {
    refreshUsage();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new ApiError(body.error?.code ?? "INTERNAL", body.error?.message ?? `HTTP ${res.status}`);
  return body;
}

async function refreshUsage() {
  try {
    const res = await fetch("/api/status", { headers: { "x-app": "railways" } });
    const s = await res.json();
    usageEl.textContent = `${s.reads_today.used}/${s.reads_today.limit} live checks today`;
    if (!s.live) {
      bannerEl.hidden = false;
      bannerEl.textContent =
        "Live seats are off. Add ENABLE_UNOFFICIAL_SOURCES=railyatri and your FIRECRAWL_API_KEY to the .env file, then restart the app.";
    } else bannerEl.hidden = true;
  } catch {
    usageEl.textContent = "offline";
  }
}

const FRIENDLY = {
  RATE_LIMITED: "Limit reached",
  UPSTREAM_UNAVAILABLE: "RailYatri didn't load properly",
  UPSTREAM_AUTH: "Firecrawl rejected the key",
  NOT_FOUND: "Nothing listed",
  UNSUPPORTED: "Live seats are off",
  INVALID_INPUT: "Check the search",
  OFFLINE: "App not reachable",
};

function errorCard(e, retry) {
  return h(
    "div",
    { class: "card error" },
    h("h2", {}, FRIENDLY[e.code] ?? "Something went wrong"),
    h("p", { class: "muted" }, e.message),
    retry ? h("button", { class: "secondary", onclick: retry }, "Try again") : null,
  );
}

// ---------- stations ----------

const stationCache = store.get("stations", {});
function remember(st) {
  stationCache[st.code] = { code: st.code, name: st.name, lat: st.lat ?? null, lon: st.lon ?? null };
  store.set("stations", stationCache);
}
const nameOf = (code) => stationCache[code]?.name ?? code;
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
/** Display name of a station code; the bare code until its name is known. */
const label = (code) => (stationCache[code] ? titleCase(stationCache[code].name) : code);

/** Looks up names for codes this browser hasn't seen yet (local timetable, no live checks). */
async function learnNames(codes) {
  await Promise.all(
    codes
      .filter((c) => !stationCache[c])
      .map(async (c) => {
        try {
          const r = await call("search_stations", { query: c, limit: 3 });
          const st = r.stations.find((x) => x.code === c);
          if (st) remember(st);
        } catch {
          /* names are cosmetic; codes still work */
        }
      }),
  );
}

function stationInput(labelText, initial, onPick) {
  const id = `st-${labelText.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  let picked = initial;
  let items = [];
  let active = -1;
  let timer = 0;
  let seq = 0;
  const input = h("input", {
    id,
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Station name or code",
    value: initial ? `${titleCase(initial.name)} (${initial.code})` : "",
    role: "combobox",
    "aria-expanded": "false",
    "aria-controls": `${id}-list`,
  });
  const list = h("ul", { class: "suggest", id: `${id}-list`, role: "listbox", hidden: true });

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };
  const choose = (st) => {
    picked = st;
    remember(st);
    input.value = `${titleCase(st.name)} (${st.code})`;
    close();
    onPick(st);
  };
  const render = () => {
    list.replaceChildren(
      ...items.map((st, i) =>
        h(
          "li",
          { role: "option", "aria-selected": i === active ? "true" : "false", onmousedown: (ev) => (ev.preventDefault(), choose(st)) },
          h("span", {}, `${titleCase(st.name)} `, h("b", {}, st.code)),
          h(
            "span",
            { class: "meta" },
            [st.state, st.trains_halting != null ? `${st.trains_halting} trains` : null].filter(Boolean).join(" · "),
          ),
        ),
      ),
    );
    list.hidden = items.length === 0;
    input.setAttribute("aria-expanded", String(!list.hidden));
  };
  input.addEventListener("input", () => {
    picked = null;
    onPick(null);
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      items = [];
      render();
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const r = await call("search_stations", { query: q, limit: 7 });
        if (mine !== seq) return;
        items = r.stations;
        active = items.length ? 0 : -1;
        render();
      } catch {
        if (mine === seq) {
          items = [];
          render();
        }
      }
    }, 160);
  });
  input.addEventListener("keydown", (ev) => {
    if (list.hidden) return;
    if (ev.key === "ArrowDown") active = Math.min(items.length - 1, active + 1);
    else if (ev.key === "ArrowUp") active = Math.max(0, active - 1);
    else if (ev.key === "Enter" && active >= 0) choose(items[active]);
    else if (ev.key === "Escape") close();
    else return;
    ev.preventDefault();
    if (!list.hidden) render();
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("focus", () => input.select());

  const el = h("div", { class: "station" }, h("label", { class: "field", for: id }, labelText), input, list);
  return {
    el,
    get value() {
      return picked;
    },
    set(st) {
      picked = st;
      input.value = st ? `${titleCase(st.name)} (${st.code})` : "";
    },
  };
}

// ---------- search view ----------

function searchView() {
  const last = store.get("last", {});
  let date = last.date && last.date >= today() ? last.date : addDays(today(), 1);
  const classes = new Set(store.get("classes", DEFAULT_CLASSES));
  let from = last.from ? (stationCache[last.from] ?? null) : null;
  let to = last.to ? (stationCache[last.to] ?? null) : null;

  const go = h("button", { class: "primary", type: "submit" }, "Check live seats");
  const sync = () => (go.disabled = !(from && to && from.code !== to.code && classes.size));
  const fromIn = stationInput("From", from, (s) => ((from = s), sync()));
  const toIn = stationInput("To", to, (s) => ((to = s), sync()));
  const swap = h(
    "button",
    {
      class: "swap",
      type: "button",
      title: "Swap stations",
      "aria-label": "Swap stations",
      onclick: () => {
        [from, to] = [to, from];
        fromIn.set(from);
        toIn.set(to);
        sync();
      },
    },
    "⇅",
  );

  const dateChips = h("div", { class: "chips" });
  const picker = h("input", { type: "date", min: today(), value: date, "aria-label": "Pick a date" });
  const renderDates = () => {
    const opts = Array.from({ length: 6 }, (_, i) => addDays(today(), i));
    dateChips.replaceChildren(
      ...opts.map((iso, i) =>
        h(
          "button",
          {
            type: "button",
            class: "chip",
            "aria-pressed": String(iso === date),
            onclick: () => ((date = iso), (picker.value = iso), renderDates()),
          },
          i === 0 ? "Today" : i === 1 ? "Tomorrow" : fmtDay(iso),
        ),
      ),
      picker,
    );
  };
  picker.addEventListener("change", () => {
    if (picker.value) {
      date = picker.value;
      renderDates();
    }
  });
  renderDates();

  const classChips = h(
    "div",
    { class: "chips" },
    CLASSES.map((c) => {
      const b = h("button", { type: "button", class: "chip", "aria-pressed": String(classes.has(c)) }, c);
      b.addEventListener("click", () => {
        classes.has(c) ? classes.delete(c) : classes.add(c);
        b.setAttribute("aria-pressed", String(classes.has(c)));
        store.set("classes", [...classes]);
        sync();
      });
      return b;
    }),
  );

  const form = h(
    "form",
    {
      class: "card",
      onsubmit: (ev) => {
        ev.preventDefault();
        if (go.disabled) return;
        const cls = CLASSES.filter((c) => classes.has(c));
        store.set("last", { from: from.code, to: to.code, date });
        const recent = store.get("recent", []).filter((r) => !(r.from === from.code && r.to === to.code));
        store.set("recent", [{ from: from.code, to: to.code }, ...recent].slice(0, 6));
        location.hash = `#/r/${from.code}/${to.code}/${date}?c=${cls.join(",")}`;
      },
    },
    h("h1", {}, "Find a confirmed seat"),
    h("p", { class: "sub" }, "Live availability for every train on your route, plus other ways to get there."),
    h("div", { class: "stations" }, fromIn.el, swap, toIn.el),
    h("div", { class: "row" }, h("label", { class: "field" }, "Date"), dateChips),
    h("div", { class: "row" }, h("label", { class: "field" }, "Classes"), classChips),
    go,
  );
  sync();

  const recent = store.get("recent", []);
  const recentCard = recent.length
    ? h(
        "div",
        { class: "card" },
        h("div", { class: "section-title" }, "Recent"),
        h(
          "ul",
          { class: "recent" },
          recent.map((r) =>
            h(
              "li",
              {},
              h(
                "button",
                {
                  type: "button",
                  onclick: () => {
                    from = stationCache[r.from] ?? { code: r.from, name: r.from };
                    to = stationCache[r.to] ?? { code: r.to, name: r.to };
                    fromIn.set(from);
                    toIn.set(to);
                    sync();
                    go.focus();
                  },
                },
                h("span", {}, `${label(r.from)} → ${label(r.to)}`),
                h("span", { class: "meta" }, `${r.from} → ${r.to}`),
              ),
            ),
          ),
        ),
      )
    : null;

  view.replaceChildren(form, recentCard ?? "");
}

// ---------- results view ----------

const RANK = { available: 0, rac: 1, waitlist: 2, unknown: 3, not_available: 4 };

function bestRank(train, classes) {
  let best = 9;
  let count = 1e9;
  for (const c of train.classes) {
    if (!classes.includes(c.class_code)) continue;
    const r = RANK[c.category] ?? 5;
    if (r < best || (r === best && (c.count ?? 1e9) < count)) {
      best = r;
      count = c.count ?? 1e9;
    }
  }
  return [best, best === 0 ? 0 : count];
}

function classChip(c) {
  return h(
    "div",
    { class: `cls ${c.category}` },
    h(
      "div",
      { class: "top" },
      h("span", {}, c.class_code),
      c.fare_inr != null ? h("span", {}, `₹${c.fare_inr.toLocaleString("en-IN")}`) : null,
    ),
    h("div", { class: "st" }, c.status),
    c.confirm_chance ? h("div", { class: "chance" }, `${c.confirm_chance} chance`) : null,
  );
}

function trainCard(t, q, showAll) {
  const shown = showAll ? t.classes : t.classes.filter((c) => q.classes.includes(c.class_code));
  const dep = toMin(t.departure_time);
  const days = dep != null && t.duration_minutes != null ? Math.floor((dep + t.duration_minutes) / 1440) : 0;
  const notes = [];
  if (t.from_code && t.from_code !== q.from) notes.push(`Boards at ${t.from_code}`);
  if (t.to_code && t.to_code !== q.to) notes.push(`Arrives at ${t.to_code}`);
  return h(
    "article",
    { class: "card train" },
    h(
      "div",
      { class: "train-head" },
      h("div", { class: "train-name", title: t.train_name }, h("span", { class: "train-no" }, t.train_number), t.train_name),
    ),
    h(
      "div",
      { class: "times" },
      h("div", {}, h("span", { class: "t" }, t.departure_time ?? "--:--"), h("span", { class: "st" }, t.from_code)),
      h("div", { class: "line" }, h("span", {}, fmtDur(t.duration_minutes))),
      h(
        "div",
        {},
        h("span", { class: "t" }, t.arrival_time ?? "--:--"),
        days > 0 ? h("span", { class: "plus" }, ` +${days}`) : null,
        h("span", { class: "st" }, t.to_code),
      ),
    ),
    notes.length ? h("div", { class: "note" }, notes.join(" · ")) : null,
    shown.length
      ? h("div", { class: "classes" }, shown.map(classChip))
      : h("div", { class: "muted" }, "None of your classes on this train."),
    h(
      "div",
      { class: "links" },
      ext(IRCTC, "Book on IRCTC"),
      ext(railYatriUrl(t.from_code || q.from, t.to_code || q.to, q.date), "RailYatri"),
    ),
  );
}

function parseRoute() {
  const m = location.hash.match(/^#\/r\/([A-Z0-9]{2,6})\/([A-Z0-9]{2,6})\/(\d{4}-\d{2}-\d{2})(?:\?c=([A-Z0-9,]*))?$/);
  if (!m) return null;
  const classes = (m[4] ?? "").split(",").filter((c) => CLASSES.includes(c));
  return { from: m[1], to: m[2], date: m[3], classes: classes.length ? classes : DEFAULT_CLASSES };
}

const dateSummary = store.get("dateSummary", {});

function dateStrip(q) {
  const start = Math.max(-3, Math.round((dateOf(today()) - dateOf(q.date)) / 86400000));
  const days = Array.from({ length: 7 }, (_, i) => addDays(q.date, start + i));
  return h(
    "nav",
    { class: "dates", "aria-label": "Nearby dates" },
    days.map((iso) => {
      const s = dateSummary[`${q.from}|${q.to}|${iso}|${q.classes.join(",")}`];
      return h(
        "a",
        { class: "date", href: `#/r/${q.from}/${q.to}/${iso}?c=${q.classes.join(",")}`, "aria-current": iso === q.date ? "date" : null },
        h("span", {}, dateOf(iso).toLocaleDateString("en-IN", { weekday: "short" })),
        h("b", {}, dateOf(iso).getDate()),
        h("span", {}, s ? (s.open ? `${s.open} open` : "no seats") : dateOf(iso).toLocaleDateString("en-IN", { month: "short" })),
      );
    }),
  );
}

let resultsSeq = 0;

async function resultsView(q) {
  const mine = ++resultsSeq;
  const prefs = store.get("prefs", { seatsOnly: false, showAll: false });
  const header = h(
    "div",
    {},
    h("a", { class: "back", href: "#/" }, "← New search"),
    h("h1", {}, `${label(q.from)} → ${label(q.to)}`),
    h("p", { class: "sub" }, `${q.from} → ${q.to} · ${fmtDay(q.date)} · ${q.classes.join(", ")}`),
    dateStrip(q),
  );
  const status = h("div", { class: "statusline" });
  const list = h("div", {});
  const alt = h("div", {});
  view.replaceChildren(header, status, list, alt);
  if (!stationCache[q.from] || !stationCache[q.to]) {
    learnNames([q.from, q.to]).then(() => {
      if (mine === resultsSeq) header.querySelector("h1").textContent = `${label(q.from)} → ${label(q.to)}`;
    });
  }

  const started = Date.now();
  const tick = () =>
    (status.textContent = `Checking live seats… ${Math.round((Date.now() - started) / 1000)}s (a fresh check takes 15–25 s)`);
  tick();
  const timer = setInterval(tick, 1000);
  list.replaceChildren(h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));

  let data;
  try {
    data = await call("get_route_availability", { from: q.from, to: q.to, date: q.date });
  } catch (e) {
    if (mine !== resultsSeq) return;
    clearInterval(timer);
    status.textContent = "";
    list.replaceChildren(errorCard(e, () => resultsView(q)));
    alt.replaceChildren(altLauncher(q));
    return;
  }
  clearInterval(timer);
  if (mine !== resultsSeq) return;

  const trains = data.availability.trains;
  const open = trains.filter((t) => t.classes.some((c) => q.classes.includes(c.class_code) && c.category === "available")).length;
  dateSummary[`${q.from}|${q.to}|${q.date}|${q.classes.join(",")}`] = { open, at: Date.now() };
  store.set("dateSummary", dateSummary);
  header.replaceChild(dateStrip(q), header.lastChild);

  const render = () => {
    const sorted = [...trains].sort((a, b) => {
      const [ra, ca] = bestRank(a, q.classes);
      const [rb, cb] = bestRank(b, q.classes);
      return ra - rb || ca - cb || (toMin(a.departure_time) ?? 0) - (toMin(b.departure_time) ?? 0);
    });
    const visible = prefs.seatsOnly
      ? sorted.filter((t) => t.classes.some((c) => q.classes.includes(c.class_code) && c.category === "available"))
      : sorted;
    status.replaceChildren(
      h(
        "span",
        {},
        `${trains.length} trains · `,
        h("b", {}, `${open} with confirmed seats`),
        ` · checked ${fmtTime(data.availability.observed_at)}`,
        data.summary.not_loaded ? ` · ${data.summary.not_loaded} classes didn't load` : "",
      ),
      h(
        "span",
        { class: "toggles" },
        h(
          "button",
          {
            class: "chip",
            "aria-pressed": String(prefs.seatsOnly),
            onclick: () => ((prefs.seatsOnly = !prefs.seatsOnly), store.set("prefs", prefs), render()),
          },
          "Seats only",
        ),
        h(
          "button",
          {
            class: "chip",
            "aria-pressed": String(prefs.showAll),
            onclick: () => ((prefs.showAll = !prefs.showAll), store.set("prefs", prefs), render()),
          },
          "All classes",
        ),
        h("button", { class: "chip", onclick: () => resultsView(q) }, "↻ Refresh"),
      ),
    );
    list.replaceChildren(
      ...(visible.length
        ? visible.map((t) => trainCard(t, q, prefs.showAll))
        : [h("div", { class: "card empty" }, prefs.seatsOnly ? "No confirmed seats in your classes on this date." : "No trains listed.")]),
    );
  };
  render();
  alt.replaceChildren(altLauncher(q, open > 0));
}

// ---------- alternatives ----------

const altStore = store.get("altStations", {});
const MAX_ALT = 3;

function haversineKm(a, b) {
  if (a?.lat == null || b?.lat == null) return null;
  const r = (d) => (d * Math.PI) / 180;
  const x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

function altLauncher(q, hasSeats = false) {
  const wrap = h("div", {});
  const saved = (altStore[q.to] ?? []).filter((s) => s.code !== q.to && s.code !== q.from);
  const selected = new Set(saved.slice(0, MAX_ALT).map((s) => s.code));
  const chips = h("div", { class: "chips" });
  const renderChips = () => {
    chips.replaceChildren(
      ...saved.map((s) => {
        const b = h(
          "button",
          { type: "button", class: "chip", "aria-pressed": String(selected.has(s.code)) },
          `${titleCase(s.name)} `,
          h("small", {}, s.code),
        );
        b.addEventListener("click", () => {
          if (selected.has(s.code)) selected.delete(s.code);
          else if (selected.size < MAX_ALT) selected.add(s.code);
          renderChips();
        });
        return b;
      }),
    );
  };
  const adder = stationInput("Add a station near " + label(q.to), null, (st) => {
    if (!st || st.code === q.to || st.code === q.from) return;
    if (!saved.some((s) => s.code === st.code)) saved.unshift({ code: st.code, name: st.name });
    saved.splice(6);
    altStore[q.to] = saved;
    store.set("altStations", altStore);
    if (selected.size < MAX_ALT) selected.add(st.code);
    adder.set(null);
    renderChips();
  });
  renderChips();
  const box = h(
    "div",
    { class: "card" },
    h("div", { class: "alt-head" }, h("h2", {}, hasSeats ? "Other ways to go" : "No luck? Other ways to go")),
    h(
      "p",
      { class: "muted" },
      "Checks one change of train through big junctions, plus any nearby stations you pick (up to 3). Each route is checked live: about 5 to 12 live checks.",
    ),
    chips,
    h("div", { class: "row" }, adder.el),
    h("button", { class: "primary", onclick: () => runAlternatives(q, wrap, [...selected]) }, "Find alternatives"),
  );
  wrap.append(box);
  return wrap;
}

function optionCard(o, q) {
  let badge;
  if (o.kind === "direct") badge = h("span", { class: "badge direct" }, "Direct");
  else if (o.kind === "alternative_destination") {
    const end = o.legs[o.legs.length - 1].to_code;
    const km = haversineKm(stationCache[end], stationCache[q.to]);
    badge = h("span", { class: "badge" }, `Ends at ${end}${km != null ? ` · ${Math.round(km)} km from ${q.to}` : ""}`);
  } else badge = h("span", { class: "badge" }, `Change at ${o.transfer.station_code} · ${fmtDur(o.transfer.layover_minutes)} wait`);
  return h(
    "div",
    { class: "card" },
    badge,
    o.legs.map((l) =>
      h(
        "div",
        { class: "leg" },
        h(
          "div",
          {},
          h("b", {}, `${l.train_number} `),
          l.train_name,
          h(
            "div",
            { class: "muted" },
            `${l.from_code} ${l.departure_time ?? ""} → ${l.to_code} ${l.arrival_time ?? ""} · ${fmtDay(l.date)}`,
          ),
        ),
        classChip(l),
      ),
    ),
    h(
      "div",
      { class: "option-foot" },
      h("span", {}, o.total_fare_inr != null ? `Total ₹${o.total_fare_inr.toLocaleString("en-IN")}` : "Fare not shown"),
      h("span", {}, ext(railYatriUrl(o.legs[0].from_code, o.legs[0].to_code, o.legs[0].date), "Open first leg")),
    ),
    o.kind === "connection"
      ? h("div", { class: "warn" }, "Two separate tickets: if the first train runs late, the second one won't wait.")
      : null,
  );
}

async function runAlternatives(q, wrap, nearby) {
  wrap.replaceChildren(
    h(
      "div",
      { class: "card" },
      h("div", { class: "statusline" }, "Checking connections and nearby stations live… this can take up to a minute."),
      h("div", { class: "skeleton" }),
    ),
  );
  try {
    const r = await call("plan_journey", {
      from: q.from,
      to: q.to,
      date: q.date,
      classes: q.classes,
      alternative_destinations: nearby,
      connections: "always",
      max_change_stations: 3,
      limit: 12,
    });
    const opts = r.options.filter((o) => o.kind !== "direct");
    const head = h(
      "div",
      { class: "card" },
      h("div", { class: "alt-head" }, h("h2", {}, "Other ways to go"), h("span", { class: "muted" }, `${r.lookups_used} live checks used`)),
      nearby.length
        ? h(
            "p",
            { class: "muted" },
            `Nearby stations checked: ${nearby.map((c) => (stationCache[c] ? `${label(c)} (${c})` : c)).join(", ")}`,
          )
        : null,
      h("button", { class: "secondary", onclick: () => wrap.replaceChildren(...altLauncher(q).childNodes) }, "Change stations"),
    );
    wrap.replaceChildren(
      head,
      ...(opts.length
        ? opts.map((o) => optionCard(o, q))
        : [h("div", { class: "card empty" }, "No nearby-station or one-change options with seats in your classes on this date.")]),
    );
  } catch (e) {
    wrap.replaceChildren(errorCard(e, () => runAlternatives(q, wrap, nearby)));
  }
}

// ---------- router ----------

function route() {
  const q = parseRoute();
  window.scrollTo(0, 0);
  if (q) resultsView(q);
  else searchView();
}

window.addEventListener("hashchange", route);
refreshUsage();
route();
