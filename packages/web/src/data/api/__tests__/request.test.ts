import { describe, it, expect } from 'vitest';

import { ApiException, type ApiError } from '../types';

describe('ApiException', () => {
  it('exposes status / message / code from the wrapped ApiError', () => {
    const err: ApiError = { status: 404, message: 'Not found', code: 'NOT_FOUND' };
    const ex = new ApiException(err);
    expect(ex.status).toBe(404);
    expect(ex.code).toBe('NOT_FOUND');
    expect(ex.message).toBe('Not found');
    expect(ex.name).toBe('ApiException');
  });

  it('is an Error instance (can be thrown / caught)', () => {
    const ex = new ApiException({ status: 500, message: 'Boom' });
    expect(ex).toBeInstanceOf(Error);
    expect(() => {
      throw ex;
    }).toThrow('Boom');
  });

  it('code is optional', () => {
    const ex = new ApiException({ status: 400, message: 'Bad request' });
    expect(ex.code).toBeUndefined();
  });
});
