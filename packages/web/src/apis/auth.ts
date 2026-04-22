/**
 * Auth API — register, login, logout, current user.
 */

import { request, type CustomAxiosRequestConfig } from '@/utils/request';
import type { UserEntity, ApiResponse, RegisterInput, LoginInput } from '@breatic/shared';

/** Register a new account. */
export const register = (data: RegisterInput) =>
  request<ApiResponse<{ user: UserEntity; token: string }>>({
    url: '/api/v1/auth/register',
    method: 'post',
    data,
  });

/** Login with email and password. */
export const login = (data: LoginInput) =>
  request<ApiResponse<{ user: UserEntity; token: string }>>({
    url: '/api/v1/auth/login',
    method: 'post',
    data,
  });

/** Login with Google OAuth credential (ID token from Google Sign-In). */
export const loginGoogle = (credential: string) =>
  request<ApiResponse<{ user: UserEntity; token: string }>>({
    url: '/api/v1/auth/google',
    method: 'post',
    data: { credential },
  });

/** Get the current authenticated user. */
export const getMe = () =>
  request<ApiResponse<UserEntity>>({
    url: '/api/v1/auth/me',
    method: 'get',
  });

/** Logout and invalidate the session. */
export const logout = () =>
  request({
    url: '/api/v1/auth/logout',
    method: 'post',
  });

/** Request a password reset email. */
export const forgotPassword = (email: string) =>
  request<{ message: string }>({
    url: '/api/v1/auth/forgot-password',
    method: 'post',
    data: { email },
  });

/** Reset password with token from email. */
export const resetPassword = (token: string, password: string) =>
  request<{ message: string }>({
    url: '/api/v1/auth/reset-password',
    method: 'post',
    data: { token, password },
  });
