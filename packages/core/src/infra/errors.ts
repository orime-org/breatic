/**
 * Typed errors that cross the library / application boundary.
 *
 * Per CLAUDE.md "industrial-grade server standards" mandate row "process lifecycle (forbidden in the library layer)": library packages don't decide when the process
 * should die. When a library function needs the application to
 * abort (a failed startup connectivity check, a missing env
 * var, etc.), it throws one of the typed errors below; each
 * application entry (`server` / `worker` / `collab`) catches at
 * the top level, logs the failure with its own context, and
 * calls `process.exit(1)` itself.
 */

/**
 * Thrown by `checkInfraReady` (and its collab sibling
 * `checkCollabInfraReady`) when a startup dependency probe
 * fails. The application entry's top-level catch is expected to
 * log `{ component, hint, cause }` with full application context
 * and then `process.exit(1)`.
 *
 * - `component` - short stable tag like `"PostgreSQL"` /
 *   `"Redis"` / `"Redis (stream DB)"`. Used as the log `component`
 *   field so dashboards can split startup failures by dependency
 *   without grepping the message string.
 * - `hint` - human-readable recovery instruction, e.g.
 *   "Check DATABASE_URL=... or run: docker compose up -d postgres".
 *   The entry should surface this in the log line so an oncall
 *   reading the journal can act without opening the source.
 * - `cause` - the original error from the failed probe (PG
 *   client `connection refused`, Redis `ETIMEDOUT`, etc.). Use
 *   `{ err: error.cause }` in the log to preserve the stack.
 */
export class InfraNotReadyError extends Error {
  public readonly component: string;
  public readonly hint: string;
  public override readonly cause: unknown;

  /**
   * Construct a startup-dependency-unreachable error.
   * @param component - short stable tag for the failed dependency (e.g. `"PostgreSQL"`)
   * @param hint - human-readable recovery instruction for the oncall reader
   * @param cause - the original error from the failed probe, preserved for the stack
   */
  constructor(component: string, hint: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`${component} not reachable: ${causeMsg}`);
    this.name = "InfraNotReadyError";
    this.component = component;
    this.hint = hint;
    this.cause = cause;
  }
}
