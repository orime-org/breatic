// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { consentForCollab } from '@web/data/analytics';
import {
  newId,
  type SpaceRpcRequest,
  type SpaceRpcResponse,
  SpaceRpcResponseSchema,
} from '@breatic/shared';

import { sendCorrelatedRpc, type RpcCapableProvider } from '@web/data/yjs/stateless-rpc-client';
export { SpaceRpcUnanswered } from '@web/data/yjs/stateless-rpc-client';
export type { RpcCapableProvider } from '@web/data/yjs/stateless-rpc-client';

export interface SendSpaceRpcOptions {
  /** Round-trip timeout in ms. Default 10000 (user-confirmed 2026-05-25). */
  timeoutMs?: number;
  /** Override the correlation id generator (tests). */
  idGen?: () => string;
}

/**
 * Send a Space lifecycle RPC over a live Hocuspocus connection on the
 * project's meta doc.
 *
 * Per ADR 2026-05-23 yjs-collab-only-write-authz: client writes to
 * `meta.spaces` / `meta.projectMessages` are forbidden — they must
 * round-trip through the collab process via this RPC so the write is
 * authorized + audited server-side.
 *
 * The caller is responsible for picking a provider that is already
 * authenticated against `project-{pid}/meta` (typically the live
 * provider yielded by `useSocket`).
 * @param provider - Live Hocuspocus provider authenticated on the project meta doc.
 * @param request - The Space RPC request without its correlation id (generated here).
 * @param opts - Optional timeout and correlation-id-generator overrides.
 * @returns The matching Space RPC response from the collab process.
 * @throws {SpaceRpcUnanswered} When no response arrives within the round-trip
 *   timeout.
 */
export async function sendSpaceRpc(
  provider: RpcCapableProvider,
  request: Omit<SpaceRpcRequest, 'id'>,
  opts: SendSpaceRpcOptions = {},
): Promise<SpaceRpcResponse> {
  const id = opts.idGen?.() ?? newId();
  const timeoutMs = opts.timeoutMs ?? 10000;

  const envelope = { id, ...request, analyticsConsent: consentForCollab() } as SpaceRpcRequest;
  return sendCorrelatedRpc(provider, envelope, SpaceRpcResponseSchema, { timeoutMs });
}
