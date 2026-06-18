// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";
import {
  isLoopbackIp,
  resolveClientIp,
  createLoopbackExemptThrottle,
} from "@collab/infra/loopback-exempt-throttle.js";

/** Build a minimal onConnect payload with a socket IP + optional x-forwarded-for. */
function payload(remoteAddress: string, xff?: string) {
  return {
    request: {
      headers: xff ? { "x-forwarded-for": xff } : {},
      socket: { remoteAddress },
    },
  };
}

describe("isLoopbackIp", () => {
  it("treats all loopback forms as loopback", () => {
    for (const ip of [
      "127.0.0.1",
      "127.0.0.5",
      "::1",
      "::ffff:127.0.0.1",
      "localhost",
    ]) {
      expect(isLoopbackIp(ip)).toBe(true);
    }
  });

  it("treats real / empty IPs as NOT loopback", () => {
    for (const ip of ["1.2.3.4", "192.168.1.10", "::ffff:1.2.3.4", "10.0.0.1", ""]) {
      expect(isLoopbackIp(ip)).toBe(false);
    }
  });
});

describe("resolveClientIp", () => {
  it("prefers x-real-ip, then x-forwarded-for, then the socket address", () => {
    expect(
      resolveClientIp({
        headers: { "x-real-ip": "9.9.9.9", "x-forwarded-for": "8.8.8.8" },
        socket: { remoteAddress: "127.0.0.1" },
      }),
    ).toBe("9.9.9.9");
    expect(
      resolveClientIp({
        headers: { "x-forwarded-for": "8.8.8.8" },
        socket: { remoteAddress: "127.0.0.1" },
      }),
    ).toBe("8.8.8.8");
    expect(
      resolveClientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }),
    ).toBe("127.0.0.1");
  });
});

describe("createLoopbackExemptThrottle", () => {
  it("NEVER bans a loopback IP, even far past the throttle threshold (the dev bug)", async () => {
    const ext = createLoopbackExemptThrottle({ throttle: 2, banTime: 1 });
    // 20 rapid connects from loopback — all must resolve (exempt), where a real
    // IP would be banned after the 3rd.
    for (let i = 0; i < 20; i++) {
      await expect(ext.onConnect(payload("::1"))).resolves.toBeUndefined();
    }
    await ext.onDestroy();
  });

  it("still bans a NON-loopback IP once it exceeds the threshold", async () => {
    const ext = createLoopbackExemptThrottle({ throttle: 2, banTime: 1 });
    const p = payload("1.2.3.4");
    /** Whether onConnect rejected — the Throttle rejects with `undefined` (the
     * value the server turns into the "Forbidden" reason), so we only assert
     * that it rejected, not the reason. */
    const rejected = async (): Promise<boolean> => {
      try {
        await ext.onConnect(p);
        return false;
      } catch {
        return true;
      }
    };
    // length 1 and 2 are within threshold (> 2 is the ban condition)
    expect(await rejected()).toBe(false);
    expect(await rejected()).toBe(false);
    // 3rd connection (length 3 > 2) → throttle bans, and stays banned after
    expect(await rejected()).toBe(true);
    expect(await rejected()).toBe(true);
    await ext.onDestroy();
  });

  it("exempts loopback supplied via x-forwarded-for too (dev behind the vite proxy)", async () => {
    const ext = createLoopbackExemptThrottle({ throttle: 1, banTime: 1 });
    for (let i = 0; i < 10; i++) {
      await expect(
        ext.onConnect(payload("10.0.0.1", "127.0.0.1")),
      ).resolves.toBeUndefined();
    }
    await ext.onDestroy();
  });
});
