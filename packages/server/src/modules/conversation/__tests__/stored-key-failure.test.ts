// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A turn that failed on the payer's own key (inner#1953) keeps why in its stored reply, as a turn too long or stopped
 * by a shutdown does: the failure's kind, the upstream and the key's own reason are written down from the mark the
 * turn streamed, and read back into the same mark, so the panel still tells the user to top up or replace the key
 * after a reload.
 */

import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { toStoredParts, toUiParts } from "@server/modules/conversation/message-part-mapping.js";

type UiParts = UIMessage["parts"];

describe("a turn failed on an account key, stored and read back", () => {
  it.each([
    [{ reason: "account_key_failed", upstream: "openrouter", keyReason: "no_balance" }],
    [{ reason: "account_key_failed", upstream: "openrouter", keyReason: "no_balance", keyOwner: "payer-account" }],
    [{ reason: "account_key_missing" }],
    [{ reason: "upstream_unavailable", upstream: "fal" }],
  ])("keeps %o", (data) => {
    const stored = toStoredParts([{ type: "data-failed", data }] as unknown as UiParts);

    expect(stored).toEqual([{ type: "failed", ...data }]);
    expect(toUiParts(stored)).toEqual([{ type: "data-failed", data }]);
  });

  it("keeps no field it does not know", () => {
    const stored = toStoredParts([{ type: "data-failed", data: { reason: "account_key_failed", upstream: "openrouter", keyReason: "sk-or-v1-x", key: "sk" } }] as unknown as UiParts);

    expect(stored).toEqual([{ type: "failed", reason: "account_key_failed", upstream: "openrouter" }]);
  });
});
