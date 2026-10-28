// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** One caption editor's local state, owned by the open document. */
export interface CaptionDraft {
  readonly blockId: string;
  readonly phase: 'closed' | 'editing' | 'suspended' | 'retained';
  readonly base: string;
  readonly value: string;
  readonly shared: string;
  readonly dirty: boolean;
  readonly composing: boolean;
  readonly readOnly: boolean;
  readonly exists: boolean;
  /** Identifies the current input lifetime across detach and explicit close. */
  readonly session: number;
}

/** Current shared facts, read by the caller when an event occurs. */
export interface CaptionDraftContext {
  readonly caption: string;
  readonly readOnly: boolean;
  readonly exists: boolean;
}

/** The events accepted by the document's single caption state writer. */
export type CaptionDraftEvent =
  | ({ readonly type: 'open' } & CaptionDraftContext)
  | ({ readonly type: 'sync' } & CaptionDraftContext)
  | { readonly type: 'input' | 'composition-start' | 'composition-end'; readonly session: number; readonly value: string }
  | { readonly type: 'detach'; readonly session: number; readonly value?: string }
  | { readonly type: 'cancel'; readonly session: number; readonly caption: string }
  | ({ readonly type: 'commit'; readonly session: number; readonly write: (value: string) => void } & CaptionDraftContext);

/** Stable snapshots and one event entry point for a document's local captions. */
export interface CaptionDrafts {
  /** Reads one block's current snapshot. */
  get(blockId: string): CaptionDraft | undefined;
  /** Reads the same array until an event changes a draft. */
  all(): readonly CaptionDraft[];
  /** Subscribes to snapshot changes and returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Applies a caption event, checking its input lifetime before editing.
   * @throws {Error} When the shared caption writer throws.
   */
  event(blockId: string, event: CaptionDraftEvent): void;
  /** Releases drafts and subscriptions when their document closes. */
  dispose(): void;
}

/**
 * The initial closed editor for a known media block.
 * @param blockId - The stable block identity.
 * @param context - Current shared facts.
 * @returns The clean snapshot.
 */
function initialDraft(blockId: string, context: CaptionDraftContext): CaptionDraft {
  return {
    blockId, phase: 'closed', base: context.caption, value: context.caption,
    shared: context.caption, dirty: false, composing: false,
    readOnly: context.readOnly, exists: context.exists, session: 0,
  };
}

/**
 * Incorporates current shared facts while preserving a local edit's baseline.
 * @param draft - The previous snapshot.
 * @param context - Current shared caption, permission and target presence.
 * @returns The reconciled snapshot.
 */
function withFacts(draft: CaptionDraft, context: CaptionDraftContext): CaptionDraft {
  const clean = !draft.dirty && !draft.composing;
  const removed = draft.exists && !context.exists && draft.phase !== 'closed';
  return {
    ...draft,
    shared: context.caption,
    base: clean ? context.caption : draft.base,
    value: clean ? context.caption : draft.value,
    readOnly: context.readOnly,
    exists: context.exists,
    phase: draft.phase === 'closed' ? 'closed' : !context.exists ? 'retained' : context.readOnly ? 'suspended' : 'editing',
    composing: removed ? false : draft.composing,
    session: draft.session + (removed ? 1 : 0),
  };
}

/**
 * Creates the local draft state held by one open document.
 * @returns The store whose only state writer is its event entry point.
 */
export function createCaptionDrafts(): CaptionDrafts {
  const drafts = new Map<string, CaptionDraft>();
  const listeners = new Set<() => void>();
  let snapshots: readonly CaptionDraft[] = [];
  let disposed = false;

  /**
   * Publishes one changed immutable snapshot.
   * @param next - The state produced by the event entry point.
   */
  const publish = (next: CaptionDraft): void => {
    const current = drafts.get(next.blockId);
    const candidate = { ...next, dirty: next.value !== next.base };
    if (current !== undefined && (Object.keys(candidate) as (keyof CaptionDraft)[]).every((key) => current[key] === candidate[key])) return;
    drafts.set(next.blockId, candidate);
    snapshots = [...drafts.values()];
    listeners.forEach((listener) => listener());
  };

  /**
   * Applies shared facts or a current input's local event.
   * @param blockId - The stable block identity.
   * @param event - The event and its current facts.
   * @throws {Error} When the shared caption writer throws.
   */
  const event = (blockId: string, event: CaptionDraftEvent): void => {
    if (disposed) return;
    const current = drafts.get(blockId);
    if (event.type === 'open' || event.type === 'sync') {
      const previous = current ?? initialDraft(blockId, event);
      const next = withFacts(previous, event);
      if (event.type === 'open' && previous.phase === 'closed') {
        publish({
          ...next, phase: !event.exists ? 'retained' : event.readOnly ? 'suspended' : 'editing',
          base: event.caption, value: event.caption, composing: false, session: previous.session + 1,
        });
      } else publish(next);
      return;
    }
    if (current === undefined || event.session !== current.session || current.phase === 'closed') return;
    switch (event.type) {
      case 'input':
      case 'composition-start':
      case 'composition-end': {
        if (current.phase === 'retained') return;
        const composing = event.type === 'composition-start' || (event.type === 'input' && current.composing);
        const cleanEnd = event.type === 'composition-end' && event.value === current.base;
        publish({
          ...current, composing,
          base: cleanEnd ? current.shared : current.base,
          value: cleanEnd ? current.shared : event.value,
        });
        return;
      }
      case 'detach':
        publish({ ...current, value: event.value ?? current.value, composing: false, session: current.session + 1 });
        return;
      case 'cancel':
        if (!current.composing) publish({
          ...current, phase: 'closed', base: event.caption, value: event.caption,
          shared: event.caption, composing: false, session: current.session + 1,
        });
        return;
      case 'commit': {
        const next = withFacts(current, event);
        if (!next.exists || next.readOnly || next.composing) {
          publish(next);
          return;
        }
        const value = next.value !== next.base ? next.value : event.caption;
        if (next.value !== next.base) event.write(value);
        publish({
          ...next, phase: 'closed', base: value, value, shared: value,
          composing: false, session: next.session + 1,
        });
        return;
      }
    }
  };

  return {
    get: (blockId) => drafts.get(blockId),
    all: () => snapshots,
    subscribe: (listener) => {
      if (!disposed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    event,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      drafts.clear();
      snapshots = [];
      listeners.forEach((listener) => listener());
      listeners.clear();
    },
  };
}

const editorDrafts = new WeakMap<object, CaptionDrafts>();

/**
 * Reads the same draft store from an editor handle and its presentation tree.
 * @param editor - The document's editor identity.
 * @returns Its local caption store, released by the owning document cache.
 */
export function captionDraftsFor(editor: object): CaptionDrafts {
  let drafts = editorDrafts.get(editor);
  if (drafts === undefined) {
    drafts = createCaptionDrafts();
    editorDrafts.set(editor, drafts);
  }
  return drafts;
}
