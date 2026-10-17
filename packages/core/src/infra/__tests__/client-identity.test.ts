// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The client-identity rule collab and the server share (inner#1478).
 *
 * The rule is a single question — is the connection's peer our own reverse
 * proxy, or the client itself? — and it has exactly three outcomes. There is
 * no fallback chain: `x-forwarded-for` is never consulted, because nginx
 * APPENDS to it (`$proxy_add_x_forwarded_for`) so its first hop is whatever
 * the client sent.
 */

import { describe, it, expect } from "vitest";
import {
  isLoopbackIp,
  decideClientIdentity,
} from "@core/infra/client-identity.js";

describe("isLoopbackIp", () => {
  it("treats every loopback form as loopback", () => {
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

  it("treats real and empty addresses as NOT loopback", () => {
    for (const ip of ["1.2.3.4", "192.168.1.10", "::ffff:1.2.3.4", "10.0.0.1", ""]) {
      expect(isLoopbackIp(ip)).toBe(false);
    }
  });
});

describe("decideClientIdentity", () => {
  it("exempts a loopback peer and identifies it by its own address", () => {
    // Dev: the browser talks to Vite, Vite proxies /ws to collab on the same
    // machine, so collab's peer is loopback. Nothing here should be throttled.
    expect(
      decideClientIdentity({ peerAddress: "::1", realIpHeader: undefined }),
    ).toEqual({ kind: "exempt", identity: "::1" });

    expect(
      decideClientIdentity({ peerAddress: "127.0.0.1", realIpHeader: undefined }),
    ).toEqual({ kind: "exempt", identity: "127.0.0.1" });
  });

  it("ignores whatever a loopback peer claims in x-real-ip", () => {
    // A loopback peer is exempt on the strength of its address alone; letting a
    // header change that would hand any local process a way to be counted as
    // someone else.
    expect(
      decideClientIdentity({ peerAddress: "::1", realIpHeader: "9.9.9.9" }),
    ).toEqual({ kind: "exempt", identity: "::1" });
  });

  it("identifies a proxied client by the header the proxy set", () => {
    // Prod: the peer is nginx, which OVERWRITES x-real-ip with the real client
    // address, so the header is trustworthy exactly when the peer is not us.
    expect(
      decideClientIdentity({ peerAddress: "172.18.0.4", realIpHeader: "203.0.113.9" }),
    ).toEqual({ kind: "identify", identity: "203.0.113.9" });
  });

  it("refuses a non-loopback peer that carries no x-real-ip", () => {
    // Nobody should reach collab except through our proxy, and our proxy always
    // sets the header. No header therefore means "not from our proxy".
    expect(
      decideClientIdentity({ peerAddress: "203.0.113.9", realIpHeader: undefined }),
    ).toEqual({ kind: "refuse", reason: "missing-real-ip" });
  });

  it("refuses a non-loopback peer whose x-real-ip is blank", () => {
    for (const blank of ["", "   "]) {
      expect(
        decideClientIdentity({ peerAddress: "203.0.113.9", realIpHeader: blank }),
      ).toEqual({ kind: "refuse", reason: "missing-real-ip" });
    }
  });

  it("refuses when the peer address is unavailable", () => {
    // No address means the connection never really established; there is
    // nothing to identify and nothing to count.
    expect(
      decideClientIdentity({ peerAddress: undefined, realIpHeader: "203.0.113.9" }),
    ).toEqual({ kind: "refuse", reason: "no-peer-address" });

    expect(
      decideClientIdentity({ peerAddress: "", realIpHeader: "203.0.113.9" }),
    ).toEqual({ kind: "refuse", reason: "no-peer-address" });
  });

  it("trims the header before using it as an identity", () => {
    expect(
      decideClientIdentity({ peerAddress: "172.18.0.4", realIpHeader: " 203.0.113.9 " }),
    ).toEqual({ kind: "identify", identity: "203.0.113.9" });
  });
});

describe("IPv6 sources are counted by their /64", () => {
  // An ISP hands one subscriber at least a /64, so counting each address
  // separately lets one subscriber rotate through 2^64 identities.
  const decide = (ip: string): ReturnType<typeof decideClientIdentity> =>
    decideClientIdentity({ peerAddress: "172.18.0.4", realIpHeader: ip });

  it("puts two addresses in one /64 under the same identity", () => {
    expect(decide("2001:db8:1:2::a")).toEqual(decide("2001:db8:1:2:ffff:1:2:3"));
    expect(decide("2001:db8:1:2::a")).toEqual({ kind: "identify", identity: "2001:db8:1:2::/64" });
  });

  it("keeps addresses in different /64s apart", () => {
    expect(decide("2001:db8:1:2::a")).not.toEqual(decide("2001:db8:1:3::a"));
  });

  it("reads compressed, expanded and uppercase forms as the same /64", () => {
    const expected = { kind: "identify", identity: "2001:db8:1:2::/64" };
    expect(decide("2001:0DB8:0001:0002:0000:0000:0000:000A")).toEqual(expected);
    expect(decide("2001:db8:1:2:0:0:0:a")).toEqual(expected);
  });

  it("groups a /64 whose upper half has zeros", () => {
    expect(decide("2001:db8::5")).toEqual({ kind: "identify", identity: "2001:db8::/64" });
  });

  it("counts a dotted IPv4-mapped address as the IPv4 address", () => {
    expect(decide("::ffff:203.0.113.9")).toEqual({ kind: "identify", identity: "203.0.113.9" });
  });

  it("keeps an IPv4 address whole", () => {
    expect(decide("203.0.113.9")).toEqual({ kind: "identify", identity: "203.0.113.9" });
  });
});
