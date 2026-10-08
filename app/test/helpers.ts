import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
export const SEED_DIR = join(ROOT, "data", "seed");
export const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
export const seedJson = <T>(name: string): T => readJson<T>(join(SEED_DIR, name));
