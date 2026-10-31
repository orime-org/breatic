// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Three connections arriving together at a Space whose tier allows two
 * writable ones (inner#1034).
 *
 * Collab takes a seat in one Redis script, so two handshakes can never both
 * read "one seat left": whatever order the three arrive in, two write and one
 * is read-only. When the late one is the admin's second tab it takes over that
 * person's earlier seat, so which page ends up read-only varies; how many does
 * not.
 *
 * The suite's accounts are on `self_hosted`, whose ceiling nobody reaches, and
 * other cases running at the same time rely on that. So this case makes an
 * admin of its own, moves it to `base` (`concurrent_editors: 2` in
 * `config/membership.yaml`) and back again at the end; the account itself stays
 * in the local database like any other the suite has made.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { expect, type BrowserContext, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { credentialsFor } from '../helpers/credentials';
import { MADE_BY_SMOKE } from '../helpers/project';
import { stateFile, test } from '../helpers/slot';
import { visibleSpace } from '../helpers/space';

/** The repository root, where the account scripts run from. */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** How long the three seats are watched after they first add up, for a late handover. */
const SETTLE_MS = 5_000;

/**
 * Run one of the suite's account scripts the way setup runs `seed-smoke-account.ts`.
 * @param script - The file under `scripts/`.
 * @param input - What the script reads from stdin.
 * @returns What the script printed.
 * @throws {Error} When the script fails, with what it printed.
 */
function runScript(script: string, input: object): string {
  try {
    return execFileSync(
      'pnpm',
      ['exec', 'tsx', '--tsconfig', 'packages/server/tsconfig.json', `scripts/${script}`],
      { cwd: REPO_ROOT, input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const said = (err as { stderr?: string }).stderr?.trim() ?? String(err);
    throw new Error(`scripts/${script} failed: ${said.slice(-400)}`);
  }
}

/**
 * Which of the pages show the read-only notice in the Space on screen.
 * @param pages - The pages to read.
 * @returns One flag per page, in the same order.
 */
async function showingNotice(pages: readonly Page[]): Promise<boolean[]> {
  return Promise.all(
    pages.map((p) => visibleSpace(p).getByTestId('space-read-only-notice').isVisible()),
  );
}

test('three connections to a Space capped at two leave exactly one read-only', async ({ browser }) => {
  const mark = randomBytes(6).toString('hex');
  const admin = { email: `smoke-cap-${mark}@breatic.test`, password: randomBytes(18).toString('base64url') };
  const { userId } = JSON.parse(runScript('seed-smoke-account.ts', admin)) as { userId: string };
  let adminContext: BrowserContext | undefined;
  let peerContext: BrowserContext | undefined;
  let projectId: string | undefined;
  let joinedUserId: string | undefined;
  try {
    runScript('set-smoke-tier.ts', { userId, tier: 'base' });
    adminContext = await browser.newContext();
    const api = adminContext.request;
    await dataOf(await api.post('/api/v1/auth/login', { data: admin }), 'sign the admin in');
    await dataOf(
      await api.post('/api/v1/auth/setup-studio', { data: { slug: `smoke-cap-${mark}` } }),
      'create the admin personal studio',
    );
    const studios = await dataOf<Array<{ id: string; type: string }>>(await api.get('/api/v1/studios'), 'list studios');
    const studioId = studios.find((studio) => studio.type === 'personal')?.id;
    expect(studioId, 'the admin personal studio').toBeDefined();
    const project = await dataOf<{ id: string; name: string }>(
      await api.post('/api/v1/projects', {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { studioId, name: `Seat cap ${mark}`, slug: `${MADE_BY_SMOKE}-cap-${mark}`, spaceType: 'canvas' },
      }),
      'create the project',
    );
    projectId = project.id;
    const projectPath = `/project/${projectId}`;

    // The first open seeds the project's one canvas Space, which every page
    // below lands on because it is the newest.
    const owner = await adminContext.newPage();
    await owner.goto(projectPath);
    await expect(visibleSpace(owner).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    await owner.getByRole('button', { name: 'Invite', exact: true }).click();
    await owner.getByTestId('share-invite-input').fill(credentialsFor('B').email);
    await owner.getByTestId('share-invite-role').click();
    await owner.getByRole('option', { name: 'Editor', exact: true }).click();
    await owner.getByTestId('share-send-invite').click();
    await expect(owner.getByTestId('share-popover')).toHaveCount(0);

    peerContext = await browser.newContext({ storageState: stateFile('B') });
    const peer = await peerContext.newPage();
    joinedUserId = (await dataOf<{ id: string }>(await peer.request.get('/api/v1/auth/me'), 'read peer identity')).id;
    await peer.goto('/studio');
    await peer.getByTestId('bell-trigger').click();
    const invitation = peer.locator('li[data-testid^="bell-notification-"]').filter({ hasText: project.name });
    await invitation.locator('[data-testid^="bell-open-decision-"]').click();
    const accept = peer.getByRole('button', { name: 'Accept', exact: true });
    await accept.click();
    await expect(accept).toHaveCount(0);
    const roster = await dataOf<Array<{ userId: string; role: string }>>(
      await api.get(`/api/v1/projects/${projectId}/members`),
      'read joined membership',
    );
    expect(roster.find((member) => member.userId === joinedUserId)?.role).toBe('editor');
    // The owner's page holds a seat; it leaves so the three below start level.
    await owner.close();
    await peer.close();

    const pages = [await adminContext.newPage(), await adminContext.newPage(), await peerContext.newPage()];
    await Promise.all(pages.map((p) => p.goto(projectPath)));
    for (const p of pages) {
      await expect(visibleSpace(p).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    }
    await expect
      .poll(async () => (await showingNotice(pages)).filter(Boolean).length, { timeout: 20_000 })
      .toBe(1);
    // A handover that arrives late would move or add a notice.
    await pages[0].waitForTimeout(SETTLE_MS);
    expect((await showingNotice(pages)).filter(Boolean)).toHaveLength(1);
  } finally {
    await peerContext?.close();
    if (adminContext !== undefined && projectId !== undefined) {
      const api = adminContext.request;
      if (joinedUserId !== undefined) {
        const members = await dataOf<Array<{ userId: string }>>(
          await api.get(`/api/v1/projects/${projectId}/members`),
          'read peer membership for cleanup',
        );
        if (members.some((member) => member.userId === joinedUserId)) {
          await dataOf(
            await api.delete(`/api/v1/projects/${projectId}/members/${joinedUserId}`),
            'remove peer membership',
          );
        }
      }
      const invitations = await dataOf<Array<{ invitationId: string; email: string }>>(
        await api.get(`/api/v1/projects/${projectId}/invitations`),
        'read pending invitations for cleanup',
      );
      for (const pending of invitations.filter((item) => item.email === credentialsFor('B').email)) {
        await dataOf(
          await api.delete(`/api/v1/projects/${projectId}/invitations/${pending.invitationId}`),
          'revoke pending peer invitation',
        );
      }
      // Archiving closes the project's documents, its one Space included.
      const archived = await api.post(`/api/v1/projects/${projectId}/archive`);
      expect(archived.ok(), `archive the case's project: ${archived.status()}`).toBe(true);
    }
    await adminContext?.close();
    runScript('set-smoke-tier.ts', { userId, tier: 'self_hosted' });
  }
});
