// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, type BrowserContext, type Page } from 'playwright/test';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Doc } from 'yjs';

import { test, stateFile } from '../helpers/slot';
import { credentialsFor } from '../helpers/credentials';
import { dataOf } from '../helpers/api';
import { selectInBody } from '../helpers/editor-keys';
import { liveModuleUrl, YJS_MANAGER } from '../helpers/live-module';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR } from '../helpers/space';

/**
 * Open a document through its tab or the Space drawer.
 * @param page - A member's Project page.
 * @param spaceId - The document created by this case.
 * @throws {Error} When the document cannot be opened.
 */
async function openDocument(page: Page, spaceId: string): Promise<void> {
  const tab = page.getByTestId(`space-tab-name-${spaceId}`);
  if (await tab.count() === 0) {
    await page.getByTestId('space-drawer-trigger').click();
    const drawer = page.getByTestId('space-drawer');
    await expect(drawer).toBeVisible();
    await page.getByTestId(`space-drawer-row-${spaceId}`).getByRole('button').first().click();
    await expect(drawer).toHaveCount(0);
  } else {
    await tab.click();
  }
  await expect(page.locator(DOCUMENT_EDITOR)).toBeVisible();
}

/**
 * Append text after the document's current content with a settled selection.
 * @param page - The page displaying the document.
 * @param text - A marker that the peer must receive.
 * @throws {Error} When the editor cannot hold the selection or text.
 */
async function appendText(page: Page, text: string): Promise<void> {
  await selectInBody(page, () => page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    if (editor === null) throw new Error('The document editor is missing');
    const paragraphs = editor.querySelectorAll('p');
    const paragraph = paragraphs.item(paragraphs.length - 1);
    if (paragraph === null) throw new Error('The document paragraph is missing');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    if (selection === null) throw new Error('The document selection is missing');
    selection.removeAllRanges();
    selection.addRange(range);
  }, DOCUMENT_EDITOR));
  await page.keyboard.type(text);
  await expect(page.locator(DOCUMENT_EDITOR)).toContainText(text);
}

/**
 * Reconnect the page's shared transport while keeping its attached documents.
 * @param page - The member's page with both documents attached.
 * @param projectId - The Project owning the live meta provider.
 * @throws {Error} When the transport or its live document is unavailable.
 */
async function reconnect(page: Page, projectId: string): Promise<void> {
  const urls = {
    manager: await liveModuleUrl(page, YJS_MANAGER),
    socket: await liveModuleUrl(page, 'data/yjs/collab-socket.tsx'),
  };
  await Promise.all([page.waitForEvent('websocket'), page.evaluate(async ({ urls, projectId }) => {
    const manager = await import(/* @vite-ignore */ urls.manager) as {
      hasDoc: (name: string) => boolean;
      getDoc: (name: string) => Doc;
      docName: { projectMeta: (id: string) => string };
    };
    const socket = await import(/* @vite-ignore */ urls.socket) as {
      acquireDocProvider: (name: string, doc: Doc) => HocuspocusProvider;
      releaseDocProvider: (name: string) => void;
    };
    const name = manager.docName.projectMeta(projectId);
    if (!manager.hasDoc(name)) throw new Error('The live meta document is missing');
    const provider = socket.acquireDocProvider(name, manager.getDoc(name));
    try {
      const transport = provider.configuration.websocketProvider;
      const closed = new Promise<void>((resolve) => {
        /** Release this observer when the shared transport closes. */
        const onClose = (): void => {
          transport.off('close', onClose);
          resolve();
        };
        transport.on('close', onClose);
      });
      transport.disconnect();
      await closed;
      await transport.connect();
    } finally {
      socket.releaseDocProvider(name);
    }
  }, { urls, projectId })]);
}

