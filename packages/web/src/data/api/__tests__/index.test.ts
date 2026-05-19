import { describe, it, expect } from 'vitest';
import * as api from '../index';

describe('data/api barrel', () => {
  it('exposes all 14 API client objects + request helpers', () => {
    expect(typeof api.request).toBe('function');
    expect(typeof api.apiGet).toBe('function');
    expect(typeof api.apiPost).toBe('function');
    expect(typeof api.apiPatch).toBe('function');
    expect(typeof api.apiDelete).toBe('function');

    expect(api.authApi).toBeDefined();
    expect(api.usersApi).toBeDefined();
    expect(api.projectsApi).toBeDefined();
    expect(api.spacesApi).toBeDefined();
    expect(api.membersApi).toBeDefined();
    expect(api.chatApi).toBeDefined();
    expect(api.canvasApi).toBeDefined();
    expect(api.miniToolsApi).toBeDefined();
    expect(api.textToolsApi).toBeDefined();
    expect(api.tasksApi).toBeDefined();
    expect(api.skillsApi).toBeDefined();
    expect(api.paymentApi).toBeDefined();
    expect(api.assetsApi).toBeDefined();
    expect(api.modelsApi).toBeDefined();
  });

  it('ApiException class is exported', () => {
    const ex = new api.ApiException({ status: 500, message: 'x' });
    expect(ex).toBeInstanceOf(Error);
    expect(ex.status).toBe(500);
  });
});
