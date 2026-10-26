// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { BlockNoteEditor } from '@blocknote/core';
import type { EditorState, Selection, Transaction } from '@tiptap/pm/state';
import type * as Y from 'yjs';

import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import type { BodyJournal, BodyJournalSnapshot } from '@web/spaces/document/document-body-journal';
import type { BodySelectionName } from '@web/spaces/document/document-body-positions-types';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';

/** The source of one complete accepted transaction batch. */
export type BodyTransactionSource = 'user' | 'machine' | 'projection' | 'metadata';

/** The synchronous state of one bound editor's mutation boundary. */
export type BodyBindingPhase = 'idle' | 'collecting' | 'preflighting' | 'registering' | 'committing' | 'projecting' | 'frozen' | 'closed';

/** Existing handle-owned resources passed into records editor construction. */
export interface DocumentBodyOptions {
  readonly document: string;
  readonly runtime: DocumentBodyRuntime;
  readonly history: Y.UndoManager;
  readonly origin: object;
}

/** A root and its accepted append loop retain their original frame and selection. */
export interface BodyAcceptedBatch {
  readonly id: string;
  readonly root: Transaction;
  readonly revision: number;
  readonly before: BodyProjection;
  readonly preSelection: BodySelectionName;
  readonly source: 'user' | 'machine';
  readonly journal: BodyJournal;
  readonly accepted: BodyJournalSnapshot;
}

/** History and final consumers observe only a successfully committed frame. */
export interface BodyAppliedBatch {
  readonly id: string;
  readonly source: 'user' | 'machine';
  readonly preSelection: BodySelectionName;
  readonly postSelection: Selection;
  readonly projection: BodyProjection;
}

/** The common handle API shared by native history and final writer consumers. */
export interface DocumentBodyBindingAccess {
  readonly doc: Y.Doc;
  readonly document: string;
  readonly runtime: DocumentBodyRuntime;
  readonly history: Y.UndoManager;
  readonly origin: object;
  read: (state?: EditorState) => BodyProjection;
  phase: () => BodyBindingPhase;
  canWrite: () => boolean;
  requestSelection: (selection: BodySelectionName) => void;
  subscribeApplied: (listener: (batch: BodyAppliedBatch) => void) => () => void;
  dispose: () => void;
}

/** Each immutable PM state owns its matching accepted batch or published frame. */
export interface BodyBindingPluginState {
  readonly owner: DocumentBodyBindingAccess;
  readonly frame: BodyProjection | null;
  readonly batch: BodyAcceptedBatch | null;
  readonly source: BodyTransactionSource;
}

/** The real BlockNote editor type used at the factory and binding boundary. */
export type BoundBodyEditor = BlockNoteEditor<never, never, never>;
