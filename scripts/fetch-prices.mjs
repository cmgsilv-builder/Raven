#!/usr/bin/env node
/**
 * Raven daily price watcher.
 *
 * Reads data/watch-config.json, calls the Travelpayouts / Aviasales Data API
 * price-calendar endpoint (cheapest fare per day of a month for a route),
 * and appends today's snapshot to data/history.json (committed back by CI).
 *
 * The PWA NEVER calls the API — it only reads the committed history.json.
 *
 * Token: read from env TRAVELPAYOUTS_TOKEN (a GitHub Actions secret).
 * Never commit the token.
 *
 * --- Swapping the price source ---
 * If the endpoint/params change, edit ONLY `fetchCalendar()` below. It must
 * return a map { "YYYY-MM-DD": priceNumber } of the cheapest fare per day for
 * one origin->destination in one month. Everything else stays the same.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filterCalendarToMonth, cheapestOf } from "./lib/prices.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "data", "watch-config.json");
const HISTORY_PATH = join(ROOT, "data", "history.json");

const API_BASE = "https://api.travelpayouts.com/v1/prices/calendar";
const MAX_SNAPSHOTS = 400;
const REQUEST_GAP_MS = 400; // be gentle with the free API

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch the cheapest one-way fare per departure day for one route/month.
 * Returns { "YYYY-MM-DD": price } (may be partial or empty).
 */
async function fetchCalendar({ origin, destination, month, currency, token }) {
  const url =
    `${API_BASE}?origin=${encodeURIComponent(origin)}` +
    `&destination=${encodeURIComponent(destination)}` +
    `&depart_date=${encodeURIComponent(month)}` +
    `&calendar_type=departure_date` +
    `&currency=${encodeURIComponent(currency.toLowerCase())}`;

  const res = await fetch(url, {
    headers: { "X-Access-Token": token, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${origin}->${destination} ${month}`);
  }
  const body = await res.json();
  if (!body || body.success === false) {
    throw new Error(`API error for ${origin}->${destination} ${month}: ${JSON.stringify(body).slice(0, 200)}`);
  }

  const out = {};
  const data = body.data || {};
  for (const [date, entry] of Object.entries(data)) {
    // Different API versions expose the fare as `price` or `value`.
    const price = typeof entry === "number" ? entry : entry?.price ?? entry?.value;
    if (typeof price === "number" && price > 0) out[date] = Math.round(price);
  }
  return out;
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const token = process.env.TRAVELPAYOUTS_TOKEN;
  if (!token) {
    console.error(
      "TRAVELPAYOUTS_TOKEN is not set. Skipping fetch (history.json unchanged).\n" +
        "Set it as a GitHub Actions secret — see README."
    );
    process.exit(0); // don't fail the workflow; just no new data today
  }

  const config = await loadJson(CONFIG_PATH, null);
  if (!config) {
    console.error(`Cannot read ${CONFIG_PATH}`);
    process.exit(1);
  }
  const currency = config.currency || "EUR";
  // Support multiple destinations; fall back to the single legacy `destination`.
  const destinations = (config.destinations && config.destinations.length)
    ? config.destinations
    : [config.destination].filter(Boolean);

  const prices = [];
  let anySuccess = false;
  for (const origin of config.origins) {
    for (const destination of destinations) {
      for (const month of config.months) {
        try {
          const raw = await fetchCalendar({ origin, destination, month, currency, token });
          // The API returns cheap fares for dates beyond the requested month;
          // keep ONLY in-month dates so the cheapest day can't fall outside it.
          const calendar = filterCalendarToMonth(raw, month);
          const { cheapestDate, cheapest } = cheapestOf(calendar);
          if (cheapest != null) anySuccess = true;
          prices.push({ origin, destination, month, cheapestDate, cheapest, calendar });
          console.log(`${origin}->${destination} ${month}: cheapest ${cheapest ?? "n/a"} ${currency} on ${cheapestDate ?? "n/a"} (${Object.keys(calendar).length}/${Object.keys(raw).length} in-month days)`);
        } catch (err) {
          console.error(`  ! ${err.message}`);
          prices.push({ origin, destination, month, cheapestDate: null, cheapest: null, calendar: {} });
        }
        await sleep(REQUEST_GAP_MS);
      }
    }
  }

  if (!anySuccess) {
    console.error("No prices returned from any route. Leaving history.json unchanged.");
    process.exit(0);
  }

  // Load existing history; if it's the shipped sample, start a fresh live series.
  let history = await loadJson(HISTORY_PATH, null);
  if (!history || history.meta?.sample) {
    history = {
      meta: {
        currency,
        unit: "per-adult one-way cheapest fare",
        source: "travelpayouts-v1-calendar",
        sample: false,
      },
      config: {},
      snapshots: [],
    };
  }
  history.meta.currency = currency;
  history.meta.sample = false;
  history.config = {
    origins: config.origins,
    destination: destinations[0] || config.destination,
    destinations,
    months: config.months,
    tripType: config.tripType,
    daysAtDestination: config.daysAtDestination,
    travellers: config.travellers,
    marker: config.marker || "", // Travelpayouts affiliate marker (optional)
    // Non-secret alert status the app shows (no credentials — those are secrets).
    email: (config.alerts && config.alerts.email) || { enabled: false, to: "" },
  };

  const today = new Date().toISOString().slice(0, 10); // UTC date
  const snapshot = { date: today, ts: new Date().toISOString(), ok: true, prices };

  // Idempotent: replace today's snapshot if the job runs twice in a day.
  const existingIdx = history.snapshots.findIndex((s) => s.date === today);
  if (existingIdx >= 0) history.snapshots[existingIdx] = snapshot;
  else history.snapshots.push(snapshot);

  history.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (history.snapshots.length > MAX_SNAPSHOTS) {
    history.snapshots = history.snapshots.slice(-MAX_SNAPSHOTS);
  }

  // Keep the full day-by-day calendar only on the latest snapshot (the app
  // uses it for the cheapest-day view). Older snapshots keep just the cheapest
  // per origin/month for the trend chart — this keeps history.json small.
  history.snapshots.forEach((s, i) => {
    const isLatest = i === history.snapshots.length - 1;
    if (!isLatest) {
      for (const p of s.prices) delete p.calendar;
    }
  });

  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n", "utf8");
  console.log(`Wrote ${HISTORY_PATH} (${history.snapshots.length} snapshots).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
