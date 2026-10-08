// Environment: `.env` in the working directory or the project root (no
// dependency), then process.env wins. Every variable is listed in .env.example.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDuration } from "./duration.ts";

/** The project root: the nearest ancestor holding data/seed. */
export function projectRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, "data", "seed", "psp.json"))) return d;
    d = resolve(d, "..");
  }
  throw new Error("cannot find the project root (data/seed/psp.json)");
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

export function loadEnv(cwd = process.cwd()): Record<string, string | undefined> {
  const files = [join(cwd, ".env")];
  try {
    files.push(join(projectRoot(), ".env"));
  } catch {
    // no project root: only cwd
  }
  const merged: Record<string, string | undefined> = {};
  for (const f of files.reverse()) if (existsSync(f)) Object.assign(merged, parseDotEnv(readFileSync(f, "utf8")));
  return { ...merged, ...process.env };
}

export interface AppConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId?: string;
  minWindow: number;
  maxWindow: number;
  arbiterLang: string;
  keeperInterval: number;
}

export const TESTNET = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

export function appConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    rpcUrl: env.STELLAR_RPC_URL ?? TESTNET.rpcUrl,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET.networkPassphrase,
    ...(env.REFUNDWIN_CONTRACT ? { contractId: env.REFUNDWIN_CONTRACT } : {}),
    minWindow: parseDuration(env.MIN_WINDOW ?? "1h"),
    maxWindow: parseDuration(env.MAX_WINDOW ?? "60d"),
    arbiterLang: env.ARBITER_LANG ?? "en",
    keeperInterval: parseDuration(env.KEEPER_INTERVAL ?? "10m"),
  };
}
