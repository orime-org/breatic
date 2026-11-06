// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the bubble bar's AI menu reaches the AI output dialog (inner#1860): the
 * dialog (`DocumentAiDialog.tsx`) wraps the editor's chrome and provides a
 * launcher here, and the menu's rows call it. Apart from the dialog so the
 * menu does not import the dialog, which imports the bar.
 */

import * as React from 'react';

import type { TextToolTone } from '@breatic/shared';
import type { AiCommand } from '@web/spaces/document/document-ai-session';

/** The catalog key of each tone's label, written out for the catalog scan. */
export const TONE_LABEL_KEYS: Record<TextToolTone, string> = {
  professional: 'spaces.document.ai.tone.professional',
  casual: 'spaces.document.ai.tone.casual',
  straightforward: 'spaces.document.ai.tone.straightforward',
  confident: 'spaces.document.ai.tone.confident',
  friendly: 'spaces.document.ai.tone.friendly',
};

/**
 * Opens the dialog on a command, over the user's current selection.
 * @param command - The command.
 * @param opener - The bar the command was pressed on, whose place a
 *   select-all's dialog is pinned to.
 */
export type AiLaunch = (command: AiCommand, opener: HTMLElement | null) => void;

/** The launcher, provided by the dialog. */
export const DocumentAiLaunchContext = React.createContext<AiLaunch | null>(null);

/**
 * What opens the AI output dialog, for the bubble bar's AI menu.
 * @returns The launcher, or null outside a document editor.
 */
export function useDocumentAiLaunch(): AiLaunch | null {
  return React.useContext(DocumentAiLaunchContext);
}
