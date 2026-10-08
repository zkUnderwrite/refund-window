// Keys by alias. On testnet: REFUNDWIN_SECRET_<ALIAS> from the environment,
// else the `stellar keys` store (`stellar keys secret <alias>`). On local-sim:
// a deterministic, clearly synthetic keypair derived from the alias.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

export function simKeypair(alias: string): Keypair {
  return Keypair.fromRawEd25519Seed(createHash("sha256").update(`refund-window/local-sim/${alias}`).digest());
}

export function resolveKeypair(alias: string, network: "testnet" | "local-sim", env: Record<string, string | undefined>): Keypair {
  if (StrKey.isValidEd25519SecretSeed(alias)) return Keypair.fromSecret(alias);
  if (network === "local-sim") return simKeypair(alias);
  const envKey = env[`REFUNDWIN_SECRET_${alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (envKey) return Keypair.fromSecret(envKey);
  try {
    const out = execFileSync("stellar", ["keys", "secret", alias], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return Keypair.fromSecret(out);
  } catch (e) {
    throw new Error(`no key for alias "${alias}": set REFUNDWIN_SECRET_${alias.toUpperCase()} or run \`stellar keys generate ${alias} --fund\` (${(e as Error).message.split("\n")[0]})`);
  }
}

/** An address flag: a G…/C… strkey, or an alias resolved to its public key. */
export function resolveAddress(v: string, network: "testnet" | "local-sim", env: Record<string, string | undefined>): string {
  if (StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v)) return v;
  return resolveKeypair(v, network, env).publicKey();
}
