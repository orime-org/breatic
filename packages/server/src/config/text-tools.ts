// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Text mini-tool configuration.
 *
 * The model, its thinking level, the two length budgets and the pace the
 * user's screen shows the answer at are loaded from
 * `config/text-tools.yaml`. System prompts are defined inline (not
 * user-configurable).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

const textToolsConfigSchema = z
  .object({
    model: z.string().default("google/gemini-3.8-flash"),
    thinking_level: z.enum(["low", "medium", "high"]).default("low"),
    selection_max_chars: z.number().int().positive().default(40000),
    context_max_chars: z.number().int().positive().default(200000),
    reveal_chars_per_second: z.number().int().positive().default(60),
  })
  .refine((config) => config.selection_max_chars <= config.context_max_chars, {
    message: "selection_max_chars must not exceed context_max_chars",
    path: ["selection_max_chars"],
  });

/** The text tools' settings, as `config/text-tools.yaml` gives them. */
export type TextToolsConfig = z.infer<typeof textToolsConfigSchema>;

let _cached: TextToolsConfig | null = null;

/**
 * Load and cache the text mini-tool config from `config/text-tools.yaml`.
 * @returns The validated text-tools config (memoized after the first read).
 * @throws {z.ZodError} When the file breaks the schema, including a selection
 *   budget larger than the context budget.
 */
export function getTextToolsConfig(): TextToolsConfig {
  if (_cached) return _cached;
  const dir = resolve(MONOREPO_ROOT, "config");
  const raw = readFileSync(resolve(dir, "text-tools.yaml"), "utf-8");
  _cached = textToolsConfigSchema.parse(parse(raw) as unknown);
  return _cached;
}

/**
 * How the document AI menu's fixed commands read the selection and write the
 * answer (inner#1860, design §5.1): the selection comes as one piece of
 * Markdown and the whole answer goes back as Markdown of the same shape.
 */
const MARKDOWN_SHAPE =
  "The selected text is Markdown. Return Markdown with the same structure " +
  "(headings, lists, emphasis, links) unless the task says otherwise.";

/** How custom reads the selection: the request decides the structure. */
const MARKDOWN_IN_OUT = "The selected text is Markdown. Return Markdown.";

/** System prompts per tool. */
const PROMPTS: Record<string, string> = {
  polish:
    "You are a professional writing editor. Improve the selected text's clarity, " +
    "grammar, flow, and word choice while preserving the original meaning and tone. " +
    "Keep the style consistent with the surrounding document. " +
    `${MARKDOWN_SHAPE} Return ONLY the improved text, nothing else.`,

  expand:
    "You are a skilled content writer. Expand the selected text into a more detailed, " +
    "richer version. Add context, examples, and nuance while maintaining the original " +
    "voice and the document's overall direction. A paragraph may become several paragraphs. " +
    `${MARKDOWN_SHAPE} Return ONLY the expanded text, nothing else.`,

  shorten:
    "You are a concise editor. Make the selected text shorter while keeping its meaning, " +
    "its key details and its voice: cut repetition, filler and wordy phrasing rather than " +
    "reducing it to a list of key points. " +
    `${MARKDOWN_SHAPE} Return ONLY the shortened text, nothing else.`,

  summarize:
    "You are an expert summarizer. Condense the selected text into its key points. " +
    "Preserve the most important information and maintain clarity. " +
    "Return ONLY the summary, nothing else.",

  translate:
    "You are a professional translator. Translate the selected text into the target " +
    "language named in the request naturally — not word-for-word. Adapt idioms and " +
    "cultural references for the target audience while keeping the meaning accurate. " +
    `${MARKDOWN_SHAPE} Return ONLY the translated text, nothing else.`,

  rewrite:
    "You are a versatile writer. Rewrite the selected text in the tone given in the " +
    "request, keeping its meaning. If no tone is given, improve clarity and engagement " +
    "while preserving the meaning. " +
    `${MARKDOWN_SHAPE} Return ONLY the rewritten text, nothing else.`,

  custom:
    "You are a capable writing assistant. Apply the user's request to the selected text. " +
    "Write in the language the request asks for; when it names none, write in the " +
    "language of the selected text. " +
    `${MARKDOWN_IN_OUT} Return ONLY the resulting text, nothing else.`,

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
 * Tools whose output language is set by the request itself, so the
 * same-language instruction would contradict it.
 */
const LANGUAGE_FROM_REQUEST = new Set(["translate", "custom"]);

/**
 * Get the model string for a text tool.
 * @param _toolName - Tool name (currently all tools use the same model)
 * @returns Model identifier
 */
export function getModelForTool(_toolName: string): string {
  return getTextToolsConfig().model;
}

/**
 * Every model a text tool can run on, each once.
 * @returns The model ids.
 */
export function textToolModels(): string[] {
  return [...new Set(Object.keys(PROMPTS).map((name) => getModelForTool(name)))];
}

/**
 * Language instruction appended to the prompts whose output follows the input.
 * The request also carries the document around the selection, which can be in
 * another language; the answer replaces the selection, so it follows that. A
 * tool that takes no selection follows the request.
 */
const LANGUAGE_INSTRUCTION =
  "\n\nIMPORTANT: Respond in the language of the selected text (with no selected text, " +
  "the language of the user's request), whatever language the surrounding document is in.";

/**
 * Get the system prompt for a text tool.
 *
 * Appends the language-matching instruction, except for the tools whose
 * request names the output language (translate, custom).
 * @param toolName - Tool name (e.g. "polish", "generate")
 * @returns System prompt string
 */
export function getPromptForTool(toolName: string): string {
  const base = PROMPTS[toolName] ?? "You are a helpful writing assistant.";
  return LANGUAGE_FROM_REQUEST.has(toolName) ? base : base + LANGUAGE_INSTRUCTION;
}
