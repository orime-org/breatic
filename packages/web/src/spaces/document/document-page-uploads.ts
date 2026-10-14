// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The page's one upload controller, against the real network (inner#1351 +
 * inner#1390 design §5.5): every open body on the page shares it, so a
 * result is kept for the page's lifetime whichever body the block turns up
 * in. Each upload runs against the project and Space it was started in.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';

import { assetsApi } from '@web/data/api/assets';
import { canvasApi } from '@web/data/api/canvas';
import { uploadMedia } from '@web/data/upload/media-upload';
import { waitForUploadEnding } from '@web/data/upload/upload-status';
import { readDocFacts, readWriteAccess } from '@web/data/yjs/collab-socket';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import {
  openBodyUploads,
  type BodyAwareness,
  type BodyConnection,
  type BodyUploads,
} from '@web/spaces/document/document-body-uploads';
import {
  createUploadController,
  type UploadController,
  type UploadControllerDeps,
} from '@web/spaces/document/document-upload-controller';
import { createUploadSources } from '@web/spaces/document/document-upload-sources';

/** Where an upload lands. */
export interface UploadTarget {
  readonly projectId: string;
  readonly spaceId: string;
}

/** The project and Space each upload this page started lands in. */
const targets = new Map<string, UploadTarget>();

/** One run function per Space, so a paste's addresses of ours go in one request. */
const runners = new Map<string, UploadControllerDeps['run']>();

/**
 * Reads a `data:` or `blob:` address into a file. Nothing crosses the
 * network, so there is nothing for the shared transport to retry, and it
 * takes only `http(s)` addresses; `XMLHttpRequest` reads both kinds.
 * @param url - The address.
 * @returns The file.
 * @throws {Error} When the address cannot be read: a `blob:` its page revoked.
 */
function readLocalAddress(url: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.onload = (): void => {
      const blob = xhr.response as Blob;
      resolve(new File([blob], 'pasted', { type: blob.type }));
    };
    xhr.onerror = (): void => {
      reject(new Error('The address could not be read'));
    };
    xhr.send();
  });
}

/**
 * The run function for uploads landing in a Space.
 * @param target - The project and Space.
 * @returns The run function.
 */
function runnerFor(target: UploadTarget): UploadControllerDeps['run'] {
  const key = `${target.projectId}:${target.spaceId}`;
  let run = runners.get(key);
  if (run === undefined) {
    run = createUploadSources({
      uploadFile: (file, onProgress) => uploadMedia(file, target, onProgress),
      ingest: async (url) =>
        (await assetsApi.ingestUrl({ url, project_id: target.projectId, space_id: target.spaceId })).storage_key,
      waitForEnding: waitForUploadEnding,
      register: async ({ urls, pairs }) =>
        (await canvasApi.paste({ project_id: target.projectId, urls, pairs, history: [] })).map,
      assetUrlPrefix: () =>
        assetsApi
          .fetchUploadConfig()
          .then((cfg) => cfg.assetUrlPrefix)
          .catch(() => null),
      readAddress: readLocalAddress,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    runners.set(key, run);
  }
  return run;
}

/**
 * Ticks on a Worker's timer, which a hidden tab does not slow.
 * @param tick - Called on each tick.
 * @returns What stops the timer.
 */
function renewOnWorker(tick: () => void): () => void {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./document-claim-renewal-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    // ponytail: main-thread fallback, throttled to once in 30 s+ when hidden.
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }
  worker.onmessage = tick;
  return () => worker.terminate();
}

let controller: UploadController | null = null;

/**
 * The page's controller, built the first time a body asks.
 * @returns The controller.
 */
function pageController(): UploadController {
  if (controller === null) {
    const operations = useSpaceOperationsStore.getState();
    controller = createUploadController({
      run: (uploadId, source, onProgress) => {
        const target = targets.get(uploadId);
        if (target === undefined) {
          return Promise.resolve({
            ok: false,
            failure: { messageKey: 'canvas.upload.failed', params: {}, retryable: false },
          });
        }
        return runnerFor(target)(uploadId, source, onProgress);
      },
      register: (spaceId, uploadId) => {
        operations.register(spaceId, uploadId);
      },
      unregister: (spaceId, uploadId) => {
        operations.unregister(spaceId, uploadId);
      },
      renew: renewOnWorker,
    });
  }
  return controller;
}

/**
 * What this page's provider says about a body.
 * @param name - The body's document name.
 * @param provider - Its provider; absent, the body is taken as writable.
 * @returns The connection.
 */
function connectionOf(name: string, provider: HocuspocusProvider | undefined): BodyConnection {
  if (provider === undefined) {
    return { writeAccess: () => 'granted', refused: () => false, onChange: () => () => {} };
  }
  /**
   * Whether the server refused the body, read off the provider registry.
   * @returns True while its last handshake was refused.
   */
  const refused = (): boolean => readDocFacts(name).authFailure !== null;
  return {
    awareness: provider.awareness as unknown as BodyAwareness,
    writeAccess: () => (refused() ? 'denied' : readWriteAccess(provider)),
    refused,
    onChange: (listener) => {
      provider.on('authenticated', listener);
      provider.on('authenticationFailed', listener);
      return () => {
        provider.off('authenticated', listener);
        provider.off('authenticationFailed', listener);
      };
    },
  };
}

/**
 * Opens a body's link to the page's uploads.
 * @param target - Where its uploads land.
 * @param doc - Its document.
 * @param name - Its document name.
 * @param provider - This page's provider for it, when there is one.
 * @returns The link.
 */
export function openPageBodyUploads(
  target: UploadTarget,
  doc: Y.Doc,
  name: string,
  provider: HocuspocusProvider | undefined,
): BodyUploads {
  return openBodyUploads(
    pageController(),
    { spaceId: target.spaceId, doc, connection: connectionOf(name, provider) },
    (uploadId) => {
      targets.set(uploadId, target);
    },
  );
}
