/**
 * LLM provider configuration using Vercel AI SDK.
 *
 * Configures model providers from environment variables.
 * Default provider: OpenRouter (supports 100+ models).
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { env } from "@breatic/core";

// Providers are built LAZILY (on first use), not at module import:
// each reads an API key from the injected config (`env.*`), which is
// only available after the application entry runs `initCore`. This
// mirrors the lazy db / Redis singletons — importing this module has
// no env dependency, so the `@breatic/core` barrel stays importable
// before initialization.

type OpenAIProvider = ReturnType<typeof createOpenAI>;
type AnthropicProvider = ReturnType<typeof createAnthropic>;
type GoogleProvider = ReturnType<typeof createGoogleGenerativeAI>;

let _openrouter: OpenAIProvider | null = null;
let _anthropic: AnthropicProvider | null = null;
let _google: GoogleProvider | null = null;
let _openai: OpenAIProvider | null = null;

/** OpenRouter provider (default — routes to any model). */
function getOpenrouter(): OpenAIProvider {
  if (_openrouter === null) {
    _openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: env.OPENROUTER_API_KEY || undefined,
    });
  }
  return _openrouter;
}

/** Direct Anthropic provider (for Claude models). */
function getAnthropic(): AnthropicProvider {
  if (_anthropic === null) {
    _anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY || undefined });
  }
  return _anthropic;
}

/** Direct Google provider (for Gemini models). */
function getGoogle(): GoogleProvider {
  if (_google === null) {
    _google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY || undefined });
  }
  return _google;
}

/** Direct OpenAI provider. */
function getOpenai(): OpenAIProvider {
  if (_openai === null) {
    _openai = createOpenAI({ apiKey: env.OPENAI_API_KEY || undefined });
  }
  return _openai;
}

/**
 * Get an AI SDK model instance by model string.
 *
 * Supports `provider/model` format (e.g. `"anthropic/claude-sonnet-4-6"`)
 * or plain model names (routed through OpenRouter by default).
 *
 * @param modelString - Model identifier. Defaults to OpenRouter Claude.
 * @returns AI SDK LanguageModel instance
 */
export function getModel(modelString?: string): ReturnType<OpenAIProvider> {
  const model = modelString ?? "anthropic/claude-sonnet-4-6";

  // Route to direct provider if API key is configured, otherwise fall back to OpenRouter
  if (model.startsWith("anthropic/") && env.ANTHROPIC_API_KEY) {
    return getAnthropic()(model.replace("anthropic/", ""));
  }
  if (model.startsWith("google/") && env.GOOGLE_API_KEY) {
    return getGoogle()(model.replace("google/", ""));
  }
  if (model.startsWith("openai/") && env.OPENAI_API_KEY) {
    return getOpenai()(model.replace("openai/", ""));
  }

  // Fall back to OpenRouter (supports all models via unified API)
  return getOpenrouter()(model);
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
