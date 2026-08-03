// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Subscribing to a text node's body (#1774, design section 9.1).
 *
 * The body is a shared fragment on the node, and it is deliberately absent from
 * the node-view projection: that absence is what makes a keystroke re-render
 * nothing on the canvas (design section 7). The cost is that the text no longer
 * arrives with the rest of the node, so everyone who displays it subscribes
 * here — the node itself, and the generation panel for each `@` reference it
 * carries.
 *
 * One hook, two consumers, on purpose. Giving the panel its own path would put
 * a second answer to "what does this node say" in the codebase, and the two
 * would drift the first time one of the layers below changed.
 */

import * as React from 'react';
import * as Y from 'yjs';

import { docName, getDoc } from '@web/data/yjs/manager';
import { nodeDataMap } from '@web/data/yjs/canvas-space';
import { bodyToPlainText } from '@web/data/yjs/text-body';

/**
 * Subscribe to a text node's body and get it back as plain text.
 *
 * Two observers, because one cannot cover both things that change:
 *
 * - `observeDeep` on the fragment. A collaborator typing inside a paragraph
 *   changes something nested, and a shallow observer would never fire — the
 *   text would freeze the moment somebody else edited an existing line.
 * - A shallow observer on the node's data, watching the `body` key itself get
 *   replaced. A node with no body gets repaired, and when two clients repair at
 *   once the loser's key is overwritten with the winner's fragment. Whoever
 *   stays bound to the old object is bound to something no longer in the
 *   document, and goes silent forever.
 *
 * A node with no body reads as the empty string rather than throwing or
 * signalling absence: to a reader an unwritten node and a repaired-but-empty
 * one look the same. Writers ask a different question, and repair through
 * `reseedTextBody` before they bind an editor.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space holding the node.
 * @param nodeId - Id of the text node whose body to follow.
 * @returns The body as plain text, blocks separated by newlines.
 */
export function useTextBody(
  projectId: string,
  spaceId: string,
  nodeId: string,
): string {
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = React.useMemo(() => getDoc(name), [name]);
  const [text, setText] = React.useState('');

  React.useEffect(() => {
    const data = nodeDataMap(doc, nodeId);
    if (!data) {
      setText('');
      return undefined;
    }

    let bound: Y.XmlFragment | null = null;
    /**
     * Push the bound body's current text into React state.
     */
    const publish = (): void => {
      setText(bound ? bodyToPlainText(bound) : '');
    };
    /**
     * Point the deep observer at whatever body the node holds right now.
     *
     * Runs on every change to the node's data, not just the `body` key —
     * filtering the event would mean a second place that has to stay correct,
     * and the check below is a reference comparison.
     */
    const rebind = (): void => {
      const next = data.get('body');
      const body = next instanceof Y.XmlFragment ? next : null;
      if (body === bound) return;
      bound?.unobserveDeep(publish);
      bound = body;
      bound?.observeDeep(publish);
      publish();
    };

    data.observe(rebind);
    rebind();
    return () => {
      data.unobserve(rebind);
      bound?.unobserveDeep(publish);
    };
  }, [doc, nodeId]);

  return text;
}
