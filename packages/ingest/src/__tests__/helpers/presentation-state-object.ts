// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { DurableObject } from 'cloudflare:workers';

/**
 * Real workerd storage for the presentation store tests (inner#1306). The tests
 * build the production store inside it with `runInDurableObject`
 * (`machine-store.ts`), so the object itself delegates nothing; the earlier
 * RPC delegates over the v1 store API were removed with the S6c rewrite.
 */
export class PresentationStateTestObject extends DurableObject<{ BUCKET: R2Bucket }> {}
