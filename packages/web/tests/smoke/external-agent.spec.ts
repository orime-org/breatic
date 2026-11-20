// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An external agent connected over MCP (breatic#1488), end to end through the
 * real server, collab and MCP service: the user makes a personal access token
 * from the account menu, the agent works on a canvas with it, and the user sees
 * where it works, lets it see the screen, follows it, hands it a note and reads
 * its reply, then revokes it; and a member mentioned in a note hears it from
 * the bell at once.
 *
 *   pnpm --filter @breatic/web test:smoke external-agent
 */
import { expect, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { credentialsFor } from '../helpers/credentials';
import { openSmokeProject } from '../helpers/project';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { stateFile, test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { projectIdOf } from '../helpers/tab-restore';

/** What one tool call answered: its JSON result and any image it carried. */
interface ToolAnswer {
  result: Record<string, unknown>;
  image: { mimeType: string } | null;
  isError: boolean;
}

/**
 * Make a personal access token from the account menu's Agent tokens dialog.
 * @param page - A signed-in page; it ends on the studio page.
 * @param name - The token's name.
 * @returns The token and its connection id.
 */
async function newToken(page: Page, name: string): Promise<{ token: string; connectionId: string }> {
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByTestId('account-menu-agent-tokens').click();
  const dialog = page.getByTestId('agent-tokens-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'New token' }).click();
  await page.locator('#agent-token-name').fill(name);
  await page.getByRole('button', { name: 'Generate' }).click();
  const token = (await page.getByTestId('agent-token-value').textContent())?.trim() ?? '';
  expect(token.length).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Escape');
  const list = (await (await page.request.get('/api/v1/agent-access/connections')).json()) as { data: Array<{ id: string; displayName: string }> };
  const row = list.data.find((r) => r.displayName === name);
  if (!row) throw new Error(`The token ${name} is not among the connections`);
  return { token, connectionId: row.id };
}

/**
 * Call one MCP tool the way an external agent does.
 * @param page - Any page on the app, for its origin.
 * @param token - The agent's token.
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns What it answered.
 */
async function callTool(page: Page, token: string, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const res = await page.request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status(), `${name} answered ${String(res.status())}`).toBe(200);
  const line = (await res.text()).split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`${name} sent no message`);
  const message = JSON.parse(line.slice('data: '.length)) as {
    result: { content: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean };
  };
  const text = message.result.content.find((c) => c.type === 'text')?.text ?? '{}';
  const image = message.result.content.find((c) => c.type === 'image');
  return {
    result: (JSON.parse(text) as { result?: Record<string, unknown> }).result ?? {},
    image: image ? { mimeType: image.mimeType ?? '' } : null,
    isError: message.result.isError === true,
  };
}

let page: Page;
let spaceId = '';
let connectionId = '';

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
});

test.afterEach(async () => {
  if (connectionId !== '') await page.request.delete(`/api/v1/agent-access/connections/${encodeURIComponent(connectionId)}`);
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page.close();
  spaceId = '';
  connectionId = '';
});

test('shows where an external agent works, lets it see the screen and be followed, and lets it go when revoked', async () => {
  const name = `agent-e2e-${String(Date.now())}`;
  const made = await newToken(page, name);
  connectionId = made.connectionId;
  await openSmokeProject(page);
  spaceId = await createSpace(page, 'canvas', `agent-e2e-${String(Date.now())}`);
  const projectId = projectIdOf(page.url());

  const created = await callTool(page, made.token, 'create_canvas_nodes', { projectId, spaceId, nodes: [{ type: 'text', name: 'Agent draft' }] });
  expect(created.isError).toBe(false);

  // Its name tag sits on the node it made, and the member list says it is working.
  await expect(visibleSpace(page).locator(`[data-testid="node-occupant-agent-${connectionId}"]`)).toContainText(name);
  await page.getByTestId('members-trigger').click();
  await expect(page.getByTestId(`members-agent-status-${connectionId}`)).toHaveText('Online · Working');

  // It asks to see the screen and gets the canvas in front, with what is on it.
  const seen = await callTool(page, made.token, 'view_user_screen', { projectId });
  expect(seen.image?.mimeType).toMatch(/^image\/(webp|jpeg)$/);
  expect(seen.result).toMatchObject({ watching: true, view: { spaceId, kind: 'canvas' } });

  // The user follows it from its row.
  await page.getByTestId(`members-agent-follow-${connectionId}`).click();
  await expect(page.getByTestId('follow-bar')).toContainText(name);

  // Revoked, it goes offline: its tag leaves the node and following ends.
  const revoked = await page.request.delete(`/api/v1/agent-access/connections/${encodeURIComponent(connectionId)}`);
  expect(revoked.status()).toBe(200);
  connectionId = '';
  await expect(page.getByTestId('follow-bar')).toHaveCount(0, { timeout: 15_000 });
  await expect(visibleSpace(page).locator('[data-testid^="node-occupant-agent-"]')).toHaveCount(0);
});

