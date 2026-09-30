// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a reading asks, in the language its reader will read the answer in.
 *
 * The words this run produces become a text node's body, and whoever opens
 * that node set a language. Nothing about the media says which one that is,
 * so the browser sends it along and it travels as a locale code — the answer
 * is a sentence only the model can write, so naming the language is the last
 * thing done to the question before it goes out.
 */

import { extractPromptText } from "@breatic/shared";

/**
 * How each locale's language is named to the model.
 *
 * The five this product ships. A code absent from here names no language,
 * which is what a run carrying no locale at all does too: the model answers
 * however it sees fit, the way every reading did before the locale travelled.
 */
const ANSWER_LANGUAGE: Readonly<Record<string, string>> = {
  en: "English",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  ja: "Japanese",
  ko: "Korean",
};

/**
 * Build the question one reading asks.
 * @param prompt - What the reader typed, when they typed one.
 * @param sourceType - The medium being read, for the default question.
 * @param readerLocale - The locale the answer is read in, when one travelled.
 * @returns The question, with the language named when it is one we ship.
 */
export function understandQuestion(
  prompt: unknown,
  sourceType: string,
  readerLocale: unknown,
): string {
  const asked = extractPromptText(prompt) || `Describe this ${sourceType}.`;
  const language =
    typeof readerLocale === "string" ? ANSWER_LANGUAGE[readerLocale] : undefined;
  return language === undefined ? asked : `${asked} Answer in ${language}.`;
}
