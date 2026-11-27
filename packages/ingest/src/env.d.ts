// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
import type { PresentationStateTestObject } from '@ingest/__tests__/helpers/presentation-state-object.js';

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env { PRESENTATION_STATE_TEST: DurableObjectNamespace<PresentationStateTestObject> }
}
