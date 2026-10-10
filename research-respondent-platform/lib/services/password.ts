/**
 * Password hashing and session tokens.
 *
 * Uses Node's built-in scrypt so the platform needs no native crypto dependency.
 * Parameters are stored per user record so they can be strengthened later
 * without invalidating existing credentials.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export interface PasswordHash {
  hash: string;
  salt: string;
  params: string;
}

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

const DEFAULT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): PasswordHash {
  if (password.length < 10) {
    throw new Error("Password must contain at least 10 characters.");
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize("NFKC"), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
  });
  return {
    hash: derived.toString("hex"),
    salt: salt.toString("hex"),
    params: JSON.stringify(params),
  };
}

export function verifyPassword(password: string, stored: PasswordHash): boolean {
  let params: ScryptParams;
  try {
    params = JSON.parse(stored.params) as ScryptParams;
  } catch {
    return false;
  }
  const salt = Buffer.from(stored.salt, "hex");
  const derived = scryptSync(password.normalize("NFKC"), salt, params.keylen ?? 64, {
    N: params.N,
    r: params.r,
    p: params.p,
  });
  const expected = Buffer.from(stored.hash, "hex");
  if (expected.length !== derived.length) {
    return false;
  }
  return timingSafeEqual(expected, derived);
}

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
