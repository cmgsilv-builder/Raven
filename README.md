# 🐦‍⬛ Raven

A free, installable **PWA** that watches flight prices for one trip and tells you
**buy now vs wait** — like a personal travel advisor.

You describe a trip once. A daily robot checks fares, saves the history in this
repo, and the app shows you a price chart, the cheapest days, an airport and
destination comparison, and a clear buy/wait call. It can also **push and email
you** when your target price is hit, let you **bookmark a fare**, and **deep-link
straight to booking**.

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
> on whatever you enter, but the fares it has are whatever the watcher fetched.
> The daily cron's routes live in [`data/watch-config.json`](data/watch-config.json).
> If you pick an airport or destination that isn't in the data yet, the app says
> "no data" for it — **but you can fetch it right away with the “🔎 Search this
> route” button** (see [Search any route on demand](#search-any-route-on-demand-new)).
> To add a route to the *daily* watch, edit `watch-config.json` and commit.

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

## Search any route on demand (new)

Type **any** origins and destination in *Your trip* and tap **🔎 Search this
route**. Raven asks GitHub to run the price watcher for exactly those routes,
then auto-refreshes the page when the fresh fares land (~1–3 min). No more
"nothing happened" when you enter a route the daily cron never fetched.

Two clearly separated buttons in *Your trip*:

- **🔎 Search this route** — tells the robot (GitHub Actions) to fetch fresh
  fares now, then re-renders advice, prices, chart, calendar, destination,
  airport comparison and taxes.
- **Save trip** — just stores your settings in this browser (`localStorage`).

### One-time: connect GitHub (token stays on your device)

The button triggers the watcher through GitHub's REST API, which needs a token
you create once. Open Raven → **Search live · connect GitHub** and follow the
steps, or:

1. Create a **fine-grained personal access token**:
   **https://github.com/settings/personal-access-tokens/new**
2. **Resource owner:** your account.
3. **Repository access:** *Only select repositories* → **`cmgsilv-builder/Raven`**.
4. **Repository permissions → Actions: Read and write.** Leave everything else at
   *No access*. (That's the exact minimum: **Actions: Read and write** — write to
   start the run, read to validate the token. Reading fresh data uses the public
   raw file, so **Contents** is *not* required.)
5. Generate, copy, and paste it into Raven's **Connect** box.

> 🔒 **Your token never leaves your device except to call GitHub.** It's stored
> only in this browser's `localStorage` (wrapped in try/catch). Raven sends it
> *only* to `api.github.com` to start a search — it is never committed to the
> repo, never logged, and never uploaded anywhere else. Tap **Disconnect / forget
> token** to remove it. The repo (`cmgsilv-builder/Raven`) is hardcoded, so you
> only ever paste the token.

### How it works

```
  You: type LIS → NAT, tap "🔎 Search this route"
        │
        ▼  POST .../actions/workflows/watch-prices.yml/dispatches   (your token)
   GitHub Actions runs scripts/fetch-prices.mjs for JUST that route
        │  merges it into data/history.json (keeps the daily routes), commits
        ▼
   App polls the committed history, sees the new snapshot, re-renders everything
```

- The app dispatches with `ref: main` and `inputs` = your `origins`,
  `destinations`, and window `months` (comma-separated).
- It then polls the committed `history.json` (the public
  `raw.githubusercontent.com` copy, which updates within seconds) every ~12s for a
  newer snapshot, with a ~6-minute timeout and a visible *searching…* / *done* /
  *timed out* state.
- If the free source has **no fares** for a route (it happens — e.g. EIN/DUS, or
  an unusual pair), Raven says so plainly: *"No fares found for LIS → NAT — the
  free data source has no cached prices for this route."*

### On-demand workflow inputs

The daily workflow also accepts manual/on-demand inputs (used by the button, and
runnable yourself from **Actions → Daily price watch → Run workflow**):

| Input | Example | Empty means |
| --- | --- | --- |
| `origins` | `LIS,AMS` | use `watch-config.json` origins (a normal daily run) |
| `destinations` | `NAT` | use `watch-config.json` destinations |
| `months` | `2027-02,2027-03` | use `watch-config.json` months |

When origins **and** destinations are provided, `scripts/fetch-prices.mjs` runs in
on-demand mode: it fetches only those routes and **merges** them into the latest
snapshot (keeping the daily-watched routes; re-searching a route just refreshes
it, never duplicates it). With no inputs it behaves exactly as the daily cron.

---

## Install the app on your iPhone

1. Open the Pages URL in **Safari** (iOS 16.4 or newer).
2. Tap the **Share** button (the square with the up-arrow).
3. Tap **Add to Home Screen** → **Add**.
4. Launch “Raven” from your home screen — it opens full-screen and works offline.

On desktop Chrome/Edge, click the **install** icon in the address bar.

---

## Alerts: push notifications & email (optional)

Both are **free** and both are sent by the **daily** workflow — so they fire at
most once a day, right after the watcher fetches fares, not in real time (that's
the trade-off of a serverless, cron-based design).

Set your **server-side target** in [`data/watch-config.json`](data/watch-config.json)
under `alerts.targetPrice` (leave it `null` to disable all alerts). The alert
fires when the cheapest **in-window estimated total** is at or below it.

> The `targetPrice` in the app screen only drives the on-screen banner (it lives
> in your browser). The workflow can't read your browser, so the alert target
> lives in `watch-config.json`.

### Push notifications (iPhone + desktop)

1. **Generate keys once (locally):**
   ```
   node scripts/gen-vapid.mjs
   ```
   This writes the **public** key into `data/push-config.json` (safe to commit)
   and prints the **private** key.
2. **Add secrets** (Settings → Secrets and variables → Actions):
   - `VAPID_PRIVATE_KEY` — the private key it printed (**never commit it**).
   - `VAPID_SUBJECT` — a contact, e.g. `mailto:you@example.com`.
3. **Commit** `data/push-config.json` (with the public key filled in).
4. **Subscribe in the app:** open Raven → **Alerts & notifications** → *Turn on
   push alerts*. Copy the subscription JSON it shows you and add it as the secret
   `PUSH_SUBSCRIPTIONS` (a JSON array — you can paste one object or an array of
   several devices).

**iPhone:** web push only works when Raven is **installed to the Home Screen**
(iOS 16.4+). Install it first (see below), then subscribe from the installed app.

> **needs-decision — where subscriptions live.** On a static, public, serverless
> app there's no private database to store push subscriptions in. Raven's default
> is the **`PUSH_SUBSCRIPTIONS` Actions secret** (private, free, but you re-paste
> if the subscription changes — rare). Alternatives if you prefer: (a) commit a
> `data/push-subscriptions.json` array — simplest, but the endpoints become
> public (they still can't be pushed to without your private key); or (b) add a
> tiny free serverless function to auto-store them. The sender reads the secret
> **and** the file, so either works. Pick per your privacy comfort.

### Email alerts (one or many recipients)

1. **Register recipients in the app:** open Raven → **Alerts & notifications** →
   **Email**. Add one or more addresses, then **Copy list for watch-config**.
2. In `data/watch-config.json`, set `alerts.email.enabled: true` and paste the
   list into `alerts.email.to` (a JSON **array**, e.g. `["a@x.com","b@y.com"]`;
   a single string still works).
3. Add your mail provider's **SMTP** credentials as Actions secrets:
   - `SMTP_HOST` (e.g. `smtp.gmail.com`), `SMTP_USER`, `SMTP_PASS`
   - optional: `SMTP_PORT` (default `587`; use `465` for SSL), `SMTP_FROM`
   - For Gmail, use an **App Password**, not your normal password.

That's it — the daily workflow emails **all** listed recipients when the target
is hit.

> **needs-decision — where recipient emails live.** A static PWA can't send mail
> or read your browser, so the workflow reads recipients from
> `watch-config.json` (committed). The in-app list is a convenience you copy in.
> Default: **commit the list in `alerts.email.to`** (visible in a public repo —
> fine for your own addresses). Alternatives: (a) keep recipients only in an
> Actions secret and have the sender read it, or (b) add a tiny free function to
> collect them. The committed-array default is the simplest free option; switch
> if you'd rather not publish the addresses.

## What else is new (all free, all on the static app)

- **“Good-for-baby” preference** — toggle *Prefer baby-friendly flights* in your
  trip. **Data limit:** the free feed gives only *cheapest fare per day*, with no
  layover/duration/red-eye detail, so Raven can't filter itineraries. The toggle
  is a reminder and, where possible, nudges the booking link toward direct
  flights; confirm actual flight times at checkout. (If you later swap in a
  richer price source that returns stops/duration, surface those fields here.)
- **Clear destination** — the *Fly to* field shows a readout like
  **To: São Paulo (GRU)** so the final destination is unmistakable.
- **Preferred departure airport** — tap the ☆ on an airport chip to star **one**
  preferred origin. It's highlighted in *Compare airports* and drives the
  buy/wait advice (instead of the cheapest-across-all default).
- **Totals include taxes** — Travelpayouts fares already include taxes, so every
  total is labelled **incl. taxes (estimate)**; the final figure is at checkout.
- **Multiple destinations** — list them in `watch-config.json` `destinations`
  (e.g. `["GRU","GIG"]`). The app shows a **Compare destinations** table and you
  pick which one to focus on in *Your trip*.
- **Price-freeze / bookmark** — tap **☆ Bookmark** on a cheapest day to freeze a
  fare in your browser; the *Saved fares* card shows it vs the current price.
- **“Any date” whole-month mode** — set *Earliest/Latest departure* to narrow to
  specific days, or tick **“Any date”** to use the whole month(s).
- **Baggage panel** — a reference list of airline baggage rules
  ([`data/baggage.json`](data/baggage.json)). **Reference only — verify at the
  airline.**
- **Deep-link to buy** — every cheapest day has a **Book** button that opens an
  Aviasales search for that exact route/date/party. Set your Travelpayouts
  affiliate `marker` in `watch-config.json` to earn commission (never hardcoded).

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
- **Web Push** — the browser push services (Apple/Google/Mozilla) are free; the
  workflow signs pushes with your own VAPID keys.
- **Email** — sent via your own mail provider's SMTP (most have a free tier).
- **`web-push` / `nodemailer`** — free open-source libraries, installed only in
  CI. The PWA itself has **zero** dependencies.

No paid services are used anywhere.

## Swapping the price source

The price source is expected to change over time. Only one function needs editing:
`fetchCalendar()` in [`scripts/fetch-prices.mjs`](scripts/fetch-prices.mjs). It must
return a map `{ "YYYY-MM-DD": price }` of the cheapest fare per day for one
origin→destination in one month. Everything downstream stays the same.

## Regenerating / checking locally

```
node scripts/selfcheck.mjs    # cheapest-day regression test (no deps)
node scripts/gen-seed.mjs     # rewrites data/history.json as sample (deterministic)
node scripts/gen-vapid.mjs    # generate push (VAPID) keys, once
node scripts/gen-icons.py     # regenerates the PWA icons
```

---

## Delivered (was the v1 roadmap)

All of these now ship — see the sections above for setup and limits:

- ✅ Push notifications (iPhone + desktop) and ✅ email alerts
- ✅ "Good-for-baby" flight preference (within the data limit noted above)
- ✅ Multiple destinations at once, with a comparison table
- ✅ Price-freeze / bookmark a fare
- ✅ "Any date" whole-month mode (plus optional day-level bounds)
- ✅ Baggage reference panel
- ✅ Deep-link straight to a booking page (with affiliate marker)

### The "cheapest day" fix

The Travelpayouts calendar returns cheap fares for dates **outside** the month
you asked for. Raven now keeps only in-month dates before choosing the cheapest
(in the watcher **and** defensively in the app), and the app restricts the
"cheapest day in your window" to your configured window. Proof:

```
node scripts/selfcheck.mjs     # regression test for the cheapest-day bug
```

It also runs in CI before every fetch.

---

## New GitHub Actions secrets (summary)

All optional; add only the ones you use. None are ever committed.

| Secret | For | Notes |
| --- | --- | --- |
| `TRAVELPAYOUTS_TOKEN` | prices | required for live data (existing) |
| `VAPID_PRIVATE_KEY` | push | from `node scripts/gen-vapid.mjs` |
| `VAPID_SUBJECT` | push | e.g. `mailto:you@example.com` |
| `PUSH_SUBSCRIPTIONS` | push | JSON array of subscriptions (from the app) |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | email | your mail provider |
| `SMTP_PORT` / `SMTP_FROM` | email | optional (default 587 / = SMTP_USER) |

---

## Project layout

```
index.html                     app shell
styles.css  app.js  sw.js      UI, logic, offline service worker + web push
manifest.webmanifest           PWA manifest
icons/  apple-touch-icon.png   installable icons
data/watch-config.json         what the watcher fetches + alert config (edit this)
data/history.json              price history (sample now; live after first run)
data/push-config.json          VAPID public key (safe to commit; empty = off)
data/baggage.json              airline baggage reference (editable)
scripts/fetch-prices.mjs       the daily watcher (run by CI)
scripts/notify.mjs             sends push + email when target hit (run by CI)
scripts/gen-vapid.mjs          generate VAPID keys (run once, locally)
scripts/selfcheck.mjs          cheapest-day regression test
scripts/lib/prices.mjs         shared in-month price helpers
scripts/gen-seed.mjs           regenerates the sample history
scripts/gen-icons.py           regenerates icons
package.json                   CI-only deps (web-push, nodemailer); the PWA has none
.github/workflows/watch-prices.yml   the daily cron workflow
```
