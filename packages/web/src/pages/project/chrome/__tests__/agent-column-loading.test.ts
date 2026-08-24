// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How the chat panel reaches the bundle.
 *
 * Read as text rather than run. The claim is about which chunk a module lands
 * in, and a rendered page answers the same either way — the panel works
 * whether its code arrived with the login screen or on its own.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * Reads one file from the web package's source.
 * @param path - Its path, relative to `src`.
 * @returns The file's text.
 */
function read(path: string): string {
  return readFileSync(resolve(__dirname, '../../../../', path), 'utf8');
}

describe('the chat panel is fetched when it is needed', () => {
  it('reaches ChatPanel through a dynamic import', () => {
    // A static import puts a module in the same chunk as whoever imports it,
    // all the way up to the entry. The markdown pipeline hangs off this one
    // edge — ChatPanel to MessageList to MessageBubble to MarkdownMessage,
    // one importer each — so this is where the whole subtree is decided.
    const source = read('pages/project/chrome/AgentColumn.tsx');

    expect(source).not.toMatch(/^import \{[^}]*\bChatPanel\b[^}]*\} from/m);
    expect(source).toMatch(/import\(\s*['"][^'"]*chat\/ChatPanel['"]\s*\)/);
  });

  it('keeps the column header out of that wait', () => {
    // The header carries the conversation's name and the buttons that open
    // the history. Those are the panel's chrome, and chrome that arrives late
    // is a worse trade than prose that arrives late.
    const source = read('pages/project/chrome/AgentColumn.tsx');

    expect(source).toMatch(/^import \{[^}]*\bAgentColHeader\b[^}]*\} from/m);
  });
});
