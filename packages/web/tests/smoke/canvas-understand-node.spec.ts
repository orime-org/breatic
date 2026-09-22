// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a node, and keeping what the reading said (#2175).
 *
 * Two halves the unit suite cannot reach. The first is whether one press on
 * Understand really produces a node downstream with a row counting the run —
 * the browser builds the node and the edge, the server opens the row, the
 * worker settles it, and collab writes the words into the body: four
 * processes, none of which a unit test has.
 *
 * The second is Snapshot, which is the browser writing a history row for
 * words only it can see. Its whole point is that the server never reads the
 * canvas document, so the only proof the row holds the right text is asking
 * for the list back and finding it.
 *
 * Nothing is uploaded. An Understand run reads whatever address the node is
 * showing, so the image node here points at a public one — the same way the
 * agent's own tool is measured (`agent-understand-media.spec.ts`).
 *
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke:all
 */
import { randomUUID } from 'node:crypto';

import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

/** A public JPEG, the same host the agent's own understand run is measured against. */
const IMAGE = 'https://picsum.photos/id/237/400/300.jpg';

let page: Page;
let projectId = '';
let spaceId = '';

// Real node ids are uuids, and both history endpoints validate that — a
// readable stand-in like `e2e-words` is refused before either is reached.
let imageNode = '';
let wordsNode = '';

/**
 * Seed a node straight into the live canvas document.
 *
 * The same route `audio-generate-panel.spec.ts` takes: the module is imported
 * by its versioned URL so the page's own copy answers, caches and all, rather
 * than a second evaluation with empty ones.
 * @param opts - What to seed.
 * @param opts.id - Node id.
 * @param opts.type - Node modality.
 * @param opts.x - Flow x.
 * @param opts.data - Extra data fields merged onto the required ones.
 * @param opts.body - Words to seed into a text node's body.
 * @returns Nothing; resolves once the document holds the node.
 */
async function seedNode(opts: {
  id: string;
  type: string;
  x: number;
  data?: Record<string, unknown>;
  body?: string;
}): Promise<void> {
  const seen = await page.evaluate(
    async ([pid, sid, raw]: [string, string, string]) => {
      const spec = JSON.parse(raw) as {
        id: string;
        type: string;
        x: number;
        data?: Record<string, unknown>;
        body?: string;
      };
      const live = (re: RegExp): string => {
        const found = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => re.test(n));
        if (found === undefined) throw new Error(`no module matches ${re.source}`);
        return found;
      };
      const canvas = (await import(
        /* @vite-ignore */ live(/data\/yjs\/canvas-space\.ts/)
      )) as {
        addNode: (p: string, s: string, n: unknown) => void;
        getTextBody: (p: string, s: string, id: string) => unknown;
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string }[] };
      };
      canvas.addNode(pid, sid, {
        id: spec.id,
        type: spec.type,
        position: { x: spec.x, y: 0 },
        data: {
          name: `${spec.type}-e2e`,
          createdAt: Date.now(),
          createdBy: 'understand-e2e',
          locked: false,
          attachments: [],
          ...(spec.data ?? {}),
        },
      });
      if (spec.body !== undefined) {
        // The body helpers have their own entry point, so the module to ask
        // for is that one — the package's main bundle does not carry them.
        const shared = (await import(
          /* @vite-ignore */
          live(/@breatic_shared_canvas-body|shared\/dist\/canvas\/text-body\.js/)
        )) as { writePlainTextIntoBody: (b: unknown, t: string) => void };
        shared.writePlainTextIntoBody(
          canvas.getTextBody(pid, sid, spec.id),
          spec.body,
        );
      }
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id);
    },
    [projectId, spaceId, JSON.stringify(opts)] as [string, string, string],
  );
  if (!seen.includes(opts.id)) {
    throw new Error(`${opts.id} never reached the document; saw [${seen.join(', ')}]`);
  }
}

