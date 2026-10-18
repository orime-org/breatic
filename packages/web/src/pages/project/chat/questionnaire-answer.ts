// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a questionnaire card sends its answers (inner#1542).
 *
 * The card sits deep inside a message, and the conversation it answers in is
 * held by the panel; the panel provides this, and a card rendered without it
 * (a message read on its own) has nowhere to send and only reads.
 */
import * as React from 'react';
import type { AskUserAnswer } from '@breatic/shared';

/** Sends a card's answers; resolves when the turn they resume is over. */
export type AnswerQuestionnaire = (toolCallId: string, answers: AskUserAnswer['answers']) => Promise<void>;

/** The panel's way of answering, or undefined outside one. */
export const QuestionnaireAnswerContext = React.createContext<AnswerQuestionnaire | undefined>(undefined);
