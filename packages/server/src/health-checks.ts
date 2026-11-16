// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the server's `/healthz` probes: every Postgres and Redis connection
 * the server uses (AGENTS.md#health-checks), and outside the global region
 * whether the global region answers.
 */
import { getRedis, globalApiHealthChecks, pingDb, pingRedis, yjsRawPg, type HealthCheck } from "@breatic/core";
import { getChatSubscriberRedis } from "@server/agent/run-stream.js";

/**
 * The server's health checks.
 * @returns One check per critical connection.
 */
export function serverHealthChecks(): HealthCheck[] {
  return [
    // Single SELECT-1 liveness helper, shared across all services.
    { name: "postgres", check: () => pingDb() },
    // Liveness for the separate Yjs-store Postgres DB.
    { name: "postgres_yjs", check: () => pingDb(yjsRawPg) },
    // Single PING liveness helper, shared across all services.
    { name: "redis_general", check: () => pingRedis(getRedis()) },
    // The connection Agent chat runs hear their stops and readers on
    // (inner#1717); without it no run can be stopped or attached to.
    { name: "redis_chat_subscriber", check: () => pingRedis(getChatSubscriberRedis()) },
    // Outside the global region: whether the global region answers (inner#1955);
    // informational, so it never marks the instance unhealthy.
    ...globalApiHealthChecks(),
  ];
}
