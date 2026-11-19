// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from 'react';
import { useSearchParams } from 'react-router-dom';

import { AgentsSection } from '@web/pages/studio/container/tabs/settings/AgentsSection';
import { AvatarSection } from '@web/pages/studio/container/tabs/settings/AvatarSection';
import { BasicInfoSection } from '@web/pages/studio/container/tabs/settings/BasicInfoSection';
import { DangerZone } from '@web/pages/studio/container/tabs/settings/DangerZone';
import { useStudioSettings } from '@web/pages/studio/container/tabs/settings/use-studio-settings';
import type { StudioDetail } from '@web/pages/studio/container/container-types';
import type { StudioMember } from '@web/pages/studio/container/container-types';

interface SettingsTabProps {
  studio: StudioDetail;
  /** The studio's members — the transfer picker lists the non-guest ones. */
  members: readonly StudioMember[];
  /** The page's scroller, which brings a row a link points at into view. */
  scroller?: React.RefObject<HTMLDivElement | null>;
}

/**
 * The Settings tab: the studio's own details, and the actions that cannot be
 * taken back.
 *
 * Editing is the admin's; a non-admin still sees the values, because the
 * studio's name and description are things every member has a reason to look
 * up. The danger zone below holds a different set for each of them: the admin
 * gets the actions that dispose of the studio or its address, and a non-admin
 * gets the one that only concerns themselves — walking away from it.
 * @param props - The current studio detail and its members.
 * @param props.studio - The studio being configured.
 * @param props.members - The studio members (the transfer picker's source).
 * @param props.scroller - The page's scroller.
 * @returns The Settings tab content.
 */
export function SettingsTab({
  studio,
  members,
  scroller,
}: SettingsTabProps): React.JSX.Element {
  const settings = useStudioSettings(studio);
  const canEdit = studio.myStudioRole === 'admin';
  // A personal studio's settings are its owner's account settings, where
  // their external agents are; a comment's label links here with the row.
  const [params] = useSearchParams();
  const focusConnection = params.get('connection') ?? undefined;

  return (
    <div className='mx-auto flex max-w-xl flex-col gap-8'>
      <AvatarSection
        studio={studio}
        canEdit={canEdit}
        uploading={settings.uploadingAvatar}
        error={settings.avatarError}
        onUpload={settings.uploadAvatar}
        removing={settings.removingAvatar}
        onRemove={settings.removeAvatar}
        onDismissError={settings.clearAvatarError}
      />
      <BasicInfoSection
        studio={studio}
        canEdit={canEdit}
        saving={settings.saving}
        savingDetails={settings.savingDetails}
        onSave={settings.save}
      />
      {studio.type === 'personal' && canEdit ? (
        <AgentsSection {...(focusConnection === undefined ? {} : { focusId: focusConnection })} {...(scroller === undefined ? {} : { scroller })} />
      ) : null}
      <DangerZone
        studio={studio}
        members={members}
        leaving={settings.leaving}
        onLeave={settings.leave}
        saving={settings.saving}
        renaming={settings.renaming}
        onSave={settings.save}
      />
    </div>
  );
}
