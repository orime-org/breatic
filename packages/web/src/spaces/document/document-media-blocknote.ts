// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The image, video and audio blocks, as this Space draws them (inner#1127).
 *
 * The library's own blocks keep their props, parse rules and HTML export;
 * only the node view is ours. Two things it does that the library's does not:
 *
 * - **`update`.** The library's block node views have none
 *   (`createSpec.ts:286-290`), so every prop change rebuilds the view — a
 *   video playing when a co-editor changes its width would start again from
 *   the top. Here a prop change re-renders the same container and rewrites
 *   the block's own `data-*` attributes, which the library writes only when
 *   the view is built (`internal.ts:198-210`).
 * - **The page draws it.** The view builds the container and enters it in
 *   `document-media-views`; `DocumentMediaViews` renders into it through a
 *   portal, inside the page's React tree.
 * - **`stopEvent`.** The toolbar, the caption field and the resize handles
 *   live inside the node view. ProseMirror's default answer to an event there
 *   is to handle it itself (`prosemirror-view` `stopEvent` → false), so with
 *   the block node-selected a key typed in the caption would replace the
 *   whole block. Events from `[data-media-chrome]` are the controls' own.
 *
 * The node itself comes from `addNodeAndExtensionsToSpec`: a spec made by
 * `createBlockSpec` has no node until the schema is built
 * (`createSpec.ts:437-456`), and the schema keeps a node it is handed.
 */

import { carriesFiles } from '@web/lib/stray-file-drop';
import { startRowDrag } from '@web/spaces/document/document-row-drag';
import {
  addNodeAndExtensionsToSpec,
  camelToDataKebab,
  wrapInBlockStructure,
  type BlockNoteEditor,
} from '@blocknote/core';
import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Decoration } from '@tiptap/pm/view';

import { downloadHref } from '@web/data/api/download-href';
import { triggerDownload } from '@web/lib/download';
import {
  MEDIA_CHROME,
  type MediaBlockActions,
  type MediaBlockProps,
} from '@web/spaces/document/DocumentMediaBlock';
import type { MediaBlockType } from '@web/spaces/document/document-media-types';
import { dropMediaView, putMediaView } from '@web/spaces/document/document-media-views';
import { isLetGo } from '@web/spaces/document/document-node-selection-focus';

/** A prop declaration in BlockNote's shape, as far as this reads one. */
interface PropDecl {
  readonly default?: unknown;
}

/** The parts of a media block spec this module reads and rebuilds. */
interface MediaSpec {
  readonly config: {
    readonly type: string;
    readonly propSchema: Record<string, PropDecl>;
  };
  readonly implementation: {
    readonly meta?: { readonly fileBlockAccept?: readonly string[] };
  } & Record<string, unknown>;
  readonly extensions?: readonly unknown[];
}

/** Where a media block's drags may start: the media, and its caption field. */
const MEDIA_BLOCK_DRAGS = '[data-media-frame], [data-testid="doc-media-caption-input"]';

/**
 * Writes the block's props onto its own element the way the library does:
 * one `data-*` attribute per prop that is not at its default.
 * @param dom - The `blockContent` element.
 * @param node - The block's node.
 * @param propSchema - The block's props.
 */
function writeAttributes(dom: HTMLElement, node: PMNode, propSchema: Record<string, PropDecl>): void {
  for (const [prop, decl] of Object.entries(propSchema)) {
    const name = camelToDataKebab(prop);
    const value: unknown = node.attrs[prop];
    if (value === decl.default || value === undefined) {
      dom.removeAttribute(name);
    } else {
      dom.setAttribute(name, String(value));
    }
  }
}

/**
 * The block's props as the view reads them.
 * @param node - The block's node.
 * @returns The props.
 */
function propsOf(node: PMNode): MediaBlockProps {
  const attrs = node.attrs as Record<string, unknown>;
  return {
    url: typeof attrs['url'] === 'string' ? attrs['url'] : '',
    name: typeof attrs['name'] === 'string' ? attrs['name'] : '',
    caption: typeof attrs['caption'] === 'string' ? attrs['caption'] : '',
    ...(typeof attrs['previewWidth'] === 'number' && { previewWidth: attrs['previewWidth'] }),
    ...(typeof attrs['textAlignment'] === 'string' && { textAlignment: attrs['textAlignment'] }),
  };
}

/**
 * The node view for one media block.
 * @param viewProps - What Tiptap hands a node view.
 * @param editor - The BlockNote editor.
 * @param spec - The block's spec.
 * @returns The node view.
 */
