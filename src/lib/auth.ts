import crypto from "crypto";
import { cookies } from "next/headers";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

function getSecret(): string {
  const secret = process.env.APP_AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("APP_AUTH_SECRET is required and must be at least 16 chars.");
  }
  return secret;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string): string {
  return crypto.createHmac("sha256", getSecret()).update(value).digest("base64url");
}

export function createAuthToken(username: string): string {
  const payload = {
    username,
    exp: Date.now() + SESSION_TTL_MS,
  };

  const rawPayload = JSON.stringify(payload);
  const encoded = toBase64Url(rawPayload);
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

export function verifyAuthToken(token: string): { username: string; exp: number } | null {
  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSig = sign(encodedPayload);
  if (signature !== expectedSig) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as {
      username: string;
      exp: number;
    };

    if (!payload.username || typeof payload.exp !== "number") {
      return null;
    }

    if (Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export async function getCurrentUser(): Promise<{ username: string } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;

  // Auth disabled mode (user requested "link-only" access).
  // If a valid token exists, keep using it. Otherwise treat as a single public user.
  if (!token) return { username: "public" };

  const parsed = verifyAuthToken(token);
  if (!parsed) return { username: "public" };

  return { username: parsed.username || "public" };
}

export function validateAppCredential(username: string, password: string): boolean {
  const expectedUsername = process.env.APP_LOGIN_ID;
  const expectedPassword = process.env.APP_LOGIN_PASSWORD;

  if (!expectedUsername || !expectedPassword) {
    throw new Error("APP_LOGIN_ID and APP_LOGIN_PASSWORD are required.");
  }

  return username === expectedUsername && password === expectedPassword;
}
