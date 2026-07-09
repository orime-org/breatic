// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Frontend prompt document types — the structured shape of a generative node's
 * `prompt`. At runtime the prompt is a `Y.XmlFragment` (`data.prompt`), opaque
 * (`unknown`) on the wire. These types live in web, NOT `@breatic/shared`: the
 * backend never reads the chip structure — it extracts plain text via
 * `extractPromptText` — so only the frontend TipTap editor needs them. (Moved
 * out of shared 2026-07-08: zero backend consumers + the wire treats prompt as
 * opaque, so they were misplaced.)
 */

/** Source node modality for a prompt chip snapshot. */
export type GenerativeRefSourceType = 'image' | 'video' | 'audio' | 'text';

/**
 * Frozen snapshot of a reference at the moment the user @-inserts it into the
 * prompt (slice 2). Its DISPLAY is frozen — renaming the upstream does not
 * change the chip's captured name / thumbnail. But its LIFECYCLE is tied to
 * the reference it was inserted from: removing that reference (deleting the
 * incoming edge, or deleting the upstream node which cascades the edge) also
 * removes every chip in the prompt that points at that source (user decision
 * 2026-07-08). `sourceNodeId` links the chip back to its reference for this
 * cascade and for "jump to source" UX. (Slice 1 has no chips — plain-text
 * prompt only — so this cascade first applies in slice 2.)
 */
export interface ChipSnapshot {
  /** Unique id for this chip; each @-insertion produces a new id even when the source is the same. */
  chipId: string;
  /** Source node the chip points at; deleting that reference removes the chip. */
  sourceNodeId: string;
  sourceNodeType: GenerativeRefSourceType;
  /** Frozen display name from the moment of capture. */
  snapshotName: string;
  snapshotThumbnail?: string;
  /** Frozen content excerpt at capture time (text body, URL, etc.). */
  snapshotContent?: string;
  /** When the snapshot was taken (epoch ms). */
  capturedAt: number;
}

/** One inline run in a {@link PromptDoc} — either plain text or an atomic chip. */
export type PromptInline =
  | { type: 'text'; text: string }
  | { type: 'chip'; attrs: ChipSnapshot };

/**
 * Serialized prompt body. At runtime stored as a Y.XmlFragment in the
 * generative node's data Y.Map under key `prompt` (so collaborators see
 * keystrokes via y-prosemirror). The plain shape mirrors the Tiptap /
 * ProseMirror document so the editor can render it directly. Slice 1 uses a
 * plain-text prompt; the full Tiptap implementation (slice 2) preserves the
 * inline-atom shape.
 */
export interface PromptDoc {
  type: 'doc';
  content: PromptInline[];
}
