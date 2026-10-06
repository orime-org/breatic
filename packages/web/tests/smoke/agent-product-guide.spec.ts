// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asked how to use the product, the agent answers from the product (#260).
 *
 * Unit tests settle that the guide says the right things and that a turn
 * hands it the reader's language. What they cannot settle is that a real
 * model, asked a real question, reaches for the guide rather than guessing,
 * and that what it writes names the control the reader's screen shows. The
 * label is read off the screen itself, so the assertion does not trust the
 * guide to be right about it.
 *
 * The same file checks the reply formats the prompt asks for, since both are
 * about what the model writes and both need a real turn to show.
 */
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace, DOCUMENT_EDITOR } from '../helpers/space';

let page: Page;
const spaces: string[] = [];

/**
 * Which tools the newest stored conversation used.
 * @param p - The signed-in page.
 * @returns Each tool name, in the order the turn used them.
 */
async function toolsUsed(p: Page): Promise<string[]> {
  return p.evaluate(async () => {
    const list = await (
      await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })
    ).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (
      await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })
    ).json();
    const messages = (read?.data?.messages ?? []) as { parts?: { type?: string }[] }[];
    return messages
      .flatMap((m) => m.parts ?? [])
      .map((part) => part.type ?? '')
      .filter((type) => type.startsWith('tool-'))
      .map((type) => type.slice('tool-'.length));
  });
}

/**
 * Ask one question in a fresh conversation and wait for the whole reply.
 * @param p - The signed-in page.
 * @param question - What the reader types.
 * @returns The reply's bubble.
 */
async function ask(p: Page, question: string): Promise<ReturnType<Page['getByTestId']>> {
  await p.getByTestId('new-conversation').click();
  await expect(p.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  const composer = p.getByTestId('chat-composer-box');
  await composer.fill(question);
  await composer.press('Enter');
  await expect(p.getByTestId('message-bubble')).toHaveCount(2, { timeout: 200_000 });
  await expect(p.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
  return p.getByTestId('message-bubble').last();
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({
    storageState: STATE_FILE.A,
    viewport: { width: 1500, height: 900 },
  });
  await openSmokeProject(page);
});

test.afterEach(async () => {
  for (const id of spaces.splice(0)) await deleteSpace(page, id);
  await page.close();
});

test('asked how to generate, names the menu item the screen shows @needs-model', async () => {
  test.setTimeout(300_000);
  spaces.push(await createSpace(page, 'canvas', `guide-${String(Date.now())}`));

  // The label as this reader's screen shows it, read off a real node's menu.
  const pane = visibleSpace(page).locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.getByTestId('create-node-image').click();
  const node = visibleSpace(page).locator('.react-flow__node').first();
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.click({ button: 'right' });
  const label = (await page.getByTestId('node-menu-generate').innerText()).trim();
  await page.keyboard.press('Escape');
  expect(label.length).toBeGreaterThan(0);

  const reply = await ask(page, '我想用这个图片节点生成一张图，要点哪里？');

  const used = await toolsUsed(page);
  expect(used, `tools used: ${used.join(', ')}`).toContain('get_product_guide');
  const text = await reply.innerText();
  expect(text, `the reply: ${text}`).toContain(label);
});

test('asked about a document, reads the guide @needs-model', async () => {
  test.setTimeout(300_000);
  spaces.push(await createSpace(page, 'document', `guide-doc-${String(Date.now())}`));

  const reply = await ask(page, '在文档里怎么把一行变成标题？');

  const used = await toolsUsed(page);
  expect(used, `tools used: ${used.join(', ')}`).toContain('get_product_guide');
  const text = await reply.innerText();
  // A heading is `#` then a space at the start of a line, or Cmd with
  // Option / Alt and 1; a bare `#` anywhere else says nothing about headings.
  expect(text, `the reply: ${text}`).toMatch(/(^|\s)#{1,3}\s|(Alt|Option|⌥)\s*\+?\s*1/m);
});

test('asked how to insert a table and add a row, names the controls the screen shows @needs-model', async () => {
  test.setTimeout(300_000);
  spaces.push(await createSpace(page, 'document', `guide-table-${String(Date.now())}`));
  const editor = page.locator(`${DOCUMENT_EDITOR}`);
  await editor.click();
  await page.keyboard.type('lead');

  // The labels as this reader's screen shows them: the insert submenu, the
  // table row in it, and the row handle's "insert below".
  const row = await page.locator('[data-testid="document-space"] .bn-block-content').first().boundingBox();
  if (row === null) throw new Error('the line has no box');
  await page.mouse.move(row.x + 40, row.y + Math.min(row.height / 2, 12), { steps: 3 });
  await page.getByTestId('doc-block-handle').click();
  const insertBelow = (await page.getByTestId('doc-block-row-insertBelow').innerText()).trim();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  const table = (await page.getByTestId('doc-block-insert-table').innerText()).trim();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  await page.locator('[data-testid="document-space"] .bn-block-content').first().click();
  const cell = await page.locator('[data-testid="document-space"] td').first().boundingBox();
  if (cell === null) throw new Error('the table has no cell');
  await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2, { steps: 3 });
  await page.getByTestId('doc-table-row-handle').click();
  const rowBelow = (await page.getByTestId('doc-table-row-insertBelow').innerText()).trim();
  await page.keyboard.press('Escape');

  const reply = await ask(page, '文档里怎么插入一个表格？插好之后怎么在某一行下面再加一行？');

  const used = await toolsUsed(page);
  expect(used, `tools used: ${used.join(', ')}`).toContain('get_product_guide');
  const text = await reply.innerText();
  for (const label of [insertBelow, table, rowBelow]) {
    expect(text, `the reply: ${text}`).toContain(label);
  }
});

test('writes a formula and HTML the way the reply renders them @needs-model', async () => {
  test.setTimeout(300_000);
  spaces.push(await createSpace(page, 'canvas', `format-${String(Date.now())}`));

  const reply = await ask(
    page,
    '写一下勾股定理的公式，再给我一段在网页上显示 hello 的最小 HTML。',
  );

  // A formula the renderer read draws through KaTeX; one it did not stays as
  // the dollars the model wrote.
  await expect(reply.locator('.katex').first()).toBeVisible({ timeout: 20_000 });
  // HTML in a fence is a code block; HTML in prose would be characters in a
  // paragraph with no block around it.
  await expect(reply.locator('pre code').first()).toContainText('hello');
  // A formula left in single dollars, even one letter inside a sentence,
  // reaches the reader as the dollars themselves.
  const prose = await reply.evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('pre, .katex').forEach((n) => n.remove());
    return copy.innerText;
  });
  expect(prose, `the prose: ${prose}`).not.toContain('$');
});