test('valid sessions synchronize two Spaces and reconnect the shared transport', async ({ page, browser }) => {
  const spaces: string[] = [];
  let peerContext: BrowserContext | undefined;
  let joinedUserId: string | undefined;
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const project = await dataOf<{ name: string }>(
    await page.request.get(`/api/v1/projects/${projectId}`),
    'read the current Project name',
  );
  const marker = `session-${crypto.randomUUID()}`;
  const first = `${marker}-first`;
  const second = `${marker}-second`;
  const afterReconnect = `${marker}-reconnected`;
  try {
    spaces.push(await createSpace(page, 'document', `${marker}-one`));
    spaces.push(await createSpace(page, 'document', `${marker}-two`));
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await page.getByTestId('share-invite-input').fill(credentialsFor('B').email);
    await page.getByTestId('share-invite-role').click();
    await page.getByRole('option', { name: 'Editor', exact: true }).click();
    await page.getByTestId('share-send-invite').click();
    await expect(page.getByTestId('share-popover')).toHaveCount(0);

    peerContext = await browser.newContext({ storageState: stateFile('B') });
    const peer = await peerContext.newPage();
    const me = await dataOf<{ id: string }>(await peer.request.get('/api/v1/auth/me'), 'read peer identity');
    joinedUserId = me.id;
    await peer.goto(new URL('/studio', projectUrl).toString());
    await peer.getByTestId('bell-trigger').click();
    const invitation = peer.locator('li[data-testid^="bell-notification-"]').filter({ hasText: project.name });
    await invitation.locator('[data-testid^="bell-open-decision-"]').click();
    const accept = peer.getByRole('button', { name: 'Accept', exact: true });
    await accept.click();
    await expect(accept).toHaveCount(0);

    const roster = await dataOf<Array<{ userId: string; role: string }>>(
      await page.request.get(`/api/v1/projects/${projectId}/members`),
      'read joined membership',
    );
    expect(roster.find((member) => member.userId === me.id)?.role).toBe('editor');
    await peer.goto(projectUrl);
    await expect(peer.getByTestId('space-drawer-trigger')).toBeVisible();

    for (const spaceId of spaces) {
      await openDocument(peer, spaceId);
      await expect(peer.locator(DOCUMENT_EDITOR)).toHaveAttribute('contenteditable', 'true');
    }
    await openDocument(page, spaces[0]);
    await appendText(page, first);
    await openDocument(peer, spaces[0]);
    await expect(peer.locator(DOCUMENT_EDITOR)).toContainText(first);

    await openDocument(peer, spaces[1]);
    await appendText(peer, second);
    await openDocument(page, spaces[1]);
    await expect(page.locator(DOCUMENT_EDITOR)).toContainText(second);

    await reconnect(peer, projectId);
    await appendText(peer, afterReconnect);
    await expect(page.locator(DOCUMENT_EDITOR)).toContainText(afterReconnect);
    await openDocument(page, spaces[0]);
    await appendText(page, `${marker}-return`);
    await openDocument(peer, spaces[0]);
    await expect(peer.locator(DOCUMENT_EDITOR)).toContainText(`${marker}-return`);
  } finally {
    await peerContext?.close();
    for (const spaceId of spaces.reverse()) await deleteSpace(page, spaceId);
    if (joinedUserId !== undefined) {
      const members = await dataOf<Array<{ userId: string }>>(
        await page.request.get(`/api/v1/projects/${projectId}/members`),
        'read peer membership for cleanup',
      );
      if (members.some((member) => member.userId === joinedUserId)) {
        await dataOf(
          await page.request.delete(`/api/v1/projects/${projectId}/members/${joinedUserId}`),
          'remove peer membership',
        );
      }
    }
    const invitations = await dataOf<Array<{ invitationId: string; email: string }>>(
      await page.request.get(`/api/v1/projects/${projectId}/invitations`),
      'read pending invitations for cleanup',
    );
    for (const invitation of invitations.filter((item) => item.email === credentialsFor('B').email)) {
      await dataOf(
        await page.request.delete(`/api/v1/projects/${projectId}/invitations/${invitation.invitationId}`),
        'revoke pending peer invitation',
      );
    }
  }
});
