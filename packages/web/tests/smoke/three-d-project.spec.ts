// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Project creation and real membership around collaborative 3D scenes (inner#1689). */
import { expect, type BrowserContext, type Locator, type Page } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { credentialsFor } from '../helpers/credentials';
import { archiveProjects, MADE_BY_SMOKE } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

interface Studio {
  id: string;
  slug: string;
  type: string;
}

interface Project {
  id: string;
  slug: string;
  name: string;
}

/**
 * Find the slot account's own Studio through the authenticated application API.
 * @throws {Error} When the slot account has no personal Studio.
 */
async function ownStudio(page: Page): Promise<Studio> {
  const studios = await dataOf<Studio[]>(await page.request.get('/api/v1/studios'), 'list own studios');
  const studio = studios.find((item) => item.type === 'personal');
  if (!studio) throw new Error('The smoke account has no personal Studio');
  return studio;
}

/** Create this case's Project, whose initial Canvas keeps later scene deletion above the one-Space floor. */
async function newProject(page: Page, studio: Studio, topic: string): Promise<Project> {
  const slug = `${MADE_BY_SMOKE}-3d-${topic}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  return dataOf<Project>(await page.request.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: { studioId: studio.id, slug, name: `Smoke run 3D ${topic}`, spaceType: 'canvas' },
  }), 'create independent scene Project');
}

/** Require the active Space's actual 3D renderer, rather than a loading or error fallback. */
async function scene(page: Page): Promise<Locator> {
  const editor = visibleSpace(page).getByTestId('three-d-space');
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId('three-d-viewport')).toBeVisible();
  return editor;
}

/** Open a known Space through the drawer; each Project uses its own tab preferences. */
async function openScene(page: Page, project: Project, spaceId: string): Promise<Locator> {
  await page.goto(`/project/${project.slug}-${project.id}`);
  await page.getByTestId('space-drawer-trigger').click();
  await page.getByTestId(`space-drawer-row-${spaceId}`).getByRole('button').first().click();
  await expect(page.getByTestId('space-drawer')).toHaveCount(0);
  return scene(page);
}

/** Select an object through the portal list and read its actual inspector. */
async function objectName(page: Page, objectId: string): Promise<Locator> {
  const editor = await scene(page);
  await editor.getByTestId('scene-objects-trigger').click();
  await page.getByTestId('scene-objects-panel').getByTestId(`scene-object-${objectId}`).click();
  return page.getByTestId('scene-properties-panel').getByLabel('Name', { exact: true });
}

/** Commit an object's name through its actual inspector field. */
async function renameObject(page: Page, objectId: string, name: string): Promise<void> {
  const field = await objectName(page, objectId);
  await field.fill(name);
  await field.press('Enter');
  await expect(field).toHaveValue(name);
}

/**
 * Place a built-in block through the Add menu and return its stable object identity.
 * @throws {Error} When the created row has no stable identity.
 */
async function addBlock(page: Page, name: string): Promise<string> {
  const editor = await scene(page);
  await editor.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add block', exact: true }).click();
  const field = page.getByTestId('scene-properties-panel').getByLabel('Name', { exact: true });
  await expect(field).toHaveValue('Stage block');
  await field.fill(name);
  await field.press('Enter');
  await editor.getByTestId('scene-objects-trigger').click();
  const row = page.getByTestId('scene-objects-panel').getByRole('button', { name, exact: true });
  await expect(row).toBeVisible();
  const testId = await row.getAttribute('data-testid');
  if (!testId) throw new Error('The created object has no identity');
  await row.click();
  return testId.slice('scene-object-'.length);
}

/** Delete this case's extra scene through the Space helper, then archive its Project even if navigation fails. */
async function cleanProject(page: Page, project: Project | null, spaceId?: string): Promise<void> {
  if (!project) return;
  try {
    if (spaceId) {
      await page.goto(`/project/${project.slug}-${project.id}`);
      await expect(page.getByTestId('space-drawer-trigger')).toBeVisible();
      await deleteSpace(page, spaceId);
    }
  } finally {
    expect(await archiveProjects(page.request, [project.id]), 'Project cleanup').toEqual([]);
  }
}

/**
 * Read the actual invitation notification addressed to this account and Project.
 * @throws {Error} When no invitation token was delivered.
 */
async function invitationToken(context: BrowserContext, projectId: string): Promise<string> {
  let token: string | undefined;
  await expect.poll(async () => {
    const bell = await dataOf<{ items: Array<{ type: string; payload: { projectId?: string; shareToken?: string } }> }>(
      await context.request.get('/api/v1/users/me/notifications'), 'read invitee notification',
    );
    token = bell.items.find((item) => item.type === 'project.invite_request' && item.payload.projectId === projectId)?.payload.shareToken;
    return token;
  }).toBeDefined();
  if (!token) throw new Error('No invitation token was delivered');
  return token;
}

/** Remove accepted membership and revoke any invitation left pending by an earlier failure. */
async function cleanMembership(page: Page, projectId: string, memberId: string): Promise<void> {
  try {
    const members = await dataOf<Array<{ userId: string }>>(
      await page.request.get(`/api/v1/projects/${projectId}/members`), 'list members for cleanup',
    );
    if (members.some((member) => member.userId === memberId)) {
      await dataOf(await page.request.delete(`/api/v1/projects/${projectId}/members/${memberId}`), 'remove invited member');
    }
  } finally {
    const pending = await dataOf<Array<{ invitationId: string; invitedUserId: string | null }>>(
      await page.request.get(`/api/v1/projects/${projectId}/invitations`), 'list pending invitations for cleanup',
    );
    for (const invitation of pending.filter((item) => item.invitedUserId === memberId)) {
      await dataOf(await page.request.delete(`/api/v1/projects/${projectId}/invitations/${invitation.invitationId}`), 'revoke unused invitation');
    }
  }
}

test('Studio creation with 3D Space opens the first Project directly as a scene', async ({ page }) => {
  const studio = await ownStudio(page);
  let project: Project | null = null;
  try {
    await page.goto(`/studio/${studio.slug}/projects`);
    await page.getByTestId('container-toolbar').getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByTestId('new-project-dialog');
    expect(await dialog.getByRole('radio').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-testid')))).toEqual([
      'new-project-type-canvas', 'new-project-type-document', 'new-project-type-3d', 'new-project-type-timeline',
    ]);
    await expect(dialog.getByTestId('new-project-type-3d').getByText('3D', { exact: true })).toBeVisible();
    await dialog.locator('#new-project-name').fill(`Smoke run 3D first ${crypto.randomUUID()}`);
    await dialog.getByTestId('new-project-type-3d').click();
    const [created] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/projects' && response.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Create', exact: true }).click(),
    ]);
    project = await dataOf<Project>(created, 'create 3D Project from Studio');
    await expect(page).toHaveURL(new RegExp(`/project/${project.slug}-${project.id}$`));
    const editor = await scene(page);
    const tab = page.locator('[data-testid^="space-tab-name-"]');
    await expect(tab).toHaveCount(1);
    await expect(tab).toHaveText('3D');
    await page.getByTestId('space-drawer-trigger').click();
    const drawerName = page.getByTestId('space-drawer').locator('[data-testid^="space-drawer-name-"]');
    await expect(drawerName).toHaveCount(1);
    await expect(drawerName).toHaveText('3D');
    await page.screenshot({ path: test.info().outputPath('initial-3d-name.png'), animations: 'disabled' });
    await test.info().attach('initial-3d-name', { body: JSON.stringify({ tab: await tab.innerText(), drawer: await drawerName.innerText() }), contentType: 'application/json' });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('space-drawer')).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add block', exact: true }).click();
    await expect(page.getByTestId('scene-properties-panel').getByLabel('Name', { exact: true })).toHaveValue('Stage block');
  } finally {
    // The only initial Space cannot be deleted independently; archiving owns this entire Project.
    await cleanProject(page, project);
  }
});

for (const role of ['editor', 'viewer'] as const) {
  test(`a different account accepts a Project invitation as ${role} and shares the scene with that access`, async ({ page, browser, baseURL }) => {
    const invitee = await browser.newContext({ baseURL, storageState: stateFile('B') });
    let project: Project | null = null;
    let sceneId: string | undefined;
    let inviteeId: string | undefined;
    try {
      const studio = await ownStudio(page);
      const owner = await dataOf<{ id: string }>(await page.request.get('/api/v1/auth/me'), 'owner identity');
      const other = await dataOf<{ id: string }>(await invitee.request.get('/api/v1/auth/me'), 'invitee identity');
      inviteeId = other.id;
      expect(other.id).not.toBe(owner.id);
      project = await newProject(page, studio, role);
      await page.goto(`/project/${project.slug}-${project.id}`);
      sceneId = await createSpace(page, '3d', `Shared scene ${crypto.randomUUID()}`);
      const objectId = await addBlock(page, 'Shared block');

      await dataOf(await page.request.post(`/api/v1/projects/${project.id}/invitations`, {
        data: { email: credentialsFor('B').email, role },
      }), 'invite another account');
      const token = await invitationToken(invitee, project.id);
      const memberPage = await invitee.newPage();
      await memberPage.goto(`/decision?token=${encodeURIComponent(token)}`);
      await expect(memberPage.getByRole('heading', { name: 'You\'ve been invited to a Project', exact: true })).toBeVisible();
      const [accepted] = await Promise.all([
        memberPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/decisions/respond'
          && response.request().method() === 'POST'),
        memberPage.getByRole('button', { name: 'Accept', exact: true }).click(),
      ]);
      await dataOf(accepted, 'accept real Project invitation');
      expect(await dataOf<{ myRole: string }>(await invitee.request.get(`/api/v1/projects/${project.id}`), 'read granted role')).toMatchObject({ myRole: role });

      const shared = await openScene(memberPage, project, sceneId);
      const name = await objectName(memberPage, objectId);
      await expect(name).toHaveValue('Shared block');
      if (role === 'editor') {
        await expect(shared.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
        await renameObject(memberPage, objectId, 'Edited by the invited account');
        await expect(page.getByTestId('scene-properties-panel').getByLabel('Name', { exact: true })).toHaveValue('Edited by the invited account');
      } else {
        await expect(shared.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
        await expect(shared.getByRole('button', { name: 'Duplicate', exact: true })).toBeDisabled();
        await expect(shared.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
        await expect(name).toBeDisabled();
      }
      await renameObject(page, objectId, 'Owner update reaches the other account');
      await expect(name).toHaveValue('Owner update reaches the other account');
    } finally {
      try {
        await invitee.close();
      } finally {
        try {
          if (project && inviteeId) await cleanMembership(page, project.id, inviteeId);
        } finally {
          await cleanProject(page, project, sceneId);
        }
      }
    }
  });
}
