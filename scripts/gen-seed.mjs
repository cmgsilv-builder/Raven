#!/usr/bin/env node
/**
 * Generate a realistic SAMPLE data/history.json so the PWA renders before the
 * first real cron run. Marked meta.sample=true; the first live watcher run
 * discards it and starts a fresh live series.
 *
 * Deterministic (seeded) so the sample is stable across regenerations.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "data", "watch-config.json");
const HISTORY_PATH = join(ROOT, "data", "history.json");

const DAYS = 45; // snapshots of history

// tiny seeded PRNG (mulberry32)
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// baseline per-adult one-way fare (EUR) per origin — GRU is long-haul
const BASE = { AMS: 690, BRU: 720, DUS: 705, EIN: 760, default: 730 };
// small per-destination adjustment so a second destination looks distinct
const DEST_ADJ = { GRU: 1.0, GIG: 1.05, default: 1.0 };

function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const rand = rng(20270214);
  const destinations = (config.destinations && config.destinations.length)
    ? config.destinations
    : [config.destination].filter(Boolean);

  const snapshots = [];
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (DAYS - 1));

  // slowly drifting "market" multiplier shared across origins, plus noise
  let market = 1.12; // start a bit high, drift down then wobble

  for (let d = 0; d < DAYS; d++) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + d);
    const iso = date.toISOString().slice(0, 10);

    // market trend: gentle decline first half, slight rise near the end
    const phase = d / DAYS;
    const drift = phase < 0.7 ? -0.12 * (phase / 0.7) : 0.06 * ((phase - 0.7) / 0.3);
    market = 1.12 + drift + (rand() - 0.5) * 0.03;

    const prices = [];
    for (const origin of config.origins) {
      const base = BASE[origin] ?? BASE.default;
      for (const destination of destinations) {
        const destAdj = DEST_ADJ[destination] ?? DEST_ADJ.default;
        for (const month of config.months) {
          const dim = daysInMonth(month);
          const calendar = {};
          // per-day fares across the month with a mid-month dip
          for (let day = 1; day <= dim; day++) {
            const dd = String(day).padStart(2, "0");
            const midDip = 1 - 0.08 * Math.exp(-((day - 15) ** 2) / 60); // cheapest ~mid month
            const monthAdj = month.endsWith("-03") ? 1.04 : 1.0; // March a touch pricier
            const noise = 0.9 + rand() * 0.25;
            const price = base * market * midDip * monthAdj * destAdj * noise;
            calendar[`${month}-${dd}`] = Math.round(price / 5) * 5;
          }
          let cheapestDate = null;
          let cheapest = Infinity;
          for (const [k, v] of Object.entries(calendar)) {
            if (v < cheapest) {
              cheapest = v;
              cheapestDate = k;
            }
          }
          prices.push({ origin, destination, month, cheapestDate, cheapest, calendar });
        }
      }
    }
    snapshots.push({ date: iso, ts: date.toISOString(), ok: true, prices });
  }

  // Keep full day-by-day calendars only on the latest snapshot (matches the
  // live watcher), so the sample file stays small.
  snapshots.forEach((s, i) => {
    if (i !== snapshots.length - 1) {
      for (const p of s.prices) delete p.calendar;
    }
  });

  const history = {
    meta: {
      currency: config.currency || "EUR",
      unit: "per-adult one-way cheapest fare",
      source: "SAMPLE (generated) — replaced by first live watcher run",
      sample: true,
    },
    config: {
      origins: config.origins,
      destination: destinations[0] || config.destination,
      destinations,
      months: config.months,
      tripType: config.tripType,
      daysAtDestination: config.daysAtDestination,
      travellers: config.travellers,
      marker: config.marker || "",
      email: (config.alerts && config.alerts.email) || { enabled: false, to: [] },
    },
    snapshots,
  };

  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n", "utf8");
  console.log(`Wrote sample ${HISTORY_PATH} (${snapshots.length} snapshots).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
