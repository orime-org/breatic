// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a transcription asks (inner#856).
 *
 * Keeps the words in their spoken language, a new line per speaker and
 * Chinese in the reader's script. It names no answer language, because
 * asking for one makes the model translate.
 */

/** The fillers named to the model, in the languages it is likely to hear. */
const FILLERS = "um, uh, er, \u55ef, \u5443, \u90a3\u4e2a, \u5c31\u662f\u8bf4";

/**
 * Build the question one transcription asks.
 * @param sourceType - The medium being transcribed.
 * @param keepFillers - Whether filler words stay as spoken.
 * @param readerLocale - The locale the reader set, when one travelled.
 * @returns The question.
 */
export function transcribeQuestion(
  sourceType: string,
  keepFillers: boolean,
  readerLocale: unknown,
): string {
  const script = readerLocale === "zh-TW" ? "Traditional" : "Simplified";
  const fillers = keepFillers
    ? `Keep filler words (such as ${FILLERS}), repetitions and false starts exactly as spoken.`
    : `Leave out filler words (such as ${FILLERS}), stutters and repeated words, without changing any other word.`;
  return [
    `Transcribe the speech in this ${sourceType}.`,
    "Write the words exactly as they are spoken, in the language they are spoken in; do not translate, summarise or describe.",
    "Output only the transcript.",
    "Start a new line whenever a different person starts speaking.",
    `Write any Chinese in ${script} Chinese characters.`,
    fillers,
  ].join(" ");
}

/**
 * Whether a reading task is a transcription.
 * @param params - The task's params.
 * @returns True when the task asked for a transcription.
 */
export function isTranscription(params: Readonly<Record<string, unknown>>): boolean {
  return params.reading === "transcribe";
}
