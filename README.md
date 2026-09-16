# 🐦‍⬛ Raven

A free, installable **PWA** that watches flight prices for one trip and tells you
**buy now vs wait** — like a personal travel advisor.

You describe a trip once. A daily robot checks fares, saves the history in this
repo, and the app shows you a price chart, the cheapest days, an airport
comparison, and a clear buy/wait call.

**Everything costs €0/month.** No server, no paid API, no database.

---

## How it works (the whole thing on one page)

```
                 once a day (GitHub Actions cron)
   Travelpayouts  ──────────────►  scripts/fetch-prices.mjs
   price API                         │  writes cheapest fares
                                     ▼
                          data/history.json  (committed to the repo)
                                     │
                                     ▼   (just reads the file, never the API)
                          Raven PWA on GitHub Pages
                          chart · buy/wait · alerts · calendar · airports
```

- **App:** static HTML/CSS/JS on **GitHub Pages**. Installable, works offline.
- **Watcher:** a **GitHub Actions** cron job runs once a day, calls the price
  API, and commits the results to `data/history.json`.
- **Price data:** **Travelpayouts / Aviasales Data API** (free, no per-call cost).
- **The app never calls the price API.** It only reads the committed JSON. That
  keeps it free, fast, and means no API token is ever exposed in the browser.

---

## The reference trip (all editable in the app)

- 2 adults + 1 lap infant (under 2, on a lap)
- Fly from Eindhoven / nearby airports — you pick (AMS, BRU, DUS, EIN…)
- Fly to Brazil (e.g. GRU)
- Window: February–March 2027, flexible dates
- Round-trip or one-way, and how many days in Brazil

Everything above is just the default. Change it in the **Your trip** screen; it's
saved in your browser (`localStorage`).

> **Note on what the app shows vs what is watched:** the app *displays and alerts*
> on whatever you enter, but the fares it has are whatever the daily watcher
> fetched. The watcher's routes live in [`data/watch-config.json`](data/watch-config.json).
> If you pick an airport or destination that isn't in that file, the app says
> "no data" for it. To watch something new, edit `watch-config.json` and commit —
> the next daily run picks it up.

---

## Setup (one-time, ~5 minutes)

### 1. Get a free Travelpayouts token

1. Sign up at **https://www.travelpayouts.com/** (free).
2. Open the dashboard → **Developers** → **API tokens** (a.k.a. your API token /
   marker). Copy the token string.
   - Docs: https://support.travelpayouts.com/ and
     https://travelpayouts-data-api.readthedocs.io/

### 2. Add it as a GitHub Actions secret (never commit it)

In this repo: **Settings → Secrets and variables → Actions → New repository secret**

- **Name:** `TRAVELPAYOUTS_TOKEN`
- **Value:** the token you copied

That's it. The token lives only in GitHub's secret store and is injected into the
workflow at run time. It is never written to a file and never reaches the browser.

### 3. Turn on GitHub Pages  ← *one manual click*

**Settings → Pages → Build and deployment → Source: “Deploy from a branch” →
Branch: `main` / root (`/`) → Save.**

After a minute your app is live at:

```
https://cmgsilv-builder.github.io/Raven/
```

### 4. Let the watcher run

The workflow runs automatically every day. To get data right now without waiting:
**Actions → “Daily price watch” → Run workflow**. It commits a snapshot to
`data/history.json`, and the app updates on the next load.

Until the first real run, the app shows clearly-labelled **sample data** so you
can see how it looks.

---

## Install the app on your iPhone

1. Open the Pages URL in **Safari** (iOS 16.4 or newer).
2. Tap the **Share** button (the square with the up-arrow).
3. Tap **Add to Home Screen** → **Add**.
4. Launch “Raven” from your home screen — it opens full-screen and works offline.

On desktop Chrome/Edge, click the **install** icon in the address bar.

---

## How “buy vs wait” is decided (transparent, simple rules)

Raven looks at the series of cheapest estimated totals over time. Let:

- `current` = today's cheapest, `recentMin` = lowest seen, `median` = typical,
- `trend` = average of the last 7 days vs the 7 days before that.

Then, in order:

1. `current ≤ your target`  → **BUY NOW** (at/below target)
2. `current` within 2% of `recentMin` and not rising → **BUY NOW** (near recent low)
3. `trend` rising more than 3% → **BUY SOON** (prices climbing)
4. `current` more than 5% above `median` and falling → **WAIT** (pricey, dropping)
5. otherwise → **WAIT** (no urgency)

The logic lives in `computeAdvice()` in [`app.js`](app.js).

---

## Estimates (please read)

Fares come from Travelpayouts and change constantly, so treat every number as an
estimate:

- The watcher stores the **cheapest per-adult one-way** fare per day.
- **Round-trip** is estimated as **2× one-way**.
- A **lap infant** is **not free** on international flights to Brazil — roughly
  **10% of an adult fare plus taxes**. Raven estimates it at ~10%. The exact
  infant price and final total only show at the **airline checkout**.

---

## Free-tier notes

- **GitHub Pages** — free static hosting.
- **GitHub Actions** — unlimited minutes on public repos.
- **Travelpayouts Data API** — free, no per-call cost.

No paid services are used anywhere.

## Swapping the price source

The price source is expected to change over time. Only one function needs editing:
`fetchCalendar()` in [`scripts/fetch-prices.mjs`](scripts/fetch-prices.mjs). It must
return a map `{ "YYYY-MM-DD": price }` of the cheapest fare per day for one
origin→destination in one month. Everything downstream stays the same.

## Regenerating the sample data

```
node scripts/gen-seed.mjs     # rewrites data/history.json as sample (deterministic)
node scripts/gen-icons.py     # regenerates the PWA icons
```

---

## Roadmap (deferred — NOT in v1)

These are intentionally left for later phases:

- Push notifications and email alerts
- "Good-for-baby" flight rules (layovers, night flights, etc.)
- Multiple destinations at once
- Price-freeze / bookmark a fare
- "Any date" whole-month mode
- Baggage fees panel
- Deep-link straight to a booking page

---

## Project layout

```
index.html                     app shell
styles.css  app.js  sw.js      UI, logic, offline service worker
manifest.webmanifest           PWA manifest
icons/  apple-touch-icon.png   installable icons
data/watch-config.json         what the watcher fetches (edit to change routes)
data/history.json              price history (sample now; live after first run)
scripts/fetch-prices.mjs       the daily watcher (run by CI)
scripts/gen-seed.mjs           regenerates the sample history
scripts/gen-icons.py           regenerates icons
.github/workflows/watch-prices.yml   the daily cron workflow
```
