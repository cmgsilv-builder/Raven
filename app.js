/* Raven PWA — reads the committed price history and gives buy-vs-wait advice.
 * No network calls to any price API: it only fetches ./data/history.json,
 * which the daily GitHub Actions watcher keeps up to date.
 */
(() => {
  "use strict";

  // ---- Config / constants ---------------------------------------------------
  const APP_VERSION = "2.0.0";
  const HISTORY_URL = "./data/history.json";
  const PUSH_CONFIG_URL = "./data/push-config.json";
  const BAGGAGE_URL = "./data/baggage.json";
  const LS_KEY = "raven.trip.v1";
  const LS_BOOKMARKS = "raven.bookmarks.v1";

  // Pricing model (documented, rough — see README "Estimates"):
  //  - history stores per-adult ONE-WAY cheapest fare.
  //  - round-trip is estimated as 2x one-way.
  //  - lap infant ~10% of an adult fare (excl. taxes) — estimate only.
  const ROUND_MULT = 2;
  const INFANT_FRACTION = 0.1;

  // Rough driving time to each airport FROM Eindhoven (nice-to-have note).
  const DRIVE_FROM_EIN = {
    EIN: "~10 min",
    AMS: "~1h30",
    BRU: "~1h30",
    DUS: "~1h30",
    RTM: "~1h15",
    CRL: "~1h45",
    CGN: "~1h45",
  };

  // Airport code -> city, so destinations/origins read clearly. Falls back to
  // the raw code for anything not listed.
  const CITY = {
    // Brazil (destinations)
    GRU: "São Paulo", GIG: "Rio de Janeiro", BSB: "Brasília", CNF: "Belo Horizonte",
    SSA: "Salvador", REC: "Recife", FOR: "Fortaleza", POA: "Porto Alegre",
    CWB: "Curitiba", VCP: "Campinas", GYN: "Goiânia", NAT: "Natal",
    // Europe (origins)
    AMS: "Amsterdam", BRU: "Brussels", DUS: "Düsseldorf", EIN: "Eindhoven",
    RTM: "Rotterdam", CRL: "Charleroi", CGN: "Cologne", LIS: "Lisbon",
  };
  const cityName = (code) => CITY[code] || code;
  const cityLabel = (code) => (CITY[code] ? `${CITY[code]} (${code})` : code);

  // ---- Safe localStorage ----------------------------------------------------
  const storage = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, val) {
      try { localStorage.setItem(key, val); return true; } catch { return false; }
    },
  };

  const DEFAULT_TRIP = {
    origins: ["AMS", "BRU", "DUS", "EIN"],
    destination: "GRU",
    adults: 2,
    lapInfants: 1,
    tripType: "round",
    daysAtDestination: 28,
    windowStart: "2027-02",
    windowEnd: "2027-03",
    // Optional day-precision bounds inside the window months. Empty = whole months.
    windowStartDate: "",
    windowEndDate: "",
    // "Any date" mode: ignore the day bounds and use the whole month(s).
    anyDate: false,
    // Prefer baby-friendly flights (direct / no red-eye) where the data allows.
    babyFriendly: false,
    // One preferred departure airport (starred). Drives the advice + is
    // highlighted in Compare airports. Empty = use the cheapest across all.
    preferredOrigin: "",
    // Notification email addresses the user registers in-app (see README for
    // how they reach the daily workflow).
    alertEmails: [],
    targetPrice: null,
  };

  function loadTrip() {
    const raw = storage.get(LS_KEY);
    if (!raw) return { ...DEFAULT_TRIP };
    try {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_TRIP, ...parsed };
    } catch {
      return { ...DEFAULT_TRIP };
    }
  }

  function saveTrip(trip) {
    return storage.set(LS_KEY, JSON.stringify(trip));
  }

  // ---- State ----------------------------------------------------------------
  let trip = loadTrip();
  let history = null;
  let pushConfig = null; // { publicKey } from data/push-config.json (optional)
  let baggage = null;    // data/baggage.json (optional reference data)

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props = {}, kids = []) => {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    });
    (Array.isArray(kids) ? kids : [kids]).forEach((c) => c && node.appendChild(c));
    return node;
  };

  const fmtMoney = (n, cur) =>
    n == null ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency: cur || "EUR", maximumFractionDigits: 0 }).format(n);

  const fmtDate = (iso) => {
    const d = new Date(iso + (iso.length === 10 ? "T00:00:00Z" : ""));
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };

  // ---- Window / pricing helpers --------------------------------------------
  function monthsInWindow(start, end) {
    const out = [];
    if (!start || !end) return out;
    let [sy, sm] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    let guard = 0;
    while ((sy < ey || (sy === ey && sm <= em)) && guard++ < 60) {
      out.push(`${sy}-${String(sm).padStart(2, "0")}`);
      sm++;
      if (sm > 12) { sm = 1; sy++; }
    }
    return out;
  }

  function partyMultiplier() {
    const adults = Math.max(1, Number(trip.adults) || 1);
    const infants = Math.max(0, Number(trip.lapInfants) || 0);
    const legMult = trip.tripType === "round" ? ROUND_MULT : 1;
    // per-adult one-way fare -> whole party, whole trip
    return legMult * (adults + infants * INFANT_FRACTION);
  }

  // watched origins present in the data
  function watchedOrigins() {
    if (!history) return [];
    const set = new Set();
    for (const s of history.snapshots) for (const p of s.prices) set.add(p.origin);
    return [...set];
  }

  // origins the user wants AND that we actually have data for
  function activeOrigins() {
    const watched = new Set(watchedOrigins());
    return trip.origins.filter((o) => watched.has(o));
  }

  // does one origin have any in-window data (latest snapshot, primary dest)?
  function originHasWindowData(origin) {
    if (!history || !history.snapshots.length) return false;
    const latest = history.snapshots[history.snapshots.length - 1];
    const months = monthsInWindow(trip.windowStart, trip.windowEnd);
    const dest = primaryDestination();
    for (const p of latest.prices) {
      if (p.origin !== origin || p.destination !== dest || !months.includes(p.month)) continue;
      if (entryCheapestInWindow(p, months)) return true;
    }
    return false;
  }

  // origins the advice/chart use: just the preferred one when it's set and has
  // data, otherwise the cheapest across all active origins.
  function adviceOrigins() {
    const active = activeOrigins();
    if (trip.preferredOrigin && active.includes(trip.preferredOrigin) && originHasWindowData(trip.preferredOrigin)) {
      return [trip.preferredOrigin];
    }
    return active;
  }

  // destinations present in the data
  function watchedDestinations() {
    if (!history) return [];
    const set = new Set();
    for (const s of history.snapshots) for (const p of s.prices) if (p.destination) set.add(p.destination);
    return [...set];
  }

  // destination the app focuses on for advice/chart/calendar
  function primaryDestination() {
    const watched = watchedDestinations();
    if (trip.destination && watched.includes(trip.destination)) return trip.destination;
    return watched[0] || trip.destination;
  }

  // Is an ISO day inside the user's window? (months + optional day bounds)
  // In "any date" mode the day bounds are ignored (whole month(s)).
  function dayInWindow(dateStr, months) {
    if (typeof dateStr !== "string") return false;
    const ms = months || monthsInWindow(trip.windowStart, trip.windowEnd);
    if (!ms.includes(dateStr.slice(0, 7))) return false;
    if (trip.anyDate) return true;
    if (trip.windowStartDate && dateStr < trip.windowStartDate) return false;
    if (trip.windowEndDate && dateStr > trip.windowEndDate) return false;
    return true;
  }

  // Cheapest in-window { price, date } for one price entry. Prefers the
  // day-by-day calendar so an out-of-window date can never be chosen — this is
  // the app-side half of the "cheapest day" bug fix (defends old snapshots too).
  function entryCheapestInWindow(p, months) {
    if (p.calendar && Object.keys(p.calendar).length) {
      let best = Infinity, bestDate = null;
      for (const [date, price] of Object.entries(p.calendar)) {
        if (price == null || !dayInWindow(date, months)) continue;
        if (price < best) { best = price; bestDate = date; }
      }
      return bestDate ? { price: best, date: bestDate } : null;
    }
    // Older snapshot without a calendar: only trust the stored cheapest when its
    // date is verifiably inside the window; otherwise skip it.
    if (p.cheapest != null && dayInWindow(p.cheapestDate, months)) {
      return { price: p.cheapest, date: p.cheapestDate };
    }
    return null;
  }

  // cheapest per-adult one-way fare in one snapshot for the active origins+window
  function snapshotCheapest(snapshot, origins, months, destination) {
    let best = Infinity;
    let bestEntry = null;
    let bestDate = null;
    for (const p of snapshot.prices) {
      if (!origins.includes(p.origin)) continue;
      if (destination && p.destination !== destination) continue;
      if (!months.includes(p.month)) continue;
      const c = entryCheapestInWindow(p, months);
      if (!c) continue;
      if (c.price < best) { best = c.price; bestEntry = p; bestDate = c.date; }
    }
    return bestEntry ? { perAdult: best, entry: bestEntry, cheapestDate: bestDate } : null;
  }

  // series of estimated trip totals over time (only snapshots with data)
  function buildSeries() {
    const origins = adviceOrigins();
    const months = monthsInWindow(trip.windowStart, trip.windowEnd);
    const destination = primaryDestination();
    const mult = partyMultiplier();
    const series = [];
    if (!history) return { series, origins, months, destination };
    for (const s of history.snapshots) {
      const c = snapshotCheapest(s, origins, months, destination);
      if (!c) continue;
      series.push({
        date: s.date,
        perAdult: c.perAdult,
        total: Math.round(c.perAdult * mult),
        origin: c.entry.origin,
        cheapestDate: c.cheapestDate,
      });
    }
    return { series, origins, months, destination };
  }

  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  /**
   * Buy-vs-wait rules (transparent — same logic documented in the README):
   *  Let current = latest total, recentMin/median over the series,
   *  and trend = avg(last 7) vs avg(prior 7).
   *  1. current <= target                -> BUY (at/below target)
   *  2. within 2% of recent low & not rising -> BUY (near recent low)
   *  3. trend rising > 3%                 -> BUY SOON (prices climbing)
   *  4. current > 5% above median & falling -> WAIT (pricey, dropping)
   *  5. otherwise                         -> WAIT (no urgency)
   */
  function computeAdvice(series, target) {
    if (!series.length) {
      return { verdict: "No data yet", cls: "wait", reason: "The watcher hasn't collected prices for this trip yet." };
    }
    const totals = series.map((p) => p.total);
    const current = totals[totals.length - 1];
    const recentMin = Math.min(...totals);
    const med = median(totals);
    const last7 = totals.slice(-7);
    const prior7 = totals.slice(-14, -7);
    const a1 = avg(last7);
    const a0 = avg(prior7.length ? prior7 : last7);
    const trendPct = a0 ? ((a1 - a0) / a0) * 100 : 0;

    let verdict, cls, reason;
    if (target != null && current <= target) {
      verdict = "BUY NOW";
      cls = "buy";
      reason = `Cheapest estimate ${fmtMoney(current, cur())} is at or below your target ${fmtMoney(target, cur())}.`;
    } else if (current <= recentMin * 1.02 && trendPct <= 1) {
      verdict = "BUY NOW";
      cls = "buy";
      reason = `Price is near its recent low (${fmtMoney(recentMin, cur())}) and not rising.`;
    } else if (trendPct > 3) {
      verdict = "BUY SOON";
      cls = "soon";
      reason = `Prices have climbed ${trendPct.toFixed(0)}% over the last week — likely to keep rising.`;
    } else if (med != null && current > med * 1.05 && trendPct < 0) {
      verdict = "WAIT";
      cls = "wait";
      reason = `Currently ${Math.round(((current - med) / med) * 100)}% above the typical ${fmtMoney(med, cur())}, and falling.`;
    } else {
      verdict = "WAIT";
      cls = "wait";
      reason = `No urgency — price is around typical (${fmtMoney(med, cur())}). Keep watching.`;
    }
    return { verdict, cls, reason, current, recentMin, med, trendPct };
  }

  const cur = () => (history && history.meta && history.meta.currency) || "EUR";

  // ---- Rendering ------------------------------------------------------------
  function renderDataStamp() {
    const stamp = $("#dataStamp");
    if (!history || !history.snapshots.length) { stamp.textContent = ""; return; }
    const last = history.snapshots[history.snapshots.length - 1];
    const sample = history.meta && history.meta.sample;
    stamp.textContent = `${sample ? "Sample data · " : "Updated "}${fmtDate(last.date)}`;
  }

  function renderSampleBanner() {
    const main = $(".app-main");
    const existing = $("#sampleBanner");
    const isSample = history && history.meta && history.meta.sample;
    if (isSample && !existing) {
      const b = el("div", {
        id: "sampleBanner",
        class: "sample-banner",
        text: "Showing sample data. The daily watcher replaces this with real fares once your Travelpayouts token is set (see README).",
      });
      main.insertBefore(b, main.firstChild);
    } else if (!isSample && existing) {
      existing.remove();
    }
  }

  // One-line "what's being priced" summary (party · trip · destination · taxes).
  // Carrier is shown only when the underlying data actually carries it.
  function pricingSummary(series) {
    const adults = Math.max(1, Number(trip.adults) || 1);
    const infants = Math.max(0, Number(trip.lapInfants) || 0);
    const who = `${adults} adult${adults > 1 ? "s" : ""}` +
      (infants ? ` + ${infants} lap infant${infants > 1 ? "s" : ""}` : "");
    const parts = [who, trip.tripType === "round" ? "round-trip" : "one-way", `to ${cityLabel(primaryDestination())}`];
    const last = series && series.length ? series[series.length - 1] : null;
    if (last && last.origin) parts.push(`from ${last.origin}`);
    if (last && last.carrier) parts.push(`cheapest via ${last.carrier}`);
    parts.push("total incl. taxes (estimate)");
    return parts.join(" · ");
  }

  function renderAdvice(series) {
    const adv = computeAdvice(series, trip.targetPrice);
    const verdict = $("#adviceVerdict");
    verdict.textContent = adv.verdict;
    verdict.className = "advice-verdict " + adv.cls;
    $("#adviceReason").textContent = adv.reason;
    const sum = $("#adviceSummary");
    if (sum) sum.textContent = pricingSummary(series);

    const stats = $("#adviceStats");
    stats.innerHTML = "";
    if (series.length) {
      const rows = [
        ["Cheapest now", fmtMoney(adv.current, cur())],
        ["Recent low", fmtMoney(adv.recentMin, cur())],
        ["Typical", fmtMoney(adv.med, cur())],
      ];
      for (const [lbl, val] of rows) {
        stats.appendChild(el("div", { class: "stat" }, [
          el("div", { class: "val", text: val }),
          el("div", { class: "lbl", text: lbl }),
        ]));
      }
    }
  }

  function renderAlert(series) {
    const card = $("#alertCard");
    if (trip.targetPrice == null || !series.length) {
      card.classList.add("hidden");
      return;
    }
    const current = series[series.length - 1].total;
    const hit = current <= trip.targetPrice;
    card.classList.remove("hidden");
    card.classList.toggle("hit", hit);
    card.classList.toggle("miss", !hit);
    card.innerHTML = "";
    if (hit) {
      card.appendChild(el("p", { class: "alert-title", text: `🎯 Target hit! ${fmtMoney(current, cur())} ≤ ${fmtMoney(trip.targetPrice, cur())}` }));
      card.appendChild(el("p", { class: "alert-sub", text: "The estimated cheapest total is at or below your target." }));
    } else {
      const diff = current - trip.targetPrice;
      card.appendChild(el("p", { class: "alert-title", text: `Target ${fmtMoney(trip.targetPrice, cur())} — not yet` }));
      card.appendChild(el("p", { class: "alert-sub", text: `Cheapest now is ${fmtMoney(current, cur())}, ${fmtMoney(diff, cur())} above target.` }));
    }
  }

  function renderChart(series) {
    const wrap = $("#chartWrap");
    wrap.innerHTML = "";
    $("#chartRange").textContent = series.length ? `${series.length} days` : "";
    if (series.length < 2) {
      wrap.appendChild(el("p", { class: "fine", text: "Not enough data points yet to draw a trend. Come back after a few daily runs." }));
      return;
    }

    const W = 700, H = 260, padL = 52, padR = 16, padT = 16, padB = 30;
    const totals = series.map((p) => p.total);
    const target = trip.targetPrice;
    let min = Math.min(...totals);
    let max = Math.max(...totals);
    if (target != null) { min = Math.min(min, target); max = Math.max(max, target); }
    const range = max - min || 1;
    min = Math.floor((min - range * 0.1) / 10) * 10;
    max = Math.ceil((max + range * 0.1) / 10) * 10;

    const x = (i) => padL + (i / (series.length - 1)) * (W - padL - padR);
    const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Price history line chart");

    const add = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.appendChild(n);
      return n;
    };

    // gridlines + y labels
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const v = min + ((max - min) * t) / ticks;
      const yy = y(v);
      add("line", { x1: padL, y1: yy, x2: W - padR, y2: yy, stroke: "#322f66", "stroke-width": 1 });
      const lbl = add("text", { x: padL - 8, y: yy + 4, "text-anchor": "end", fill: "#7c79b0", "font-size": 11 });
      lbl.textContent = fmtMoney(Math.round(v), cur());
    }

    // target line
    if (target != null && target >= min && target <= max) {
      add("line", { x1: padL, y1: y(target), x2: W - padR, y2: y(target), stroke: "#34d399", "stroke-width": 1.5, "stroke-dasharray": "6 4" });
      const t = add("text", { x: W - padR, y: y(target) - 6, "text-anchor": "end", fill: "#34d399", "font-size": 11 });
      t.textContent = `target ${fmtMoney(target, cur())}`;
    }

    // area + line
    const linePts = series.map((p, i) => `${x(i)},${y(p.total)}`).join(" ");
    const areaPts = `${padL},${H - padB} ${linePts} ${x(series.length - 1)},${H - padB}`;
    add("polygon", { points: areaPts, fill: "rgba(99,102,241,0.15)" });
    add("polyline", { points: linePts, fill: "none", stroke: "#a5b4fc", "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" });

    // last point marker
    const lastX = x(series.length - 1), lastY = y(totals[totals.length - 1]);
    add("circle", { cx: lastX, cy: lastY, r: 4.5, fill: "#facc15" });

    // x labels (first, middle, last)
    [0, Math.floor((series.length - 1) / 2), series.length - 1].forEach((i) => {
      const t = add("text", { x: x(i), y: H - 8, "text-anchor": i === 0 ? "start" : i === series.length - 1 ? "end" : "middle", fill: "#7c79b0", "font-size": 11 });
      t.textContent = fmtDate(series[i].date);
    });

    wrap.appendChild(svg);

    $("#unitNote").textContent =
      `Estimated total (incl. taxes) for ${trip.adults} adult${trip.adults > 1 ? "s" : ""}` +
      (trip.lapInfants ? ` + ${trip.lapInfants} lap infant${trip.lapInfants > 1 ? "s" : ""}` : "") +
      `, ${trip.tripType === "round" ? "round-trip" : "one-way"}, in ${cur()}. Based on fares from Travelpayouts, which already include taxes.`;
  }

  function daysInMonth(month) {
    const [y, m] = month.split("-").map(Number);
    return new Date(y, m, 0).getDate();
  }
  function dowOfFirst(month) {
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun
  }

  function renderCalendar() {
    const wrap = $("#calendarWrap");
    wrap.innerHTML = "";
    if (!history || !history.snapshots.length) return;
    const latest = history.snapshots[history.snapshots.length - 1];
    const origins = activeOrigins();
    const months = monthsInWindow(trip.windowStart, trip.windowEnd);
    const destination = primaryDestination();
    const mult = partyMultiplier();

    if (!origins.length) {
      wrap.appendChild(el("p", { class: "fine", text: "None of your chosen airports are being watched yet. Add them to data/watch-config.json." }));
      return;
    }

    let renderedAny = false;
    for (const month of months) {
      // cheapest per day across active origins for the primary destination.
      // Only in-month, in-window days count (the app-side cheapest-day fix).
      const perDay = {};       // date -> total
      const perDayOrigin = {}; // date -> origin giving that cheapest
      for (const p of latest.prices) {
        if (!origins.includes(p.origin) || p.destination !== destination || p.month !== month || !p.calendar) continue;
        for (const [date, price] of Object.entries(p.calendar)) {
          if (date.slice(0, 7) !== month || !dayInWindow(date, months)) continue;
          const total = Math.round(price * mult);
          if (perDay[date] == null || total < perDay[date]) { perDay[date] = total; perDayOrigin[date] = p.origin; }
        }
      }
      const entries = Object.entries(perDay);
      if (!entries.length) continue;
      renderedAny = true;

      const prices = entries.map(([, v]) => v);
      const lo = Math.min(...prices);
      const hi = Math.max(...prices);
      const cheapThresh = lo + (hi - lo) * 0.15;
      const priceyThresh = lo + (hi - lo) * 0.7;
      let cheapestDate = null;
      for (const [d, v] of entries) if (v === lo) { cheapestDate = d; break; }

      const box = el("div", { class: "cal-month" });
      const [yy, mm] = month.split("-").map(Number);
      const label = new Date(Date.UTC(yy, mm - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
      box.appendChild(el("h3", { text: `${label} — cheapest ${fmtMoney(lo, cur())} on ${fmtDate(cheapestDate)}` }));

      // Actions for the cheapest day: deep-link to book + bookmark the fare.
      const cheapestOrigin = perDayOrigin[cheapestDate];
      const acts = el("div", { class: "cal-actions" });
      acts.appendChild(el("a", {
        class: "btn-small btn-book",
        href: aviasalesUrl({ origin: cheapestOrigin, destination, departDate: cheapestDate }),
        target: "_blank", rel: "noopener noreferrer",
        text: `Book ${cheapestOrigin}→${destination} ↗`,
      }));
      const bmBtn = el("button", { type: "button", class: "btn-small", text: "☆ Bookmark" });
      bmBtn.addEventListener("click", () => addBookmark({
        origin: cheapestOrigin, destination, date: cheapestDate, total: lo,
      }));
      acts.appendChild(bmBtn);
      box.appendChild(acts);

      const grid = el("div", { class: "cal-grid" });
      ["S", "M", "T", "W", "T", "F", "S"].forEach((d) => grid.appendChild(el("div", { class: "cal-dow", text: d })));
      const startDow = dowOfFirst(month);
      for (let i = 0; i < startDow; i++) grid.appendChild(el("div", { class: "cal-cell empty" }));

      const dim = daysInMonth(month);
      for (let day = 1; day <= dim; day++) {
        const dd = String(day).padStart(2, "0");
        const key = `${month}-${dd}`;
        const v = perDay[key];
        const cell = el("div", { class: "cal-cell" });
        if (v == null) {
          cell.classList.add("empty");
        } else {
          if (key === cheapestDate) cell.classList.add("cheapest");
          else if (v <= cheapThresh) cell.classList.add("cheap");
          else if (v >= priceyThresh) cell.classList.add("pricey");
          cell.appendChild(el("div", { class: "d", text: String(day) }));
          cell.appendChild(el("div", { class: "p", text: (v / 1000).toFixed(1) + "k" }));
        }
        grid.appendChild(cell);
      }
      box.appendChild(grid);
      wrap.appendChild(box);
    }

    if (!renderedAny) {
      wrap.appendChild(el("p", { class: "fine", text: "No day-by-day calendar in the latest snapshot yet." }));
      return;
    }

    const legend = el("div", { class: "cal-legend" }, [
      el("span", { html: '<i class="swatch" style="background:#059669;border-color:#34d399"></i> cheapest day' }),
      el("span", { html: '<i class="swatch" style="background:#1b1940;border-color:#34d399"></i> cheap' }),
      el("span", { html: '<i class="swatch" style="background:#1b1940"></i> pricier' }),
      el("span", { text: "Prices shown as estimated total incl. taxes, e.g. 2.4k" }),
    ]);
    wrap.appendChild(legend);
  }

  function renderCompare() {
    const wrap = $("#airportCompare");
    wrap.innerHTML = "";
    if (!history || !history.snapshots.length) return;
    const latest = history.snapshots[history.snapshots.length - 1];
    const months = monthsInWindow(trip.windowStart, trip.windowEnd);
    const destination = primaryDestination();
    const mult = partyMultiplier();
    const watched = watchedOrigins();

    // cheapest per origin across window (per-adult) from latest snapshot,
    // for the primary destination, restricted to in-window dates.
    const rows = [];
    for (const origin of watched) {
      let best = Infinity, bestDate = null;
      for (const p of latest.prices) {
        if (p.origin !== origin || p.destination !== destination || !months.includes(p.month)) continue;
        const c = entryCheapestInWindow(p, months);
        if (!c) continue;
        if (c.price < best) { best = c.price; bestDate = c.date; }
      }
      rows.push({
        origin,
        perAdult: best === Infinity ? null : best,
        total: best === Infinity ? null : Math.round(best * mult),
        date: bestDate,
        chosen: trip.origins.includes(origin),
        preferred: origin === trip.preferredOrigin,
      });
    }
    rows.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
    const bestTotal = rows.find((r) => r.total != null)?.total;

    const table = el("table", { class: "cmp-table" });
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", { text: "Airport" }),
      el("th", { text: "Drive*" }),
      el("th", { text: "Cheapest date" }),
      el("th", { text: "Total incl. tax", class: "num", style: "text-align:right" }),
    ])));
    const tbody = el("tbody");
    for (const r of rows) {
      const tr = el("tr");
      if (r.total != null && r.total === bestTotal) tr.classList.add("best");
      if (r.preferred) tr.classList.add("preferred");
      const nameCell = el("td");
      if (r.preferred) nameCell.appendChild(el("span", { class: "star", text: "★ " }));
      nameCell.appendChild(document.createTextNode(r.origin));
      if (r.chosen) nameCell.appendChild(el("span", { class: "cmp-badge", text: "yours" }));
      tr.appendChild(nameCell);
      tr.appendChild(el("td", { text: DRIVE_FROM_EIN[r.origin] || "—" }));
      tr.appendChild(el("td", { text: r.date ? fmtDate(r.date) : "—" }));
      tr.appendChild(el("td", { class: "num", text: r.total != null ? fmtMoney(r.total, cur()) : "no data" }));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.appendChild(el("p", { class: "cmp-note", text: "* Rough driving time from Eindhoven — for planning only." }));
  }

  // ---- Deep-link to book ----------------------------------------------------
  // Builds an Aviasales search URL for a specific fare. The affiliate marker is
  // read from the committed config (never hardcoded); omitted if not set.
  function aviasalesUrl({ origin, destination, departDate }) {
    if (!origin || !destination || !departDate) return "https://www.aviasales.com/";
    const ddmm = (iso) => {
      const [, m, d] = iso.split("-");
      return `${d}${m}`;
    };
    let path = `${origin}${ddmm(departDate)}${destination}`;
    if (trip.tripType === "round") {
      const back = new Date(departDate + "T00:00:00Z");
      back.setUTCDate(back.getUTCDate() + (Number(trip.daysAtDestination) || 28));
      path += ddmm(back.toISOString().slice(0, 10));
    }
    const adults = Math.max(1, Number(trip.adults) || 1);
    const infants = Math.max(0, Number(trip.lapInfants) || 0);
    // Aviasales passenger suffix: adults[children][infants]
    path += infants ? `${adults}0${infants}` : `${adults}`;

    const params = [];
    const marker = (history && history.config && history.config.marker) || "";
    if (marker) params.push(`marker=${encodeURIComponent(marker)}`);
    let url = `https://www.aviasales.com/search/${path}`;
    if (params.length) url += `?${params.join("&")}`;
    return url;
  }

  // ---- Price-freeze / bookmarks --------------------------------------------
  function loadBookmarks() {
    const raw = storage.get(LS_BOOKMARKS);
    if (!raw) return [];
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  function saveBookmarks(list) { return storage.set(LS_BOOKMARKS, JSON.stringify(list)); }

  function addBookmark({ origin, destination, date, total }) {
    const list = loadBookmarks();
    list.unshift({
      origin, destination, date, total,
      currency: cur(),
      savedAt: new Date().toISOString(),
    });
    if (list.length > 20) list.length = 20;
    saveBookmarks(list);
    renderBookmarks();
    toast(`Bookmarked ${fmtMoney(total, cur())} · ${origin}→${destination} ${fmtDate(date)}`);
  }

  function removeBookmark(idx) {
    const list = loadBookmarks();
    list.splice(idx, 1);
    saveBookmarks(list);
    renderBookmarks();
  }

  // Current cheapest total for a saved bookmark's route+date, from latest data.
  function currentTotalFor(origin, destination, date) {
    if (!history || !history.snapshots.length) return null;
    const latest = history.snapshots[history.snapshots.length - 1];
    const mult = partyMultiplier();
    for (const p of latest.prices) {
      if (p.origin !== origin || p.destination !== destination || !p.calendar) continue;
      const price = p.calendar[date];
      if (price != null) return Math.round(price * mult);
    }
    return null;
  }

  function renderBookmarks() {
    const wrap = $("#bookmarksWrap");
    if (!wrap) return;
    wrap.innerHTML = "";
    const list = loadBookmarks();
    if (!list.length) {
      wrap.appendChild(el("p", { class: "fine", text: "No saved fares yet. Tap “☆ Bookmark” on a cheapest day to freeze a price and compare it later." }));
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const now = currentTotalFor(b.origin, b.destination, b.date);
      const row = el("div", { class: "bm-row" });
      const info = el("div", { class: "bm-info" }, [
        el("div", { class: "bm-route", text: `${b.origin} → ${b.destination} · ${fmtDate(b.date)}` }),
        el("div", { class: "bm-meta", text: `Saved ${fmtMoney(b.total, b.currency)} on ${fmtDate(b.savedAt.slice(0, 10))}` }),
      ]);
      let deltaNode;
      if (now == null) {
        deltaNode = el("div", { class: "bm-delta flat", text: "no current price" });
      } else {
        const diff = now - b.total;
        const cls = diff < 0 ? "down" : diff > 0 ? "up" : "flat";
        const sign = diff > 0 ? "+" : "";
        deltaNode = el("div", { class: "bm-delta " + cls, text: `now ${fmtMoney(now, cur())} (${sign}${fmtMoney(diff, cur())})` });
      }
      const del = el("button", { type: "button", class: "bm-del", "aria-label": "Remove bookmark", text: "×" });
      del.addEventListener("click", () => removeBookmark(i));
      row.appendChild(info);
      row.appendChild(deltaNode);
      row.appendChild(del);
      wrap.appendChild(row);
    }
  }

  // ---- Compare destinations -------------------------------------------------
  function renderDestinationCompare() {
    const card = $("#destCompareCard");
    const wrap = $("#destCompare");
    if (!card || !wrap) return;
    wrap.innerHTML = "";
    const dests = watchedDestinations();
    if (!history || !history.snapshots.length || dests.length < 2) {
      // Only meaningful when more than one destination is watched.
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");

    const latest = history.snapshots[history.snapshots.length - 1];
    const origins = activeOrigins();
    const months = monthsInWindow(trip.windowStart, trip.windowEnd);
    const mult = partyMultiplier();

    const rows = [];
    for (const dest of dests) {
      let best = Infinity, bestDate = null, bestOrigin = null;
      for (const p of latest.prices) {
        if (p.destination !== dest || !origins.includes(p.origin) || !months.includes(p.month)) continue;
        const c = entryCheapestInWindow(p, months);
        if (!c) continue;
        if (c.price < best) { best = c.price; bestDate = c.date; bestOrigin = p.origin; }
      }
      rows.push({
        dest,
        total: best === Infinity ? null : Math.round(best * mult),
        date: bestDate,
        origin: bestOrigin,
        primary: dest === primaryDestination(),
      });
    }
    rows.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
    const bestTotal = rows.find((r) => r.total != null)?.total;

    const table = el("table", { class: "cmp-table" });
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", { text: "To" }),
      el("th", { text: "Best from" }),
      el("th", { text: "Cheapest date" }),
      el("th", { text: "Total incl. tax", style: "text-align:right" }),
    ])));
    const tbody = el("tbody");
    for (const r of rows) {
      const tr = el("tr");
      if (r.total != null && r.total === bestTotal) tr.classList.add("best");
      const nameCell = el("td");
      nameCell.appendChild(document.createTextNode(cityLabel(r.dest)));
      if (r.primary) nameCell.appendChild(el("span", { class: "cmp-badge", text: "shown" }));
      tr.appendChild(nameCell);
      tr.appendChild(el("td", { text: r.origin || "—" }));
      tr.appendChild(el("td", { text: r.date ? fmtDate(r.date) : "—" }));
      tr.appendChild(el("td", { class: "num", text: r.total != null ? fmtMoney(r.total, cur()) : "no data" }));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.appendChild(el("p", { class: "cmp-note", text: "Pick which destination the app shows in “Your trip”. Add more in data/watch-config.json." }));
  }

  // ---- Baggage reference panel ---------------------------------------------
  function renderBaggage() {
    const wrap = $("#baggageWrap");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!baggage || !Array.isArray(baggage.airlines) || !baggage.airlines.length) {
      wrap.appendChild(el("p", { class: "fine", text: "Baggage reference not loaded." }));
      return;
    }
    for (const a of baggage.airlines) {
      const item = el("details", { class: "bag-item" });
      item.appendChild(el("summary", { text: a.airline }));
      const dl = el("div", { class: "bag-body" });
      const add = (lbl, val) => { if (val) dl.appendChild(el("p", { html: `<b>${lbl}:</b> ${val}` })); };
      add("Carry-on", a.carryOn);
      add("Checked (economy)", a.checkedEconomy);
      add("Infant (lap)", a.infant);
      add("Notes", a.notes);
      item.appendChild(dl);
      wrap.appendChild(item);
    }
    const upd = baggage.updated ? ` Last edited ${baggage.updated}.` : "";
    wrap.appendChild(el("p", { class: "fine", text: `Reference only — airlines change rules often. Always verify on the airline's site and at check-in.${upd}` }));
  }

  // ---- Notifications status (push + email) ----------------------------------
  function renderNotify() {
    const pushStat = $("#pushStatus");
    const emailStat = $("#emailStatus");
    const subBtn = $("#pushSubscribe");
    if (!pushStat || !subBtn) return;

    const configured = pushConfig && pushConfig.publicKey;
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

    if (!supported) {
      pushStat.textContent = "This browser/device can't do web push. On iPhone, install Raven to the Home Screen first (iOS 16.4+).";
      subBtn.classList.add("hidden");
    } else if (!configured) {
      pushStat.textContent = "Push not set up yet. The owner runs scripts/gen-vapid.mjs and adds the keys (see README).";
      subBtn.classList.add("hidden");
    } else {
      subBtn.classList.remove("hidden");
      subBtn.textContent = Notification.permission === "granted" ? "Re-subscribe / copy subscription" : "Turn on push alerts";
      pushStat.textContent = "Daily check: if your target price is hit, Raven pushes an alert — even with the app closed. iPhone needs Raven installed to the Home Screen (iOS 16.4+).";
    }

    if (emailStat) {
      const cfg = (history && history.config && history.config.email) || null;
      const to = cfg && cfg.to;
      const list = Array.isArray(to) ? to : (to ? [to] : []);
      if (cfg && cfg.enabled && list.length) {
        emailStat.textContent = `Email alerts ON → ${list.join(", ")}. Sent by the daily workflow when your target is hit.`;
      } else {
        emailStat.textContent = "Email alerts off. Add address(es) below, then enable alerts.email in data/watch-config.json and add SMTP secrets (see README).";
      }
    }
  }

  function urlB64ToUint8Array(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function subscribePush() {
    try {
      if (!(pushConfig && pushConfig.publicKey)) { toast("Push not configured"); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Notifications not allowed"); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(pushConfig.publicKey),
      });
      showSubscription(JSON.stringify(sub));
    } catch (err) {
      console.error("Push subscribe failed:", err);
      toast("Could not subscribe to push");
    }
  }

  function showSubscription(json) {
    const box = $("#pushSubBox");
    const ta = $("#pushSubJson");
    if (!box || !ta) return;
    ta.value = json;
    box.classList.remove("hidden");
    ta.focus();
    ta.select();
  }

  function renderEstimateNote() {
    $("#estimateNote").textContent =
      "Prices are estimates from Travelpayouts and change constantly. Fares from Travelpayouts already include taxes, so every total shown includes taxes (estimate). Round-trip is estimated as 2× one-way; a lap infant is estimated at ~10% of an adult fare. The exact infant price and final total appear at the airline checkout.";
  }

  function renderAll() {
    const { series } = buildSeries();
    renderDataStamp();
    renderSampleBanner();
    renderAdvice(series);
    renderAlert(series);
    renderChart(series);
    renderCalendar();
    renderCompare();
    renderDestinationCompare();
    renderBookmarks();
    renderNotify();
    renderEstimateNote();
  }

  // ---- Trip form ------------------------------------------------------------
  function renderOriginChips() {
    const box = $("#originChips");
    box.innerHTML = "";
    trip.origins.forEach((code) => {
      const isPref = trip.preferredOrigin === code;
      const chip = el("span", { class: "chip" + (isPref ? " preferred" : "") });
      const star = el("button", {
        type: "button", class: "chip-star",
        "aria-label": isPref ? `${code} is your preferred airport` : `Set ${code} as preferred`,
        title: isPref ? "Preferred airport" : "Set as preferred",
        text: isPref ? "★" : "☆",
      });
      star.addEventListener("click", () => {
        trip.preferredOrigin = isPref ? "" : code;
        saveTrip(trip);
        renderOriginChips();
        renderAll();
      });
      const rm = el("button", { type: "button", class: "chip-rm", "aria-label": `Remove ${code}`, text: "×" });
      rm.addEventListener("click", () => {
        trip.origins = trip.origins.filter((o) => o !== code);
        if (trip.preferredOrigin === code) trip.preferredOrigin = "";
        renderOriginChips();
      });
      chip.appendChild(star);
      chip.appendChild(document.createTextNode(code));
      chip.appendChild(rm);
      box.appendChild(chip);
    });
  }

  // Live "To: São Paulo (GRU)" readout so the destination is unmistakable.
  function renderDestReadout() {
    const node = $("#destReadout");
    if (!node) return;
    const code = ($("#destination").value || "").trim().toUpperCase().slice(0, 3);
    node.textContent = code ? `To: ${cityLabel(code)}` : "";
  }

  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  // Notification email list (item 5). Stored in the browser; the user copies it
  // into data/watch-config.json alerts.email.to for the workflow to send to.
  function renderEmailChips() {
    const box = $("#emailChips");
    if (!box) return;
    box.innerHTML = "";
    (trip.alertEmails || []).forEach((addr) => {
      const chip = el("span", { class: "chip email-chip" });
      chip.appendChild(document.createTextNode(addr));
      const rm = el("button", { type: "button", class: "chip-rm", "aria-label": `Remove ${addr}`, text: "×" });
      rm.addEventListener("click", () => {
        trip.alertEmails = trip.alertEmails.filter((e) => e !== addr);
        saveTrip(trip);
        renderEmailChips();
      });
      chip.appendChild(rm);
      box.appendChild(chip);
    });
  }

  function addEmailFromInput() {
    const inp = $("#newEmail");
    const addr = (inp.value || "").trim().toLowerCase();
    if (!addr) return;
    if (!isEmail(addr)) { toast("That doesn't look like an email"); return; }
    if (!Array.isArray(trip.alertEmails)) trip.alertEmails = [];
    if (!trip.alertEmails.includes(addr)) {
      trip.alertEmails.push(addr);
      saveTrip(trip);
      renderEmailChips();
    }
    inp.value = "";
    inp.focus();
  }

  function copyEmailsForConfig() {
    const json = JSON.stringify(trip.alertEmails || []);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(json).then(() => toast("Copied — paste into alerts.email.to"), () => toast("Copy failed"));
    } else {
      toast(json);
    }
  }

  function fillForm() {
    $("#destination").value = trip.destination || "";
    $("#adults").value = trip.adults;
    $("#lapInfants").value = trip.lapInfants;
    $("#tripType").value = trip.tripType;
    $("#daysAtDestination").value = trip.daysAtDestination;
    $("#windowStart").value = trip.windowStart;
    $("#windowEnd").value = trip.windowEnd;
    $("#windowStartDate").value = trip.windowStartDate || "";
    $("#windowEndDate").value = trip.windowEndDate || "";
    $("#anyDate").checked = !!trip.anyDate;
    $("#babyFriendly").checked = !!trip.babyFriendly;
    $("#targetPrice").value = trip.targetPrice ?? "";
    updateAnyDateUI();
    renderOriginChips();
    renderDestReadout();
    renderEmailChips();
    document.querySelectorAll(".cur").forEach((n) => (n.textContent = cur()));
  }

  // Grey out the day-precision bounds while "any date" mode is on.
  function updateAnyDateUI() {
    const on = $("#anyDate").checked;
    ["#windowStartDate", "#windowEndDate"].forEach((sel) => {
      const inp = $(sel);
      if (inp) { inp.disabled = on; inp.closest(".field")?.classList.toggle("disabled", on); }
    });
  }

  function readForm() {
    const num = (id, min, max, dflt) => {
      let v = Number($(id).value);
      if (!Number.isFinite(v)) v = dflt;
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      return v;
    };
    trip.destination = ($("#destination").value || "").trim().toUpperCase().slice(0, 3);
    trip.adults = num("#adults", 1, 9, 2);
    trip.lapInfants = num("#lapInfants", 0, 4, 0);
    trip.tripType = $("#tripType").value;
    trip.daysAtDestination = num("#daysAtDestination", 1, 120, 28);
    trip.windowStart = $("#windowStart").value || DEFAULT_TRIP.windowStart;
    trip.windowEnd = $("#windowEnd").value || DEFAULT_TRIP.windowEnd;
    if (trip.windowEnd < trip.windowStart) trip.windowEnd = trip.windowStart;
    trip.windowStartDate = $("#windowStartDate").value || "";
    trip.windowEndDate = $("#windowEndDate").value || "";
    if (trip.windowStartDate && trip.windowEndDate && trip.windowEndDate < trip.windowStartDate) {
      trip.windowEndDate = trip.windowStartDate;
    }
    trip.anyDate = $("#anyDate").checked;
    trip.babyFriendly = $("#babyFriendly").checked;
    const tp = $("#targetPrice").value;
    trip.targetPrice = tp === "" ? null : Math.max(0, Number(tp) || 0);
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  function wireForm() {
    $("#addOrigin").addEventListener("click", () => {
      const inp = $("#newOrigin");
      const code = (inp.value || "").trim().toUpperCase().slice(0, 3);
      if (code && !trip.origins.includes(code)) {
        trip.origins.push(code);
        renderOriginChips();
      }
      inp.value = "";
      inp.focus();
    });
    $("#newOrigin").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("#addOrigin").click(); }
    });

    $("#tripForm").addEventListener("submit", (e) => {
      e.preventDefault();
      readForm();
      const ok = saveTrip(trip);
      $("#saveStamp").textContent = ok ? "Saved ✓" : "Saved (this session only)";
      setTimeout(() => ($("#saveStamp").textContent = ""), 2500);
      renderAll();
      if (trip.destination && history && history.config && history.config.destination &&
          trip.destination !== history.config.destination) {
        toast(`Heads up: the watcher tracks ${history.config.destination}, not ${trip.destination}.`);
      }
    });

    $("#toggleTrip").addEventListener("click", () => {
      const form = $("#tripForm");
      const hidden = form.classList.toggle("hidden");
      $("#toggleTrip").textContent = hidden ? "Edit" : "Hide";
      $("#toggleTrip").setAttribute("aria-expanded", String(!hidden));
    });

    $("#anyDate").addEventListener("change", updateAnyDateUI);
    $("#destination").addEventListener("input", renderDestReadout);

    $("#reloadData").addEventListener("click", () => loadHistory(true));
  }

  function wireNotify() {
    const subBtn = $("#pushSubscribe");
    if (subBtn) subBtn.addEventListener("click", subscribePush);
    const addEmail = $("#addEmail");
    if (addEmail) addEmail.addEventListener("click", addEmailFromInput);
    const newEmail = $("#newEmail");
    if (newEmail) newEmail.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addEmailFromInput(); }
    });
    const emailCopy = $("#emailCopy");
    if (emailCopy) emailCopy.addEventListener("click", copyEmailsForConfig);
    const copyBtn = $("#pushCopy");
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      const ta = $("#pushSubJson");
      try {
        await navigator.clipboard.writeText(ta.value);
        toast("Subscription copied");
      } catch {
        ta.focus(); ta.select();
        toast("Select-all + copy the text");
      }
    });
  }

  // ---- Data load ------------------------------------------------------------
  async function loadHistory(force) {
    try {
      const url = force ? `${HISTORY_URL}?t=${Date.now()}` : HISTORY_URL;
      const res = await fetch(url, { cache: force ? "reload" : "default" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      history = await res.json();
      if (!history.snapshots) history.snapshots = [];
      fillForm();
      renderAll();
      if (force) toast("Data refreshed");
    } catch (err) {
      console.error("Failed to load history:", err);
      if (!history) {
        $("#adviceVerdict").textContent = "Data unavailable";
        $("#adviceVerdict").className = "advice-verdict wait";
        $("#adviceReason").textContent = "Could not load price history. If offline, connect once so it can cache.";
      } else {
        toast("Could not refresh (offline?)");
      }
    }
  }

  // Optional side-data: push public key + baggage reference. Both are optional;
  // the app renders fine without them.
  async function loadExtras() {
    try {
      const res = await fetch(PUSH_CONFIG_URL, { cache: "default" });
      if (res.ok) pushConfig = await res.json();
    } catch { /* push simply stays "not set up" */ }
    try {
      const res = await fetch(BAGGAGE_URL, { cache: "default" });
      if (res.ok) baggage = await res.json();
    } catch { /* baggage panel shows "not loaded" */ }
    renderNotify();
    renderBaggage();
  }

  // ---- Service worker -------------------------------------------------------
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW register failed:", e));
    });
  }

  // ---- Boot -----------------------------------------------------------------
  fillForm();
  wireForm();
  wireNotify();
  renderBookmarks();
  registerSW();
  loadHistory(false);
  loadExtras();
  console.log(`Raven v${APP_VERSION} ready.`);
})();