test('a note handed to an external agent waits for it, and its reply ends the wait and rings the bell', async () => {
  const name = `agent-hand-${String(Date.now())}`;
  const made = await newToken(page, name);
  connectionId = made.connectionId;
  await openSmokeProject(page);
  spaceId = await createSpace(page, 'canvas', `agent-hand-${String(Date.now())}`);
  const projectId = projectIdOf(page.url());

  // A note on the canvas, opened, handed to the agent from its own row.
  const note = await callTool(page, made.token, 'comment_on_canvas', { projectId, spaceId, text: 'Please tighten the opening', position: { x: 0, y: 0 } });
  expect(note.isError).toBe(false);
  const annotationId = String(note.result.annotationId ?? note.result.nodeId ?? '');
  expect(annotationId).not.toBe('');
  await visibleSpace(page).getByTestId('annotation-pin').first().click();
  const sticky = page.getByTestId('annotation-sticky').first();
  await sticky.getByTestId('hand-over-open').click();
  await page.getByTestId(`hand-over-choice-${connectionId}`).click();
  await expect(sticky).toContainText(`Waiting for ${name}`);

  // The agent replies to the thread; the wait ends and its reply says who.
  const reply = await callTool(page, made.token, 'comment_on_canvas', { projectId, spaceId, text: 'Done: the opening is two lines now', annotationId });
  expect(reply.result).toMatchObject({ answered: true });
  await expect(sticky).toContainText(`${name} replied`);
  await expect(sticky).not.toContainText(`Waiting for ${name}`);

  // The one who handed it over hears about it from the bell, already open:
  // collab writes the notification while it runs the reply and tells the
  // project page, which reads the bell again.
  await page.getByTestId('bell-trigger').click();
  await expect(page.getByTestId('bell-popover')).toContainText(`${name} finished the comment you handed it`, { timeout: 5_000 });
});

test('a member mentioned in a note hears it from the bell on the project page at once', async ({ browser }) => {
  await openSmokeProject(page);
  const projectId = projectIdOf(page.url());
  const peer = await browser.newContext({ storageState: stateFile('B') });
  const me = await dataOf<{ id: string }>(await peer.request.get('/api/v1/auth/me'), 'read slot B identity');
  const peerPage = await inviteMember(page, peer, projectId, credentialsFor('B').email, 'editor');
  try {
    spaceId = await createSpace(page, 'canvas', `mention-${String(Date.now())}`);
    // An inbox with nothing unread, so the row below can only be this note's.
    await dataOf(await peer.request.post('/api/v1/users/me/notifications/read-all'), 'B clears news');
    await peerPage.goto(page.url());
    await peerPage.getByTestId('bell-trigger').click();
    const bell = peerPage.getByTestId('bell-popover');
    await expect(bell).toBeVisible();

    // A writes a note that mentions B, picked from the @ list.
    await page.getByTestId('tool-comment').click();
    const board = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
    if (board === null) throw new Error('the board draws nothing');
    await page.mouse.click(board.x + board.width * 0.35, board.y + board.height * 0.45);
    await expect(page.getByTestId('annotation-composer-input')).toBeVisible();
    await page.keyboard.type('look @');
    await page.getByTestId(`mention-picker-member-${me.id}`).click();
    await page.keyboard.type(' please');
    await page.keyboard.press('Enter');

    // B's open bell shows it without being opened again.
    await expect(bell).toContainText('mentioned you in a comment', { timeout: 5_000 });
  } finally {
    await cleanMembership(page, projectId, me.id);
    await peer.close();
  }
});
