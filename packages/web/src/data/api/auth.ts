import { apiGet, apiPost } from '@/data/api/request';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  credits: number;
}

/**
 * Register / login responses no longer return a `token` field —
 * the server sets an httpOnly `breatic_session` cookie on the
 * response instead (2026-05-26 cookie migration). The frontend
 * never holds the token; subsequent calls authenticate via the
 * cookie automatically (axios `withCredentials: true`).
 */
interface RegisterResponse {
  user: AuthUser;
  /** One-time recovery code — shown ONCE on the registration confirm screen. */
  recoveryCode: string;
}

interface LoginResponse {
  user: AuthUser;
}

interface ResetWithRecoveryCodeResponse {
  /** A fresh recovery code that replaces the consumed one — must be saved. */
  newRecoveryCode: string;
}

export const authApi = {
  register(body: { email: string; password: string; name: string }) {
    return apiPost<RegisterResponse>('/auth/register', body);
  },
  login(body: { email: string; password: string }) {
    return apiPost<LoginResponse>('/auth/login', body);
  },
  google(body: { idToken: string }) {
    return apiPost<LoginResponse>('/auth/google', body);
  },
  me() {
    return apiGet<AuthUser>('/auth/me');
  },
  logout() {
    return apiPost<void>('/auth/logout');
  },
  forgotPassword(body: { email: string }) {
    return apiPost<{ message: string }>('/auth/forgot-password', body);
  },
  resetPasswordWithToken(body: { token: string; password: string }) {
    return apiPost<{ message: string }>('/auth/reset-password', body);
  },
  resetPasswordWithRecoveryCode(body: {
    email: string;
    recoveryCode: string;
    newPassword: string;
  }) {
    return apiPost<ResetWithRecoveryCodeResponse>(
      '/auth/reset-password-with-recovery-code',
      body,
    );
  },
  verifyEmail(body: { token: string }) {
    return apiPost<void>('/auth/verify-email', body);
  },
  resendVerificationEmail() {
    return apiPost<void>('/auth/resend-verification-email');
  },
};
