/**
 * Pure price helpers shared by the watcher (fetch-prices.mjs) and the
 * self-check (selfcheck.mjs). No I/O, no network — easy to unit-test.
 *
 * The bug these guard against: the Travelpayouts calendar response includes
 * cheap fares for dates OUTSIDE the requested month. The cheapest fare/day for
 * a watched month must be chosen ONLY from dates inside that month.
 */

/** True if an ISO date "YYYY-MM-DD" falls inside the given month "YYYY-MM". */
export function inMonth(dateStr, month) {
  return typeof dateStr === "string" && typeof month === "string" && dateStr.slice(0, 7) === month;
}

/** Keep only the calendar entries whose date is inside `month`. */
export function filterCalendarToMonth(calendar, month) {
  const out = {};
  for (const [date, price] of Object.entries(calendar || {})) {
    if (inMonth(date, month)) out[date] = price;
  }
  return out;
}

/**
 * Cheapest fare + its date within a calendar map { "YYYY-MM-DD": price }.
 * Assumes the calendar has already been narrowed to the dates you care about
 * (e.g. via filterCalendarToMonth). Returns nulls when empty.
 */
export function cheapestOf(calendar) {
  let bestDate = null;
  let best = Infinity;
  for (const [date, price] of Object.entries(calendar || {})) {
    if (price != null && price < best) {
      best = price;
      bestDate = date;
    }
  }
  return bestDate ? { cheapestDate: bestDate, cheapest: best } : { cheapestDate: null, cheapest: null };
}

/**
 * Stable identity of one price entry: origin|destination|month.
 */
export function priceKey(p) {
  return `${p.origin}|${p.destination}|${p.month}`;
}

/**
 * Merge freshly-fetched price entries over a previous snapshot's prices.
 *
 * Fresh entries OVERWRITE any previous entry with the same origin|destination|month
 * (so re-fetching a route refreshes it, never duplicates it). Previous entries for
 * routes NOT in the fresh set are carried forward — deep-cloned so the result never
 * shares object references with the old snapshot (calendar pruning of older
 * snapshots must not mutate the new one).
 *
 * This is the same merge for both watcher paths:
 *  - daily run: fresh = all watch-config routes → refreshes them, keeps any ad-hoc
 *    on-demand routes fetched earlier.
 *  - on-demand run: fresh = just the requested routes → refreshes/adds them, keeps
 *    the daily-watched routes.
 * With no previous snapshot (first live run / sample reset) it returns fresh as-is.
 */
export function mergeSnapshotPrices(prevPrices, freshPrices) {
  const fresh = freshPrices || [];
  const freshKeys = new Set(fresh.map(priceKey));
  const carried = (prevPrices || [])
    .filter((p) => !freshKeys.has(priceKey(p)))
    .map((p) => JSON.parse(JSON.stringify(p)));
  return [...fresh, ...carried];
}
