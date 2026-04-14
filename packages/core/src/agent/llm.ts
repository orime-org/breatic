/**
 * LLM provider configuration using Vercel AI SDK.
 *
 * Configures model providers from environment variables.
 * Default provider: OpenRouter (supports 100+ models).
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { env } from "../config/env.js";

/** OpenRouter provider (default — routes to any model). */
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: env.OPENROUTER_API_KEY || undefined,
});

/** Direct Anthropic provider (for Claude models). */
const anthropic = createAnthropic({
  apiKey: env.ANTHROPIC_API_KEY || undefined,
});

/** Direct Google provider (for Gemini models). */
const google = createGoogleGenerativeAI({
  apiKey: env.GOOGLE_API_KEY || undefined,
});

/** Direct OpenAI provider. */
const openai = createOpenAI({
  apiKey: env.OPENAI_API_KEY || undefined,
});

/**
 * Get an AI SDK model instance by model string.
 *
 * Supports `provider/model` format (e.g. `"anthropic/claude-sonnet-4-6"`)
 * or plain model names (routed through OpenRouter by default).
 *
 * @param modelString - Model identifier. Defaults to OpenRouter Claude.
 * @returns AI SDK LanguageModel instance
 */
export function getModel(modelString?: string): ReturnType<typeof openrouter> {
  const model = modelString ?? "anthropic/claude-sonnet-4-6";

  // Route to direct provider if API key is configured, otherwise fall back to OpenRouter
  if (model.startsWith("anthropic/") && env.ANTHROPIC_API_KEY) {
    return anthropic(model.replace("anthropic/", ""));
  }
  if (model.startsWith("google/") && env.GOOGLE_API_KEY) {
    return google(model.replace("google/", ""));
  }
  if (model.startsWith("openai/") && env.OPENAI_API_KEY) {
    return openai(model.replace("openai/", ""));
  }

  // Fall back to OpenRouter (supports all models via unified API)
  return openrouter(model);
}

/**
 * Resolve the actual provider name for a model string.
 *
 * Returns the provider that getModel() would route to.
 * Used for recording the actual provider in credit transactions.
 */
export function resolveProvider(modelString?: string): string {
  const model = modelString ?? "anthropic/claude-sonnet-4-6";

  if (model.startsWith("anthropic/") && env.ANTHROPIC_API_KEY) return "anthropic";
  if (model.startsWith("google/") && env.GOOGLE_API_KEY) return "google";
  if (model.startsWith("openai/") && env.OPENAI_API_KEY) return "openai";

  return "openrouter";
}
