import { apiGet, apiPost } from './request';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  credits: number;
}

interface AuthResponse {
  token: string;
  user: AuthUser;
}

export const authApi = {
  register(body: { email: string; password: string; name: string }) {
    return apiPost<AuthResponse>('/auth/register', body);
  },
  login(body: { email: string; password: string }) {
    return apiPost<AuthResponse>('/auth/login', body);
  },
  google(body: { idToken: string }) {
    return apiPost<AuthResponse>('/auth/google', body);
  },
  me() {
    return apiGet<AuthUser>('/auth/me');
  },
  logout() {
    return apiPost<void>('/auth/logout');
  },
};
