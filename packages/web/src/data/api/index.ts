/**
 * API layer — all backend communication.
 *
 * Usage:
 *   import { authApi, projectsApi, chatApi } from '@/data/api';
 *   const user = await authApi.getMe();
 */

import * as authApi from './auth';
import * as projectsApi from './projects';
import * as chatApi from './chat';
import * as canvasApi from './canvas';
import * as miniToolsApi from './mini-tools';
import * as modelsApi from './models';
import * as paymentApi from './payment';
import * as assetsApi from './assets';

export {
  authApi,
  projectsApi,
  chatApi,
  canvasApi,
  miniToolsApi,
  modelsApi,
  paymentApi,
  assetsApi,
};
