// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { chatApi, type ChatModels } from '@web/data/api/chat';

/** Query key prefix of the models the reader can pick. */
const CHAT_MODELS_KEY = 'chat-models';

/**
 * The models the reader can pick in the chat panel, and the one a new
 * conversation of theirs starts on (#1363).
 * @param asked - Asked again whenever this rises: the caller passes how many
 *   sends the server has refused, since a refusal is how a page learns a
 *   model was taken off.
 * @returns The query.
 */
export function useChatModels(asked: number): UseQueryResult<ChatModels> {
  return useQuery({
    queryKey: [CHAT_MODELS_KEY, asked],
    queryFn: () => chatApi.models(),
    staleTime: Infinity,
  });
}
