// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { studiosApi, type CreateStudioBody } from '@web/data/api/studios';
import type { Studio } from '@breatic/shared';

/**
 * The create-team-studio flow (rail segment ③). Creates the studio, then
 * refreshes the rail's studio list (`['studios', 'user']` — the same key
 * `StudioLayout` reads) and navigates into the new studio so its card appears
 * and it opens. Errors are left to the caller (the dialog surfaces a taken-slug
 * / limit / rate-limit message inline) — the mutation does not toast.
 * @returns the React Query mutation; call `.mutate(body, { onError })` on submit.
 */
export function useCreateStudio(): UseMutationResult<
  Studio,
  unknown,
  CreateStudioBody
  > {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateStudioBody) => studiosApi.createStudio(body),
    onSuccess: (studio) => {
      void queryClient.invalidateQueries({ queryKey: ['studios', 'user'] });
      navigate(`/studio/${studio.slug}`);
    },
  });
}
