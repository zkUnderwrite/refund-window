// Durations on the command line: 90s, 30m, 1h, 3d, 14d, 2w (or plain seconds).
const UNITS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 };

/** Parses duration strings like 1h, 30m into seconds. */
export function parseDuration(input: string): number {
  const s = input.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(\d+)(s|m|h|d|w)$/.exec(s);
  if (!m) throw new Error(`invalid duration "${input}" (examples: 90m, 1h, 3d, 14d)`);
  const v = Number(m[1]) * UNITS[m[2]!]!;
  if (!Number.isSafeInteger(v)) throw new Error(`duration "${input}" is too large`);
  return v;
}

export function formatDuration(secs: number): string {
  for (const [u, n] of [["w", 604_800], ["d", 86_400], ["h", 3_600], ["m", 60]] as const) {
    if (secs >= n && secs % n === 0) return `${secs / n}${u}`;
  }
  return `${secs}s`;
}

/** Converts unix seconds to ISO UTC string. */
export function isoUtc(unixSecs: number): string {
  return new Date(unixSecs * 1000).toISOString().replace(".000Z", "Z");
}

/** "2026-09-15 14:23 (-06:00)" in a fixed-offset timezone like "-06:00". */
export function localTime(unixSecs: number, offset: string): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`invalid UTC offset "${offset}"`);
  const sign = m[1] === "-" ? -1 : 1;
  const shift = sign * (Number(m[2]) * 3600 + Number(m[3]) * 60);
  const d = new Date((unixSecs + shift) * 1000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} (${offset})`;
}
