// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { afterEach, describe, expect, it, vi } from "vitest";
const { config, connections } = vi.hoisted(() => ({ config: { REDIS_QUEUE_URL: "redis://localhost:6379/1" }, connections: [] as Record<string, unknown>[] }));
vi.mock("@core/config/env.js", () => ({ env: config, MONOREPO_ROOT: decodeURIComponent(new URL("../../../../../", import.meta.url).pathname) }));
vi.mock("bullmq", () => {
    class ConnectionSpy {
        constructor(_name: string, optionsOrProcessor: unknown, workerOptions?: {
            connection: Record<string, unknown>;
        }) {
            const options = workerOptions ?? optionsOrProcessor as {
                connection: Record<string, unknown>;
            };
            connections.push(options.connection);
        }
        async close(): Promise<void> { }
    }
    return { Queue: ConnectionSpy, QueueEvents: ConnectionSpy, Worker: ConnectionSpy };
});
import { createQueue, createQueueEvents, createWorker, closeQueues } from "../queue.js";
afterEach(async () => { await closeQueues(); connections.length = 0; });
describe("queue Redis URL", () => {
    it("passes TLS, decoded ACL credentials and DB to all queue connections", () => {
        config.REDIS_QUEUE_URL = "rediss://queue%40team:p%40ss%3Aword%2F%25@redis.example.com:6380/1";
        createQueue("jobs");
        createQueueEvents("jobs");
        createWorker("jobs", async () => undefined);
        expect(connections).toHaveLength(3);
        for (const c of connections)
            expect(c).toMatchObject({ host: "redis.example.com", port: 6380, db: 1, username: "queue@team", password: "p@ss:word/%", tls: {}, maxRetriesPerRequest: null, enableReadyCheck: false });
    });
    it("retains local unauthenticated Redis and handles IPv6 hosts", () => {
        config.REDIS_QUEUE_URL = "redis://[::1]/1";
        createQueue("jobs");
        expect(connections[0]).toMatchObject({ host: "::1", port: 6379, db: 1 });
        expect(connections[0]?.tls).toBeUndefined();
    });
    it("rejects non-Redis schemes without exposing credentials", () => {
        config.REDIS_QUEUE_URL = "https://user:secret@localhost/1";
        expect(() => createQueue("jobs")).toThrow("REDIS_QUEUE_URL must use redis:// or rediss://");
    });
    it("supports password-only authentication", () => {
        config.REDIS_QUEUE_URL = "redis://:p%40ss@localhost/1";
        createQueue("jobs");
        expect(connections[0]?.password).toBe("p@ss");
        expect(connections[0]?.username).toBeUndefined();
    });
});
