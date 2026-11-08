/**
 * Server-side Solana wiring.
 *
 * One place builds the RPC client, the escrow SDK instance, and the two
 * privileged signers. The seller and arbiter keys come from the environment, or
 * from a local key file so a restart does not orphan escrows that are still
 * open against a previous address.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Aesdr } from "@aesdr/sdk";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  getBase58Decoder,
  getBase58Encoder,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";

import { rpcUrl } from "./config";

let rpcSingleton: Rpc<SolanaRpcApi> | undefined;

/** Shared RPC client. Created once per server process. */
export function rpc(): Rpc<SolanaRpcApi> {
  rpcSingleton ??= createSolanaRpc(rpcUrl());
  return rpcSingleton;
}

/** Shared escrow SDK instance, pointed at the deployed program. */
export function aesdr(): Aesdr {
  return new Aesdr({ rpc: rpc() });
}

const signerCache = new Map<string, Promise<KeyPairSigner>>();

/**
 * Load a role's signer.
 *
 * Precedence is explicit: an env var wins, otherwise a local key file, and only
 * if neither exists is one generated.
 *
 * An existing key file is **never** overwritten. That is deliberate: the seller
 * and arbiter addresses are baked into every escrow opened against them, so
 * silently replacing a key would make the whole history of sessions unreadable
 * and permanently unsettleable. To rotate on purpose, delete the file (or use
 * `npm run keys:reset`) rather than expecting a rerun to do it.
 */
export function roleSigner(role: "seller" | "arbiter"): Promise<KeyPairSigner> {
  const cached = signerCache.get(role);
  if (cached) return cached;

  const loaded = loadSigner(role);
  signerCache.set(role, loaded);
  return loaded;
}

async function loadSigner(role: "seller" | "arbiter"): Promise<KeyPairSigner> {
  const envVar = role === "seller" ? "SELLER_SECRET_KEY" : "ARBITER_SECRET_KEY";
  const fromEnv = process.env[envVar]?.trim();

  // A 64-byte secret key is the familiar Solana keypair file format; a 32-byte
  // value is a raw seed. Accept both so either style of env var works.
  if (fromEnv) {
    const bytes = getBase58Encoder().encode(fromEnv);
    return bytes.length === 32
      ? createKeyPairSignerFromPrivateKeyBytes(bytes)
      : createKeyPairSignerFromBytes(bytes);
  }

  const dir = join(process.cwd(), ".keys");
  const file = join(dir, `${role}.json`);

  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      secretKey: string;
    };
    return createKeyPairSignerFromPrivateKeyBytes(
      getBase58Encoder().encode(saved.secretKey)
    );
  }

  // Dev fallback: 32 random bytes saved beside the app, so restarts keep the
  // same address. Clearly local-only rather than silently ephemeral.
  const seed = randomBytes(32);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    file,
    JSON.stringify(
      {
        note: "local development only, never commit",
        address: signer.address,
        secretKey: getBase58Decoder().decode(seed),
      },
      null,
      2
    ),
    // `wx` fails instead of truncating if the file appeared between the
    // existence check and this write, which can happen if two requests race on
    // a cold start. Failing loudly beats two workers disagreeing about who the
    // seller is.
    { flag: "wx", mode: 0o600 }
  );

  console.warn(
    `[aesdr] generated a local ${role} key at ${file}; fund it before use`
  );
  return signer;
}
