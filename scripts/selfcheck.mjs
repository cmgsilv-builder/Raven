#!/usr/bin/env node
/**
 * Self-check / regression test (no framework, run with `node scripts/selfcheck.mjs`).
 *
 * Proves the "cheapest day" bug is fixed: a calendar that contains dates
 * OUTSIDE the requested month must never yield an out-of-month cheapest day.
 *
 * This mirrors the real live bug: for AMS->GRU 2027-02 the API returned
 * `2027-06-07: 727` (June — outside the Feb window) and the old code reported
 * it as the cheapest day.
 */
import { filterCalendarToMonth, cheapestOf, inMonth, mergeSnapshotPrices } from "./lib/prices.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

// --- The exact shape that caused the live bug ------------------------------
const liveCalendar = {
  "2026-09-18": 1037,
  "2026-10-30": 824,
  "2026-11-24": 741,
  "2027-01-11": 846,
  "2027-02-14": 812, // the true cheapest IN February
  "2027-02-20": 805, // ...and an even cheaper Feb day
  "2027-04-19": 734,
  "2027-06-07": 727, // global minimum, but OUTSIDE the window
};

const febOnly = filterCalendarToMonth(liveCalendar, "2027-02");
const feb = cheapestOf(febOnly);
check("Feb cheapest is inside February", inMonth(feb.cheapestDate, "2027-02"));
check("Feb cheapest date is 2027-02-20", feb.cheapestDate === "2027-02-20");
check("Feb cheapest price is 805 (not the 727 June global min)", feb.cheapest === 805);
check("out-of-month June date is dropped", !Object.keys(febOnly).includes("2027-06-07"));

// --- A month with NO in-month dates must yield null, not a wrong date ------
const marchOnly = filterCalendarToMonth(liveCalendar, "2027-03");
const march = cheapestOf(marchOnly);
check("March (no in-month fares) yields null date", march.cheapestDate === null);
check("March (no in-month fares) yields null price", march.cheapest === null);

// --- Sanity: a clean in-month calendar still works ------------------------
const clean = { "2027-02-01": 900, "2027-02-15": 700, "2027-02-28": 850 };
const c = cheapestOf(filterCalendarToMonth(clean, "2027-02"));
check("clean calendar picks the real min", c.cheapestDate === "2027-02-15" && c.cheapest === 700);

// --- On-demand merge (the "Search this route" path) ------------------------
// The daily-watched routes (AMS/BRU -> GRU) already in the latest snapshot...
const dailyPrices = [
  { origin: "AMS", destination: "GRU", month: "2027-02", cheapest: 800, calendar: { "2027-02-10": 800 } },
  { origin: "BRU", destination: "GRU", month: "2027-02", cheapest: 825, calendar: { "2027-02-01": 825 } },
];
// ...and an on-demand run that fetched only LIS -> NAT.
const onDemandFresh = [
  { origin: "LIS", destination: "NAT", month: "2027-02", cheapest: 640, calendar: { "2027-02-12": 640 } },
];
const merged = mergeSnapshotPrices(dailyPrices, onDemandFresh);
check("on-demand run keeps the daily-watched routes",
  merged.some((p) => p.origin === "AMS" && p.destination === "GRU") &&
  merged.some((p) => p.origin === "BRU" && p.destination === "GRU"));
check("on-demand run adds the requested route",
  merged.some((p) => p.origin === "LIS" && p.destination === "NAT" && p.cheapest === 640));
check("on-demand merge adds exactly one entry (no clobber)", merged.length === 3);

// Re-searching a route already covered refreshes it, never duplicates it.
const refresh = [{ origin: "AMS", destination: "GRU", month: "2027-02", cheapest: 770, calendar: { "2027-02-11": 770 } }];
const merged2 = mergeSnapshotPrices(dailyPrices, refresh);
check("re-search overwrites the existing route",
  merged2.find((p) => p.origin === "AMS" && p.destination === "GRU").cheapest === 770);
check("re-search does not duplicate the route",
  merged2.filter((p) => p.origin === "AMS" && p.destination === "GRU").length === 1);
check("re-search keeps the other daily route", merged2.some((p) => p.origin === "BRU"));

// Daily path unchanged: first live run / sample reset has no previous snapshot.
const firstRun = mergeSnapshotPrices([], dailyPrices);
check("daily/first run with no history = fresh routes only",
  firstRun.length === 2 && firstRun.every((p) => p.destination === "GRU"));

// Carried-forward entries are deep-cloned (calendar pruning must not mutate them).
const merged3 = mergeSnapshotPrices(dailyPrices, onDemandFresh);
merged3.find((p) => p.origin === "AMS").calendar["2027-02-10"] = 1;
check("carried entries are deep-cloned (no shared refs)", dailyPrices[0].calendar["2027-02-10"] === 800);

console.log("");
if (failures) {
  console.error(`Self-check FAILED (${failures} failing).`);
  process.exit(1);
}
console.log("Self-check passed ✓");
