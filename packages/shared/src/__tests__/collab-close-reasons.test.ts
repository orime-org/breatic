// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The close reason for a refused oversized write (inner#1790, spec C-07).
 * It must not be a re-authentication reason: the client would reconnect at
 * once and send the same refused updates again.
 */

import { describe, expect, it } from "vitest";
import {
  COLLAB_DOCUMENT_TOO_LARGE_REASON,
  COLLAB_REAUTH_REASONS,
  isReauthCloseReason,
} from "@shared/collab-close-reasons.js";

describe("COLLAB_DOCUMENT_TOO_LARGE_REASON", () => {
  it("C-07 is its own reason, outside the re-authentication set", () => {
    expect(COLLAB_DOCUMENT_TOO_LARGE_REASON).toBe("Document size limit reached");
    expect(Object.values(COLLAB_REAUTH_REASONS)).not.toContain(COLLAB_DOCUMENT_TOO_LARGE_REASON);
    expect(isReauthCloseReason(COLLAB_DOCUMENT_TOO_LARGE_REASON)).toBe(false);
  });
});
