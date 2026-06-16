// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Loud fallback for a dying pino transport.
 *
 * pino transports run in a worker thread; if that thread errors (a
 * pino-roll rotation `reopen` failing, a disk write error, a transport
 * crash) the error is emitted on the transport's EventEmitter and —
 * with no listener — silently swallowed, killing all file/stdout
 * logging without a trace. collab ran 2026-06-01 → 06-16 with dead file
 * logging for exactly this reason. Attaching this fallback makes such a
 * death loud (writes to stderr) so it can never silently recur. See
 * pino #1437 / #1338.
 */

/** Minimal shape of a pino transport stream this fallback depends on. */
export interface TransportErrorSource {
  on(event: "error", listener: (err: unknown) => void): void;
}

/**
 * Attach an `error` listener to a pino transport that writes a loud
 * degradation notice via `writeFallback` (typically stderr) when the
 * transport worker thread errors — turning a silent logging death into
 * a visible one.
 * @param transport - The pino transport stream returned by `pino.transport(...)`.
 * @param writeFallback - Sink for the fallback line, e.g. `(l) => process.stderr.write(l)`.
 */
export function attachTransportErrorFallback(
  transport: TransportErrorSource,
  writeFallback: (line: string) => void,
): void {
  transport.on("error", (err) => {
    const detail =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    writeFallback(
      `[collab-logger] transport error — logging degraded: ${detail}\n`,
    );
  });
}
