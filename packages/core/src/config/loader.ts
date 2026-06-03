// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * YAML configuration loader.
 *
 * Reads and parses YAML config files for agent behavior parameters
 * and model catalogs. Returns frozen readonly objects.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const agentConfigSchema = z.object({
  max_tool_iterations: z.number().int().positive().default(40),
  default_model: z.string().default("anthropic/claude-sonnet-4-6"),
  consolidation_model: z.string().default("anthropic/claude-sonnet-4-6"),
  memory_window: z.number().int().positive().default(20),
  memory_keep_recent_turns: z.number().int().positive().default(3),
  full_detail_turns: z.number().int().positive().default(3),
  memory_project_max_size: z.number().int().positive().default(3072),
  memory_user_max_size: z.number().int().positive().default(2048),
  web_fetch_max_chars: z.number().int().positive().default(50000),
});

/** Validated agent configuration type. */
export type AgentConfig = z.infer<typeof agentConfigSchema>;

let _cachedConfig: Readonly<AgentConfig> | null = null;

/**
 * Load and validate agent configuration from YAML.
 * @param configDir - Path to the config directory (defaults to `../../config`)
 * @returns Frozen, validated agent configuration
 */
export function getAgentConfig(configDir?: string): Readonly<AgentConfig> {
  if (_cachedConfig) return _cachedConfig;

  const dir = configDir ?? resolve(MONOREPO_ROOT, "config");
  const filePath = resolve(dir, "agent.yaml");
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw) as unknown;
  const config = agentConfigSchema.parse(parsed);

  _cachedConfig = Object.freeze(config);
  return _cachedConfig;
}

/** Reset cached config (for testing). */
export function resetAgentConfig(): void {
  _cachedConfig = null;
}
