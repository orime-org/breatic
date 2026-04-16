/**
 * Login / Register / Forgot Password page.
 *
 * Three tabs in one page:
 * - login: email/password + Google OAuth
 * - register: email/password + confirm
 * - forgot: email → send reset link
 */

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GoogleLogin, GoogleOAuthProvider } from '@react-oauth/google';
import { useTranslation } from 'react-i18next';
import * as authApi from '@/apis/auth';
import { setToken } from '@/utils/token';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';

type Tab = 'login' | 'register' | 'forgot';

declare const __GOOGLE_CLIENT_ID__: string;
const GOOGLE_CLIENT_ID = typeof __GOOGLE_CLIENT_ID__ !== 'undefined' ? __GOOGLE_CLIENT_ID__ : '';

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as Tab) || 'login';

  const [tab, setTab] = useState<Tab>(initialTab);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const { setAuthInfo } = useUserCenterStore();

  const handleLoginSuccess = (token: string) => {
    const authData = { state: { isAuthenticated: true, token }, version: 0 };
    setAuthInfo(authData);
    setToken(authData);
    navigate('/workspace');
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.login({ email, password });
      handleLoginSuccess(res.data.token);
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: { message?: string } | string } } })?.response?.data;
      const msg = typeof errData?.error === 'string' ? errData.error : errData?.error?.message;
      setError(msg || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.register({ email, password });
      handleLoginSuccess(res.data.token);
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: { message?: string } | string } } })?.response?.data;
      const msg = typeof errData?.error === 'string' ? errData.error : errData?.error?.message;
      setError(msg || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      await authApi.forgotPassword(email);
      setSuccess('If this email is registered, a reset link has been sent. Check your inbox.');
    } catch {
      setError('Failed to send reset email. Try again later.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSuccess = async (credentialResponse: { credential?: string }) => {
    if (!credentialResponse.credential) {
      setError('Google returned no credential');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await authApi.loginGoogle(credentialResponse.credential);
      handleLoginSuccess(res.data.token);
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: { message?: string } | string } } })?.response?.data;
      const msg = typeof errData?.error === 'string' ? errData.error : errData?.error?.message;
      setError(msg || 'Google login failed');
    } finally {
      setLoading(false);
    }
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    setError('');
    setSuccess('');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background-default-base">
      <div className="w-full max-w-md p-8 space-y-6 bg-background-default-secondary rounded-xl shadow-lg">
        {/* Logo */}
        <div className="text-center">
          <h1 className="text-2xl font-bold text-text-default-base">Breatic</h1>
          <p className="text-sm text-text-default-tertiary mt-1">AI Creative Platform</p>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-border-default-base">
          <button
            type="button"
            onClick={() => switchTab('login')}
            className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'login'
                ? 'border-green-500 text-green-600'
                : 'border-transparent text-text-default-tertiary hover:text-text-default-base'
            }`}
          >
            {t('auth.login', 'Sign In')}
          </button>
          <button
            type="button"
            onClick={() => switchTab('register')}
            className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'register'
                ? 'border-green-500 text-green-600'
                : 'border-transparent text-text-default-tertiary hover:text-text-default-base'
            }`}
          >
            {t('auth.register', 'Sign Up')}
          </button>
        </div>

        {/* Error / Success */}
        {error && (
          <div className="p-3 rounded-lg bg-red-50 text-red-600 text-sm">{error}</div>
        )}
        {success && (
          <div className="p-3 rounded-lg bg-green-50 text-green-600 text-sm">{success}</div>
        )}

        {/* Login form */}
        {tab === 'login' && (
          <form onSubmit={handleEmailLogin} className="space-y-4">
            <input
              type="email"
              placeholder={t('auth.email', 'Email')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-lg border border-border-default-base bg-background-default-base text-text-default-base placeholder:text-text-default-tertiary focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <input
              type="password"
              placeholder={t('auth.password', 'Password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-lg border border-border-default-base bg-background-default-base text-text-default-base placeholder:text-text-default-tertiary focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-lg bg-green-500 text-white font-medium hover:bg-green-600 disabled:opacity-50 transition-colors"
            >
              {loading ? '...' : t('auth.login', 'Sign In')}
            </button>
            <button
              type="button"
              onClick={() => switchTab('forgot')}
              className="w-full text-sm text-text-default-tertiary hover:text-green-500 transition-colors"
            >
              {t('auth.forgotPassword', 'Forgot password?')}
            </button>
          </form>
        )}

        {/* Register form */}
        {tab === 'register' && (
          <form onSubmit={handleRegister} className="space-y-4">
            <input
              type="email"
              placeholder={t('auth.email', 'Email')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-lg border border-border-default-base bg-background-default-base text-text-default-base placeholder:text-text-default-tertiary focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <input
              type="password"
              placeholder={t('auth.password', 'Password (min 8 characters)')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full px-4 py-3 rounded-lg border border-border-default-base bg-background-default-base text-text-default-base placeholder:text-text-default-tertiary focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <input
              type="password"
              placeholder={t('auth.confirmPassword', 'Confirm password')}
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
              {loading ? '...' : t('auth.register', 'Sign Up')}
            </button>
          </form>
        )}

        {/* Forgot password form */}
        {tab === 'forgot' && (
          <form onSubmit={handleForgotPassword} className="space-y-4">
            <p className="text-sm text-text-default-tertiary">
              {t('auth.forgotDescription', 'Enter your email and we\'ll send you a reset link.')}
            </p>
            <input
              type="email"
              placeholder={t('auth.email', 'Email')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-lg border border-border-default-base bg-background-default-base text-text-default-base placeholder:text-text-default-tertiary focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-lg bg-green-500 text-white font-medium hover:bg-green-600 disabled:opacity-50 transition-colors"
            >
              {loading ? '...' : t('auth.sendResetLink', 'Send Reset Link')}
            </button>
            <button
              type="button"
              onClick={() => switchTab('login')}
              className="w-full text-sm text-text-default-tertiary hover:text-green-500 transition-colors"
            >
              {t('auth.backToLogin', 'Back to Sign In')}
            </button>
          </form>
        )}

        {/* Google OAuth divider + button */}
        {tab !== 'forgot' && GOOGLE_CLIENT_ID && (
          <>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border-default-base" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="px-2 bg-background-default-secondary text-text-default-tertiary">
                  {t('auth.or', 'or')}
                </span>
              </div>
            </div>
            <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
              <div className="flex justify-center">
                <GoogleLogin
                  onSuccess={handleGoogleSuccess}
                  onError={() => setError('Google login failed')}
                  width={360}
                />
              </div>
            </GoogleOAuthProvider>
          </>
        )}
      </div>
    </div>
  );
}
