# Rail Seat Finder: specification

## Goal

A private, fast search page on my Mac for live Indian Railways seat availability.

It reuses this repository's engine:

- the `railyatri` provider (RailYatri, read through Firecrawl);
- the MCP tools `search_stations`, `find_nearby_stations`, `get_route_availability` and `plan_journey`.

## User

Only me, on this Mac. The app is never public.

## Page 1: Search

- **From** and **To** fields with station autocomplete:
  - backed by `search_stations`;
  - 160 ms debounce;
  - keyboard navigation with the arrow keys, Enter to select.
- A **swap** button that exchanges From and To.
- **Date** chips: Today, Tomorrow and the next 4 days, plus a date picker.
- **Class** chips: 1A, 2A, 3A, 3E, SL, CC, 2S.
  - Default selection: 3A, 2A, 1A.
  - The selection is remembered in `localStorage`.
- A **Check live seats** button, disabled until both stations are picked.
- The **last 6 searches**.

## Page 2: Results

URL format: `#/r/NDLS/CPR/2026-11-18?c=3A,2A,1A`.

### Header area

- A title with the station names. If this browser hasn't seen a station yet, its name is looked up.
- A **7-day date row**; each day is a link.
- A **status line** showing:
  - the number of trains;
  - how many have confirmed seats;
  - the time the data was checked;
  - the classes that didn't load.
- Toggles: **Seats only** and **All classes**.
- A **Refresh** button.

### Train cards

One card per train, showing:

- train number and name;
- departure and arrival times, with station codes;
- duration;
- a **+1 day** marker when the train arrives on a later day;
- a note when the train boards or arrives at a different station than the one searched (for example ANVT for NDLS);
- one box per class, with fare and confirmation chance, coloured by status:
  - green: available;
  - amber: RAC;
  - red: waitlist;
  - grey: regret or not loaded.

Links on each card:

- **Book on IRCTC**: `https://www.irctc.co.in/nget/train-search`
- **RailYatri**: the RailYatri page for the route and date.

### Sort order

1. Trains with confirmed seats first.
2. Then the smallest RAC or waitlist number.
3. Then departure time.

### Other ways to go

Shown at the bottom of page 2, only when I press a button.

- `plan_journey` with connections set to `"always"`, through up to 3 change stations.
- Up to 3 nearby destination stations that I pick myself with autocomplete. My picks are remembered per destination.

Each option shows:

- a badge: "Change at X, N h wait" or "Ends at X, N km away";
- its legs, each with date and class box;
- the total fare;
- for connections, a warning that they are two separate tickets.

## Loading and errors

- **Loading:** skeleton cards and a seconds counter, with a note that a fresh live check takes 15 to 25 seconds.
- **Errors:** a plain-language card for each error code, with a **Try again** button.

## Safety (non-negotiable)

- **Network binding:** listen on `127.0.0.1` only, on `APP_PORT` (default `4321`). Never `0.0.0.0`.
- **DNS rebinding protection:** reject any request whose `Host` header isn't `127.0.0.1:PORT` or `localhost:PORT`.
- **Same-origin API:**
  - the API answers only same-origin requests that carry the header `x-app: railways`;
  - it checks `Origin` and `Sec-Fetch-Site`;
  - it never sends CORS headers.
- **Response headers:**
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - no `X-Powered-By` header.
- **No third parties:** no third-party scripts, fonts, CDNs or analytics.
- **Safe rendering:** every string from the server goes into the page with `textContent`, never `innerHTML`. Train names come from a scraped page.
- **Tool allow-list:** the API may call only this fixed list of read-only tools:
  - `search_stations`
  - `find_nearby_stations`
  - `get_route_availability`
  - `plan_journey`
  - `get_data_sources`
- **Limits:**
  - 120 API calls a minute;
  - a daily cap on live page reads: `APP_DAILY_PAGE_READS`, default 150, resetting at midnight IST. Only real Firecrawl reads count, not cache hits;
  - the header shows "N/150 live checks today".
- **Secrets:** the Firecrawl key comes only from `.env`, through `process.env`. It is never logged and never sent to the browser.

## Tech

### Server

- `src/app.ts`, using Express (already a dependency).
- Tools are called in-process through an MCP client on an `InMemoryTransport` (`createMcpServer`).
- Exports `createLocalApp(ctx, options)` so tests can use it.
- Live reads are counted with a `beforeRead` hook on the `railyatri` provider, passed in through `buildContext`.

### Frontend

- Files: `web/index.html`, `web/styles.css`, `web/app.js`.
- Plain ES module: no framework, no build step, no dependencies.
- System font, light and dark mode, mobile-first, maximum width 760 px.

### Scripts

- `package.json` script: `"app": "tsx --env-file=.env src/app.ts"`. This repository does not load `.env` by itself.

### Tests

- `test/app.test.ts`, with a fake `route_availability` provider and synthetic data only (CONTRIBUTING rule).

### Checks

- Before every commit: `npm run typecheck && npm test && npm run format:check`.

## Scope

- **Out of scope for now:** PNR tracker, alerts, Tatkal page.
- **Never in scope:** booking, IRCTC login, CAPTCHA, OTP or payment code.
