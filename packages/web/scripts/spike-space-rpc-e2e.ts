/**
 * End-to-end spike for the PR-a/PR-b collab-only-write protocol.
 *
 * Stands up two HocuspocusProvider clients against the live local
 * collab on :1234 (assumes `LOGIN_MODE=NoAccount` dev mode — auth.ts
 * gives every connection `{ user: { id: DEV_USER_ID, role: 'owner' } }`).
 *
 * Reproduces the exact path the browser walks:
 *   1. Open ws + sync the meta doc
 *   2. Observe `spaces` Y.Map for change events
 *   3. Send `space:create` stateless RPC
 *   4. Wait for the stateless response (collab acks ok / error)
 *   5. Wait for the spaces Map to actually receive the new entry
 *
 * Runs two clients ('A' = actor, 'B' = observer) so we can tell
 * whether the missing broadcast is a self-broadcast filter (only A
 * stuck) or a true broadcast hole (both stuck).
 *
 * Exit codes: 0 = full path works, 1 = stuck somewhere (the spike
 * prints which checkpoint last fired).
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import { nanoid } from "nanoid";
import * as Y from "yjs";

// node 22+ has globalThis.WebSocket built in — no polyfill needed.

const URL = "ws://localhost:1234";
const PROJECT_ID = "6c77479d-33a9-4d89-aa0d-beacbbe1418c";
const DOC_NAME = `project-${PROJECT_ID}/meta`;
const TIMEOUT_MS = 15_000;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function log(client: string, msg: string, extra?: Record<string, unknown>) {
  const tail = extra ? " " + JSON.stringify(extra) : "";
  console.log(`[${ts()}] [${client}] ${msg}${tail}`);
}

async function buildProvider(label: string): Promise<{
  provider: HocuspocusProvider;
  doc: Y.Doc;
}> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: URL,
    name: DOC_NAME,
    document: doc,
    token: "spike-no-account-mode",
    onSynced: () => log(label, "synced=true"),
    onStatus: ({ status }) => log(label, `status=${status}`),
    onAuthenticationFailed: ({ reason }) =>
      log(label, `auth_fail reason=${reason}`),
  });
  provider.on("stateless", (data: { payload: string }) => {
    log(label, "<-stateless", { len: data.payload.length, head: data.payload.slice(0, 80) });
  });

  // Wait for first sync
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} sync timeout`)), TIMEOUT_MS);
    provider.on("synced", () => { clearTimeout(t); resolve(); });
  });
  return { provider, doc };
}

async function main(): Promise<void> {
  console.log("=== SPACE-RPC E2E SPIKE ===");
  console.log(`url=${URL} docName=${DOC_NAME}`);

  // --- Client A (actor) ---
  const a = await buildProvider("A");
  const aSpaces = a.doc.getMap<Y.Map<unknown>>("spaces");
  log("A", "initial spaces.size", { size: aSpaces.size, keys: [...aSpaces.keys()] });

  // --- Client B (observer) — opens AFTER A has done initial sync so it
  // sees A's view of the doc — mirrors a second browser tab. ---
  const b = await buildProvider("B");
  const bSpaces = b.doc.getMap<Y.Map<unknown>>("spaces");
  log("B", "initial spaces.size", { size: bSpaces.size, keys: [...bSpaces.keys()] });

  // Observe changes on BOTH clients.
  const aSpaceUpdates: Array<{ keys: string[]; size: number }> = [];
  aSpaces.observeDeep(() => {
    aSpaceUpdates.push({ keys: [...aSpaces.keys()], size: aSpaces.size });
    log("A", "spaces.observeDeep fired", {
      size: aSpaces.size,
      keys: [...aSpaces.keys()],
    });
  });
  const bSpaceUpdates: Array<{ keys: string[]; size: number }> = [];
  bSpaces.observeDeep(() => {
    bSpaceUpdates.push({ keys: [...bSpaces.keys()], size: bSpaces.size });
    log("B", "spaces.observeDeep fired", {
      size: bSpaces.size,
      keys: [...bSpaces.keys()],
    });
  });

  // Also watch the underlying Y.Doc update events to see if Yjs
  // actually receives the change at all (vs. observer not firing).
  a.doc.on("update", (_update: Uint8Array, origin: unknown) => {
    log("A", "doc.on(update) fired", { origin: typeof origin });
  });
  b.doc.on("update", (_update: Uint8Array, origin: unknown) => {
    log("B", "doc.on(update) fired", { origin: typeof origin });
  });

  // --- Send space:create RPC from A ---
  const newSpaceId = nanoid();
  const rpcId = nanoid();
  const req = {
    id: rpcId,
    type: "space:create",
    payload: { spaceId: newSpaceId, type: "canvas", name: `spike-${ts()}` },
  };
  log("A", "->sendStateless space:create", { spaceId: newSpaceId, rpcId });

  let stateRpcResponse: Record<string, unknown> | null = null;
  const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("RPC response timeout")), TIMEOUT_MS);
    a.provider.on("stateless", (data: { payload: string }) => {
      try {
        const parsed = JSON.parse(data.payload) as Record<string, unknown>;
        if (parsed.id === rpcId) {
          clearTimeout(t);
          stateRpcResponse = parsed;
          resolve(parsed);
        }
      } catch {
        // ignore non-json
      }
    });
  });

  a.provider.sendStateless(JSON.stringify(req));

  let rpcOk = false;
  try {
    const response = await responsePromise;
    rpcOk = !!response.ok;
    log("A", "rpc response received", response);
  } catch (e) {
    log("A", "rpc response FAILED", { err: (e as Error).message });
  }

  // --- Wait up to TIMEOUT_MS for both A and B spaces Maps to contain
  // the new spaceId — mirrors what ProjectPage's safety timeout watches.
  const sawOnA = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), TIMEOUT_MS);
    const check = () => {
      if (aSpaces.has(newSpaceId)) {
        clearTimeout(t);
        resolve(true);
      }
    };
    check();
    aSpaces.observeDeep(check);
  });
  const sawOnB = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), TIMEOUT_MS);
    const check = () => {
      if (bSpaces.has(newSpaceId)) {
        clearTimeout(t);
        resolve(true);
      }
    };
    check();
    bSpaces.observeDeep(check);
  });

  const [a_saw, b_saw] = await Promise.all([sawOnA, sawOnB]);

  // --- Report ---
  console.log("");
  console.log("=== RESULT ===");
  console.log(`RPC response received with ok=true: ${rpcOk}`);
  console.log(`Client A spaces Map contains new spaceId: ${a_saw}`);
  console.log(`Client B spaces Map contains new spaceId: ${b_saw}`);
  console.log(`A observeDeep fires after RPC: ${aSpaceUpdates.length}`);
  console.log(`B observeDeep fires after RPC: ${bSpaceUpdates.length}`);
  console.log("");
  console.log(`Final A spaces keys: ${[...aSpaces.keys()].join(",")}`);
  console.log(`Final B spaces keys: ${[...bSpaces.keys()].join(",")}`);
  console.log(`Final state stateRpcResponse: ${JSON.stringify(stateRpcResponse)}`);

  a.provider.destroy();
  b.provider.destroy();

  const success = rpcOk && a_saw && b_saw;
  process.exit(success ? 0 : 1);
}

main().catch((e) => {
  console.error("spike failed:", e);
  process.exit(2);
});
