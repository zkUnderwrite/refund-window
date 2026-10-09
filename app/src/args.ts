// Command-line parsing for `refundwin`. Small and strict: unknown flags are
// errors, boolean flags never take a value, value flags always need one.

import { parseAmount } from "./amount.ts";
import { parseDuration } from "./duration.ts";

export const BOOLEAN_FLAGS = new Set(["all", "yes", "json", "once", "due", "help", "dry-run"]);

export interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

export class ArgError extends Error {}

/** Parses raw command line arguments into positional arguments and flags. */
export function parseArgv(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).trim();
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new ArgError(`bad flag "${a}"`);
      if (flags.has(name)) throw new ArgError(`--${name} given twice`);
      if (BOOLEAN_FLAGS.has(name)) {
        if (eq >= 0) throw new ArgError(`--${name} does not take a value`);
        flags.set(name, true);
      } else if (eq >= 0) {
        flags.set(name, a.slice(eq + 1));
      } else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new ArgError(`--${name} needs a value`);
        flags.set(name, v);
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** Accessor that tracks which flags were read, so leftovers can be rejected. */
export class Flags {
  private readonly used = new Set<string>();
  private readonly p: Parsed;
  constructor(p: Parsed) {
    this.p = p;
  }

  str(name: string): string | undefined {
    this.used.add(name);
    const v = this.p.flags.get(name);
    if (v === true) throw new ArgError(`--${name} needs a value`);
    return v;
  }
  req(name: string): string {
    const v = this.str(name);
    if (v === undefined || v.trim() === "") throw new ArgError(`--${name} is required`);
    return v;
  }
  bool(name: string): boolean {
    this.used.add(name);
    return this.p.flags.get(name) === true;
  }
  duration(name: string): number | undefined {
    const v = this.str(name);
    return v === undefined ? undefined : parseDuration(v);
  }
  int(name: string): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) throw new ArgError(`--${name} must be a non-negative integer`);
    return Number(v);
  }
  list(name: string): string[] {
    const v = this.str(name);
    return v === undefined ? [] : v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  /** Rejects flags that no handler read. */
  done(): void {
    const extra = [...this.p.flags.keys()].filter((k) => !this.used.has(k) && k !== "network");
    if (extra.length) throw new ArgError(`unknown flag(s): ${extra.map((e) => `--${e}`).join(", ")}`);
  }
}

/** `--amount X` or `--all`, exactly one. */
export function amountOrAll(f: Flags): { all: true } | { all: false; amount: bigint } {
  const all = f.bool("all");
  const amount = f.str("amount");
  if (all && amount !== undefined) throw new ArgError("use either --amount or --all, not both");
  if (!all && amount === undefined) throw new ArgError("give --amount <x> or --all");
  if (all) return { all: true };
  const v = parseAmount(amount!);
  if (v <= 0n) throw new ArgError("--amount must be positive");
  return { all: false, amount: v };
}

/** `--ref X` or `--due`, exactly one. */
export function refOrDue(f: Flags): { due: true } | { due: false; ref: string } {
  const due = f.bool("due");
  const ref = f.str("ref");
  if (due && ref !== undefined) throw new ArgError("use either --ref or --due, not both");
  if (!due && ref === undefined) throw new ArgError("give --ref <order ref> or --due");
  return due ? { due: true } : { due: false, ref: ref! };
}

/** Parses asset flags like USDC or USDC:G... */
export function parseAssetFlag(v: string): { code: string; issuer?: string } {
  const m = /^([A-Za-z0-9]{1,12})(?::(G[A-Z2-7]{55}))?$/.exec(v.trim());
  if (!m) throw new ArgError(`bad --asset "${v}" (use CODE or CODE:G…ISSUER)`);
  return { code: m[1]!.toUpperCase(), ...(m[2] ? { issuer: m[2] } : {}) };
}

/** Parses the network argument, defaulting to local-sim if unspecified. */
export function parseNetwork(v: string | undefined): "testnet" | "local-sim" {
  const n = v ?? process.env.REFUNDWIN_NETWORK ?? "local-sim";
  if (n !== "testnet" && n !== "local-sim") throw new ArgError(`--network must be testnet or local-sim, got "${n}"`);
  return n;
}
