// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";
import { reachable } from "../private-address.js";

// Resolution is stubbed: `localhost` answers one private address,
// `split.example.com` a public one beside a private one, `nowhere.example`
// does not resolve, and every other name is public.
vi.mock("node:dns/promises", () => ({
  lookup: (host: string) => {
    if (host === "localhost") return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    if (host === "split.example.com") {
      return Promise.resolve([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    }
    if (host === "nowhere.example") return Promise.reject(new Error("ENOTFOUND"));
    return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
  },
}));

describe("reachable", () => {
  it.each([
    ["loopback", "http://127.0.0.1:5432/x.png"],
    ["loopback by name", "http://localhost:8080/x.png"],
    ["link-local, where cloud metadata lives", "http://169.254.169.254/latest/meta-data/"],
    ["private class A", "http://10.0.0.5/x.png"],
    ["private class B", "http://172.16.3.4/x.png"],
    ["private class C", "http://192.168.1.1/x.png"],
    ["IPv6 loopback", "http://[::1]/x.png"],
    ["IPv6 unique local", "http://[fd00::1]/x.png"],
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/x.png"],
    ["loopback written as a decimal number", "http://2130706433/x.png"],
  ])("refuses %s", async (_name, url) => {
    await expect(reachable(url)).resolves.toBe(false);
  });

  it("refuses a name that answers with a public address beside a private one", async () => {
    await expect(reachable("https://split.example.com/x.png")).resolves.toBe(false);
  });

  it("refuses a malformed address", async () => {
    await expect(reachable("not a url")).resolves.toBe(false);
  });

  it("accepts a public literal and a name that answers only public addresses", async () => {
    await expect(reachable("https://93.184.216.34/x.png")).resolves.toBe(true);
    await expect(reachable("https://cdn.example.com/x.png")).resolves.toBe(true);
  });

  it("lets a name that does not resolve through, so the request reports why", async () => {
    await expect(reachable("https://nowhere.example/x.png")).resolves.toBe(true);
  });

  it.each([
    ["a data address", "data:image/png;base64,iVBORw0KGgo="],
    ["a file address", "file:///etc/passwd"],
    ["an ftp address", "ftp://93.184.216.34/x.png"],
    ["a blob address", "blob:https://cdn.example.com/1234"],
  ])("refuses %s: only http and https are fetched", async (_name, url) => {
    await expect(reachable(url)).resolves.toBe(false);
  });

  it("accepts an IPv4-mapped IPv6 address that reaches a public IPv4 address", async () => {
    await expect(reachable("http://[::ffff:8.8.8.8]/x.png")).resolves.toBe(true);
  });
});
