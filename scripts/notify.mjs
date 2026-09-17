#!/usr/bin/env node
/**
 * Raven alert sender — runs in the daily workflow AFTER fetch-prices.mjs.
 *
 * Reads the latest snapshot in data/history.json, finds the cheapest in-window
 * estimated TOTAL (party + round-trip), and if it is at or below the target in
 * data/watch-config.json, sends:
 *   - Web Push (to subscriptions) using VAPID keys, and/or
 *   - Email (via SMTP), depending on watch-config `alerts`.
 *
 * All senders degrade gracefully: missing keys/subscriptions/SMTP => skipped,
 * never a hard failure. A small data/alert-state.json prevents re-alerting the
 * same (or higher) price every day.
 *
 * Secrets (GitHub Actions), none committed:
 *   VAPID_PRIVATE_KEY, VAPID_SUBJECT            (push)
 *   PUSH_SUBSCRIPTIONS                          (push, JSON array of subscriptions)
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM   (email)
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filterCalendarToMonth } from "./lib/prices.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "data", "watch-config.json");
const HISTORY_PATH = join(ROOT, "data", "history.json");
const PUSH_CONFIG_PATH = join(ROOT, "data", "push-config.json");
const SUBS_PATH = join(ROOT, "data", "push-subscriptions.json");
const STATE_PATH = join(ROOT, "data", "alert-state.json");

async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

const ROUND_MULT = 2;
const INFANT_FRACTION = 0.1;

function partyMultiplier(config) {
  const adults = Math.max(1, Number(config.travellers?.adults) || 1);
  const infants = Math.max(0, Number(config.travellers?.lapInfants) || 0);
  const legMult = config.tripType === "round" ? ROUND_MULT : 1;
  return legMult * (adults + infants * INFANT_FRACTION);
}

function inDayBounds(date, alerts) {
  if (alerts?.windowStartDate && date < alerts.windowStartDate) return false;
  if (alerts?.windowEndDate && date > alerts.windowEndDate) return false;
  return true;
}

// Cheapest in-window { origin, destination, date, perAdult, total } or null.
function cheapestInWindow(config, history) {
  const snap = history.snapshots?.[history.snapshots.length - 1];
  if (!snap) return null;
  const alerts = config.alerts || {};
  const mult = partyMultiplier(config);
  let best = null;
  for (const p of snap.prices) {
    if (!p.calendar) continue;
    if (!config.months.includes(p.month)) continue;
    const inMonth = filterCalendarToMonth(p.calendar, p.month);
    for (const [date, price] of Object.entries(inMonth)) {
      if (price == null || !inDayBounds(date, alerts)) continue;
      if (!best || price < best.perAdult) {
        best = { origin: p.origin, destination: p.destination, date, perAdult: price, total: Math.round(price * mult) };
      }
    }
  }
  return best;
}

function siteUrl() {
  const repo = process.env.GITHUB_REPOSITORY; // "owner/name"
  if (repo && repo.includes("/")) {
    const [owner, name] = repo.split("/");
    return `https://${owner}.github.io/${name}/`;
  }
  return "./index.html";
}

async function sendPush(payload) {
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:raven@example.com";
  if (!priv) { console.log("Push: no VAPID_PRIVATE_KEY — skipping."); return; }
  const pushCfg = await loadJson(PUSH_CONFIG_PATH, {});
  if (!pushCfg.publicKey) { console.log("Push: no public key in push-config.json — skipping."); return; }

  // Subscriptions from the PUSH_SUBSCRIPTIONS secret (JSON) and/or a committed file.
  let subs = [];
  if (process.env.PUSH_SUBSCRIPTIONS) {
    try {
      const parsed = JSON.parse(process.env.PUSH_SUBSCRIPTIONS);
      subs = subs.concat(Array.isArray(parsed) ? parsed : [parsed]);
    } catch { console.error("Push: PUSH_SUBSCRIPTIONS is not valid JSON."); }
  }
  const fileSubs = await loadJson(SUBS_PATH, null);
  if (Array.isArray(fileSubs)) subs = subs.concat(fileSubs);
  if (!subs.length) { console.log("Push: no subscriptions — skipping."); return; }

  let webpush;
  try { webpush = (await import("web-push")).default; }
  catch { console.error("Push: web-push not installed — skipping."); return; }

  webpush.setVapidDetails(subject, pushCfg.publicKey, priv);
  let ok = 0;
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); ok++; }
    catch (e) { console.error(`Push: send failed (${e.statusCode || e.message}).`); }
  }
  console.log(`Push: sent to ${ok}/${subs.length} subscription(s).`);
}

async function sendEmail(config, subjectLine, text, html) {
  const email = config.alerts?.email || {};
  if (!email.enabled || !email.to) { console.log("Email: disabled or no recipient — skipping."); return; }
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) { console.log("Email: SMTP_HOST/USER/PASS not set — skipping."); return; }

  let nodemailer;
  try { nodemailer = (await import("nodemailer")).default; }
  catch { console.error("Email: nodemailer not installed — skipping."); return; }

  const port = Number(process.env.SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host, port, secure: port === 465, auth: { user, pass },
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || user,
    to: email.to,
    subject: subjectLine,
    text, html,
  });
  console.log(`Email: sent to ${email.to}.`);
}

async function main() {
  const config = await loadJson(CONFIG_PATH, null);
  const history = await loadJson(HISTORY_PATH, null);
  if (!config || !history) { console.log("notify: missing config or history — nothing to do."); return; }

  const target = config.alerts?.targetPrice;
  if (target == null) { console.log("notify: no alerts.targetPrice set — alerts disabled."); return; }

  const best = cheapestInWindow(config, history);
  const state = await loadJson(STATE_PATH, { belowTarget: false, lastNotifiedTotal: null, lastNotifiedDate: null });

  if (!best) { console.log("notify: no in-window fares yet."); await writeState({ ...state, belowTarget: false }); return; }

  const cur = history.meta?.currency || config.currency || "EUR";
  console.log(`notify: cheapest in-window ${best.total} ${cur} (${best.origin}->${best.destination} ${best.date}), target ${target}.`);

  const hit = best.total <= target;
  if (!hit) { await writeState({ ...state, belowTarget: false }); console.log("notify: target not hit."); return; }

  // Dedupe: only alert on a fresh crossing or a meaningfully lower price.
  const fresh = !state.belowTarget || state.lastNotifiedTotal == null || best.total < Math.floor(state.lastNotifiedTotal * 0.99);
  if (!fresh) { console.log("notify: already alerted at this price — skipping send."); return; }

  const money = `${best.total} ${cur}`;
  const targetMoney = `${target} ${cur}`;
  const title = "🐦‍⬛ Raven — target price hit!";
  const body = `${money} for ${best.origin}→${best.destination} on ${best.date} (target ${targetMoney}).`;
  const url = siteUrl();
  const payload = { title, body, url, tag: "raven-price-alert" };

  const html = `<p><b>${body}</b></p><p><a href="${url}">Open Raven</a> to see the trend and book.</p>` +
    `<p style="color:#888;font-size:12px">Estimate: round-trip = 2× one-way; lap infant ~10%. Final total at checkout.</p>`;

  await sendPush(payload);
  await sendEmail(config, title, body + "\n\nOpen Raven: " + url, html);

  await writeState({ belowTarget: true, lastNotifiedTotal: best.total, lastNotifiedDate: history.snapshots[history.snapshots.length - 1].date });
}

async function writeState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

main().catch((err) => { console.error(err); process.exit(0); }); // never fail the workflow over alerts
