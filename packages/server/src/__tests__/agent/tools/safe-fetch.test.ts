/**
 * Tests for the SSRF-safe fetch wrapper.
 *
 * We mock `node:dns/promises` so the tests are hermetic — we never
 * make real DNS queries or network calls. The global `fetch` is also
 * mocked for the "public host" and "redirect" paths.
 *
 * The properties pinned here:
 *
 *   - Non-http(s) schemes → SsrfError
 *   - Hostname → loopback IP → SsrfError (even before fetch is called)
 *   - Hostname → AWS metadata IP (169.254.169.254) → SsrfError
 *   - Hostname → RFC 1918 private (10.0.0.1) → SsrfError
 *   - Hostname deny list (`localhost`, `metadata.google.internal`)
 *   - IP literal in URL (`http://127.0.0.1/`) → SsrfError
 *   - Redirect from public → internal → SsrfError on hop 2
 *   - Public unicast IP → the underlying fetch is invoked
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const dnsLookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (host: string, opts?: unknown) => dnsLookupMock(host, opts),
}));

// A manual global fetch mock that returns canned Response objects
// based on the URL. Tests can push entries onto `fetchQueue`.
interface FetchCall {
  url: string;
  init?: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const fetchQueue: Array<() => Response> = [];

const originalFetch = globalThis.fetch;
beforeEach(() => {
  fetchCalls.length = 0;
  fetchQueue.length = 0;
  dnsLookupMock.mockReset();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`No mocked fetch response for ${url}`);
    return next();
  }) as typeof fetch;
});

// Import after mocks are set up
import { safeFetch, SsrfError } from "../../../agent/tools/safe-fetch.js";

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("safeFetch — scheme and hostname blocking", () => {
  it("rejects ftp:// and other non-http schemes", async () => {
    await expect(safeFetch("ftp://example.com/x")).rejects.toThrow(SsrfError);
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow();
  });

  it("rejects the `localhost` hostname literal", async () => {
    await expect(safeFetch("http://localhost/admin")).rejects.toThrow(SsrfError);
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("rejects `metadata.google.internal`", async () => {
    await expect(
      safeFetch("http://metadata.google.internal/computeMetadata/v1/"),
    ).rejects.toThrow(SsrfError);
  });
});

describe("safeFetch — IP literal blocking", () => {
  it("rejects http://127.0.0.1/", async () => {
    await expect(safeFetch("http://127.0.0.1/")).rejects.toThrow(SsrfError);
  });

  it("rejects http://169.254.169.254/ (AWS metadata)", async () => {
    await expect(
      safeFetch("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(SsrfError);
  });

  it("rejects RFC 1918 10.0.0.0/8", async () => {
    await expect(safeFetch("http://10.0.0.5/")).rejects.toThrow(SsrfError);
  });

  it("rejects RFC 1918 192.168.0.0/16", async () => {
    await expect(safeFetch("http://192.168.1.1/")).rejects.toThrow(SsrfError);
  });

  it("rejects IPv6 loopback ::1", async () => {
    await expect(safeFetch("http://[::1]/x")).rejects.toThrow(SsrfError);
  });
});

describe("safeFetch — DNS-resolved hostname blocking", () => {
  it("blocks a hostname that resolves to a private IP", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(safeFetch("http://sneaky.example.com/")).rejects.toThrow(
      SsrfError,
    );
  });

  it("blocks when ANY of the resolved addresses is private", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 }, // public
      { address: "127.0.0.1", family: 4 }, // loopback
    ]);
    await expect(safeFetch("http://dual-stack.example.com/")).rejects.toThrow(
      SsrfError,
    );
  });

  it("allows a hostname that resolves to a public IP", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]);
    fetchQueue.push(() => new Response("hello", { status: 200 }));

    const res = await safeFetch("http://example.com/");
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("http://example.com/");
  });
});

describe("safeFetch — redirect re-checking", () => {
  it("blocks a redirect from a public host to a private IP", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]);
    fetchQueue.push(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );

    await expect(safeFetch("http://example.com/")).rejects.toThrow(SsrfError);
    // First hop went through (public), redirect hop caught.
    expect(fetchCalls).toHaveLength(1);
  });

  it("follows a redirect to another public host", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]);
    fetchQueue.push(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://example.org/final" },
        }),
    );
    fetchQueue.push(() => new Response("final", { status: 200 }));

    const res = await safeFetch("http://example.com/");
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]!.url).toBe("http://example.org/final");
  });
});
