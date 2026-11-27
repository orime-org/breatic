// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';

/**
 * A sentence with an email address in it, the address in bold. The sentence
 * comes whole from the catalog so each language keeps its own word order; the
 * address is found in it and set apart.
 * @param root0 - component props
 * @param root0.text - the localized sentence, address already filled in
 * @param root0.email - the address to set in bold
 * @returns the sentence with the address emphasised.
 */
export function EmailInSentence({ text, email }: { text: string; email: string }): React.JSX.Element {
  const at = email ? text.indexOf(email) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className='font-medium text-foreground'>{email}</span>
      {text.slice(at + email.length)}
    </>
  );
}
