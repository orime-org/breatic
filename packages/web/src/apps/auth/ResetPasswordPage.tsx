/**
 * Reset password page — accepts token from email link.
 */

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as authApi from '@/apis/auth';

export default function ResetPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!token) {
      setError('Invalid reset link. Please request a new one.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      await authApi.resetPassword(token, password);
      setSuccess(true);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setError(msg || 'Reset failed. The link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background-default-base">
        <div className="w-full max-w-md p-8 space-y-6 bg-background-default-secondary rounded-xl shadow-lg text-center">
          <h1 className="text-2xl font-bold text-text-default-base">
            {t('auth.resetSuccess', 'Password Reset')}
          </h1>
          <p className="text-text-default-tertiary">
            {t('auth.resetSuccessMessage', 'Your password has been reset. You can now sign in.')}
          </p>
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="w-full py-3 rounded-lg bg-green-500 text-white font-medium hover:bg-green-600 transition-colors"
          >
            {t('auth.goToLogin', 'Go to Sign In')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background-default-base">
      <div className="w-full max-w-md p-8 space-y-6 bg-background-default-secondary rounded-xl shadow-lg">
        <h1 className="text-2xl font-bold text-text-default-base text-center">
          {t('auth.resetPassword', 'Reset Password')}
        </h1>

        {error && (
          <div className="p-3 rounded-lg bg-red-50 text-red-600 text-sm">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            placeholder={t('auth.newPassword', 'New password (min 8 characters)')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="w-full px-4 py-3 rounded-lg border border-border-default-base bg-background-default-base text-text-default-base placeholder:text-text-default-tertiary focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <input
            type="password"
            placeholder={t('auth.confirmNewPassword', 'Confirm new password')}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            className="w-full px-4 py-3 rounded-lg border border-border-default-base bg-background-default-base text-text-default-base placeholder:text-text-default-tertiary focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-lg bg-green-500 text-white font-medium hover:bg-green-600 disabled:opacity-50 transition-colors"
          >
            {loading ? '...' : t('auth.resetPassword', 'Reset Password')}
          </button>
        </form>

        <button
          type="button"
          onClick={() => navigate('/login')}
          className="w-full text-sm text-text-default-tertiary hover:text-green-500 transition-colors"
        >
          {t('auth.backToLogin', 'Back to Sign In')}
        </button>
      </div>
    </div>
  );
}
