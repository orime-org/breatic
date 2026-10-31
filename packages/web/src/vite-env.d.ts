// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/// <reference types="vite/client" />

// Web Worker module typings
declare module '*.worker?worker' {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}

declare module '*.worker.ts' {
  const WorkerConstructor: {
    new (): Worker;
  };
  export default WorkerConstructor;
}

interface ImportMetaEnv {
  /** Readable product release, also written to app-version.json at build time. */
  readonly VITE_RELEASE_VERSION?: string;
  /** API base including its version prefix; empty means same-origin /api/v1. */
  readonly VITE_API_BASE_URL?: string;
  /** WebSocket URL; empty means same-origin /ws. */
  readonly VITE_COLLAB_URL?: string;
  /** Amplitude project key; empty keeps browser analytics off (inner#1442). */
  readonly VITE_AMPLITUDE_API_KEY?: string;
  /** Google tag id (`AW-…`); empty keeps ad measurement off. */
  readonly VITE_GOOGLE_ADS_TAG_ID?: string;
  /** JSON object: conversion name to Google Ads conversion label. */
  readonly VITE_GOOGLE_ADS_CONVERSION_LABELS?: string;
  /** Parent domain the consent cookie is written on, so the API reads it; empty means this host. */
  readonly VITE_CONSENT_COOKIE_DOMAIN?: string;
}
