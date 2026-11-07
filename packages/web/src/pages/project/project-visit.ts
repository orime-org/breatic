// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import {
  projectVisitLookupSchema,
  projectVisitOpenedSchema,
  projectVisitReceiptSchema,
  type ProjectVisitReceipt,
} from '@breatic/shared';
import { projectsApi } from '@web/data/api/projects';
import { ApiException } from '@web/data/api/types';

export type ProjectVisitStatus = 'pending' | 'recorded' | 'unconfirmed' | 'rejected' | 'inactive';

/** A live result belonging to one account, project and navigation activation. */
export interface ProjectVisitHandle {
  readonly status: ProjectVisitStatus;
  readonly visitId: string | null;
  readonly receipt: ProjectVisitReceipt | null;
  /**
   * Read the original result, then explicitly resume a still-active entry.
   * @returns The original receipt, if confirmed.
   * @throws {never} Failures stay in the handle.
   */
  recover(): Promise<ProjectVisitReceipt | null>;
  /**
   * Read the original result without writing.
   * @returns The original receipt, if confirmed.
   * @throws {never} Failures stay in the handle.
   */
  refresh(): Promise<ProjectVisitReceipt | null>;
}

/** Live auth source also available after the page's parent unmounts it. */
export interface ProjectVisitAccountSource {
  getAccountId(): string | null;
  /** Monotonic account generation; same-account refresh keeps it. */
  getGeneration?(): number;
  subscribe(listener: () => void): () => void;
}

/** Inputs whose ownership survives queries, providers and React effect replay. */
interface VisitOptions {
  accountId: string | null;
  projectId: string;
  allowed: () => boolean;
  subscribeAccount: (listener: () => void) => () => void;
  confirmed: () => void;
}

/** Owns transport and the immutable result of one page entry. */
export class ProjectVisit implements ProjectVisitHandle {
  readonly visitId: string | null;
  private state: Exclude<ProjectVisitStatus, 'inactive'> = 'pending';
  private original: ProjectVisitReceipt | null = null;
  private active = false;
  private revoked = false;
  private started = false;
  private readonly requests = new Set<AbortController>();
  private unsubscribeAccount: (() => void) | null = null;
  private changed: (() => void) | null = null;

  /**
   * Allocate an identity without performing transport during render.
   * @param options - Original ownership and confirmation callbacks.
   * @throws {never} Never.
   */
  constructor(private readonly options: VisitOptions) {
    this.visitId = options.accountId && options.projectId !== 'demo' ? crypto.randomUUID() : null;
  }

  /**
   * Read the live state even from a retained, departed handle.
   * @returns The original entry state.
   * @throws {never} Never.
   */
  get status(): ProjectVisitStatus {
    return this.active && !this.revoked && this.options.allowed() ? this.state : 'inactive';
  }

  /**
   * Read the first confirmed result, including an archived late answer.
   * @returns The immutable original receipt.
   * @throws {never} Never.
   */
  get receipt(): ProjectVisitReceipt | null { return this.original; }

  /**
   * Attach a mounted observer without replaying the initial write.
   * @param changed - Notify the mounted React consumer.
   * @throws {never} Never.
   */
  activate(changed: () => void): void {
    if (!this.authorized()) return;
    this.active = true;
    this.changed = changed;
    this.watchAccount();
  }

  /**
   * End this activation while allowing same-account historical lookups.
   * @throws {never} Never.
   */
  deactivate(): void {
    this.active = false;
    this.changed = null;
    this.releaseAccountIfIdle();
  }

  /**
   * Send once after the accessible page gate opens.
   * @throws {never} Failures stay in the handle.
   */
  start(): void {
    if (this.started || !this.active || !this.visitId || !this.authorized()) return;
    this.started = true;
    void this.send();
  }

  /**
   * Cancel all transport permanently when the original account ends.
   * @throws {never} Never.
   */
  private checkAccount = (): void => {
    if (this.options.allowed()) return;
    this.revoked = true;
    this.active = false;
    for (const request of this.requests) request.abort();
    this.changed?.();
    this.unsubscribeAccount?.();
    this.unsubscribeAccount = null;
  };

  /**
   * Check original-account ownership before every request.
   * @returns Whether the original account may still make requests.
   * @throws {never} Never.
   */
  private authorized(): boolean {
    this.checkAccount();
    return !this.revoked && this.visitId !== null;
  }

  /**
   * Keep transport behind the original accessible-page admission gate.
   * @returns Whether this entry has started under its still-valid account.
   * @throws {never} Never.
   */
  private mayRequest(): boolean {
    return this.started && this.authorized();
  }

