// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';

import type { Notification, NotificationType } from '@web/data/api/notifications';
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
  Record<NotificationType, { key: string; nameField: string; handleField: string }>
> = {
  'access.role_upgrade_request': {
    key: 'roleUpgradeRequest',
    nameField: 'requesterName',
    handleField: 'requesterHandle',
  },
  'access.role_upgrade_approved': {
    key: 'roleUpgradeApproved',
    nameField: 'deciderName',
    handleField: 'deciderHandle',
  },
  'access.role_upgrade_rejected': {
    key: 'roleUpgradeRejected',
    nameField: 'deciderName',
    handleField: 'deciderHandle',
  },
  'project.invite_request': {
    key: 'projectInviteRequest',
    nameField: 'inviterName',
    handleField: 'inviterHandle',
  },
  'project.invite_accepted': {
    key: 'projectInviteAccepted',
    nameField: 'inviteeName',
    handleField: 'inviteeHandle',
  },
};

/** Per-type config for a notification whose entity is a studio. */
const STUDIO_ROWS: Partial<
  Record<NotificationType, { key: string; nameField: string; handleField: string }>
> = {
  'studio.transfer_request': {
    key: 'studioTransferRequest',
    nameField: 'fromName',
    handleField: 'fromHandle',
  },
  'studio.transfer_approved': {
    key: 'studioTransferApproved',
    nameField: 'accepterName',
    handleField: 'accepterHandle',
  },
  'studio.invite_request': {
    key: 'studioInviteRequest',
    nameField: 'inviterName',
    handleField: 'inviterHandle',
  },
  'studio.invite_accepted': {
    key: 'studioInviteAccepted',
    nameField: 'inviteeName',
    handleField: 'inviteeHandle',
  },
};

/**
 * Map a notification to its headline actor + entity. Returns null for an unknown
 * / dead type (the caller falls back to the raw type string).
 * @param n - The notification to describe.
 * @returns The resolved headline parts, or null when the type isn't handled.
 */
function headlinePartsFor(n: Notification): HeadlineParts | null {
  const p = n.payload;
  const projectHref =
    n.projectId !== null
      ? projectPath(str(p, 'projectSlug'), n.projectId)
      : null;
  const studioHref = str(p, 'studioSlug')
    ? studioPath(str(p, 'studioSlug'))
    : null;

  const projectRow = PROJECT_ROWS[n.type];
  if (projectRow) {
    return {
      key: projectRow.key,
      entityParam: 'project',
      actorName: str(p, projectRow.nameField),
      actorHandle: str(p, projectRow.handleField),
      entityLabel: str(p, 'projectName'),
      entityHref: projectHref,
    };
  }
  const studioRow = STUDIO_ROWS[n.type];
  if (studioRow) {
    return {
      key: studioRow.key,
      entityParam: 'studio',
      actorName: str(p, studioRow.nameField),
      actorHandle: str(p, studioRow.handleField),
      entityLabel: str(p, 'studioName'),
      entityHref: studioHref,
    };
  }
  return null;
}

/**
 * Build the actor link node — the display name + a dimmer `@handle`, linking to
 * the actor's personal studio. When the handle is missing (a user mid-onboarding
 * with no personal studio), it degrades to plain text (the name, or a generic
 * fallback) with no broken link.
 * @param name - The actor's display name (may be empty).
 * @param handle - The actor's personal-studio slug = `@handle` (may be empty).
 * @param t - The translation function (for the no-name fallback).
 * @param onNavigate - Called when the link is followed (closes the bell popover).
 * @returns The actor link node, or a plain-text fallback.
 */
function actorNode(
  name: string,
  handle: string,
  t: ReturnType<typeof useTranslation>,
  onNavigate?: () => void,
): React.ReactNode {
  const label = name || t('notifications.actorFallback');
  if (!handle) return label;
  return (
    <Link
      to={studioPath(handle)}
      onClick={onNavigate}
      className='font-medium text-foreground underline-offset-2 hover:underline'
    >
      {label}
      <span className='ml-1 text-muted-foreground'>@{handle}</span>
    </Link>
  );
}

/**
 * Build the localized, link-bearing headline for a bell notification: the actor
 * (name + `@handle` → personal studio) and the entity (project / studio name → its
 * page) are clickable links dropped into the translated sentence frame.
 * @param n - The notification to render a headline for.
 * @param t - The translation function.
 * @param onNavigate - Called when any headline link is followed (closes the popover).
 * @returns The headline as a React node, or the raw type for an unknown notification.
 */
export function notificationHeadline(
  n: Notification,
  t: ReturnType<typeof useTranslation>,
  onNavigate?: () => void,
): React.ReactNode {
  const parts = headlinePartsFor(n);
  if (!parts) return n.type;

  const actor = actorNode(parts.actorName, parts.actorHandle, t, onNavigate);
  const entity = parts.entityHref ? (
    <Link
      to={parts.entityHref}
      onClick={onNavigate}
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
