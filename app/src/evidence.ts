// Evidence manifests. Statements and files stay off-chain; the chain stores
// one 32-byte hash per side: sha256 over the sorted manifest lines
// "<sha256 of file>  <name>\n". Any party holding the files can recompute it.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sha256Hex } from "./orderid.ts";

export type EvidenceKind = "tracking" | "photo" | "chat" | "listing" | "access_log" | "invoice" | "statement" | "other";

export interface Extracted {
  carrier?: string;
  trackingNo?: string;
  status?: string;
  /** ISO-8601 UTC */
  statusAt?: string;
  deliveryAddressMatches?: boolean;
  lastLoginAt?: string | null;
}

export interface EvidenceItem {
  name: string;
  kind: EvidenceKind;
  sha256: string;
  note?: string;
  /** ISO-8601 UTC, when the party submitted it (off-chain) */
  submittedAt?: string;
  extracted?: Extracted;
}

export function manifestLines(items: Pick<EvidenceItem, "name" | "sha256">[]): string {
  return [...items]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((i) => `${i.sha256}  ${i.name}\n`)
    .join("");
}

export function manifestHash(items: Pick<EvidenceItem, "name" | "sha256">[]): string {
  if (items.length === 0) throw new Error("an evidence manifest needs at least one item");
  return sha256Hex(manifestLines(items));
}

/** Hashes local files into manifest items (kind guessed from the name). */
export function hashFiles(paths: string[]): EvidenceItem[] {
  return paths.map((p) => ({
    name: basename(p),
    kind: guessKind(p),
    sha256: sha256Hex(readFileSync(p)),
  }));
}

export function guessKind(name: string): EvidenceKind {
  const n = name.toLowerCase();
  if (/statement|declaracion|declaração/.test(n)) return "statement";
  if (/track|carrier|shipping|guia/.test(n)) return "tracking";
  if (/\.(jpe?g|png|heic|webp)$/.test(n)) return "photo";
  if (/chat|whatsapp|messages?/.test(n)) return "chat";
  if (/listing|product-page/.test(n)) return "listing";
  if (/access|login|download/.test(n)) return "access_log";
  if (/invoice|factura|receipt/.test(n)) return "invoice";
  return "other";
}

// ---------------------------------------------------------------------------
// Carrier status CSVs arrive with inconsistent date formats. Mexican carriers
// print dd/mm/yyyy; exports from the merchant's shop print yyyy-mm-dd.
// ---------------------------------------------------------------------------

export interface CarrierRow {
  trackingNo: string;
  carrier: string;
  status: string;
  /** ISO-8601 UTC */
  at: string;
  location: string;
}

export function parseCarrierDate(date: string, time = "00:00"): string {
  const d = date.trim();
  let y: number, mo: number, da: number;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (m) {
    [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d))) {
    // dd/mm/yyyy (carrier locale)
    [da, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    throw new Error(`unrecognised carrier date "${date}"`);
  }
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!t) throw new Error(`unrecognised carrier time "${time}"`);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) throw new Error(`invalid carrier date "${date}"`);
  const iso = new Date(Date.UTC(y, mo - 1, da, Number(t[1]), Number(t[2]))).toISOString();
  return iso.replace(".000Z", "Z");
}

/** Parses "tracking_no,carrier,status,date,time,location" rows (header required). */
export function parseCarrierCsv(text: string): CarrierRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines.shift()?.toLowerCase().split(",").map((h) => h.trim()) ?? [];
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`carrier CSV is missing column "${name}"`);
    return i;
  };
  const [ci, cc, cs, cd, ct, cl] = ["tracking_no", "carrier", "status", "date", "time", "location"].map(col) as number[];
  return lines.map((l) => {
    const f = l.split(",").map((x) => x.trim());
    return {
      trackingNo: f[ci!]!,
      carrier: f[cc!]!,
      status: f[cs!]!.toLowerCase(),
      at: parseCarrierDate(f[cd!]!, f[ct!] || "00:00"),
      location: f[cl!] ?? "",
    };
  });
}

/** The latest carrier status, as `extracted` fields for a tracking item. */
export function latestStatus(rows: CarrierRow[]): Extracted {
  if (rows.length === 0) return {};
  const last = [...rows].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!;
  return { carrier: last.carrier, trackingNo: last.trackingNo, status: last.status, statusAt: last.at };
}
