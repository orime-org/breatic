import { nanoid } from 'nanoid';
import {
  type SpaceRpcRequest,
  type SpaceRpcResponse,
  SpaceRpcResponseSchema,
} from '@breatic/shared';

/**
 * Minimal slice of {@link HocuspocusProvider} the RPC client depends on.
 *
 * Declared explicitly so tests can pass a stub without spinning up a
 * real WebSocket (the real provider would attempt a y-protocols sync
 * handshake in jsdom and fail).
 */
export interface RpcCapableProvider {
  sendStateless(payload: string): void;
  on(event: 'stateless', cb: (data: { payload: string }) => void): void;
  off(event: 'stateless', cb: (data: { payload: string }) => void): void;
}

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
 */
export async function sendSpaceRpc(
  provider: RpcCapableProvider,
  request: Omit<SpaceRpcRequest, 'id'>,
  opts: SendSpaceRpcOptions = {},
): Promise<SpaceRpcResponse> {
  const id = opts.idGen?.() ?? nanoid();
  const timeoutMs = opts.timeoutMs ?? 10000;

  return new Promise<SpaceRpcResponse>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onMessage = (data: { payload: string }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.payload);
      } catch {
        return;
      }
      const r = SpaceRpcResponseSchema.safeParse(parsed);
      if (!r.success) return;
      if (r.data.id !== id) return;
      cleanup();
      resolve(r.data);
    };

    const cleanup = () => {
      provider.off('stateless', onMessage);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    provider.on('stateless', onMessage);
    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Space RPC timeout for type=${request.type} (id=${id}, ${timeoutMs}ms)`,
        ),
      );
    }, timeoutMs);

    const envelope = { id, ...request } as SpaceRpcRequest;
    provider.sendStateless(JSON.stringify(envelope));
  });
}
