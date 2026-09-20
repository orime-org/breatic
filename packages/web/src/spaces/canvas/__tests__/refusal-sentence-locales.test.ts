// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refusal sentences, rendered in all five languages (#2175).
 *
 * Both gates that refuse a file name the file and the format it is in, and
 * each half a refusal did not carry drops its part of the clause. That is
 * four combinations per sentence, written as nested ICU selects — and a
 * translator editing one arm cannot be told by the type system that the other
 * three still have to render, or that the two values still have to appear.
 *
 * So every arm is rendered in every language here. English alone passing says
 * nothing about the four catalogs the other readers open.
 */

import { describe, expect, it } from 'vitest';
import { t, setLocale, setLocaleMessages } from '@breatic/shared';

import { LOCALE_CATALOGS } from '@web/test-utils/locale-catalogs';

const FILE = '1758_a1b2.aiff';
const TYPE = 'AIFF';
const SIZE = '21 MiB';
const LIMIT = '20 MiB';

describe.each(LOCALE_CATALOGS)(
  'what a refused reading says in %s',
  (locale, catalog) => {
    /**
     * Render one key in this locale.
     * @param key - The catalog key.
     * @param params - What the sentence selects on and names.
     * @returns The rendered sentence.
     */
    function say(key: string, params: Record<string, string>): string {
      setLocaleMessages(locale, catalog as Record<string, unknown>);
      setLocale(locale);
      return t(key, params);
    }

    const UNSUPPORTED = 'canvas.task.failure.understand_unsupported_type';
    const OVER_CAP = 'canvas.task.failure.understand_over_cap';

    it('names both the file and its format when it carried both', () => {
      const said = say(UNSUPPORTED, { file: FILE, type: TYPE });

      expect(said).toContain(FILE);
      expect(said).toContain(TYPE);
      expect(said).not.toContain('{');
    });

    it('names whichever half it carried', () => {
      const onlyType = say(UNSUPPORTED, { file: 'none', type: TYPE });
      expect(onlyType).toContain(TYPE);
      expect(onlyType).not.toContain(FILE);
      expect(onlyType).not.toContain('{');

      const onlyFile = say(UNSUPPORTED, { file: FILE, type: 'none' });
      expect(onlyFile).toContain(FILE);
      expect(onlyFile).not.toContain(TYPE);
      expect(onlyFile).not.toContain('{');
    });

    it('still says what happened when it carried neither', () => {
      const said = say(UNSUPPORTED, { file: 'none', type: 'none' });

      expect(said).not.toContain('none');
      expect(said).not.toContain('{');
      expect(said.length).toBeGreaterThan(0);
    });

    it('names the file, its size and the ceiling when it refused one for size', () => {
      const said = say(OVER_CAP, { file: FILE, bytes: SIZE, limit: LIMIT });

      expect(said).toContain(FILE);
      expect(said).toContain(SIZE);
      expect(said).toContain(LIMIT);
      expect(said).not.toContain('{');
    });

    // The ceiling rides on knobs fetched after mount, and a row rendered
    // before they land drops that clause rather than printing a blank.
    it('drops the ceiling clause when the ceiling has not loaded', () => {
      const said = say(OVER_CAP, {
        file: FILE,
        bytes: SIZE,
        limit: 'unknown',
      });

      expect(said).toContain(FILE);
      expect(said).not.toContain('unknown');
      expect(said).not.toContain('{');
    });

    it('says the size refusal without a file when it carried none', () => {
      const said = say(OVER_CAP, {
        file: 'none',
        bytes: 'none',
        limit: LIMIT,
      });

      expect(said).toContain(LIMIT);
      expect(said).not.toContain('none');
      expect(said).not.toContain('{');
    });
  },
);
