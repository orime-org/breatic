// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one place an agent's three things are decided: model, instructions,
 * tools.
 *
 * The chat turn is its one caller. It runs inside a request, and the tool set
 * is built per call: the proposal tool's description quotes the template
 * prompts in the request's language.
 *
 * Execution, step ceilings and temperature stay with the caller, which makes
 * its own model call with this config.
 */
import type { Tool } from "ai";
import { getAgentConfig } from "@breatic/core";
import type { MemoryContext } from "@breatic/shared";
import { instructionsForAgentMemory, type Instructions } from "@domain/agent/instructions.js";
import { resolveModelPictureCapability } from "@domain/agent/model-picture-capability.js";
import type { AgentPicturePolicy } from "@domain/agent/project-agent-request.js";
import {
  BASELINE_TOOLS,
  CANVAS_TOOLS,
  buildToolSet,
  type ToolContext,
} from "@domain/agent/tools/index.js";

export { instructionsForAgentMemory } from "@domain/agent/instructions.js";

/** What a caller tells the factory about the run it is about to start. */
export interface AgentConfigRequest {
  /**
   * The base system prompt, already assembled by the caller.
   *
   * Passed in rather than built here because what belongs in it is an
   * application decision.
   */
  basePrompt: string;
  /** The conversation and project layers, when the caller has any. */
  memoryContext?: MemoryContext;
  /** What the turn knows that a tool needs when it is built. */
  toolContext?: ToolContext;
  /** Stop this turn's wait without cancelling the shared model-directory query. */
  signal?: AbortSignal;
}

/** The three things, resolved. */
export interface ResolvedAgentConfig {
  /**
   * The model identifier, not an instantiated provider.
   *
   * A string so two configs can be compared, and so the resolution stays in
   * one place.
   */
  modelId: string;
  /** The system prompt in its parts; `systemFor` decides whether they go as separate blocks. */
  instructions: Instructions;
  /** Tools, ready for the AI SDK's `tools` option. */
  tools: Record<string, Tool>;
  /** Fixed native-picture capability shared by messages and tools for this turn. */
  seesPictures: boolean;
  /** Fixed request-projection policy, also included in the history prefix seed. */
  picturePolicy?: AgentPicturePolicy;
}

/**
 * Resolve model, instructions and tools for one agent run.
 * @param request - What the caller knows about this run.
 * @returns The three things, decided in one place.
 * @throws {unknown} The turn's stop reason when capability resolution is cancelled.
 */
export async function buildAgentConfig(
  request: AgentConfigRequest,
): Promise<ResolvedAgentConfig> {
  const { basePrompt, memoryContext, toolContext } = request;
  const config = getAgentConfig();
  const modelId = config.default_model;
  const seesPictures = await resolveModelPictureCapability(modelId, {
    override: config.main_model_sees_pictures,
    timeoutMs: config.model_catalog_timeout_ms,
    ttlMs: config.model_catalog_ttl_ms,
    retryMs: config.model_catalog_retry_ms,
  }, request.signal);
  const picturePolicy: AgentPicturePolicy = {
    seesPictures,
    maxPictures: config.chat_pictures_max,
    maxBytes: config.chat_pictures_max_bytes,
    pictureTokensEstimate: config.picture_tokens_estimate,
  };
  const toolNames = [...BASELINE_TOOLS, ...CANVAS_TOOLS];
  return {
    modelId,
    instructions: instructionsForAgentMemory(basePrompt, memoryContext),
    tools: buildToolSet(toolNames, { ...toolContext, mediaUrlAllowed: toolContext?.mediaUrlAllowed ?? (() => false), seesPictures }),
    seesPictures,
    picturePolicy,
  };
}
