// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { authApi, type AuthUser, type SignupCodeSent } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@web/components/ui/input-otp';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell } from '@web/pages/auth/_shared/AuthCardShell';
import { FieldError } from '@web/pages/auth/_shared/FieldError';

const CODE_LENGTH = 6;
const SLOT_INDEXES = Array.from({ length: CODE_LENGTH }, (_, i) => i);
const TICK_MS = 1000;
const HTTP_EXPIRED = 410;
const HTTP_USED_UP = 422;

interface SignupCodeStepProps {
  /** The address the code went to. */
  email: string;
  /** What the code-sent answer said when this step opened. */
  sent: SignupCodeSent;
  /**
   * Start the sign-up again with the email and password the form still
   * holds — the way on when the pending sign-up has expired.
   */
  restart: () => Promise<SignupCodeSent | null>;
  /** The account exists and is signed in. */
  onVerified: (user: AuthUser) => void;
  /** Back to the form, keeping what was typed. */
  onChangeEmail: () => void;
}

/**
 * The line that says where the code went, with the address in bold. The
 * sentence comes whole from the catalog so each language keeps its own word
 * order; the address is found in it and set apart.
 * @param root0 - component props
 * @param root0.text - the localized sentence, address already filled in
 * @param root0.email - the address to set in bold
 * @returns the sentence with the address emphasised.
 */
function SentTo({ text, email }: { text: string; email: string }): React.JSX.Element {
  const at = text.indexOf(email);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className='font-medium text-foreground'>{email}</span>
      {text.slice(at + email.length)}
    </>
  );
}

/**
 * The sentence to show for a failed request: the server's own when it wrote
 * one, otherwise the generic one.
 * @param err - What the request threw.
 * @param fallback - The generic sentence.
 * @returns The sentence.
 */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiException && err.fromServer ? err.message : fallback;
}

/**
 * Second screen of an email sign-up (#287): six boxes for the mailed code,
 * a resend with its countdown, and a way back to change the address. A full
 * code submits by itself; a wrong one clears the boxes; a used-up one locks
 * them until a new code is sent; an expired sign-up is started again from
 * what the form still holds.
 * @param root0 - component props
 * @param root0.email - the address the code went to
 * @param root0.sent - the code-sent answer when the step opened
 * @param root0.restart - start the sign-up again after it expired
 * @param root0.onVerified - called with the new account
 * @param root0.onChangeEmail - go back to the form
 * @returns the code step.
 */
export function SignupCodeStep({
  email,
  sent,
  restart,
  onVerified,
  onChangeEmail,
}: SignupCodeStepProps): React.JSX.Element {
  const t = useTranslation();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [code, setCode] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [usedUp, setUsedUp] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
  const [waitLeft, setWaitLeft] = React.useState(sent.resendAfterSeconds);

  // The code is the only thing left to do here, so the caret goes to the
  // boxes whenever they can take typing: on arrival, after a check, and once
  // a new code unlocks them.
  React.useEffect(() => {
    if (!submitting && !usedUp) inputRef.current?.focus();
  }, [submitting, usedUp]);

  React.useEffect(() => {
    if (waitLeft <= 0) return undefined;
    const timer = window.setTimeout(() => setWaitLeft((left) => left - 1), TICK_MS);
    return () => window.clearTimeout(timer);
  }, [waitLeft]);

  /** Clear the boxes and put the caret back in the first one. */
  const clearAndFocus = React.useCallback((): void => {
    setCode('');
    inputRef.current?.focus();
  }, []);

  /** A new code is out: unlock, clear and say so. */
  const acceptNewCode = React.useCallback(
    (next: SignupCodeSent): void => {
      setUsedUp(false);
      setError(null);
      setInfo(t('auth.register.code.newCodeSent'));
      setWaitLeft(next.resendAfterSeconds);
      clearAndFocus();
    },
    [t, clearAndFocus],
  );

  /** The pending sign-up is gone; start it again from the form's values. */
  const startOver = React.useCallback(async (): Promise<void> => {
    const next = await restart();
    if (next) acceptNewCode(next);
  }, [restart, acceptNewCode]);

  const verify = React.useCallback(
    async (value: string): Promise<void> => {
      setSubmitting(true);
      setError(null);
      setInfo(null);
      try {
        const { user } = await authApi.verifySignupCode({ code: value });
        onVerified(user);
      } catch (err) {
        if (err instanceof ApiException && err.status === HTTP_EXPIRED) {
          await startOver();
          return;
        }
        if (err instanceof ApiException && err.status === HTTP_USED_UP) setUsedUp(true);
        setError(messageOf(err, t('auth.register.failed')));
        clearAndFocus();
      } finally {
        setSubmitting(false);
      }
    },
    [onVerified, startOver, clearAndFocus, t],
  );

  const resend = React.useCallback((): void => {
    setError(null);
    setInfo(null);
    void (async (): Promise<void> => {
      try {
        acceptNewCode(await authApi.resendSignupCode());
      } catch (err) {
        if (err instanceof ApiException && err.status === HTTP_EXPIRED) {
          await startOver();
          return;
        }
        if (err instanceof ApiException && err.retryAfterSeconds !== undefined) {
          setWaitLeft(err.retryAfterSeconds);
        }
        setError(messageOf(err, t('auth.register.failed')));
      }
    })();
  }, [acceptNewCode, startOver, t]);

  const handleChange = React.useCallback(
    (value: string): void => {
      setCode(value);
      if (value.length === CODE_LENGTH && !submitting) void verify(value);
    },
    [submitting, verify],
  );

  const waiting = waitLeft > 0;
  // The boxes carry the error until the reader starts typing the next code.
  const boxesInvalid = error !== null && code.length === 0;

  return (
    <AuthCardShell
      title={t('auth.register.code.title')}
      subtitle={<SentTo text={t('auth.register.code.sentTo', { email })} email={email} />}
    >
      <div className='flex flex-col items-center gap-2'>
        <InputOTP
          ref={inputRef}
          maxLength={CODE_LENGTH}
          value={code}
          onChange={handleChange}
          inputMode='numeric'
          pattern='^[0-9]*$'
          autoComplete='one-time-code'
          disabled={usedUp || submitting}
          aria-label={t('auth.register.code.codeLabel')}
          aria-invalid={error !== null && !usedUp ? true : undefined}
        >
          <InputOTPGroup>
            {SLOT_INDEXES.map((i) => (
              <InputOTPSlot key={i} index={i} aria-invalid={boxesInvalid || undefined} />
            ))}
          </InputOTPGroup>
        </InputOTP>
        {/* One line is always held under the boxes so a message never moves them. */}
        <div data-testid='signup-code-message' className='min-h-[1lh] text-sm leading-snug'>
          {error ? (
            <FieldError role='alert'>{error}</FieldError>
          ) : info ? (
            <p className='text-sm leading-snug text-muted-foreground'>{info}</p>
          ) : null}
        </div>
      </div>
      <div className='mt-4 flex items-center justify-between'>
        <Button
          type='button'
          variant='link'
          size={null}
          className='h-auto p-0 text-sm font-medium text-foreground'
          disabled={submitting}
          onClick={onChangeEmail}
        >
          {t('auth.register.code.changeEmail')}
        </Button>
        <Button
          type='button'
          variant='link'
          size={null}
          className='h-auto p-0 text-sm font-medium text-foreground disabled:text-muted-foreground'
          disabled={waiting || submitting}
          onClick={resend}
        >
          {waiting
            ? t('auth.register.code.resendIn', { seconds: waitLeft })
            : t('auth.register.code.resend')}
        </Button>
      </div>
    </AuthCardShell>
  );
}
