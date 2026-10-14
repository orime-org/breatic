// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent banner and the consent cookie (inner#1442 design §4.4.3). The
 * cookie is the contract the API, collab and the website read: name
 * `breatic_consent`, categories `necessary` / `analytics` / `ads`, the policy
 * revision, and per category the latest choice in `data` (`CONSENT_DATA_FIELDS`).
 */

import * as CookieConsent from 'vanilla-cookieconsent';
import 'vanilla-cookieconsent/dist/cookieconsent.css';
import '@web/lib/analytics/consent-banner.css';
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_DAYS,
  CONSENT_REVISION,
  parseConsentChoices,
  requiresOptIn,
  revisionInForce,
  type BrowserChoices,
  type NoticeShown,
} from '@breatic/shared';
import { cookieAfterWrites, decideOnLoad, writesForClick, type ConsentWrites } from '@web/lib/analytics/consent-decision';

/** Interface text, already translated. */
export interface ConsentText {
  readonly banner: { text: string; privacy: string; acceptAll: string; rejectAll: string; settings: string; gpc: string };
  readonly settings: {
    title: string;
    save: string;
    close: string;
    note: string;
    notice: { gpc: string; account: string };
    necessary: { title: string; description: string };
    analytics: { title: string; description: string };
    ads: { title: string; description: string };
  };
}

let onChoice: (choices: BrowserChoices | null) => void = ignoreChoice;

/** The listener until the banner starts. */
function ignoreChoice(): void {
  // Nothing listens yet.
}
// Which window the visitor last opened: a change made there is filed under it.
let openedModal: 'consentModal' | 'preferencesModal' | null = null;
// A button in the settings window was pressed; the library reports a save only when a category changes.
let saving = false;
// The last button pressed in either window: accept all, reject all or save.
let pressed: 'all' | 'necessary' | 'save' | null = null;
// The page's ads view: the notice the windows show and where the settings window's ads switch stands.
let adsView: { notice: NoticeShown; adsOn: boolean } = { notice: false, adsOn: false };
// The visitor changed the ads switch since the settings window opened; a later decision leaves it there.
let adsSwitchTouched = false;

/**
 * Whether the browser sends Global Privacy Control.
 * @returns True when it does.
 */
