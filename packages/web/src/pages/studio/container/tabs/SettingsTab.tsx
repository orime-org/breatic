// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

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
}

/**
 * The Settings tab: the studio's own details, and the actions that cannot be
 * taken back.
 *
 * Editing is the admin's; a non-admin still sees the values, because the
 * studio's name, handle and description are things every member has a reason
 * to look up. What a non-admin gets that an admin does not is the leave
 * button, in the danger zone below.
 * @param props - The current studio detail and its members.
 * @param props.studio - The studio being configured.
 * @param props.members - The studio members (the transfer picker's source).
 * @returns The Settings tab content.
 */
export function SettingsTab({
  studio,
  members,
}: SettingsTabProps): React.JSX.Element {
  const settings = useStudioSettings(studio);
  const canEdit = studio.myStudioRole === 'admin';

  return (
    <div className='mx-auto flex max-w-xl flex-col gap-8'>
      <AvatarSection
        studio={studio}
        canEdit={canEdit}
        uploading={settings.uploadingAvatar}
        error={settings.avatarError}
        onUpload={settings.uploadAvatar}
        onRemove={settings.removeAvatar}
      />
      <BasicInfoSection
        studio={studio}
        canEdit={canEdit}
        saving={settings.saving}
        onSave={settings.save}
      />
      <DangerZone
        studio={studio}
        members={members}
        leaving={settings.leaving}
        onLeave={settings.leave}
      />
    </div>
  );
}
