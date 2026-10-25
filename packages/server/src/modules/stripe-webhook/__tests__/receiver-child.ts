// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { serve } from "@hono/node-server";
import { initCore, loadLocales } from "@breatic/core";

initCore(process.env);
loadLocales();
const { createApp } = await import("@server/app.js");
serve({ fetch: createApp().fetch, hostname: "127.0.0.1", port: 0 }, info => {
  process.send?.({ port: info.port });
});
setTimeout(() => process.exit(1), 30_000);