test('cites a search without listing source addresses @needs-model', async () => {
  test.setTimeout(300_000);
  spaces.push(await createSpace(page, 'canvas', `search-${String(Date.now())}`));

  const reply = await ask(page, '搜一下最近一周 AI 视频生成有什么新发布，简单说说。');

  const used = await toolsUsed(page);
  expect(used, `tools used: ${used.join(', ')}`).toContain('web_search');
  // The panel draws the sources under the reply itself; an address in the
  // reply's own words is a second copy of them.
  const text = await reply.innerText();
  expect(text, `the reply: ${text}`).not.toMatch(/https?:\/\//);
});

test('after a proposal, does not ask the reader to write the prompt it wrote @needs-model', async () => {
  test.setTimeout(300_000);
  spaces.push(await createSpace(page, 'canvas', `steps-${String(Date.now())}`));

  const reply = await ask(
    page,
    'I have a product photo and I want it on a plain white background. Set it up for me on the canvas -- do not ask me anything, just propose it, and tell me what to do after I place it.',
  );

  const used = await toolsUsed(page);
  expect(used, `tools used: ${used.join(', ')}`).toContain('propose_canvas_action');
  expect(used, `tools used: ${used.join(', ')}`).toContain('get_product_guide');
  // Placing writes the prompt, its marks and its mentions; steps that start
  // from an empty prompt box describe a panel the reader will not see.
  const text = await reply.innerText();
  expect(text, `the reply: ${text}`).not.toMatch(
    /\b(write|type|enter)\s+(a|the|your)\s+(\w+\s+)?prompt\b/i,
  );
});
