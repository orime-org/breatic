// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The upgrade gate in a region that does not hold the global data
 * (inner#1955): it admits a WebSocket on the identity token alone, checked
 * with the public keys and the local revocation tombstones, and binds the
 * user and session id it verified to the connection. No session is read.
 */

import { generateKeyPairSync } from "node:crypto";
import { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { Redis } from "@breatic/core";

const { sessionLookup, revokedLookup, logs } = vi.hoisted(() => ({
  sessionLookup: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  revokedLookup: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => logs,
  getSession: sessionLookup,
  isIdentityRevoked: revokedLookup,
  identityCookieName: () => "breatic_identity_dev",
}));

import { identityCookieName, signIdentityToken } from "@breatic/core";
import {
  BOUND_IDENTITY_HEADER,
  createUpgradeSessionGate,
  readBoundIdentity,
} from "@collab/infra/upgrade-session-gate.js";

const REDIS = {} as unknown as Redis;
const NOW = 1_800_000_000;
const USER = "11111111-1111-4111-8111-111111111111";
const SID = "b".repeat(64);
const pair = generateKeyPairSync("ed25519");
const PRIVATE_KEY = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEYS = { k1: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
const sockets: GateSocket[] = [];

/** A Node Duplex standing in for the upgrade socket. */
class GateSocket extends Duplex {
  remoteAddress: string | undefined = "127.0.0.1";
  readonly chunks: string[] = [];

  /** Construct an open stream with independent readable and writable ends. */
  constructor() {
    super({ allowHalfOpen: true });
  }

  /** Keep the readable side open until the test ends it. */
  override _read(): void {}

  /** Record bytes the gate writes. */
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

/**
 * A signed identity token for {@link USER}.
 * @param signedAt - When it was signed, in Unix seconds.
 * @returns The compact token.
 */
function identityToken(signedAt: number): string {
  return signIdentityToken(
    { sub: USER, sid: SID, email: "user@example.test", tier: "base", locale: "en", personalStudio: null },
    { kid: "k1", privateKey: PRIVATE_KEY },
    signedAt,
  );
}

/**
 * An upgrade request carrying the given Cookie header.
 * @param cookie - The raw header, or undefined for none.
 * @returns The native upgrade payload.
 */
function upgrade(cookie: string | undefined): { request: IncomingMessage; socket: GateSocket } {
  const stream = new GateSocket();
  sockets.push(stream);
  const request = new IncomingMessage(stream as unknown as Socket);
  if (cookie !== undefined) request.headers.cookie = cookie;
  return { request, socket: stream };
}

/**
 * The gate as a non-global region builds it.
 * @returns The gate.
 */
function regionGate(): ReturnType<typeof createUpgradeSessionGate> {
  return createUpgradeSessionGate({
    redis: REDIS,
    identity: { publicKeys: PUBLIC_KEYS, nowSeconds: () => NOW },
  });
}

/**
 * Whether the gate admitted the upgrade.
 * @param operation - The gate's answer.
 * @returns True when admitted.
 */
async function admitted(operation: Promise<void>): Promise<boolean> {
  return operation.then(
    () => true,
    () => false,
  );
}

beforeEach(() => {
  sessionLookup.mockReset();
  revokedLookup.mockReset();
  revokedLookup.mockResolvedValue(false);
});

afterEach(() => {
  for (const stream of sockets.splice(0)) stream.destroy();
});

describe("upgrade gate in a non-global region", () => {
  it("admits a valid identity token, binds its user and session id, and reads no session", async () => {
    const gate = regionGate();
    const { request, socket } = upgrade(`${identityCookieName()}=${identityToken(NOW - 10)}`);

    expect(await admitted(gate.onUpgrade({ request, socket }))).toBe(true);
    expect(gate.identityOf(request)).toEqual({ userId: USER, sid: SID });
    expect(sessionLookup).not.toHaveBeenCalled();
    expect(revokedLookup).toHaveBeenCalledWith(REDIS, SID);
  });

  it("refuses an upgrade with no identity cookie with 401", async () => {
    const gate = regionGate();
    const { request, socket } = upgrade(undefined);

    expect(await admitted(gate.onUpgrade({ request, socket }))).toBe(false);
    expect(socket.chunks.join("")).toContain("401");
    expect(gate.identityOf(request)).toBeUndefined();
  });

  it("refuses an expired identity token with 401", async () => {
    const gate = regionGate();
    const { request, socket } = upgrade(`${identityCookieName()}=${identityToken(NOW - 120)}`);

    expect(await admitted(gate.onUpgrade({ request, socket }))).toBe(false);
    expect(socket.chunks.join("")).toContain("401");
  });

  it("refuses a token whose session this region has a revocation tombstone for", async () => {
    revokedLookup.mockResolvedValue(true);
    const gate = regionGate();
    const { request, socket } = upgrade(`${identityCookieName()}=${identityToken(NOW - 10)}`);

    expect(await admitted(gate.onUpgrade({ request, socket }))).toBe(false);
    expect(socket.chunks.join("")).toContain("401");
  });

  it("refuses a token signed by a key this region does not hold", async () => {
    const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const forged = signIdentityToken(
      { sub: USER, sid: SID, email: "user@example.test", tier: "base", locale: "en", personalStudio: null },
      { kid: "k1", privateKey: other },
      NOW - 10,
    );
    const gate = regionGate();
    const { request, socket } = upgrade(`${identityCookieName()}=${forged}`);

    expect(await admitted(gate.onUpgrade({ request, socket }))).toBe(false);
    expect(socket.chunks.join("")).toContain("401");
  });

  it("hands the bound identity to document authentication through the request headers", async () => {
    const gate = regionGate();
    const { request, socket } = upgrade(`${identityCookieName()}=${identityToken(NOW - 10)}`);

    await gate.onUpgrade({ request, socket });

    const headers = new Headers(request.headers as Record<string, string>);
    expect(readBoundIdentity(headers)).toEqual({ userId: USER, sid: SID });
  });

  it("drops an identity header the client sent itself", async () => {
    const gate = regionGate();
    const { request, socket } = upgrade(undefined);
    request.headers[BOUND_IDENTITY_HEADER] = JSON.stringify({ userId: "someone-else", sid: "forged" });

    await gate.onUpgrade({ request, socket }).catch(() => undefined);

    expect(request.headers[BOUND_IDENTITY_HEADER]).toBeUndefined();
  });
});
