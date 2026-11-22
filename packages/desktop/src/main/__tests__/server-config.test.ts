// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which server the desktop client opens (#1599).
 *
 * The address the user types follows the deployments `self-host/LOCAL.md`
 * supports: HTTPS by domain or IP, plain HTTP only on this machine. A server
 * is breatic when it publishes `/app-version.json`; the origin kept is the one
 * the check ended on, so a redirecting `www.` address does not leave the window
 * blank. The address lives in `config.json`; a missing or broken file means
 * the first launch, and `BREATIC_SERVER_URL` overrides it in development.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkServer,
  normalizeServerUrl,
  readServerConfig,
  resolveServerUrl,
  writeServerConfig,
} from "@desktop/main/server-config.js";

describe("normalizeServerUrl", () => {
  it.each([
    ["https://app.example.com", "https://app.example.com"],
    ["https://app.example.com/studio?x=1", "https://app.example.com"],
    ["  https://192.168.1.50  ", "https://192.168.1.50"],
    ["https://team.example.com:8443/", "https://team.example.com:8443"],
    ["http://localhost:8100", "http://localhost:8100"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://[::1]:8000/", "http://[::1]:8000"],
  ])("accepts %s as %s", (input, origin) => {
    expect(normalizeServerUrl(input)).toEqual({ ok: true, origin });
  });

  it.each(["http://192.168.1.50", "http://app.example.com", "ftp://app.example.com", "app.example.com", "", "not a url", "file:///etc/passwd"])(
    "refuses %s",
    (input) => {
      expect(normalizeServerUrl(input)).toEqual({ ok: false, reason: "scheme" });
    },
  );
});

describe("checkServer", () => {
  /**
   * A stand-in for `net.fetch` answering with the given body from the given final URL.
   * @param body - The response body.
   * @param url - The URL the response came from after redirects.
   * @param status - The HTTP status.
   */
  function answering(body: string, url: string, status = 200) {
    return vi.fn(async () => {
      const res = new Response(body, { status, headers: { "content-type": "application/json" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    });
  }

  it("accepts a server publishing a version and keeps the origin the check ended on", async () => {
    const fetchFn = answering('{"version":"v1"}', "https://app.example.com/app-version.json");
    expect(await checkServer("https://www.app.example.com", fetchFn)).toEqual({ ok: true, origin: "https://app.example.com" });
    expect(fetchFn).toHaveBeenCalledWith("https://www.app.example.com/app-version.json", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it.each([
    ["html", "<html></html>", 200],
    ["json without a version", '{"name":"x"}', 200],
    ["a non-string version", '{"version":3}', 200],
    ["a 404", "{}", 404],
  ])("calls an address answering %s not breatic", async (_label, body, status) => {
    expect(await checkServer("https://example.com", answering(body, "https://example.com/app-version.json", status))).toEqual({
      ok: false,
      reason: "not_server",
    });
  });

  it("calls a network failure unreachable", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); });
    expect(await checkServer("https://nowhere.test", fetchFn)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("names an untrusted certificate", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("net::ERR_CERT_AUTHORITY_INVALID"); });
    expect(await checkServer("https://192.168.1.50", fetchFn)).toEqual({ ok: false, reason: "certificate" });
  });

  it("gives up after the timeout", async () => {
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    expect(await checkServer("https://slow.test", fetchFn, 20)).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("config file", () => {
  /** A fresh directory standing in for userData. */
  function dir(): string {
    return mkdtempSync(join(tmpdir(), "breatic-desktop-"));
  }

  it("reads what it wrote", () => {
    const at = join(dir(), "config.json");
    writeServerConfig(at, "https://app.example.com");
    expect(readServerConfig(at)).toBe("https://app.example.com");
    expect(JSON.parse(readFileSync(at, "utf-8"))).toEqual({ serverUrl: "https://app.example.com" });
  });

  it.each([
    ["a missing file", null],
    ["broken JSON", "{"],
    ["no serverUrl", "{}"],
    ["an address the client refuses", '{"serverUrl":"http://192.168.1.50"}'],
  ])("treats %s as the first launch", (_label, content) => {
    const at = join(dir(), "config.json");
    if (content !== null) writeFileSync(at, content);
    expect(readServerConfig(at)).toBeNull();
  });
});

describe("resolveServerUrl", () => {
  it("lets BREATIC_SERVER_URL override the saved address", () => {
    expect(resolveServerUrl({ envUrl: "http://localhost:8100", savedUrl: "https://app.example.com", builtInUrl: "" })).toEqual({
      origin: "http://localhost:8100",
      fromEnv: true,
    });
  });

  it("uses the saved address when the build carries none", () => {
    expect(resolveServerUrl({ envUrl: undefined, savedUrl: "https://app.example.com", builtInUrl: "" })).toEqual({ origin: "https://app.example.com", fromEnv: false });
  });

  it("opens the server the build carries on the first launch, without asking", () => {
    expect(resolveServerUrl({ envUrl: undefined, savedUrl: null, builtInUrl: "https://app.example.com" })).toEqual({
      origin: "https://app.example.com",
      fromEnv: false,
    });
  });

  it("opens the server the build carries even when an older address is saved", () => {
    expect(resolveServerUrl({ envUrl: undefined, savedUrl: "https://team.example.com", builtInUrl: "https://app.example.com" })).toEqual({
      origin: "https://app.example.com",
      fromEnv: false,
    });
  });

  it("asks on the first launch of a build that carries no server", () => {
    expect(resolveServerUrl({ envUrl: undefined, savedUrl: null, builtInUrl: "" })).toBeNull();
  });

  it("throws on an override the client refuses", () => {
    expect(() => resolveServerUrl({ envUrl: "http://10.0.0.2", savedUrl: null, builtInUrl: "" })).toThrow(/BREATIC_SERVER_URL/);
  });
});
