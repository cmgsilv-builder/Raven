#!/usr/bin/env node
/**
 * Generate a VAPID key pair for Web Push (no npm dependencies).
 *
 * Run locally:  node scripts/gen-vapid.mjs
 *
 * It writes the PUBLIC key into data/push-config.json (safe to commit) and
 * PRINTS the PRIVATE key. Add the private key as the GitHub Actions secret
 * `VAPID_PRIVATE_KEY` — never commit it.
 *
 * VAPID keys are just a P-256 (prime256v1) EC key pair, base64url-encoded:
 *   public  = 0x04 || X || Y   (65 bytes, uncompressed point)
 *   private = d                (32 bytes)
 */
import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUSH_CONFIG_PATH = join(ROOT, "data", "push-config.json");

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => Buffer.from(s, "base64url");

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });

// public: 0x04 || X || Y
const pub = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
const publicKeyB64 = b64url(pub);       // 65 bytes -> 87 chars
const privateKeyB64 = b64url(fromB64url(priv.d)); // 32 bytes -> 43 chars

// Update data/push-config.json with the public key (keep the comment).
let cfg = { publicKey: "" };
try {
  cfg = JSON.parse(await readFile(PUSH_CONFIG_PATH, "utf8"));
} catch { /* create fresh */ }
cfg.publicKey = publicKeyB64;
await writeFile(PUSH_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");

console.log("VAPID keys generated.\n");
console.log("Public key  (written to data/push-config.json — commit this):");
console.log("  " + publicKeyB64 + "\n");
console.log("Private key (add as the GitHub Actions secret VAPID_PRIVATE_KEY — do NOT commit):");
console.log("  " + privateKeyB64 + "\n");
console.log("Also set the secret VAPID_SUBJECT to a contact URL or mailto:, e.g. mailto:you@example.com");