  /**
   * Watch logout while mounted or while original transport remains pending.
   * @throws {never} Never.
   */
  private watchAccount(): void {
    this.unsubscribeAccount ??= this.options.subscribeAccount(this.checkAccount);
  }

  /**
   * Release auth observers after a departed entry has no pending transport.
   * @throws {never} Never.
   */
  private releaseAccountIfIdle(): void {
    if (this.active || this.requests.size) return;
    this.unsubscribeAccount?.();
    this.unsubscribeAccount = null;
  }

  /**
   * Begin an abortable request owned by this original account.
   * @returns This request's cancellation controller.
   * @throws {never} Never.
   */
  private beginRequest(): AbortController {
    const request = new AbortController();
    this.requests.add(request);
    this.watchAccount();
    return request;
  }

  /**
   * Finish one request without releasing another pending request's guard.
   * @param request - The request that settled.
   * @throws {never} Never.
   */
  private endRequest(request: AbortController): void {
    this.requests.delete(request);
    this.releaseAccountIfIdle();
  }

  /**
   * Validate identity in addition to the shared wire contract.
   * @param result - Parsed original identifiers.
   * @throws {Error} If the result belongs to another entry.
   */
  private assertIdentity(result: Pick<ProjectVisitReceipt, 'account_id' | 'project_id' | 'visit_id'>): void {
    if (result.account_id !== this.options.accountId || result.project_id !== this.options.projectId || result.visit_id !== this.visitId) {
      throw new Error('Project visit receipt identity mismatch');
    }
  }

  /**
   * Append the first valid result and refresh lists once for that result.
   * @param result - Matching, valid server receipt.
   * @throws {never} Never.
   */
  private confirm(result: ProjectVisitReceipt): void {
    if (this.original) return;
    this.original = result;
    this.state = 'recorded';
    // An old account's late answer is archived, without refetching new-account lists.
    if (this.authorized()) this.options.confirmed();
    this.changed?.();
  }

  /**
   * Keep unknown outcomes distinct from authoritative server refusals.
   * @param error - The original protocol or transport exception.
   * @returns Whether the server explicitly refused the request.
   * @throws {never} Never.
   */
  private failed(error: unknown): boolean {
    const refused = error instanceof ApiException && error.fromServer && error.status >= 400 && error.status < 500;
    if (!this.original && this.state !== 'rejected') this.state = refused ? 'rejected' : 'unconfirmed';
    console.error('Project visit outcome', {
      reason: refused ? 'rejected' : 'unconfirmed',
      accountId: this.options.accountId,
      projectId: this.options.projectId,
      visitId: this.visitId,
    }, error);
    this.changed?.();
    return refused;
  }

  /**
   * Submit the original identity; unknown answers trigger only a lookup.
   * @returns The original receipt, if confirmed.
   * @throws {never} Failures stay in the handle.
   */
  private async send(): Promise<ProjectVisitReceipt | null> {
    if (!this.active || !this.mayRequest() || !this.visitId || this.original) return this.original;
    this.state = 'pending';
    this.changed?.();
    const request = this.beginRequest();
    try {
      const result = projectVisitOpenedSchema.parse(await projectsApi.recordOpen(this.options.projectId, this.visitId, request.signal));
      this.assertIdentity(result);
      this.confirm(projectVisitReceiptSchema.parse(result));
    } catch (error) {
      const refused = this.failed(error);
      if (!refused && this.authorized()) await this.refresh();
    } finally { this.endRequest(request); }
    return this.original;
  }

  /**
   * Read only this identity; confirmed results are append-only.
   * @returns The original receipt, if confirmed.
   * @throws {never} Failures stay in the handle.
   */
  async refresh(): Promise<ProjectVisitReceipt | null> {
    if (!this.mayRequest() || !this.visitId) return this.original;
    const request = this.beginRequest();
    try {
      const result = projectVisitLookupSchema.parse(await projectsApi.getOpenReceipt(this.options.projectId, this.visitId, request.signal));
      this.assertIdentity(result);
      if (result.status === 'recorded') this.confirm(projectVisitReceiptSchema.parse(result));
      else if (this.state === 'pending' && !this.original) {
        this.state = 'unconfirmed';
        this.changed?.();
      }
    } catch (error) { this.failed(error); }
    finally { this.endRequest(request); }
    return this.original;
  }

  /**
   * Query before explicitly resuming the current original entry.
   * @returns The original receipt, if confirmed.
   * @throws {never} Failures stay in the handle.
   */
  async recover(): Promise<ProjectVisitReceipt | null> {
    if (this.original || !this.mayRequest()) return this.original;
    await this.refresh();
    if (!this.original && this.active && this.authorized()) return this.send();
    return this.original;
  }
}
