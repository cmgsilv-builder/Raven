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
