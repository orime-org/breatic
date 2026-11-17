// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Recognising a failure of an account's own key (inner#1953) wherever it sits on an error's cause chain: provider
 * raises it as `AccountKeyFailure`, and reading a key row that is gone raises it as `account_key_missing`. It is never
 * judged into a refusal of the deployment, and nothing moves the call to our keys. The reading is provider's, so a
 * caller that cannot reach domain reads it the same way.
 */

export { accountKeyFailureIn, type AccountKeyFailureFacts } from "@breatic/provider";
