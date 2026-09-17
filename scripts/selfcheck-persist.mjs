#!/usr/bin/env node
/**
 * Persistence + commit regression test (no framework, run with
 * `node scripts/selfcheck-persist.mjs`).
 *
 * Guards the on-demand "Search this route" bug: a dispatched run that fetched
 * new fares MUST end up committed to data/history.json, so the app's poll sees a
 * newer snapshot and stops spinning. Two independent failures caused the hang:
 *
 *  1. The WRITE path — fetch-prices.mjs must actually persist the merged
 *     snapshot (daily routes kept + the searched route added) to disk.
 *  2. The COMMIT step — the workflow staged `git add data/history.json
 *     data/alert-state.json` in ONE command. When alert-state.json doesn't
 *     exist yet (alerts disabled), git aborts the whole add and stages NOTHING,
 *     so the genuinely-changed history.json was never committed. The fix stages
 *     each path on its own `git add`.
 *
 * This test exercises the real write path (via env path overrides + a mocked
 * fetch) and the real staging pattern (via a throwaway git repo).
 */
import { readFile, writeFile, mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok  - ${name}`);
  else { console.error(`  FAIL - ${name}`); failures++; }
}

// The seed the daily cron leaves behind: one snapshot, the watched GRU routes.
function seedHistory(today) {
  return {
    meta: { currency: "EUR", unit: "per-adult one-way cheapest fare", source: "travelpayouts-v1-calendar", sample: false },
    config: {},
    snapshots: [{
      date: today, ts: today + "T06:17:00.000Z", ok: true,
      prices: [
        { origin: "AMS", destination: "GRU", month: "2027-02", cheapestDate: "2027-02-10", cheapest: 800, calendar: { "2027-02-10": 800 } },
        { origin: "AMS", destination: "GRU", month: "2027-03", cheapestDate: "2027-03-05", cheapest: 780, calendar: { "2027-03-05": 780 } },
        { origin: "BRU", destination: "GRU", month: "2027-02", cheapestDate: "2027-02-01", cheapest: 825, calendar: { "2027-02-01": 825 } },
        { origin: "BRU", destination: "GRU", month: "2027-03", cheapestDate: "2027-03-02", cheapest: 815, calendar: { "2027-03-02": 815 } },
      ],
    }],
  };
}

// ---- Part 1: the WRITE path (fetch-prices.mjs on-demand) -------------------
async function testWritePath() {
  const today = new Date().toISOString().slice(0, 10);
  const dir = await mkdtemp(join(tmpdir(), "raven-persist-"));
  try {
    const histPath = join(dir, "history.json");
    const cfgPath = join(dir, "watch-config.json");
    await writeFile(histPath, JSON.stringify(seedHistory(today), null, 2) + "\n", "utf8");
    // Reuse the real watch-config so origins/months/marker resolve as in prod.
    await cp(join(ROOT, "data", "watch-config.json"), cfgPath);
    const before = await readFile(histPath, "utf8");

    // Point fetch-prices at the throwaway copy and run it as an on-demand search,
    // mirroring the captain's LIS/AMS -> NAT run: only LIS->NAT March has a fare.
    process.env.RAVEN_HISTORY_PATH = histPath;
    process.env.RAVEN_CONFIG_PATH = cfgPath;
    process.env.RAVEN_ORIGINS = "LIS,AMS";
    process.env.RAVEN_DESTINATIONS = "NAT";
    process.env.RAVEN_MONTHS = "2027-02,2027-03";
    process.env.TRAVELPAYOUTS_TOKEN = "test-token";

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      const origin = u.searchParams.get("origin");
      const month = u.searchParams.get("depart_date");
      let data = {};
      if (origin === "LIS" && month === "2027-03") {
        data = { "2027-03-14": { price: 979 }, "2027-04-02": { price: 800 } }; // + an out-of-month leak
      }
      return { ok: true, json: async () => ({ success: true, data }) };
    };

    try {
      const { main } = await import("./fetch-prices.mjs");
      await main();
    } finally {
      globalThis.fetch = realFetch;
    }

    const after = await readFile(histPath, "utf8");
    const parsed = JSON.parse(after);
    const latest = parsed.snapshots[parsed.snapshots.length - 1];
    const routes = latest.prices;
    const lisNat = routes.find((p) => p.origin === "LIS" && p.destination === "NAT" && p.month === "2027-03");

    check("on-demand run CHANGES history.json on disk", before !== after);
    check("searched route (LIS->NAT 2027-03) is persisted at 979", lisNat && lisNat.cheapest === 979);
    check("searched route cheapest day is in-month (not the April leak)", lisNat && lisNat.cheapestDate === "2027-03-14");
    check("daily-watched routes are kept (AMS/BRU -> GRU)",
      routes.some((p) => p.origin === "AMS" && p.destination === "GRU") &&
      routes.some((p) => p.origin === "BRU" && p.destination === "GRU"));
    check("partial no-fare routes still persist (as empty, not dropped)",
      routes.some((p) => p.origin === "AMS" && p.destination === "NAT"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.RAVEN_HISTORY_PATH;
    delete process.env.RAVEN_CONFIG_PATH;
    delete process.env.RAVEN_ORIGINS;
    delete process.env.RAVEN_DESTINATIONS;
    delete process.env.RAVEN_MONTHS;
    delete process.env.TRAVELPAYOUTS_TOKEN;
  }
}

// ---- Part 2: the COMMIT staging pattern ------------------------------------
// The root cause of the hang. Prove the fixed pattern stages the changed
// history.json even when the second (alert-state.json) path doesn't exist.
async function testCommitStaging() {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
  const dir = await mkdtemp(join(tmpdir(), "raven-git-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    await writeFile(join(dir, "history.json"), "v1\n");
    git(dir, "add", "history.json");
    git(dir, "commit", "-qm", "init");
    await writeFile(join(dir, "history.json"), "v2-changed\n"); // a real snapshot change

    const staged = (cwd) => {
      try { git(cwd, "diff", "--cached", "--quiet"); return false; } // exit 0 => nothing staged
      catch { return true; } // non-zero => something staged
    };

    // OLD (buggy) pattern: one add with a missing second path stages nothing.
    const buggy = await mkdtemp(join(tmpdir(), "raven-git-old-"));
    git(buggy, "init", "-q");
    git(buggy, "config", "user.email", "t@example.com");
    git(buggy, "config", "user.name", "t");
    await writeFile(join(buggy, "history.json"), "v1\n");
    git(buggy, "add", "history.json");
    git(buggy, "commit", "-qm", "init");
    await writeFile(join(buggy, "history.json"), "v2-changed\n");
    try { execFileSync("git", ["add", "history.json", "alert-state.json"], { cwd: buggy, stdio: "ignore" }); }
    catch { /* the missing path aborts the add — exactly the bug */ }
    check("OLD single `git add a b` (b missing) stages NOTHING (the bug)", staged(buggy) === false);
    await rm(buggy, { recursive: true, force: true });

    // NEW (fixed) pattern: independent adds keep history.json staged.
    git(dir, "add", "history.json");
    try { execFileSync("git", ["add", "alert-state.json"], { cwd: dir, stdio: "ignore" }); } catch { /* missing: fine */ }
    check("NEW independent adds stage the changed history.json", staged(dir) === true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await testWritePath();
await testCommitStaging();

console.log("");
if (failures) {
  console.error(`Persistence self-check FAILED (${failures} failing).`);
  process.exit(1);
}
console.log("Persistence self-check passed ✓");
