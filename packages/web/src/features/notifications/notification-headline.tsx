// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';

import type {
  Notification,
  NotificationType,
  NotificationResolved,
} from '@web/data/api/notifications';
import type { useTranslation } from '@web/i18n/use-translation';

/**
 * The bell headline is an i18n sentence with two DATA slots — the actor (a user)
 * and the entity (a project / studio) — both rendered as clickable links. The
 * sentence frame ("{actor} invited you to {entity}") is translated; the actor
 * name + `@handle` and the entity name are data, never translated. This module
 * bridges the two: it asks `t()` to interpolate unique markers for the slots,
 * then splits the localized string on the markers and drops the link nodes in at
 * the locale-correct positions (no rich-text i18n engine needed).
 */

/** A NUL control char — never present in any user-facing locale string. */
const SLOT_DELIM = String.fromCodePoint(0);
/** Matches `<NUL>name<NUL>` markers, capturing the slot name. */
const SLOT_PATTERN = new RegExp(`${SLOT_DELIM}(\\w+)${SLOT_DELIM}`);

/**
 * Build the marker `t()` interpolates for a slot — split back out at render.
 * @param name - The slot name (`actor` / `entity`).
 * @returns The delimited marker string.
 */
function slotMarker(name: string): string {
  return `${SLOT_DELIM}${name}${SLOT_DELIM}`;
}

/**
 * Split a localized string carrying slot markers and interpolate each slot's
 * React node at its marker position. Even indices are literal text; odd indices
 * are slot names resolved against `nodes`.
 * @param text - The localized string with `slotMarker(...)` markers embedded.
 * @param nodes - The React node to render for each slot name.
 * @returns The interleaved text + node sequence.
 */
