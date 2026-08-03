// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Subscribing to text node bodies (#1774, design section 9.1).
 *
 * The body is a shared fragment on the node, and it is deliberately absent from
 * the node-view projection: that absence is what makes a keystroke re-render
 * nothing on the canvas (design section 7). The cost is that the text no longer
 * arrives with the rest of the node, so everyone who displays it subscribes
 * here — the node itself, and the generation panel for each `@` reference it
 * carries.
 *
 * One module, two shapes of the same subscription, on purpose. Giving the panel
 * its own path would put a second answer to "what does this node say" in the
 * codebase, and the two would drift the first time one of the layers below
 * changed.
 */

import * as React from 'react';
import * as Y from 'yjs';

import { docName, getDoc } from '@web/data/yjs/manager';
import { nodeDataMap } from '@web/data/yjs/canvas-space';
import { bodyToPlainText } from '@web/data/yjs/text-body';

/**
 * Follow which fragment a node's `body` key holds, right now.
 *
 * The key can be REPLACED, and that is not a detail: a node with no body gets
 * repaired, and when two clients repair at once the loser's key is overwritten
 * with the winner's fragment. Whoever stays bound to the old object is bound
 * to something no longer in the document — a reader goes silent, and an open
 * editor swallows every further keystroke. Both consumers below need the
 * current fragment, so following the key lives here, once.
 * @param doc - The canvas-space document.
 * @param nodeId - Id of the node whose body to follow.
 * @param publish - Called with the current fragment (or null when the node has
 *   none), immediately and on every replacement.
 * @returns A function that removes the observer.
 */
function observeBodyFragment(
  doc: Y.Doc,
  nodeId: string,
  publish: (body: Y.XmlFragment | null) => void,
): () => void {
  const data = nodeDataMap(doc, nodeId);
  if (!data) {
    publish(null);
    return () => undefined;
  }

  let current: Y.XmlFragment | null = null;
  /**
   * Publish whatever body the node holds right now, if it changed.
   *
   * Runs on every change to the node's data, not just the `body` key —
   * filtering the event would be a second place that has to stay correct, and
   * the check below is a reference comparison.
   */
  const rebind = (): void => {
    const next = data.get('body');
    const body = next instanceof Y.XmlFragment ? next : null;
    if (body === current) return;
    current = body;
    publish(body);
  };

  data.observe(rebind);
  rebind();
  return () => data.unobserve(rebind);
}

/**
 * Follow one node's body, reporting its text on every change.
 *
 * Two observers, because one cannot cover both things that change: which
 * fragment the node holds ({@link observeBodyFragment}), and what is inside
 * it. The inner one has to be `observeDeep` — a collaborator typing inside a
 * paragraph changes something nested, and a shallow observer would never fire,
 * so the text would freeze the moment somebody else edited an existing line.
 * @param doc - The canvas-space document.
 * @param nodeId - Id of the node whose body to follow.
 * @param publish - Called with the body's text, immediately and on each change.
 * @returns A function that removes both observers.
 */
function observeTextBody(
  doc: Y.Doc,
  nodeId: string,
  publish: (text: string) => void,
): () => void {
  let bound: Y.XmlFragment | null = null;
  /**
   * Report the bound body's current text.
   * @returns Nothing.
   */
  const report = (): void => publish(bound ? bodyToPlainText(bound) : '');
  const off = observeBodyFragment(doc, nodeId, (body) => {
    bound?.unobserveDeep(report);
    bound = body;
    bound?.observeDeep(report);
    report();
  });
  return () => {
    off();
    bound?.unobserveDeep(report);
  };
}

/**
 * Subscribe to a text node's body and get it back as plain text.
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

  React.useEffect(
    () => observeTextBody(doc, nodeId, setText),
    [doc, nodeId],
  );

  return text;
}

/** The body an open editor is bound to, and the two ways it changes. */
export interface EditedTextBody {
  /** The fragment to bind, or null when no editor is open. */
  body: Y.XmlFragment | null;
  /** Open an editor on this fragment. */
  open: (body: Y.XmlFragment) => void;
  /** Close the editor. */
  close: () => void;
}

/**
 * Hold the body an open editor is bound to, following it if it is replaced.
 *
 * The open editor IS the fragment it is bound to — there is no separate
 * "editing" flag, because the two could disagree and the disagreeing state is
 * an editor bound to nothing.
 *
 * Binding the fragment read at the moment editing started is not enough. A
 * concurrent repair replaces the `body` key, and the client that loses is left
 * holding a fragment that is no longer in the document: the caret still
 * blinks, the words still appear, and not one of them reaches anybody else or
 * survives a reload. So while an editor is open this follows the key and hands
 * back whatever the node holds now; a replacement rebinds the editor, and a
 * body that disappears entirely closes it rather than leaving it bound to a
 * ghost.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space holding the node.
 * @param nodeId - Id of the text node being edited.
 * @returns The bound body plus the two transitions.
 */
export function useEditedTextBody(
  projectId: string,
  spaceId: string,
  nodeId: string,
): EditedTextBody {
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = React.useMemo(() => getDoc(name), [name]);
  const [body, setBody] = React.useState<Y.XmlFragment | null>(null);
  const editing = body !== null;

  React.useEffect(() => {
    if (!editing) return undefined;
    // Publishes the current fragment synchronously on subscribe, so the
    // fragment editing just opened on is confirmed against the document rather
    // than trusted — an id that no longer has a body closes the editor here.
    return observeBodyFragment(doc, nodeId, setBody);
  }, [editing, doc, nodeId]);

  return {
    body,
    open: setBody,
    close: React.useCallback(() => setBody(null), []),
  };
}

/**
 * Subscribe to several bodies at once, for the generation panel's `@`
 * references.
 *
 * A hook per reference is not available — the set changes as edges come and
 * go, and hooks cannot be called in a loop — so this holds all the
 * subscriptions in one effect and hands back a map.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space holding the nodes.
 * @param nodeIds - Ids of the text nodes to follow.
 * @returns Node id to body text, for the ids that have a body.
 */
export function useTextBodies(
  projectId: string,
  spaceId: string,
  nodeIds: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = React.useMemo(() => getDoc(name), [name]);
  const [texts, setTexts] = React.useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  // Serialized rather than compared by reference: the caller derives these
  // from the edge list on every render, so a fresh array with identical
  // contents arrives constantly, and re-subscribing on each of those would
  // drop and re-attach every observer between two keystrokes. JSON rather than
  // a joined string, because a separator is only safe until an id contains it.
  const key = JSON.stringify(nodeIds);

  React.useEffect(() => {
    const ids = JSON.parse(key) as ReadonlyArray<string>;
    const current = new Map<string, string>();
    const unsubscribes = ids.map((id) =>
      observeTextBody(doc, id, (text) => {
        current.set(id, text);
        // A fresh map per change: consumers memoize on this value, and mutating
        // one in place would leave them looking at an object that never
        // announces it changed.
        setTexts(new Map(current));
      }),
    );
    return () => unsubscribes.forEach((off) => off());
  }, [doc, key]);

  return texts;
}
