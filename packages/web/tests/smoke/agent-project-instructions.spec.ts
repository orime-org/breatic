// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Project instructions (#1400): one text per Project, written from the Agent
 * header, that every Agent request in the Project carries.
 *
 * The first case drives the editor the way a user does and needs no model.
 * The second has one member write "reply in English" and another member ask
 * in Chinese in a new conversation, on the default model and on Claude, then
 * clears the instructions and asks again: only real turns show whether the
 * model follows them over the language of the message.
 */
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { credentialsFor } from '../helpers/credentials';
import { MADE_BY_SMOKE, archiveProjects } from '../helpers/project';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { stateFile, test } from '../helpers/slot';

const CLAUDE = 'anthropic/claude-sonnet-5.5';
const HAN = /\p{Script=Han}/u;

interface Project {
  id: string;
  slug: string;
}

/**
 * Create a Project of this case's own in the account's personal Studio.
 * @param page - The owner's signed-in page.
 * @returns The Project.
 */
async function newProject(page: Page): Promise<Project> {
  const studios = await dataOf<{ id: string; type: string }[]>(await page.request.get('/api/v1/studios'), 'list studios');
  const studio = studios.find((one) => one.type === 'personal');
  if (studio === undefined) throw new Error('the smoke account has no personal Studio');
  const slug = `${MADE_BY_SMOKE}-instructions-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  return dataOf<Project>(await page.request.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { studioId: studio.id, slug, name: 'Smoke run Project instructions', spaceType: 'canvas' },
  }), 'create Project');
}

/**
 * Open the editor from the header, type the text in place of what is there,
 * save, and wait for the editor to close.
 * @param page - A signed-in page on the Project.
 * @param text - What to write; empty clears.
 */
async function writeInstructions(page: Page, text: string): Promise<void> {
  await page.getByTestId('agent-instructions-open').click();
  const input = page.getByTestId('agent-instructions-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(text);
  await page.getByTestId('agent-instructions-save').click();
  await expect(page.getByTestId('agent-instructions-editor')).toHaveCount(0, { timeout: 20_000 });
}

/**
 * One turn in a new conversation, sent as the chat panel sends it, and the
 * text of the reply.
 * @param api - The member's request context.
 * @param projectId - The Project.
 * @param message - What the member types.
 * @param model - The model to answer on, or undefined for the default.
 * @returns The reply's text.
 */
async function askInNewConversation(api: APIRequestContext, projectId: string, message: string, model: string | undefined): Promise<string> {
  const conversation = await dataOf<{ id: string }>(
    await api.post('/api/v1/chat/conversations', { headers: { 'Idempotency-Key': randomUUID() }, data: { project_id: projectId } }),
    'create conversation',
  );
  const res = await api.post('/api/v1/chat/message', {
    headers: { accept: 'text/event-stream', 'Accept-Language': 'zh-CN' },
    data: { project_id: projectId, conversation_id: conversation.id, message, attached_chips: [], time_zone: 'Asia/Shanghai', ...(model === undefined ? {} : { model }) },
    timeout: 300_000,
  });
  expect(res.ok(), `chat message: ${String(res.status())}`).toBe(true);
  await res.text();
  const read = await dataOf<{ messages: { role: string; parts?: { type?: string; text?: string }[] }[] }>(
    await api.get(`/api/v1/chat/conversations/${conversation.id}`), 'read conversation',
  );
  const reply = read.messages.filter((m) => m.role === 'assistant').at(-1);
  return (reply?.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

test('writes, reopens and clears the Project instructions from the Agent header', async ({ page }) => {
  test.setTimeout(120_000);
  let project: Project | null = null;
  try {
    project = await newProject(page);
    await page.goto(`/project/${project.slug}-${project.id}`);
    await expect(page.getByTestId('agent-instructions-open')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('agent-instructions-dot')).toHaveCount(0);

    const text = '  Reply in English.\nUse only blue and white.  ';
    await writeInstructions(page, text);
    await expect(page.getByTestId('agent-instructions-dot')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('agent-instructions-dot')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('agent-instructions-open').click();
    await expect(page.getByTestId('agent-instructions-input')).toHaveValue(text, { timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('agent-instructions-editor')).toHaveCount(0);

    await writeInstructions(page, '');
    await expect(page.getByTestId('agent-instructions-dot')).toHaveCount(0);
  } finally {
    if (project !== null) expect(await archiveProjects(page.request, [project.id]), 'Project cleanup').toEqual([]);
  }
});

test('one member writes "reply in English" and another member asking in Chinese is answered in English @needs-model', async ({ page, browser, baseURL }) => {
  test.setTimeout(900_000); // four real-model turns
  const member = await browser.newContext({ baseURL, storageState: stateFile('B') });
  let project: Project | null = null;
  let memberId: string | undefined;
  try {
    memberId = (await dataOf<{ id: string }>(await member.request.get('/api/v1/auth/me'), 'member identity')).id;
    project = await newProject(page);
    await inviteMember(page, member, project.id, credentialsFor('B').email, 'editor');
    await page.goto(`/project/${project.slug}-${project.id}`);
    await writeInstructions(page, 'Always reply in English, whatever language the message is written in.');

    const question = '给我三个短视频标题，主题是城市夜跑。不用生成任何东西。';
    for (const model of [undefined, CLAUDE]) {
      const reply = await askInNewConversation(member.request, project.id, question, model);
      test.info().annotations.push({ type: `with instructions on ${model ?? 'default'}`, description: reply });
      expect(reply.length, 'a reply came back').toBeGreaterThan(0);
      expect(reply, `the reply on ${model ?? 'the default model'}: ${reply}`).not.toMatch(HAN);
    }

    await writeInstructions(page, '');
    const after = await askInNewConversation(member.request, project.id, question, undefined);
    test.info().annotations.push({ type: 'after clearing', description: after });
    expect(after, `the reply after clearing: ${after}`).toMatch(HAN);
  } finally {
    try {
      await member.close();
    } finally {
      if (project !== null && memberId !== undefined) await cleanMembership(page, project.id, memberId);
      if (project !== null) expect(await archiveProjects(page.request, [project.id]), 'Project cleanup').toEqual([]);
    }
  }
});
