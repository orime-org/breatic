// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The model every reading runs on (user 2026-09-19: the reader presses
 * Understand, nobody picks a model). Here because both ends name it: the
 * server opens the task row under this id and the task list shows the name
 * beside it. Which backend serves it stays with the domain.
 */
export const UNDERSTAND_MODEL = {
  id: "google/gemini-3.8-flash",
  displayName: "Gemini 3.8 Flash",
} as const;