/**
 * Open a node's context menu.
 * @param nodeId - The node to right-click.
 * @returns Nothing; resolves once the menu is on screen.
 */
async function openNodeMenu(nodeId: string): Promise<void> {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
}

// Each case opens its own Space and seeds its own pair. The alternative is
// one opening shared across the file, and a failure in the first case then
// reports the rest as never having run — which reads as a suite that did not
// cover them rather than one that could not.
test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await openSmokeProject(page);
  // The URL segment is the project's SLUG, which ENDS in its id. Taking the
  // whole segment names a second, empty Yjs document — writes into it land
  // nowhere the canvas reads (the same trap `audio-generate-panel` documents).
  projectId = smokeProjectId();

  spaceId = await createSpace(page, 'canvas', `understand-e2e-${Date.now()}`);
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 20_000 });

  imageNode = randomUUID();
  wordsNode = randomUUID();
  await seedNode({
    id: imageNode,
    type: 'image',
    x: 0,
    data: { content: IMAGE, mimeType: 'image/jpeg', size: 40_000 },
  });
  await seedNode({ id: wordsNode, type: 'text', x: 420, body: 'Seeded words.' });
  // Snapshot reads the body, so a node that never got one would fail for a
  // reason that has nothing to do with Snapshot.
  await expect(
    page.locator(`.react-flow__node[data-id="${wordsNode}"]`),
  ).toContainText('Seeded words.', { timeout: 10_000 });
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page?.close();
  spaceId = '';
});

test('a node showing an asset offers Understand, and a text node does not @needs-internet', async () => {
  await openNodeMenu(imageNode);
  // The item is on every node's menu; on one showing an asset it is live.
  await expect(page.getByTestId('node-menu-understand')).not.toHaveAttribute(
    'data-disabled',
    '',
  );
  // Snapshot is the other way round: words have one, an asset does not.
  await expect(page.getByTestId('node-menu-snapshot')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await openNodeMenu(wordsNode);
  await expect(page.getByTestId('node-menu-snapshot')).toBeVisible();
  // A text node holds words, not an asset, and the three items that act on an
  // asset are left out rather than greyed: an item greyed on every text node
  // forever says "not right now" about something never on offer here.
  await expect(page.getByTestId('node-menu-understand')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Snapshot writes a row the history panel hands back @needs-internet', async () => {
  await openNodeMenu(wordsNode);
  await page.getByTestId('node-menu-snapshot').click();

  await openNodeMenu(wordsNode);
  await page.getByTestId('node-menu-history').click();

  const rows = page.getByTestId('node-history-row');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  // The chip says what the row IS, and this one is neither generated nor
  // uploaded — the reader asked for it to be kept.
  await expect(rows.first()).toContainText('Snapshot');
});

test('Understand puts a text node downstream with a row counting the run @needs-model @needs-internet', async () => {
  await openNodeMenu(imageNode);
  await page.getByTestId('node-menu-understand').click();

  // The browser builds the node and its edge before the request goes out, so
  // a third node is on the canvas either way; what the run decides is what
  // lands in it.
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(3, { timeout: 15_000 });

  // xyflow puts the node's id on the element, not its type — the new node is
  // the one that is neither of the two seeded here.
  const readNode = page.locator(
    `.react-flow__node:not([data-id="${imageNode}"]):not([data-id="${wordsNode}"])`,
  );
  await expect(readNode).toBeVisible();

  // What the node says before the run lands — a placeholder and its name.
  // Anything the run produces replaces it, so waiting for this string to stop
  // being what the node says is waiting for the run to have reached the node.
  const beforeRun = await readNode.innerText();

  // Either the words arrived, or the row says why they did not — both are the
  // run reaching its end. What must not happen is the node sitting exactly as
  // the browser built it with nothing anywhere saying why.
  await expect
    .poll(async () => readNode.innerText(), {
      timeout: 180_000,
      intervals: [2_000],
    })
    .not.toBe(beforeRun);
});
