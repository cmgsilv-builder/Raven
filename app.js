/* Raven PWA — reads the committed price history and gives buy-vs-wait advice.
 * No network calls to any price API: it only fetches ./data/history.json,
 * which the daily GitHub Actions watcher keeps up to date.
 */
(() => {
  "use strict";

  // ---- Config / constants ---------------------------------------------------
  const APP_VERSION = "1.0.0";
  const HISTORY_URL = "./data/history.json";
  const LS_KEY = "raven.trip.v1";

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

  // cheapest per-adult one-way fare in one snapshot for the active origins+window
  function snapshotCheapest(snapshot, origins, months) {
    let best = Infinity;
    let bestEntry = null;
    for (const p of snapshot.prices) {
      if (!origins.includes(p.origin)) continue;
      if (!months.includes(p.month)) continue;
      if (p.cheapest == null) continue;
      if (p.cheapest < best) { best = p.cheapest; bestEntry = p; }
    }
    return bestEntry ? { perAdult: best, entry: bestEntry } : null;
  }

  // series of estimated trip totals over time (only snapshots with data)
  function buildSeries() {
    const origins = activeOrigins();
    const months = monthsInWindow(trip.windowStart, trip.windowEnd);
    const mult = partyMultiplier();
    const series = [];
    if (!history) return { series, origins, months };
    for (const s of history.snapshots) {
      const c = snapshotCheapest(s, origins, months);
      if (!c) continue;
      series.push({
        date: s.date,
        perAdult: c.perAdult,
        total: Math.round(c.perAdult * mult),
        origin: c.entry.origin,
        cheapestDate: c.entry.cheapestDate,
      });
    }
    return { series, origins, months };
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

  function renderAdvice(series) {
    const adv = computeAdvice(series, trip.targetPrice);
    const verdict = $("#adviceVerdict");
    verdict.textContent = adv.verdict;
    verdict.className = "advice-verdict " + adv.cls;
    $("#adviceReason").textContent = adv.reason;

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
      `Estimated total for ${trip.adults} adult${trip.adults > 1 ? "s" : ""}` +
      (trip.lapInfants ? ` + ${trip.lapInfants} lap infant${trip.lapInfants > 1 ? "s" : ""}` : "") +
      `, ${trip.tripType === "round" ? "round-trip" : "one-way"}, in ${cur()}. Based on per-adult fares from Travelpayouts.`;
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
    const mult = partyMultiplier();

    if (!origins.length) {
      wrap.appendChild(el("p", { class: "fine", text: "None of your chosen airports are being watched yet. Add them to data/watch-config.json." }));
      return;
    }

    let renderedAny = false;
    for (const month of months) {
      // cheapest per day across active origins (per-adult -> total)
      const perDay = {};
      for (const p of latest.prices) {
        if (!origins.includes(p.origin) || p.month !== month || !p.calendar) continue;
        for (const [date, price] of Object.entries(p.calendar)) {
          const total = Math.round(price * mult);
          if (perDay[date] == null || total < perDay[date]) perDay[date] = total;
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
      el("span", { text: "Prices shown as estimated total, e.g. 2.4k" }),
    ]);
    wrap.appendChild(legend);
  }

  function renderCompare() {
    const wrap = $("#airportCompare");
    wrap.innerHTML = "";
    if (!history || !history.snapshots.length) return;
    const latest = history.snapshots[history.snapshots.length - 1];
    const months = monthsInWindow(trip.windowStart, trip.windowEnd);
    const mult = partyMultiplier();
    const watched = watchedOrigins();

    // cheapest per origin across window (per-adult) from latest snapshot
    const rows = [];
    for (const origin of watched) {
      let best = Infinity, bestDate = null;
      for (const p of latest.prices) {
        if (p.origin !== origin || !months.includes(p.month) || p.cheapest == null) continue;
        if (p.cheapest < best) { best = p.cheapest; bestDate = p.cheapestDate; }
      }
      rows.push({
        origin,
        perAdult: best === Infinity ? null : best,
        total: best === Infinity ? null : Math.round(best * mult),
        date: bestDate,
        chosen: trip.origins.includes(origin),
      });
    }
    rows.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
    const bestTotal = rows.find((r) => r.total != null)?.total;

    const table = el("table", { class: "cmp-table" });
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", { text: "Airport" }),
      el("th", { text: "Drive*" }),
      el("th", { text: "Cheapest date" }),
      el("th", { text: "Est. total", class: "num", style: "text-align:right" }),
    ])));
    const tbody = el("tbody");
    for (const r of rows) {
      const tr = el("tr");
      if (r.total != null && r.total === bestTotal) tr.classList.add("best");
      const nameCell = el("td");
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

  function renderEstimateNote() {
    $("#estimateNote").textContent =
      "Prices are estimates from Travelpayouts and change constantly. Round-trip is estimated as 2× one-way; a lap infant is estimated at ~10% of an adult fare plus taxes. The exact infant price and final total appear at the airline checkout.";
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
    renderEstimateNote();
  }

  // ---- Trip form ------------------------------------------------------------
  function renderOriginChips() {
    const box = $("#originChips");
    box.innerHTML = "";
    trip.origins.forEach((code) => {
      const chip = el("span", { class: "chip" }, [
        document.createTextNode(code),
        el("button", { type: "button", "aria-label": `Remove ${code}`, text: "×" }),
      ]);
      chip.querySelector("button").addEventListener("click", () => {
        trip.origins = trip.origins.filter((o) => o !== code);
        renderOriginChips();
      });
      box.appendChild(chip);
    });
  }

  function fillForm() {
    $("#destination").value = trip.destination || "";
    $("#adults").value = trip.adults;
    $("#lapInfants").value = trip.lapInfants;
    $("#tripType").value = trip.tripType;
    $("#daysAtDestination").value = trip.daysAtDestination;
    $("#windowStart").value = trip.windowStart;
    $("#windowEnd").value = trip.windowEnd;
    $("#targetPrice").value = trip.targetPrice ?? "";
    renderOriginChips();
    document.querySelectorAll(".cur").forEach((n) => (n.textContent = cur()));
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

    $("#reloadData").addEventListener("click", () => loadHistory(true));
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
  registerSW();
  loadHistory(false);
  console.log(`Raven v${APP_VERSION} ready.`);
})();