export function renderSlottedText(
  text: string,
  nodes: Record<string, React.ReactNode>,
): React.ReactNode[] {
  return text.split(SLOT_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <React.Fragment key={i}>{nodes[part] ?? ''}</React.Fragment>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}

/**
 * Read a string field off an opaque notification payload.
 * @param payload - The notification's opaque payload.
 * @param key - The field name to read.
 * @returns The string value, or an empty string when absent / non-string.
 */
function str(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === 'string' ? (payload[key] as string) : '';
}

/**
 * The actor (a user) + entity (project / studio) a notification headline names,
 * resolved from its payload. `entityHref` is null when the destination can't be
 * built (e.g. a studio with no slug); the entity then renders as plain text.
 */
interface HeadlineParts {
  /** i18n key under `notifications.headline.*`. */
  key: string;
  /** ICU placeholder name for the entity (`project` | `studio`). */
  entityParam: 'project' | 'studio';
  actorName: string;
  actorHandle: string;
  entityLabel: string;
  entityHref: string | null;
}

/**
 * Build the studio page path (personal or team); the slug is the `@handle`.
 * @param slug - The studio's URL slug.
 * @returns The `/studio/{slug}` path.
 */
function studioPath(slug: string): string {
  return `/studio/${slug}`;
}

/**
 * Build the project page path `/project/{slug}-{id}` (URL design §5.7) — the slug
 * (a snapshot, can repeat) prefixes the stable id. A missing slug degrades to the
 * bare id, which the page's id-extractor (`projectUuidFromRouteParam`) still
 * resolves.
 * @param slug - The project's URL slug (may be empty).
 * @param projectId - The project id (the notification's `project_id` column).
 * @returns The `/project/{slug}-{id}` path, or `/project/{id}` when slug is empty.
 */
function projectPath(slug: string, projectId: string): string {
  return slug ? `/project/${slug}-${projectId}` : `/project/${projectId}`;
}

/** Per-type config for a notification whose entity is a project. */
const PROJECT_ROWS: Partial<
  Record<NotificationType, { key: string; nameField: string; actorIdField: string }>
> = {
  'access.role_upgrade_request': {
    key: 'roleUpgradeRequest',
    nameField: 'requesterName',
    actorIdField: 'requesterUserId',
  },
  'access.role_upgrade_approved': {
    key: 'roleUpgradeApproved',
    nameField: 'deciderName',
    actorIdField: 'deciderUserId',
  },
  'access.role_upgrade_rejected': {
    key: 'roleUpgradeRejected',
    nameField: 'deciderName',
    actorIdField: 'deciderUserId',
  },
  'project.invite_request': {
    key: 'projectInviteRequest',
    nameField: 'inviterName',
    actorIdField: 'inviterUserId',
  },
  'project.invite_accepted': {
    key: 'projectInviteAccepted',
    nameField: 'inviteeName',
    actorIdField: 'inviteeUserId',
  },
  'project.transfer_request': {
    key: 'projectTransferRequest',
    nameField: 'fromName',
    actorIdField: 'fromUserId',
  },
  'project.transfer_approved': {
    key: 'projectTransferApproved',
    nameField: 'accepterName',
    actorIdField: 'accepterUserId',
  },
};

/** Per-type config for a notification whose entity is a studio. */
const STUDIO_ROWS: Partial<
  Record<NotificationType, { key: string; nameField: string; actorIdField: string }>
> = {
  'studio.transfer_request': {
    key: 'studioTransferRequest',
    nameField: 'fromName',
    actorIdField: 'fromUserId',
  },
  'studio.transfer_approved': {
    key: 'studioTransferApproved',
    nameField: 'accepterName',
    actorIdField: 'accepterUserId',
  },
  'studio.invite_request': {
    key: 'studioInviteRequest',
    nameField: 'inviterName',
    actorIdField: 'inviterUserId',
  },
  'studio.invite_accepted': {
    key: 'studioInviteAccepted',
    nameField: 'inviteeName',
    actorIdField: 'inviteeUserId',
  },
};

/**
 * Map a notification to its headline actor + entity. Returns null for an unknown
 * / dead type (the caller falls back to the raw type string).
 * @param n - The notification to describe.
 * @param resolved - Current identities for the ids it carries.
 * @returns The resolved headline parts, or null when the type isn't handled.
 */
function headlinePartsFor(
  n: Notification,
  resolved: NotificationResolved,
): HeadlineParts | null {
  const p = n.payload;

  // Names and links come from `resolved`, never from the payload. The payload
  // holds ids precisely so a rename cannot strand this row: whatever the target
  // is called RIGHT NOW is what the reader should see and click.
  //
  // Two different outcomes, handled separately. A soft-deleted target IS in the
  // map, flagged `deleted` — it keeps its name and loses only the link, because
  // "someone invited you to something" reads as nothing at all. A target that
  // is genuinely unresolvable is absent, and falls back to the stored name as
  // plain text.
  const projectId = str(p, 'projectId') || n.projectId || '';
  const projectRef = projectId ? resolved.projects[projectId] : undefined;
  const projectHref =
    projectRef && !projectRef.deleted
      ? projectPath(projectRef.slug, projectId)
      : null;

  const studioId = str(p, 'studioId');
  const studioRef = studioId ? resolved.studios[studioId] : undefined;
  const studioHref =
    studioRef && !studioRef.deleted ? studioPath(studioRef.slug) : null;

  const projectRow = PROJECT_ROWS[n.type];
  if (projectRow) {
    const actor = resolved.users[str(p, projectRow.actorIdField)];
    return {
      key: projectRow.key,
      entityParam: 'project',
      actorName: actor?.name ?? str(p, projectRow.nameField),
      actorHandle: actor && !actor.deleted ? actor.slug : '',
      entityLabel: projectRef?.name ?? str(p, 'projectName'),
      entityHref: projectHref,
    };
  }
  const studioRow = STUDIO_ROWS[n.type];
  if (studioRow) {
    const actor = resolved.users[str(p, studioRow.actorIdField)];
    return {
      key: studioRow.key,
      entityParam: 'studio',
      actorName: actor?.name ?? str(p, studioRow.nameField),
      actorHandle: actor && !actor.deleted ? actor.slug : '',
      entityLabel: studioRef?.name ?? str(p, 'studioName'),
      entityHref: studioHref,
    };
  }
  return null;
}

/**
 * Build the actor link node — the display name + a dimmer `@handle`, linking to
 * the actor's personal studio. The link opens in a NEW tab so the reader keeps
 * their place in the bell. When the handle is missing (a user mid-onboarding with
 * no personal studio), it degrades to plain text (the name, or a generic
 * fallback) with no broken link.
 * @param name - The actor's display name (may be empty).
 * @param handle - The actor's personal-studio slug = `@handle` (may be empty).
 * @param t - The translation function (for the no-name fallback).
 * @returns The actor link node, or a plain-text fallback.
 */
function actorNode(
  name: string,
  handle: string,
  t: ReturnType<typeof useTranslation>,
): React.ReactNode {
  const label = name || t('notifications.actorFallback');
  if (!handle) return label;
  return (
    <Link
      to={studioPath(handle)}
      target='_blank'
      rel='noopener noreferrer'
      className='font-medium text-foreground underline-offset-2 hover:underline'
    >
      {label}
      <span className='ml-1 text-muted-foreground'>@{handle}</span>
    </Link>
  );
}

/**
 * How the product writes each paid tier's name.
 *
 * Not translated: `PRO` and `Team` are the names on the price list, and the
 * same words appear in the comparison table beside this notice.
 */
const TIER_LABEL: Record<string, string> = {
  pro: 'PRO',
  team: 'Team',
};

/**
 * Build the localized, link-bearing headline for a bell notification: the actor
 * (name + `@handle` → personal studio) and the entity (project / studio name → its
 * page) are clickable links dropped into the translated sentence frame. Both links
 * open in a NEW tab so the reader keeps their place in the bell.
 * @param n - The notification to render a headline for.
 * @param resolved - Current identities for the ids the notification carries.
 * @param t - The translation function.
 * @returns The headline as a React node, or the raw type for an unknown notification.
 */
export function notificationHeadline(
  n: Notification,
  resolved: NotificationResolved,
  t: ReturnType<typeof useTranslation>,
): React.ReactNode {
  // A membership that ended has neither an actor nor an entity: nobody did it
  // to you, a subscription ran out, and there is nothing to open. It is one
  // localized sentence, so it skips the frame below entirely.
  if (n.type === 'membership.ended') {
    return t('notifications.headline.membershipEnded', {
      tier: TIER_LABEL[str(n.payload, 'fromTier')] ?? '',
    });
  }
  if (n.type === 'membership.upgrade_incomplete') {
    return t('notifications.headline.membershipUpgradeIncomplete', {
      tier: TIER_LABEL[str(n.payload, 'toTier')] ?? '',
    });
  }
  // Like the two above: nobody did this to you and there is nothing to open.
  // What ran out is the ACCOUNT's storage, summed across every studio it
  // administers — the studio in the payload is only where it happened.
  if (n.type === 'storage.quota_exceeded') {
    return t('notifications.headline.storageQuotaExceeded');
  }

  const parts = headlinePartsFor(n, resolved);
  if (!parts) return n.type;

  const actor = actorNode(parts.actorName, parts.actorHandle, t);
  const entity = parts.entityHref ? (
    <Link
      to={parts.entityHref}
      target='_blank'
      rel='noopener noreferrer'
      className='font-medium text-foreground underline-offset-2 hover:underline'
    >
      {parts.entityLabel}
    </Link>
  ) : (
    parts.entityLabel
  );

  const localized = t(`notifications.headline.${parts.key}`, {
    actor: slotMarker('actor'),
    [parts.entityParam]: slotMarker('entity'),
  });
  return renderSlottedText(localized, { actor, entity });
}
