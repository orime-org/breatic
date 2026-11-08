// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size of every loaded Space document (inner#1790, design 4.1).
 *
 * A record keeps the last exact measure and the current size: the exact
 * measure plus the cost of every update admitted or applied since. Costs held
 * by a connection belong to updates admitted but not applied yet, which a
 * measure taken meanwhile cannot see, so they stay on top of it. Measures run
 * after transactions, at most once per measure interval, and correct the
 * current size. Each change of phase or of being over the hard ceiling, and
 * each measure, is pushed to this instance's connections of the document as
 * `doc:size`, numbered by `seq`; a connection's acknowledgement of a push
 * tells which phase it had seen when it sent what follows.
 */

import { parseDocName, type DocSizeStatus } from "@breatic/shared";
import type { Document } from "@hocuspocus/server";
import * as Y from "yjs";
import { getCollabConfig } from "@collab/config.js";

/** The phase a size is in. */
export type DocSizePhase = DocSizeStatus["phase"];

/** What one connection has been pushed and has acknowledged. */
interface Seen {
  /** Unacknowledged pushes where `full` changed, oldest first, each with its seq. */
  changes: Array<{ seq: number; full: boolean }>;
  /** Whether the push it acknowledged last was full; false before any. */
  knowsFull: boolean;
  /** The seq of the last push it was sent. */
  lastSeq: number;
}

/** A connection's channel for pushes. */
type PushTarget = { sendStateless: (payload: string) => void };

/** One loaded document's size record. */
interface SizeRecord {
  document: Document;
  exact: number;
  current: number;
  phase: DocSizePhase;
  /** Whether `current ≥ ceiling` at the last push. */
  over: boolean;
  /** Admitted costs not applied yet, oldest first, with the connection each came on. */
  held: Array<{ connection: unknown; cost: number }>;
  /** The seq of the last push. */
  seq: number;
  seen: Map<unknown, Seen>;
  measuredAt: number;
  measureTimer: ReturnType<typeof setTimeout> | null;
}

const records = new Map<string, SizeRecord>();

/**
 * The exact size of a document: its encoded state, pending content included.
 * @param document - The document.
 * @returns Bytes.
 */
export function measure(document: Y.Doc): number {
  return Y.encodeStateAsUpdate(document).byteLength;
}

/**
 * The lines the configuration sets.
 * @returns Limit, hard ceiling, warning line and measure interval.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function lines(): { limit: number; ceiling: number; warnFrom: number; intervalMs: number } {
  const cfg = getCollabConfig();
  const limit = cfg.max_document_bytes;
  return {
    limit,
    ceiling: limit + cfg.document_size_delete_headroom_bytes,
    warnFrom: limit * cfg.document_size_warn_ratio,
    intervalMs: cfg.document_size_measure_interval_ms,
  };
}

/**
 * The phase of a size.
 * @param bytes - The size.
 * @returns Its phase.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function phaseOf(bytes: number): DocSizePhase {
  const l = lines();
  if (bytes >= l.limit) return "full";
  return bytes >= l.warnFrom ? "warning" : "normal";
}

/**
 * The `doc:size` message for a document; with no record the deployment sets
 * no limit and every number is 0.
 * @param name - The document name.
 * @returns The message.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function docSizeStatus(name: string): DocSizeStatus {
  const record = records.get(name);
  if (!record) return { type: "doc:size", seq: 0, bytes: 0, limit: 0, ceiling: 0, phase: "normal" };
  const l = lines();
  return { type: "doc:size", seq: record.seq, bytes: record.current, limit: l.limit, ceiling: l.ceiling, phase: record.phase };
}

/**
 * Note that a connection was sent the record's latest push.
 * @param record - The record.
 * @param connection - The connection.
 */
function noteSent(record: SizeRecord, connection: unknown): void {
  const full = record.phase === "full";
  let seen = record.seen.get(connection);
  if (!seen) {
    seen = { changes: [], knowsFull: false, lastSeq: 0 };
    record.seen.set(connection, seen);
  }
  if ((seen.changes.at(-1)?.full ?? seen.knowsFull) !== full) seen.changes.push({ seq: record.seq, full });
  seen.lastSeq = record.seq;
}

/**
 * Send the document's `doc:size` to one connection.
 * @param name - The document name.
 * @param connection - The connection.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function pushDocSize(name: string, connection: PushTarget): void {
  const record = records.get(name);
  if (record) {
    record.seq += 1;
    noteSent(record, connection);
  }
  connection.sendStateless(JSON.stringify(docSizeStatus(name)));
}

/**
 * Send the document's `doc:size` to every connection of it on this instance.
 * @param name - The document name.
 * @param record - Its record.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function pushAll(name: string, record: SizeRecord): void {
  record.seq += 1;
  const payload = JSON.stringify(docSizeStatus(name));
  for (const connection of record.document.getConnections()) {
    noteSent(record, connection);
    connection.sendStateless(payload);
  }
}

/**
 * Take a connection's acknowledgement of the push numbered `seq`: the last
 * full change at or below it says what the connection had seen.
 * @param name - The document name.
 * @param connection - The connection.
 * @param seq - The acknowledged push.
 */
export function acknowledge(name: string, connection: unknown, seq: number): void {
  const seen = records.get(name)?.seen.get(connection);
  if (!seen || seq > seen.lastSeq) return;
  for (let change = seen.changes[0]; change !== undefined && change.seq <= seq; change = seen.changes[0]) {
    seen.knowsFull = change.full;
    seen.changes.shift();
  }
}

