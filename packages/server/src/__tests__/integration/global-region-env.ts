// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the global region of a deployment with other regions must be
 * configured with before it starts (inner#1955): a signing key for identity
 * tokens, the parent domain their cookie is written on, and the secret calls
 * between regions are signed with.
 */

import { generateKeyPairSync } from "node:crypto";

const keys = generateKeyPairSync("ed25519");

/** The global region's identity and signing settings, for a suite's `initCore`. */
export const GLOBAL_REGION_SETTINGS = {
  IDENTITY_SIGNING_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  IDENTITY_SIGNING_KEY_ID: "test-global",
  IDENTITY_COOKIE_DOMAIN: ".example.test",
  INTERNAL_API_SECRET: "global-region-test-secret",
};
