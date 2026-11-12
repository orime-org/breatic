// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #1400 — the web side of `GET` and `PUT /chat/instructions`.
 *
 * A read asks for one Project's instructions by its id on the query string; a
 * save sends exactly what the user wrote, spaces and line breaks included,
 * because the server decides what an all-whitespace text means. Both hand
 * back the view itself, not the `{ data }` envelope `request.ts` unwraps.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosRequestConfig } from 'axios';

import type { AgentInstructionsView } from '@breatic/shared';
import { apiGet, apiPut } from '@web/data/api/request';
import {
  agentInstructionsKey,
  fetchAgentInstructions,
  saveAgentInstructions,
} from '@web/data/api/agent-instructions';

vi.mock('@web/data/api/request', () => ({ apiGet: vi.fn(), apiPut: vi.fn() }));

const mockGet = vi.mocked(apiGet);
const mockPut = vi.mocked(apiPut);

const PROJECT = '0b9a4f2e-6a51-4c4e-9d43-0c1a2b3c4d5e';

const VIEW: AgentInstructionsView = {
  text: 'Answer in English.',
  updatedBy: 'Mei Tan',
  updatedAt: '2026-11-08T08:02:00.000Z',
};

/**
 * The address a GET call asked for, wherever the call put the query: on the
 * path itself or in axios `params`.
 * @param url - The path handed to `apiGet`.
 * @param config - The axios config handed with it, if any.
 * @returns The parsed address.
 */
function askedFor(url: string, config?: AxiosRequestConfig): URL {
  const parsed = new URL(url, 'http://api.test');
  const params = (config?.params ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }
  return parsed;
}

beforeEach(() => {
  mockGet.mockReset();
  mockPut.mockReset();
});

describe('fetchAgentInstructions (#1400)', () => {
  it('asks GET /chat/instructions for that project', async () => {
    mockGet.mockResolvedValue(VIEW);
    await fetchAgentInstructions(PROJECT);

    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, config] = mockGet.mock.calls[0]!;
    const address = askedFor(url, config);
    expect(address.pathname).toBe('/chat/instructions');
    expect(address.searchParams.get('project_id')).toBe(PROJECT);
  });

  it('returns the view itself, already unwrapped', async () => {
    mockGet.mockResolvedValue(VIEW);
    await expect(fetchAgentInstructions(PROJECT)).resolves.toEqual(VIEW);
  });

  it('passes a failed read on to the caller', async () => {
    mockGet.mockRejectedValue(new Error('offline'));
    await expect(fetchAgentInstructions(PROJECT)).rejects.toThrow('offline');
  });
});

describe('saveAgentInstructions (#1400)', () => {
  it('sends PUT /chat/instructions with the project id and the text', async () => {
    mockPut.mockResolvedValue(VIEW);
    await saveAgentInstructions(PROJECT, 'Answer in English.');

    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut.mock.calls[0]!.slice(0, 2)).toEqual([
      '/chat/instructions',
      { project_id: PROJECT, text: 'Answer in English.' },
    ]);
  });

  it('sends the text exactly as written, without trimming it', async () => {
    mockPut.mockResolvedValue({ text: '', updatedBy: null, updatedAt: null });
    await saveAgentInstructions(PROJECT, '  \n  ');
    expect(mockPut.mock.calls[0]![1]).toEqual({ project_id: PROJECT, text: '  \n  ' });

    mockPut.mockClear();
    mockPut.mockResolvedValue(VIEW);
    await saveAgentInstructions(PROJECT, '  keep  the spaces \n');
    expect(mockPut.mock.calls[0]![1]).toEqual({
      project_id: PROJECT,
      text: '  keep  the spaces \n',
    });
  });

  it('returns the saved view itself, already unwrapped', async () => {
    mockPut.mockResolvedValue(VIEW);
    await expect(saveAgentInstructions(PROJECT, VIEW.text)).resolves.toEqual(VIEW);
  });

  it('passes a failed save on to the caller', async () => {
    mockPut.mockRejectedValue(new Error('rate limited'));
    await expect(saveAgentInstructions(PROJECT, 'x')).rejects.toThrow('rate limited');
  });
});

describe('agentInstructionsKey (#1400)', () => {
  it('is one query per project', () => {
    expect(agentInstructionsKey(PROJECT)).toEqual(['agent-instructions', PROJECT]);
    expect(agentInstructionsKey('other')).toEqual(['agent-instructions', 'other']);
  });
});
