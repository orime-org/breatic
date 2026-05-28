import * as React from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  accessRequestsApi,
  type RequestableRole,
} from '@/data/api/access-requests';
import { ApiException } from '@/data/api/types';
import { AuthCardShell, AuthLink } from '@/pages/auth/_shared/AuthCardShell';
import { FieldError } from '@/pages/auth/_shared/FieldError';
import { useTranslation } from '@/i18n/use-translation';

/**
 * Standalone page for non-members to request access to a project.
 *
 * Three entry paths land here:
 *   path 1: direct URL `/p/:projectId/access` (NOT_MEMBER detect
 *           redirect — see #603 routing wire)
 *   path 2: email invite link `/invite/:token` consumed and falling
 *           back here when consume fails (revoked / expired / etc.)
 *   path 3: forwarded share link — same path-2 fallback flow
 *
 * For paths 2/3 the consume endpoint either auto-enrolls the user
 * (no AccessRequestPage shown) or routes here as a fallback. Token
 * consume lives in the routing layer (#603); this page only owns
 * the access request submission form.
 *
 * UX states:
 *   form      — initial: role radio + optional message + submit
 *   submitted — success: "request sent, owner notified, you'll hear
 *               back" + back-to-studio link
 *   error     — backend rejected with a known reason (already a
 *               member → tell user to go to project; already pending
 *               → tell user to wait)
 */
type State =
  | { kind: 'form' }
  | { kind: 'submitted' }
  | { kind: 'error'; message: string };

export default function AccessRequestPage() {
  const t = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();

  const [state, setState] = React.useState<State>({ kind: 'form' });
  const [role, setRole] = React.useState<RequestableRole>('view');
  const [message, setMessage] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !projectId) return;
    setSubmitting(true);
    try {
      await accessRequestsApi.create(projectId, {
        requested_role: role,
        message: message.trim() ? message.trim() : null,
      });
      setState({ kind: 'submitted' });
    } catch (err) {
      const msg =
        err instanceof ApiException
          ? err.message
          : t('access.request.submitFailed');
      setState({ kind: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === 'submitted') {
    return (
      <AuthCardShell
        title={t('access.request.sentTitle')}
        subtitle={t('access.request.sentSubtitle')}
        footer={<AuthLink to='/studio'>{t('access.request.backToStudio')}</AuthLink>}
      >
        <p className='text-sm text-muted-foreground'>
          {t('access.request.sentBody')}
        </p>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={t('access.request.title')}
      subtitle={t('access.request.subtitle')}
      footer={<AuthLink to='/studio'>{t('access.request.backToStudio')}</AuthLink>}
    >
      <form onSubmit={handleSubmit} noValidate className='flex flex-col gap-4'>
        <fieldset className='flex flex-col gap-2'>
          <legend className='text-sm font-medium'>
            {t('access.request.roleLegend')}
          </legend>
          <RoleRadio
            value='view'
            current={role}
            label={t('access.request.roleView')}
            description={t('access.request.roleViewDescription')}
            onChange={setRole}
            disabled={submitting}
          />
          <RoleRadio
            value='edit'
            current={role}
            label={t('access.request.roleEdit')}
            description={t('access.request.roleEditDescription')}
            onChange={setRole}
            disabled={submitting}
          />
        </fieldset>

        <div className='flex flex-col gap-1'>
          <Label htmlFor='access-request-message'>
            {t('access.request.messageLabel')}
          </Label>
          <Textarea
            id='access-request-message'
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('access.request.messagePlaceholder')}
            maxLength={2000}
            rows={4}
            disabled={submitting}
            data-testid='access-request-message'
          />
        </div>

        {state.kind === 'error' ? (
          <FieldError role='alert'>{state.message}</FieldError>
        ) : null}

        <Button
          type='submit'
          disabled={submitting || !projectId}
          data-testid='access-request-submit'
        >
          {submitting
            ? t('access.request.submitting')
            : t('access.request.submit')}
        </Button>
      </form>
    </AuthCardShell>
  );
}

interface RoleRadioProps {
  value: RequestableRole;
  current: RequestableRole;
  label: string;
  description: string;
  onChange: (v: RequestableRole) => void;
  disabled?: boolean;
}

function RoleRadio({
  value,
  current,
  label,
  description,
  onChange,
  disabled,
}: RoleRadioProps) {
  const checked = current === value;
  return (
    <Label
      className={`flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 transition-colors ${
        checked ? 'border-foreground bg-accent' : 'hover:bg-accent/40'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <input
        type='radio'
        name='access-request-role'
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        disabled={disabled}
        className='mt-1'
        data-testid={`access-request-role-${value}`}
      />
      <span className='flex flex-col gap-0.5'>
        <span className='text-sm font-medium'>{label}</span>
        <span className='text-xs text-muted-foreground'>{description}</span>
      </span>
    </Label>
  );
}
