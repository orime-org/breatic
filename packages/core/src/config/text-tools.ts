/**
 * Text mini-tool configuration.
 *
 * Model is loaded from `config/text-tools.yaml`.
 * System prompts are defined inline (not user-configurable).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const textToolsConfigSchema = z.object({
  model: z.string().default("google/gemini-2.5-flash"),
});

let _cached: z.infer<typeof textToolsConfigSchema> | null = null;

function loadConfig(): z.infer<typeof textToolsConfigSchema> {
  if (_cached) return _cached;
  const dir = resolve(import.meta.dirname, "../../../../config");
  const raw = readFileSync(resolve(dir, "text-tools.yaml"), "utf-8");
  _cached = textToolsConfigSchema.parse(parse(raw) as unknown);
  return _cached;
}

/** System prompts per tool. */
const PROMPTS: Record<string, string> = {
  polish:
    "You are a professional writing editor. Improve the selected text's clarity, " +
    "grammar, flow, and word choice while preserving the original meaning and tone. " +
    "Keep the style consistent with the surrounding document. " +
    "Return ONLY the improved text, nothing else.",

  expand:
    "You are a skilled content writer. Expand the selected text into a more detailed, " +
    "richer version. Add context, examples, and nuance while maintaining the original " +
    "voice and the document's overall direction. " +
    "Return ONLY the expanded text, nothing else.",

  summarize:
    "You are an expert summarizer. Condense the selected text into its key points. " +
    "Preserve the most important information and maintain clarity. " +
    "Return ONLY the summary, nothing else.",

  translate:
    "You are a professional translator. Translate the selected text into the target " +
    "language naturally — not word-for-word. Adapt idioms and cultural references " +
    "for the target audience while keeping the meaning accurate. " +
    "Return ONLY the translated text, nothing else.",

  rewrite:
    "You are a versatile writer. Rewrite the selected text in a different style " +
    "or from a different angle as instructed. If no specific style is given, " +
    "improve clarity and engagement while preserving the meaning. " +
    "Return ONLY the rewritten text, nothing else.",

  continue:
    "You are a creative writer. Continue writing from where the selected text " +
    "ends. Match the tone, style, and narrative direction of the existing content. " +
    "Write naturally as if the original author is continuing. " +
    "Return ONLY the continuation, nothing else.",

  generate:
    "You are a versatile content creator. Generate text based on the user's " +
    "instructions. Follow any format, style, or structural requirements specified. " +
    "Be creative, detailed, and professional.",

  character:
    "You are an expert character designer for creative projects. Create a detailed " +
    "character description including appearance, personality, background, motivations, " +
    "and notable traits. Make the character vivid and memorable.",

  storyboard:
    "You are a professional storyboard writer. Create a scene-by-scene breakdown " +
    "in markdown table format with columns: Scene #, Visual Description, Camera/Angle, " +
    "Dialogue/Narration, Duration, Notes. " +
    "Each scene should be vivid and actionable for artists/animators.",

  script:
    "You are a professional screenwriter. Write dialogue and stage directions in " +
    "standard script format. Characters should have distinct voices. Include " +
    "emotional beats, pauses, and action lines.",
};

/**
 * Get the model string for a text tool.
 *
 * @param _toolName - Tool name (currently all tools use the same model)
 * @returns Model identifier
 */
export function getModelForTool(_toolName: string): string {
  return loadConfig().model;
}

/** Language instruction appended to all prompts. */
const LANGUAGE_INSTRUCTION =
  "\n\nIMPORTANT: Respond in the same language as the user's input. " +
  "If the document or selection is in Chinese, respond in Chinese. " +
  "If in English, respond in English. Match the input language exactly.";

/**
 * Get the system prompt for a text tool.
 *
 * Automatically appends a language-matching instruction so the LLM
 * responds in the same language as the user's document.
 *
 * @param toolName - Tool name (e.g. "polish", "generate")
 * @returns System prompt string with language instruction
 */
export function getPromptForTool(toolName: string): string {
  const base = PROMPTS[toolName] ?? "You are a helpful writing assistant.";
  return base + LANGUAGE_INSTRUCTION;
}
