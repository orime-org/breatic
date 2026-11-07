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
 * current size. Each change of phase, and each measure, is pushed to this
 * instance's connections of the document as `doc:size`.
 */

import { parseDocName, type DocSizeStatus } from "@breatic/shared";
import type { Document } from "@hocuspocus/server";
import * as Y from "yjs";
import { getCollabConfig } from "@collab/config.js";

/** The phase a size is in. */
export type DocSizePhase = DocSizeStatus["phase"];

/** One loaded document's size record. */
interface SizeRecord {
  document: Document;
  exact: number;
  current: number;
  phase: DocSizePhase;
  /** Admitted costs not applied yet, oldest first, with the connection each came on. */
  held: Array<{ connection: unknown; cost: number }>;
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
  if (!record) return { type: "doc:size", bytes: 0, limit: 0, ceiling: 0, phase: "normal" };
  const l = lines();
  return { type: "doc:size", bytes: record.current, limit: l.limit, ceiling: l.ceiling, phase: record.phase };
}

/**
 * Send the document's `doc:size` to one connection.
 * @param name - The document name.
 * @param connection - The connection.
 * @param connection.sendStateless - Its stateless channel.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function pushDocSize(name: string, connection: { sendStateless: (payload: string) => void }): void {
  connection.sendStateless(JSON.stringify(docSizeStatus(name)));
}

/**
 * Send the document's `doc:size` to every connection of it on this instance.
 * @param name - The document name.
 * @param record - Its record.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function pushAll(name: string, record: SizeRecord): void {
  const payload = JSON.stringify(docSizeStatus(name));
  for (const connection of record.document.getConnections()) connection.sendStateless(payload);
}

/**
 * Recompute the phase from the current size and push when it changed.
 * @param name - The document name.
 * @param record - Its record.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function settlePhase(name: string, record: SizeRecord): void {
  const phase = phaseOf(record.current);
  if (phase === record.phase) return;
  record.phase = phase;
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
    document, exact: bytes, current: bytes, phase: phaseOf(bytes), held: [], measuredAt: Date.now(), measureTimer: null,
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
  record.phase = phaseOf(record.current);
  record.measuredAt = Date.now();
  pushAll(name, record);
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
 */
export function release(name: string, connection: unknown): void {
  const record = records.get(name);
  if (!record) return;
  const i = record.held.findIndex((h) => h.connection === connection);
  if (i !== -1) record.held.splice(i, 1);
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
 * @returns Exact size, current size, phase and the held costs' sum, or undefined with no record.
 */
export function readDocSizeRecord(name: string): { exact: number; current: number; phase: DocSizePhase; heldSum: number } | undefined {
  const record = records.get(name);
  return record && {
    exact: record.exact,
    current: record.current,
    phase: record.phase,
    heldSum: record.held.reduce((sum, h) => sum + h.cost, 0),
  };
}
