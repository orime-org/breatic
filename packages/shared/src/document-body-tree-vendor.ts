// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/*
 * Parent-history selection and fractional indexing are adapted from
 * yjs-orderedtree 1.0.1-beta.3, src/ytree.js and src/util.js.
 *
 * MIT License
 * Copyright (c) [2025] [Yeshan Kaushik]
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** A registered candidate for one node's parent. */
export interface BodyTreeCandidate {
  readonly counter: number;
  readonly order: string;
  readonly fact?: string;
}

/** One candidate per known parent, including each node's default parent. */
export type BodyTreeCandidates = ReadonlyMap<string, ReadonlyMap<string, BodyTreeCandidate>>;

/** The deterministic rooted result and the edge selected for each child. */
export interface BodyComputedTree {
  readonly parents: ReadonlyMap<string, string>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly selected: ReadonlyMap<string, BodyTreeCandidate>;
}

/** One candidate waiting for its parent to become rooted. */
interface ReadyEdge {
  readonly child: string;
  readonly parent: string;
  readonly counter: number;
}

/**
 * Compares protocol identifiers by UTF-16 code units.
 * @param first - The first comparison operand.
 * @param second - The second comparison operand.
 * @returns The protocol comparison sign.
 * @throws {never}
 */
function compareId(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

/**
 * Uses the adopted counter, parent and child priority for cycle exits.
 * @param first - The first comparison operand.
 * @param second - The second comparison operand.
 * @returns The adopted priority comparison sign.
 * @throws {never}
 */
function compareEdge(first: ReadyEdge, second: ReadyEdge): number {
  return second.counter - first.counter || compareId(first.parent, second.parent) || compareId(first.child, second.child);
}

/**
 * Adds a candidate to the binary priority queue.
 * @param queue - The local priority queue.
 * @param edge - The candidate to insert.
 * @throws {never}
 */
function pushEdge(queue: ReadyEdge[], edge: ReadyEdge): void {
  queue.push(edge);
  let index = queue.length - 1;
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (compareEdge(queue[parent]!, edge) <= 0) break;
    queue[index] = queue[parent]!;
    index = parent;
  }
  queue[index] = edge;
}

/**
 * Takes the next rooted-parent candidate in protocol priority order.
 * @param queue - The local priority queue.
 * @returns The next candidate, or undefined when the queue is empty.
 * @throws {never}
 */
function popEdge(queue: ReadyEdge[]): ReadyEdge | undefined {
  const first = queue[0];
  const last = queue.pop();
  if (queue.length === 0 || last === undefined) return first;
  let index = 0;
  while (index * 2 + 1 < queue.length) {
    let child = index * 2 + 1;
    if (child + 1 < queue.length && compareEdge(queue[child + 1]!, queue[child]!) < 0) child += 1;
    if (compareEdge(last, queue[child]!) <= 0) break;
    queue[index] = queue[child]!;
    index = child;
  }
  queue[index] = last;
  return first;
}

/**
 * Selects the adopted parent-history tree without mutating candidate facts.
 * @param root - The declared root identity.
 * @param candidates - Each node and its registered parent candidates.
 * @returns Selected parents, ordered children and selected candidate values.
 * @throws {Error} If a registered node has no path to the declared root.
 */
export function computeBodyTreeCandidates(root: string, candidates: BodyTreeCandidates): BodyComputedTree {
  if (!candidates.has(root)) throw new Error("The document body root is missing");
  const ids = [...candidates.keys()].sort(compareId);
  const parents = new Map<string, string>();
  const initialChildren = new Map<string, string[]>(ids.map((id) => [id, []]));

  for (const id of ids) {
    if (id === root) continue;
    let winner: string | undefined;
    let largest = -1;
    for (const [parent, edge] of candidates.get(id)!) {
      if (!candidates.has(parent)) continue;
      if (edge.counter > largest || (edge.counter === largest && (winner === undefined || parent > winner))) {
        winner = parent;
        largest = edge.counter;
      }
    }
    if (winner === undefined) throw new Error(`The body node has no registered parent: ${id}`);
    parents.set(id, winner);
    initialChildren.get(winner)!.push(id);
  }

  const rooted = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (rooted.has(id)) continue;
    rooted.add(id);
    pending.push(...initialChildren.get(id)!);
  }

  const remaining = new Set(ids.filter((id) => !rooted.has(id)));
  const deferred = new Map<string, ReadyEdge[]>();
  const queue: ReadyEdge[] = [];
  for (const child of remaining) {
    for (const [parent, candidate] of candidates.get(child)!) {
      if (!candidates.has(parent)) continue;
      const edge = { child, parent, counter: candidate.counter };
      if (!remaining.has(parent)) pushEdge(queue, edge);
      else {
        const waiting = deferred.get(parent) ?? [];
        waiting.push(edge);
        deferred.set(parent, waiting);
      }
    }
  }

  for (let edge = popEdge(queue); edge !== undefined; edge = popEdge(queue)) {
    if (!remaining.has(edge.child)) continue;
    parents.set(edge.child, edge.parent);
    remaining.delete(edge.child);
    for (const unlocked of deferred.get(edge.child) ?? []) pushEdge(queue, unlocked);
  }
  if (remaining.size > 0) throw new Error(`The body contains an unrooted component: ${[...remaining].join(",")}`);

  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const selected = new Map<string, BodyTreeCandidate>();
  for (const [child, parent] of parents) {
    children.get(parent)!.push(child);
    selected.set(child, candidates.get(child)!.get(parent)!);
  }
  for (const siblings of children.values()) {
    siblings.sort((first, second) => compareId(selected.get(first)!.order, selected.get(second)!.order) || compareId(first, second));
  }
  return { parents, children, selected };
}

/**
 * Generates a fractional index with the operation identity as its stable suffix.
 * @param before - The exclusive lower order bound.
 * @param after - The exclusive upper order bound, or an empty unbounded limit.
 * @param operationId - The unique identity used to distinguish this order.
 * @returns A stable unique index strictly within the supplied bounds.
 * @throws {RangeError} If the supplied bounds contain no insertion position.
 */
export function bodyTreeOrderBetween(before: string, after: string, operationId: string): string {
  if (operationId.length === 0 || (after !== "" && before >= after)) throw new RangeError("Invalid body order bounds or operation identity");
  let foundDifference = false;
  let result = "";
  let index = 0;
  while (true) {
    const lower = index < before.length ? before.charCodeAt(index) : 0;
    const upper = !foundDifference && index < after.length ? after.charCodeAt(index) : 256;
    const middle = (lower + upper) >>> 1;
    result += String.fromCharCode(middle);
    if (middle <= lower) {
      if (lower < upper) foundDifference = true;
      index += 1;
      continue;
    }
    break;
  }
  // Fixed-width identity units and a nonzero terminator keep future gaps open.
  for (let position = 0; position < operationId.length; position += 1) {
    const unit = operationId.charCodeAt(position);
    result += String.fromCharCode(unit >>> 8, unit & 255);
  }
  result += "\u0001";
  if (result <= before || (after !== "" && result >= after)) throw new RangeError("The body order bounds have no insertion position");
  return result;
}