function mediaNodeView(
  viewProps: NodeViewRendererProps,
  editor: BlockNoteEditor<never, never, never>,
  spec: MediaSpec,
): {
  dom: HTMLElement;
  update: (node: PMNode, decorations: readonly Decoration[]) => boolean;
  selectNode: () => void;
  deselectNode: () => void;
  stopEvent: (event: Event) => boolean;
  ignoreMutation: () => boolean;
  destroy: () => void;
} {
  const type = spec.config.type as MediaBlockType;
  const host = document.createElement('div');
  // The block's content is a flex row, and the host would shrink to the
  // media; the row the media is aligned in is the whole width of the body.
  host.style.width = '100%';
  const { dom } = wrapInBlockStructure(
    { dom: host },
    type,
    {} as never,
    spec.config.propSchema as never,
    spec.implementation.meta?.fileBlockAccept !== undefined,
  );
  let node = viewProps.node as PMNode;
  let selected = false;
  // Still selected, but let go when the reader left the body with no place
  // for a caret (`document-node-selection-focus.ts`): drawn as not selected.
  let letGo = false;

  /**
   * The id of the block this view draws, read now.
   * @returns The id, or null once the block is gone.
   */
  const blockId = (): string | null => {
    const pos = typeof viewProps.getPos === 'function' ? viewProps.getPos() : undefined;
    if (pos === undefined) return null;
    const id: unknown = viewProps.view.state.doc.resolve(pos).parent.attrs['id'];
    return typeof id === 'string' ? id : null;
  };

  // Ends the drag the media started, while one is under way.
  let endDrag: (() => void) | null = null;

  const actions: MediaBlockActions = {
    setProps: (props) => {
      const id = blockId();
      if (id !== null) editor.updateBlock(id, { props } as never);
    },
    remove: () => {
      const id = blockId();
      if (id === null) return;
      // The caption field goes with the block; the keyboard stays with the body.
      if (host.contains(host.ownerDocument.activeElement)) editor.focus();
      editor.removeBlocks([id]);
    },
    download: () => {
      const { url } = propsOf(node);
      if (url !== '') triggerDownload(downloadHref(url));
    },
    dragStart: (event) => {
      const id = blockId();
      if (id === null || !editor.isEditable) {
        event.preventDefault();
        return;
      }
      endDrag = startRowDrag(editor as never, event, id);
    },
    dragEnd: () => {
      endDrag?.();
      endDrag = null;
    },
    focusBody: () => {
      editor.focus();
    },
    bodyHolds: (element) => viewProps.view.dom.contains(element),
  };

  /**
   * Lets through the two drags a media block has — the media moving its row,
   * and the caption field's own words — and refuses the rest. A press on a
   * selected block makes whatever was pressed draggable (ProseMirror's
   * `LeftMouseDown`), and the node view keeps every dragstart from
   * ProseMirror, so such a drag would carry nothing.
   * @param event - The dragstart.
   */
  const refuseRowDrag = (event: DragEvent): void => {
    if (!(event.target instanceof Element) || event.target.closest(MEDIA_BLOCK_DRAGS) === null) {
      event.preventDefault();
    }
  };
  dom.addEventListener('dragstart', refuseRowDrag);

  /** Enters what the container shows now. */
  const render = (): void => {
    putMediaView(editor, host, { type, props: propsOf(node), selected: selected && !letGo, actions });
  };
  writeAttributes(dom, node, spec.config.propSchema);
  render();

  return {
    dom,
    update: (next, decorations) => {
      if (next.type !== node.type) return false;
      node = next;
      letGo = isLetGo(decorations);
      writeAttributes(dom, node, spec.config.propSchema);
      render();
      return true;
    },
    selectNode: () => {
      selected = true;
      dom.classList.add('ProseMirror-selectednode');
      render();
    },
    deselectNode: () => {
      selected = false;
      dom.classList.remove('ProseMirror-selectednode');
      render();
    },
    // A file dragged onto the controls is the body's drop like anywhere else.
    // A drag from the media moves the row through `startRowDrag`, which
    // sets up what ProseMirror's own dragstart would.
    stopEvent: (event) =>
      event.type === 'dragstart' ||
      (!carriesFiles(event) &&
      event.target instanceof Element &&
      event.target.closest(MEDIA_CHROME) !== null),
    // What React draws inside is not the document's; the node has no content.
    ignoreMutation: () => true,
    destroy: () => {
      dom.removeEventListener('dragstart', refuseRowDrag);
      dropMediaView(editor, host);
    },
  };
}

/**
 * A media block spec with this Space's node view.
 * @param spec - The library's spec, with this Space's props merged in.
 * @returns The same spec, carrying a node that draws with the view above.
 */
export function withMediaView<T extends MediaSpec>(spec: T): T {
  const built = addNodeAndExtensionsToSpec(
    spec.config as never,
    spec.implementation as never,
    spec.extensions as never,
  ) as unknown as {
    implementation: { node: { extend: (config: Record<string, unknown>) => unknown } };
  };
  const node = built.implementation.node.extend({
    addNodeView(this: { options: { editor: BlockNoteEditor<never, never, never> } }) {
      const { editor } = this.options;
      return (viewProps: NodeViewRendererProps) => mediaNodeView(viewProps, editor, spec);
    },
  });
  return { ...spec, implementation: { ...spec.implementation, node } };
}
