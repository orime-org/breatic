// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a request card reads the Spaces it was asked for and sends the
 * reader's answer (inner#1552).
 *
 * The card sits deep inside a message, and the conversation and the project's
 * Spaces are held by the panel; the panel provides this, as it does for the
 * questionnaire card, and a card drawn without it only reads.
 */
import * as React from 'react';
import type { SharedSpace, SpaceRequestAnswer } from '@breatic/shared';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import type { ChatSpaceRequest } from '@web/pages/project/chat/types';

/** The panel's way of reading and answering, and whether a turn is running in its conversation. */
export interface SpaceRequestAnswering {
  /** Every Space in the project, which a waiting card names its Spaces from. */
  spaces: readonly ProjectSpace[];
  /** A turn is running in the conversation, so no answer can go yet. */
  busy: boolean;
  /**
   * Read the Spaces a request asks for, at the collaboration address the
   * shared socket dials; rejects once the signal is raised.
   */
  read: (request: ChatSpaceRequest, url: string, signal: AbortSignal) => Promise<SharedSpace[]>;
  /** Send the reader's answer; resolves when the turn it resumes is over. */
  answer: (answer: SpaceRequestAnswer) => Promise<void>;
}

/** The panel's way of reading and answering, or undefined outside one. */
export const SpaceRequestAnswerContext = React.createContext<SpaceRequestAnswering | undefined>(undefined);