function sendsGpc(): boolean {
  return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

/** The only pages the banner appears on: signing in and signing up (user 2026-10-12). */
const BANNER_PATHS: readonly string[] = ['/login', '/register'];
// An opt-in visitor who has not answered yet.
let undecided = false;
let onBannerPage = false;

// The library is running; it declines to run for crawlers and automated browsers.
let running = false;

/** Show the banner while an undecided visitor is on a banner page, and hide it elsewhere. */
function placeBanner(): void {
  if (!running) return;
  if (undecided && onBannerPage) CookieConsent.show(true);
  else CookieConsent.hide();
}

/**
 * Follow the page the visitor is on.
 * @param pathname - The page's path.
 */
export function followPage(pathname: string): void {
  onBannerPage = BANNER_PATHS.includes(pathname);
  placeBanner();
}

/**
 * Each category's choice the cookie holds. Read from the cookie itself each
 * time, so a choice another tab or the website made is seen.
 * @returns The choices in force.
 */
export function readBrowserChoices(): BrowserChoices {
  return parseConsentChoices(JSON.stringify(CookieConsent.getCookie()), Date.now());
}

/**
 * The one write path for this browser's choice (design §4.4.4 `setConsent()`):
 * each category written gets a new id and the same time; a category left out
 * keeps the choice in force before the press. The library has already saved
 * its own reading of a press by the time it calls back, so the categories
 * come from that earlier choice.
 * @param writes - The categories to write.
 * @param prior - The choices in force before this write.
 */
function writeConsent(writes: ConsentWrites, prior: BrowserChoices | null): void {
  const stored = (CookieConsent.getCookie().data ?? {}) as Record<string, unknown>;
  const { data, accepted } = cookieAfterWrites(writes, prior, stored, new Date().toISOString(), () => crypto.randomUUID());
  CookieConsent.acceptCategory(accepted, (['analytics', 'ads'] as const).filter((c) => !accepted.includes(c)));
  CookieConsent.setCookieData({ value: data, mode: 'overwrite' });
}

/** A choice the visitor made in the banner or the settings window. */
function onVisitorChoice(): void {
  if (openedModal === null) return;
  // Cleared before writing: the write's own save calls the library back, and that is not another press.
  const modal = openedModal;
  const role = pressed ?? 'save';
  openedModal = null;
  pressed = null;
  const accepted = CookieConsent.getUserPreferences().acceptedCategories;
  writeConsent(
    writesForClick({
      stored: lastSeen?.ads ?? null,
      role,
      window: modal === 'preferencesModal' ? 'settings' : 'banner',
      toggles: { analytics: accepted.includes('analytics'), ads: accepted.includes('ads') },
      notice: adsView.notice,
      gpc: sendsGpc(),
    }),
    lastSeen,
  );
  undecided = false;
  lastSeen = readBrowserChoices();
  onChoice(lastSeen);
}

/**
 * Take the page's ads view: the windows show its notice, and the settings
 * window's ads switch follows it until the visitor changes the switch, without saving.
 * @param view - The notice to show and where the ads switch stands.
 * @param view.notice - The opt-out notice, if any.
 * @param view.adsOn - Whether the ads switch is on.
 */
export function setAdsView(view: { notice: NoticeShown; adsOn: boolean }): void {
  adsView = view;
  if (!adsSwitchTouched) {
    const toggle = adsSwitch();
    if (toggle !== null) toggle.checked = view.adsOn;
  }
  const text = bannerOptions?.text();
  if (text !== undefined) showNotices(text);
}

/**
 * The settings window's ads switch, once the library has built it.
 * @returns The switch, or null.
 */
function adsSwitch(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('#cc-main .pm input[value="ads"]');
}

/** The visitor changed the ads switch. */
function markAdsSwitchTouched(): void {
  adsSwitchTouched = true;
}

/**
 * Show the opt-out notice under a window's text, or remove it.
 * @param container - Where the notice goes.
 * @param text - The notice, or null for none.
 */
function showNotice(container: Element | null, text: string | null): void {
  container?.querySelector('.breatic-consent-notice')?.remove();
  if (container === null || text === null) return;
  const note = document.createElement('p');
  note.className = 'breatic-consent-notice';
  note.textContent = text;
  container.append(note);
}

/**
 * Bring a window that just opened in line with the page's ads view: the banner
 * says when GPC keeps ads off; the settings window shows the notice above the
 * ads switch and starts the switch from the view.
 * @param modalName - The window.
 */
function presetWindow(modalName: string): void {
  const text = bannerOptions?.text();
  if (text === undefined) return;
  if (modalName === 'consentModal') {
    showNotices(text);
    return;
  }
  const toggle = adsSwitch();
  adsSwitchTouched = false;
  if (toggle !== null) {
    toggle.checked = adsView.adsOn;
    toggle.addEventListener('change', markAdsSwitchTouched);
  }
  showNotices(text);
}

/**
 * Show the current notice in whichever window is on the page.
 * @param text - The consent text.
 */
function showNotices(text: ConsentText): void {
  showNotice(document.querySelector('#cc-main .cm__desc'), adsView.notice === 'gpc' ? text.banner.gpc : null);
  const section = adsSwitch()?.closest('.pm__section--toggle') ?? null;
  // Inside the ads card, under its description.
  const body = section?.querySelector('.pm__section-desc-wrapper') ?? section;
  showNotice(body, adsView.notice === false ? null : text.settings.notice[adsView.notice]);
}

/**
 * The policy revision the library runs under and writes: the code's, or a newer one the stored choice was made under.
 * The account record takes the same, so a choice made here is not dropped as outdated.
 * @returns The revision.
 */
export function consentRevision(): number {
  return Math.max(CONSENT_REVISION, storedRevision());
}

/**
 * The policy revision the stored cookie was written under; readable before the library runs.
 * @returns The revision, or 0 when nothing is stored.
 */
function storedRevision(): number {
  // The library's getCookie(field, cookieName) reads a named cookie before run(); its type definitions omit the name.
  const read = CookieConsent.getCookie as (field: undefined, cookieName: string) => Partial<CookieConsent.CookieValue>;
  const { revision } = read(undefined, CONSENT_COOKIE_NAME);
  return revisionInForce(revision) ? (revision as number) : 0;
}

/** What the banner needs to start, kept so it can start again. */
interface BannerOptions {
  cookieDomain: string;
  language: string;
  languages: readonly string[];
  text: () => ConsentText;
  privacyUrl: string;
  country: Promise<string | null>;
  onChoice: (choices: BrowserChoices | null) => void;
}

let bannerOptions: BannerOptions | null = null;
let currentLanguage = '';
// The choice the cookie held when last read, so a cookie the browser refuses does not look like a change.
let lastSeen: BrowserChoices | null = null;

/**
 * Whether the library would decline to run here: the same test as its `hideFromBots`.
 * @returns True for crawlers and automated browsers.
 */
function isBot(): boolean {
  return navigator.webdriver || /bot|crawl|spider|slurp|teoma/i.test(navigator.userAgent);
}

/**
 * Show the banner when the visitor has to be asked, on the pages
 * {@link followPage} allows; apply the default otherwise; and report every
 * choice in force, including one another tab or the website makes.
 * @param options - Where to write and what to say.
 * @param options.cookieDomain - The cookie's domain; empty for the current host.
 * @param options.language - The interface language.
 * @param options.languages - Every interface language.
 * @param options.text - Reads the text in the current interface language.
 * @param options.privacyUrl - The privacy policy, linked from the banner.
 * @param options.country - The visitor's country lookup; null asks first.
 * @param options.onChoice - Called with the choice in force, now and after each change.
 */
export async function startConsentBanner(options: BannerOptions): Promise<void> {
  onChoice = options.onChoice;
  if (isBot()) {
    onChoice(null);
    return;
  }
  bannerOptions = options;
  currentLanguage = options.language;
  // Capture phase: runs before the library's own handler saves and hides the window.
  document.addEventListener(
    'click',
    (event) => {
      const button = event.target instanceof Element ? event.target.closest('#cc-main [data-role]') : null;
      const role = button?.getAttribute('data-role');
      if (role === 'all' || role === 'necessary' || role === 'save') pressed = role;
      if (button?.closest('.pm')) saving = true;
    },
    true,
  );
  await boot(options);
  // A restart while the lookup is still out would decide twice; the lookup ends within a second.
  await options.country;
  document.addEventListener('visibilitychange', () => void resync());
  // A window beside the one where the choice changed stays visible; it learns of it when it gets focus.
  window.addEventListener('focus', () => void resync());
}

/**
 * Pick up a choice another tab or the website wrote to the shared cookie
 * while this tab was hidden. The library keeps its own copy of the choice,
 * which its settings window shows and its next save compares against, so it
 * starts again on the cookie.
 */
async function resync(): Promise<void> {
  if (document.visibilityState !== 'visible' || bannerOptions === null) return;
  if (sameChoices(readBrowserChoices(), lastSeen)) return;
  CookieConsent.reset(false);
  await boot(bannerOptions);
}

/**
 * Start the library on the cookie, decide what is in force and report it.
 * @param options - Where to write and what to say.
 */
async function boot(options: BannerOptions): Promise<void> {
  openedModal = null;
  await CookieConsent.run({
    autoShow: false,
    // A choice stored under a newer revision stands (readBrowserChoices); the library must hold it too.
    revision: consentRevision(),
    cookie: {
      name: CONSENT_COOKIE_NAME,
      ...(options.cookieDomain !== '' ? { domain: options.cookieDomain } : {}),
      path: '/',
      sameSite: 'Lax',
      secure: window.location.protocol === 'https:',
      expiresAfterDays: CONSENT_MAX_AGE_DAYS,
    },
    guiOptions: {
      consentModal: { layout: 'bar', position: 'bottom', equalWeightButtons: true },
      preferencesModal: { layout: 'box', equalWeightButtons: true },
    },
    categories: {
      necessary: { enabled: true, readOnly: true },
      analytics: {},
      ads: {},
    },
    language: {
      default: currentLanguage,
      // Built when shown, so a language switch reads the new text.
      translations: Object.fromEntries(
        options.languages.map((language) => [language, () => toTranslation(options.text(), options.privacyUrl)]),
      ),
    },
    onModalShow: ({ modalName }) => {
      if (modalName === 'consentModal' || modalName === 'preferencesModal') openedModal = modalName;
      presetWindow(modalName);
      // A press on a window that was already hiding (a double click) never reached onModalHide.
      if (modalName === 'preferencesModal') saving = false;
    },
    // A choice that changed a category reports before the window hides and clears openedModal.
    // A save that changed nothing reports nothing, yet is the visitor's choice; closing the window
    // without a save hands back to the banner when it is still up.
    onModalHide: ({ modalName }) => {
      if (modalName !== 'preferencesModal') return;
      if (openedModal === 'preferencesModal') {
        if (saving) onVisitorChoice();
        else openedModal = undecided && onBannerPage ? 'consentModal' : null;
      }
      saving = false;
    },
    onFirstConsent: onVisitorChoice,
    onChange: onVisitorChoice,
  });

  // What the library loaded into its own memory, which its settings window shows.
  const loaded = readBrowserChoices();
  const complete = loaded.analytics !== null && loaded.ads !== null;
  const country = complete ? null : await options.country;
  const stored = readBrowserChoices();
  // Another tab stored a choice during the lookup: start again on it, as resync does.
  if (!sameChoices(stored, loaded)) {
    CookieConsent.reset(false);
    await boot(options);
    return;
  }
  const decision = decideOnLoad({ stored, optIn: requiresOptIn(country), gpc: sendsGpc() });
  // This write is ours, even if the visitor opened a window and closed it without choosing.
  openedModal = null;
  const writes: ConsentWrites = {
    ...(decision.analytics ? { analytics: decision.analytics } : {}),
    ...(decision.ads ? { ads: decision.ads } : {}),
  };
  if (writes.analytics || writes.ads) writeConsent(writes, stored);
  undecided = decision.showBanner;
  running = true;
  placeBanner();
  lastSeen = readBrowserChoices();
  onChoice(lastSeen);
}

/**
 * Whether two readings of the cookie hold the same decisions.
 * @param a - One reading.
 * @param b - The other.
 * @returns True when they match in every field.
 */
function sameChoices(a: BrowserChoices | null, b: BrowserChoices | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The library's text for one language.
 * @param text - The translated text.
 * @param privacyUrl - The privacy policy.
 * @returns The banner and settings text.
 */
function toTranslation(text: ConsentText, privacyUrl: string): CookieConsent.Translation {
  return {
    consentModal: {
      description: `${text.banner.text} <a href="${privacyUrl}" target="_blank" rel="noreferrer">${text.banner.privacy}</a>`,
      acceptAllBtn: text.banner.acceptAll,
      acceptNecessaryBtn: text.banner.rejectAll,
      showPreferencesBtn: text.banner.settings,
    },
    preferencesModal: {
      title: text.settings.title,
      acceptAllBtn: text.banner.acceptAll,
      acceptNecessaryBtn: text.banner.rejectAll,
      savePreferencesBtn: text.settings.save,
      closeIconLabel: text.settings.close,
      sections: [
        { title: text.settings.necessary.title, description: text.settings.necessary.description, linkedCategory: 'necessary' },
        { title: text.settings.analytics.title, description: text.settings.analytics.description, linkedCategory: 'analytics' },
        { title: text.settings.ads.title, description: text.settings.ads.description, linkedCategory: 'ads' },
        { description: text.settings.note },
      ],
    },
  };
}

/**
 * Follow an interface language switch.
 * @param language - The new language.
 */
export async function setConsentLanguage(language: string): Promise<void> {
  currentLanguage = language;
  await CookieConsent.setLanguage(language, true);
}

/** Open the settings window; the "Cookie settings" entries call this. */
export function openConsentSettings(): void {
  if (running) CookieConsent.showPreferences();
}
