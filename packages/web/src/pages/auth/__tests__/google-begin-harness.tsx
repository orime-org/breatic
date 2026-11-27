// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Shared pieces for the Google full-page sign-in cases (inner#2157 design §7.9):
 * catching the begin form's native post, reading what session storage holds,
 * and showing where the page went.
 */

import type { ReactElement } from 'react';
import { useLocation } from 'react-router-dom';

import { API_BASE_PATH } from '@web/data/api/base-path';

/** Where the Google sign-in form posts, built from the one API prefix. */
export const BEGIN_ACTION = `${API_BASE_PATH}/auth/google/begin`;

/** One native post of the Google begin form, as the browser would send it. */
export interface GoogleBeginPost {
  /** The form that was submitted. */
  form: HTMLFormElement;
  /** Every named field the post carries, as strings. */
  fields: Record<string, string>;
  /** Everything in session storage at the moment the form was submitted. */
  storedAtSubmit: string;
}

/**
 * Everything in session storage as `key=value` lines, so a case can look for
 * a value without depending on the key the page chose.
 * @returns The stored entries, one per line.
 */
export function sessionStorageText(): string {
  const lines: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (key !== null) lines.push(`${key}=${sessionStorage.getItem(key) ?? ''}`);
  }
  return lines.join('\n');
}

/**
 * Record every submit of a form whose action ends in `/auth/google/begin`.
 * The listener sits on `window` in the bubble phase, after React's own
 * handlers, and cancels the post so jsdom does not try to navigate.
 * @returns The recorded posts and a function that removes the listener.
 */
export function recordGoogleBeginPosts(): { posts: GoogleBeginPost[]; stop: () => void } {
  const posts: GoogleBeginPost[] = [];
  /**
   * Capture one submit of the begin form.
   * @param event - The native submit event.
   */
  const listener = (event: Event): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!(form.getAttribute('action') ?? '').endsWith('/auth/google/begin')) return;
    const fields: Record<string, string> = {};
    for (const [name, value] of new FormData(form).entries()) fields[name] = String(value);
    posts.push({ form, fields, storedAtSubmit: sessionStorageText() });
    event.preventDefault();
  };
  window.addEventListener('submit', listener);
  return { posts, stop: () => window.removeEventListener('submit', listener) };
}

/**
 * Shows the current path and query, for cases that check where the page went
 * or what it left in the address bar.
 * @returns The location as text.
 */
export function LocationProbe(): ReactElement {
  const location = useLocation();
  return <output data-testid='location'>{location.pathname}{location.search}</output>;
}

/**
 * Read the current location out of the probe.
 * @param probe - The probe element.
 * @returns The path and the parsed query.
 */
export function readLocation(probe: HTMLElement): { pathname: string; params: URLSearchParams } {
  const text = probe.textContent ?? '';
  const at = text.indexOf('?');
  return at === -1
    ? { pathname: text, params: new URLSearchParams() }
    : { pathname: text.slice(0, at), params: new URLSearchParams(text.slice(at + 1)) };
}
