// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which server the desktop client opens (#1599, design §6).
 *
 * Accepted addresses follow the deployments `self-host/LOCAL.md` supports:
 * HTTPS by domain or IP, plain HTTP only on this machine, where `ENV=dev`
 * allows the session cookie without TLS. On a LAN address plain HTTP is not a
 * secure context and the production cookie is `Secure`, so it cannot work.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Why an address was refused before or during the check. */
export type ServerRefusal = "scheme" | "unreachable" | "not_server" | "certificate";

/** Hosts that may be reached over plain HTTP: this machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The check runs before the client knows any server, so no server-side
 * configuration can reach it; ten seconds covers a slow first TLS handshake.
 */
const CHECK_TIMEOUT_MS = 10_000;

/**
 * Turn what the user typed into the origin the client keeps.
 * @param input - The address as typed.
 * @returns The origin, or why the address is refused.
 */
export function normalizeServerUrl(input: string): { ok: true; origin: string } | { ok: false; reason: "scheme" } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "scheme" };
  }
  if (url.protocol === "https:") return { ok: true, origin: url.origin };
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return { ok: true, origin: url.origin };
  return { ok: false, reason: "scheme" };
}

/** The fetch the check uses: Electron's `net.fetch`, so the system certificates and proxy apply. */
export type CheckFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Ask an origin whether it is a server of our app: it publishes `/app-version.json`
 * with a string `version`.
 * @param origin - The normalized origin.
 * @param fetchFn - The fetch to use.
 * @param timeoutMs - How long to wait.
 * @returns The origin the check ended on after redirects, or why it failed.
 */
export async function checkServer(
  origin: string,
  fetchFn: CheckFetch,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<{ ok: true; origin: string } | { ok: false; reason: Exclude<ServerRefusal, "scheme"> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${origin}/app-version.json`, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, reason: "not_server" };
    const body: unknown = await res.json().catch(() => null);
    if (typeof body !== "object" || body === null || typeof (body as { version?: unknown }).version !== "string") {
      return { ok: false, reason: "not_server" };
    }
    return { ok: true, origin: new URL(res.url || origin).origin };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message.includes("ERR_CERT_") ? "certificate" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the saved server.
 * @param file - Path of `config.json`.
 * @returns The saved origin, or null on the first launch, a broken file or a refused address.
 */
export function readServerConfig(file: string): string | null {
  try {
    const saved = (JSON.parse(readFileSync(file, "utf-8")) as { serverUrl?: unknown }).serverUrl;
    if (typeof saved !== "string") return null;
    const normalized = normalizeServerUrl(saved);
    return normalized.ok ? normalized.origin : null;
  } catch {
    return null;
  }
}

/**
 * Save the server the client connected to.
 * @param file - Path of `config.json`.
 * @param origin - The origin to keep.
 * @throws {Error} if the file cannot be written.
 */
export function writeServerConfig(file: string, origin: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ serverUrl: origin }, null, 2)}\n`);
}

/**
 * Pick the server to open: `BREATIC_SERVER_URL` in development, else the one
 * the build carries, else the one the user entered. A build that carries a
 * server always opens it, so a saved address never outlives a new build; only
 * a build that carries none asks on first launch.
 * @param sources - The override, the saved origin and the build's own.
 * @param sources.envUrl - `BREATIC_SERVER_URL`, when set.
 * @param sources.savedUrl - The origin in `config.json`, when there is one.
 * @param sources.builtInUrl - The server written into the build, or "".
 * @returns The origin and where it came from, or null when the user must choose.
 * @throws {Error} if the override is an address the client refuses.
 */
export function resolveServerUrl(sources: {
  envUrl: string | undefined;
  savedUrl: string | null;
  builtInUrl: string;
}): { origin: string; fromEnv: boolean } | null {
  if (sources.envUrl) {
    const normalized = normalizeServerUrl(sources.envUrl);
    if (!normalized.ok) throw new Error(`BREATIC_SERVER_URL is not an address the client accepts: ${sources.envUrl}`);
    return { origin: normalized.origin, fromEnv: true };
  }
  const builtIn = sources.builtInUrl ? normalizeServerUrl(sources.builtInUrl) : null;
  if (builtIn?.ok) return { origin: builtIn.origin, fromEnv: false };
  return sources.savedUrl ? { origin: sources.savedUrl, fromEnv: false } : null;
}