/**
 * Whether a connection's last acknowledged push was full.
 * @param name - The document name.
 * @param connection - The connection.
 * @returns False before any acknowledgement or with no record.
 */
export function knowsFull(name: string, connection: unknown): boolean {
  return records.get(name)?.seen.get(connection)?.knowsFull ?? false;
}

/**
 * Drop what the record keeps for connections no longer in the document.
 * @param name - The document name.
 */
export function forgetGoneConnections(name: string): void {
  const record = records.get(name);
  if (!record) return;
  for (const connection of record.seen.keys()) {
    if (!record.document.hasConnection(connection as Parameters<Document["hasConnection"]>[0])) record.seen.delete(connection);
  }
}

/**
 * Recompute the phase and whether the size is over the hard ceiling, and
 * push when either changed or `always` is set.
 * @param name - The document name.
 * @param record - Its record.
 * @param always - Push even when nothing changed (after a measure).
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function settlePhase(name: string, record: SizeRecord, always = false): void {
  const phase = phaseOf(record.current);
  const over = record.current >= lines().ceiling;
  if (!always && phase === record.phase && over === record.over) return;
  record.phase = phase;
  record.over = over;
  pushAll(name, record);
}

/**
 * Whether a document gets a size record: a Space content document while the
 * deployment sets a limit.
 * @param name - The document name.
 * @returns True when it is tracked.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function tracksSize(name: string): boolean {
  const parsed = parseDocName(name);
  return parsed !== null && parsed.kind !== "meta" && getCollabConfig().max_document_bytes > 0;
}

/**
 * Start the record of a loaded document at its exact size.
 * @param document - The Hocuspocus document; pushes go to its connections.
 * @throws {Error} When the YAML is missing / unreadable or fails validation, or the document cannot be encoded.
 */
export function openDocSizeRecord(document: Document): void {
  if (!tracksSize(document.name)) return;
  forget(document.name);
  const bytes = measure(document);
  records.set(document.name, {
    document,
    exact: bytes,
    current: bytes,
    phase: phaseOf(bytes),
    over: bytes >= lines().ceiling,
    held: [],
    seq: 0,
    seen: new Map(),
    measuredAt: Date.now(),
    measureTimer: null,
  });
}

/**
 * Set a document's exact size; the costs still held stay on top of it.
 * @param name - The document name.
 * @param bytes - The exact size.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function recordExact(name: string, bytes: number): void {
  const record = records.get(name);
  if (!record) return;
  if (record.measureTimer) clearTimeout(record.measureTimer);
  record.measureTimer = null;
  record.exact = bytes;
  record.current = bytes + record.held.reduce((sum, h) => sum + h.cost, 0);
  record.measuredAt = Date.now();
  settlePhase(name, record, true);
}

/**
 * Count an update `beforeSync` admitted, held on its connection until it is
 * applied or will not be.
 * @param name - The document name.
 * @param connection - The connection it came on.
 * @param cost - Its cost.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function admit(name: string, connection: unknown, cost: number): void {
  const record = records.get(name);
  if (!record) return;
  record.current += cost;
  record.held.push({ connection, cost });
  settlePhase(name, record);
}

/**
 * Count an update applied from outside a client connection.
 * @param name - The document name.
 * @param cost - Its cost.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function addApplied(name: string, cost: number): void {
  const record = records.get(name);
  if (!record) return;
  record.current += cost;
  settlePhase(name, record);
}

/**
 * Drop a connection's oldest held cost: its update was applied, or will not be.
 * @param name - The document name.
 * @param connection - The connection.
 * @returns True when a held cost was dropped.
 */
export function release(name: string, connection: unknown): boolean {
  const record = records.get(name);
  if (!record) return false;
  const i = record.held.findIndex((h) => h.connection === connection);
  if (i === -1) return false;
  record.held.splice(i, 1);
  return true;
}

/**
 * Measure the document once a measure interval has passed since the last
 * one, on the next turn when it already has.
 * @param name - The document name.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function scheduleMeasure(name: string): void {
  const record = records.get(name);
  if (!record || record.measureTimer) return;
  const delay = Math.max(0, record.measuredAt + lines().intervalMs - Date.now());
  record.measureTimer = setTimeout(() => {
    record.measureTimer = null;
    if (records.get(name) === record) recordExact(name, measure(record.document));
  }, delay);
  record.measureTimer.unref?.();
}

/**
 * Drop a document's record when it unloads.
 * @param name - The document name.
 */
export function forget(name: string): void {
  const record = records.get(name);
  if (!record) return;
  if (record.measureTimer) clearTimeout(record.measureTimer);
  records.delete(name);
}

/**
 * A document's record, as the size gate and tests read it.
 * @param name - The document name.
 * @returns Exact size, current size, phase, the held costs' sum and what each connection was pushed and acknowledged, or undefined with no record.
 */
export function readDocSizeRecord(
  name: string,
): { exact: number; current: number; phase: DocSizePhase; heldSum: number; seen: ReadonlyMap<unknown, Seen> } | undefined {
  const record = records.get(name);
  return record && {
    exact: record.exact,
    current: record.current,
    phase: record.phase,
    heldSum: record.held.reduce((sum, h) => sum + h.cost, 0),
    seen: record.seen,
  };
}
