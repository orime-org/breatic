import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { inviteLinksApi } from '@web/data/api/invite-links';
import { ApiException } from '@web/data/api/types';
import { AuthCardShell, AuthLink } from '@web/pages/auth/_shared/AuthCardShell';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Invite link consume landing page — `/invite/:token`.
 *
 * Entry point for a non-member who clicked an email invite or a
 * forwarded share link (owner-invite-only model — there is no
 * self-service "request to join" flow).
 *
 * The page runs `inviteLinksApi.consume(token)` on mount and routes:
 *   - success → navigate to `/project/:projectId` (the user is now a
 *     member; ProjectPage will load normally)
 *   - 403 / 404 / 410 (revoked / expired / already-consumed for
 *     single-use / bound-email mismatch) → render an inline
 *     "this link is no longer valid, contact the project owner"
 *     message in place (2026-05-28 spec § 2.1). No owner email is
 *     shown (anti-spam); there is no access-request fallback.
 *
 * While the consume is in flight an `AuthCardShell` placeholder is
 * rendered so the user isn't staring at a blank screen.
 * @returns a loading placeholder while the invite is consumed, or an inline
 * "link no longer valid" card on failure (success navigates away).
 */
export default function InviteConsumePage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const startedRef = React.useRef(false);

  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!token) {
      setErrorMessage(t('invite.consume.invalidToken'));
      return;
    }
    void (async () => {
      try {
        const res = await inviteLinksApi.consume(token);
        navigate(`/project/${res.data.projectId}`, { replace: true });
      } catch (err) {
        // Per 2026-05-28 spec § 2.1: expired / revoked / consumed /
        // bound-email-mismatch all surface a friendly full-screen
        // "this link is no longer valid, please contact the project
        // owner" message. We don't bounce to /studio (the user
        // wouldn't know why) and we don't reveal the owner's email
        // (anti-spam). Other failures fall back to a generic copy.
        const isLinkInvalid =
          err instanceof ApiException &&
          (err.status === 403 || err.status === 404 || err.status === 410);
        const msg = isLinkInvalid
          ? t('invite.consume.expiredOrInvalid')
          : err instanceof ApiException
            ? err.message
            : t('invite.consume.failed');
        setErrorMessage(msg);
      }
    })();
  }, [token, navigate, t]);

  if (errorMessage) {
    return (
      <AuthCardShell
        title={t('invite.consume.errorTitle')}
        subtitle={errorMessage}
        footer={<AuthLink to='/studio'>{t('invite.consume.backToStudio')}</AuthLink>}
      >
        <p className='text-sm text-muted-foreground'>
          {t('invite.consume.errorBody')}
        </p>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell title={t('invite.consume.loadingTitle')}>
      <p className='text-sm text-muted-foreground'>
        {t('invite.consume.loadingBody')}
      </p>
    </AuthCardShell>
  );
}
