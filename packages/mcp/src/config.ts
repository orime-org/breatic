// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The MCP service's environment (breatic#1488 §13). It reads only the
 * variables it uses, picked from core's definitions, and never calls
 * `initCore`: core's schema requires both database URLs and this service
 * connects to no database.
 */

import { coreEnvSchema } from "@breatic/core";
import { resolveRedisKeyPrefix } from "@breatic/shared";
import { z } from "zod";

const SECRET_REQUIRED = "MCP_CLIENT_SECRET must be set: the MCP service exchanges every agent token with it";

const mcpEnvSchema = coreEnvSchema
  .pick({
    ENV: true,
    DEBUG: true,
    REDIS_MCP_URL: true,
    REDIS_KEY_PREFIX: true,
    MCP_PORT: true,
    MCP_HEALTH_PORT: true,
    MCP_PUBLIC_URL: true,
    MCP_API_BASE_URL: true,
    MCP_CLIENT_SECRET: true,
    OAUTH_ISSUER: true,
  })
  .extend({
    // Every call exchanges the agent's token with this secret; without it the
    // service has nothing it can answer.
    MCP_CLIENT_SECRET: z.string({ error: SECRET_REQUIRED }).trim().min(1, SECRET_REQUIRED),
  })
  .transform((c) => ({ ...c, REDIS_KEY_PREFIX: resolveRedisKeyPrefix(c.REDIS_KEY_PREFIX, c.ENV) }));

/** The MCP service's validated environment. */
export type McpEnv = z.infer<typeof mcpEnvSchema>;

/**
 * Validate the raw environment for the MCP service.
 * @param rawEnv - The process environment.
 * @returns The variables the service reads, parsed.
 * @throws {z.ZodError} When a variable is missing or malformed.
 */
export function parseMcpEnv(rawEnv: Record<string, string | undefined>): McpEnv {
  return mcpEnvSchema.parse(rawEnv);
}
