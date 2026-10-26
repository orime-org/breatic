// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The type a stored object is recorded under is the one name the registry
 * lists (inner#1305 §7.1): a container's audio output is an .m4a, which the
 * bytes call `audio/x-m4a`, and the ledger records it as `audio/mp4` on every
 * path, the container's writes as well as the upload finish.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { sniffStoredObject } from "@ingest/stored-object.js";
import { head } from "./helpers/encoder-heads.js";

describe("sniffStoredObject", () => {
  it("names an m4a by the registry's spelling", async () => {
    await env.BUCKET.put("audio/out.m4a", head("m4a"));
    expect(await sniffStoredObject(env.BUCKET, "audio/out.m4a")).toBe("audio/mp4");
  });

  it("leaves a type with one name as the bytes say", async () => {
    await env.BUCKET.put("video/out.mp4", head("mp4"));
    expect(await sniffStoredObject(env.BUCKET, "video/out.mp4")).toBe("video/mp4");
  });
});
