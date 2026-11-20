// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A collab server started for a test listens only on the address the test
 * connects to (#1478), so no other local process can hold that port on it.
 */

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, expect, inject, it } from "vitest";
import * as core from "@breatic/core";
import { createCollabServer } from "@collab/hocuspocus.js";
import { stopInstance } from "./helpers/document-size-live.js";

core.initCore(process.env);

describe("createCollabServer's listen address", () => {
  it("listens only on the address it is given", async () => {
    const instance = await createCollabServer({
      port: 0,
      address: "127.0.0.1",
      collabRedisUrl: inject("REDIS_COLLAB_URL"),
      redisKeyPrefix: `listen-address-${randomUUID()}`,
      shutdownDeadline: () => undefined,
    });
    try {
      await instance.server.listen();
      expect((instance.server.httpServer.address() as AddressInfo).address).toBe("127.0.0.1");
    } finally {
      await stopInstance(instance);
    }
  });
});
