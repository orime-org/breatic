// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** The control row's forms: full; ratio without size; then Play as an icon; then the time without the total. */
export const TRANSPORT_FORMS = 4;

/**
 * Which form the Timeline play bar's control row should show next (inner#1709). Forms go from widest to narrowest;
 * only the shown form can be measured, so a narrower one is taken while the shown one does not fit, and a wider one is
 * tried again once it is known to fit or has not been measured since the content changed.
 * @param form - The form shown now.
 * @param widths - Each form's measured width, where known.
 * @param room - The width the row has.
 * @returns The form to show; the same form when it should stay.
 * @throws {never} Never.
 */
export function nextTransportForm(form: number, widths: readonly (number | undefined)[], room: number): number {
  const shown = widths[form];
  if (shown !== undefined && shown > room && form < TRANSPORT_FORMS - 1) return form + 1;
  if (form === 0) return form;
  const wider = widths[form - 1];
  return wider === undefined || wider <= room ? form - 1 : form;
}
