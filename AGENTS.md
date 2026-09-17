# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## What this is

Raven is a free, installable PWA that watches flight prices and advises buy-vs-wait.
Architecture, setup, and the buy/wait rules are all in [README.md](README.md) — read it first.

## Key facts

- **Static app, no build step.** Plain HTML/CSS/JS (`index.html`, `styles.css`, `app.js`,
  `sw.js`). No framework, no bundler. Served by GitHub Pages from `main` root.
- **The PWA never calls the price API.** It only fetches `data/history.json`. The daily
  GitHub Actions cron (`.github/workflows/watch-prices.yml`) runs `scripts/fetch-prices.mjs`,
  which calls Travelpayouts and commits the history back.
- **Token** is only the `TRAVELPAYOUTS_TOKEN` Actions secret — never commit it.
- **Swapping the price source:** edit only `fetchCalendar()` in `scripts/fetch-prices.mjs`;
  it must return `{ "YYYY-MM-DD": price }`. Everything downstream is source-agnostic.
- **history.json** keeps the full day-by-day calendar only on the *latest* snapshot (older
  ones keep just the cheapest per origin/month) — keeps the committed file small. Both
  `fetch-prices.mjs` and `gen-seed.mjs` enforce this.
- **Sample vs live:** `gen-seed.mjs` writes `meta.sample=true`; the first live watcher run
  discards the sample and starts a fresh series.
- **Cheapest-day rule (important):** the Travelpayouts calendar returns dates OUTSIDE the
  requested month. Always narrow to the month before picking the cheapest — helpers live in
  `scripts/lib/prices.mjs` (`filterCalendarToMonth`, `cheapestOf`), used by the watcher and by
  `scripts/selfcheck.mjs` (the regression test). `app.js` also defends this via `dayInWindow()`
  / `entryCheapestInWindow()` so old buggy snapshots still display correctly.
- **Alerts:** `scripts/notify.mjs` runs in CI after the fetch and sends Web Push + email when
  `watch-config.json`'s `alerts.targetPrice` is hit. `alerts.email.to` may be a string OR an
  array (multi-recipient). Secrets (all optional) are listed in the README.
  `data/alert-state.json` (committed by CI) dedupes repeat alerts.
- **CI-only deps:** `package.json` pulls `web-push` + `nodemailer` for the CI scripts only. The
  PWA itself stays dependency-free — never add a bundler/framework to the app.
- **Multi-destination + marker:** `watch-config.json` has `destinations[]`, a Travelpayouts
  affiliate `marker` (read by the app's Aviasales deep-link, never hardcoded), and `alerts{}`.

## Local dev / verify

- Serve: `python3 -m http.server 8765` then open `http://localhost:8765/index.html`.
- Regenerate sample data: `node scripts/gen-seed.mjs`. Regenerate icons: `python3 scripts/gen-icons.py`.
- No test framework. Sanity-check JS with `node --check <file>`; run `node scripts/selfcheck.mjs`
  for the cheapest-day regression test.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
