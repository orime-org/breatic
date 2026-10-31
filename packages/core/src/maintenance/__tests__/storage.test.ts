// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createR2MaintenanceStorage, MaintenanceDeleteError, type MaintenanceStorage } from "@core/maintenance/storage.js";

let server: Server;
let endpoint: string;
let status: number;
let hang: boolean;
let requests: { method: string; path: string; signingScheme: string }[];
let adapters: MaintenanceStorage[];

beforeEach(async () => {
  status = 200;
  hang = false;
  requests = [];
  adapters = [];
  server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", path: new URL(request.url ?? "/", "http://fixture").pathname, signingScheme: request.headers.authorization?.split(" ")[0] ?? "" });
    request.resume();
    if (hang) return;
    response.statusCode = status;
    if (status >= 400) response.setHeader("content-type", "application/xml");
    response.end(status >= 400 ? "<Error><Code>FixtureError</Code><Message>Fixture rejection</Message></Error>" : "");
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const adapter of adapters) adapter.close?.();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
});

/** Use only explicit fixture credentials and the private loopback endpoint. */
function adapter(timeout = 1000): MaintenanceStorage {
  const result = createR2MaintenanceStorage(timeout, { bucket: "fixture-bucket", region: "auto", accessKeyId: "fixture-key", secretAccessKey: "fixture-secret", endpoint, publicBaseUrl: "https://cdn.example.invalid" });
  adapters.push(result);
  return result;
}

describe("maintenance SDK port against local HTTP", () => {
  it("uses direct signed HEAD and DELETE for exactly the supplied key", async () => {
    const storage = adapter();
    expect(await storage.head("uploads/a file.png")).toBe("present");
    status = 204;
    await storage.delete("uploads/a file.png");
    expect(requests).toEqual([
      { method: "HEAD", path: "/fixture-bucket/uploads/a%20file.png", signingScheme: "AWS4-HMAC-SHA256" },
      { method: "DELETE", path: "/fixture-bucket/uploads/a%20file.png", signingScheme: "AWS4-HMAC-SHA256" },
    ]);
  });

  it("recognizes only an authoritative API HEAD 404 as missing", async () => {
    status = 404;
    expect(await adapter().head("uploads/missing.png")).toBe("missing");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("HEAD");
  });

  it.each([400, 401, 403, 429, 500, 503])("propagates HEAD %i instead of declaring absence", async (code) => {
    status = code;
    await expect(adapter().head("uploads/object.png")).rejects.toMatchObject({ $metadata: { httpStatusCode: code } });
    expect(requests).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 503])("classifies DELETE %i without hidden SDK retries", async (code) => {
    status = code;
    const result = await adapter().delete("uploads/object.png").catch((error: unknown) => error);
    expect(result).toBeInstanceOf(MaintenanceDeleteError);
    expect(result).toMatchObject({ uncertain: code >= 500, cause: { $metadata: { httpStatusCode: code } } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("DELETE");
  });

  it("bounds an unanswered DELETE and preserves its uncertain physical outcome", async () => {
    hang = true;
    const result = await adapter(250).delete("uploads/unknown.png").catch((error: unknown) => error);
    expect(result).toBeInstanceOf(MaintenanceDeleteError);
    expect(result).toMatchObject({ uncertain: true });
    expect(requests.length).toBeLessThanOrEqual(1);
  });

  it("preserves generated exact key bytes through SigV4 HTTP requests without suffix expansion", async () => {
    const storage = adapter();
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("a", "Z", "0", " ", "+", "%", "#", "?", "中"), { minLength: 1, maxLength: 12 }), async (characters) => {
      const key = `uploads/${characters.join("")}.png`;
      const offset = requests.length;
      await storage.head(key);
      await storage.delete(key);
      expect(requests.slice(offset).map((request) => request.path)).toEqual([`/fixture-bucket/uploads/${encodeURIComponent(characters.join(""))}.png`, `/fixture-bucket/uploads/${encodeURIComponent(characters.join(""))}.png`]);
      expect(requests.slice(offset).map((request) => request.method)).toEqual(["HEAD", "DELETE"]);
    }), { numRuns: 12, seed: 1793 });
  });
});
