import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Auto-clean DOM after each test to prevent leakage across tests.
afterEach(() => {
  cleanup();
});
