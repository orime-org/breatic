// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tell the test runtime what this Worker's bindings are.
 *
 * `cloudflare:test` hands tests an `env` built from wrangler.toml, typed as an
 * empty `ProvidedEnv` until something declares its shape. Declaring it as our
 * own `Env` is what makes a test that passes `env` to the handler compile —
 * and what makes a binding renamed in wrangler.toml without a matching change
 * here fail at type-check rather than at run time.
 */

import type { Env } from "@ingest/index.js";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- giving ProvidedEnv our shape is the whole declaration; it adds nothing of its own
  interface ProvidedEnv extends Env {}
}
