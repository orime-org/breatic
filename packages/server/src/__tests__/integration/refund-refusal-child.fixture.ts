// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** An owned internal-API process for the pre-commit exit integration case. */
import { serve } from "@hono/node-server";
import { initCore, loadLocales } from "@breatic/core";

// An interrupted test runner must not leave this fixture's listener behind.
process.once("disconnect", () => process.exit(1));

/**
 * Serve the real internal app with inherited testcontainer configuration.
 * @throws {Error} When configuration, app loading or loopback listening fails.
 */
async function start(): Promise<void> {
  initCore(process.env);
  loadLocales();
  const { createInternalApp } = await import("@server/internal-app.js");
  await new Promise<void>((resolve, reject) => {
    const server = serve({ fetch: createInternalApp().fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      server.off("error", reject);
      process.send?.({ type: "ready", pid: process.pid, baseUrl: `http://127.0.0.1:${info.port}` });
      resolve();
    });
    server.once("error", reject);
  });
}

try {
  await start();
} catch (error) {
  // Report a bounded failure identity, never configuration values or secrets.
  process.send?.({ type: "startup_failed", pid: process.pid, errorType: error instanceof Error ? error.name : "unknown" });
  process.exit(1);
}
