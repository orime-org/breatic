// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the rail hands to `HoverPreview` (#1945).
 *
 * The rail used to declare every non-text row as `kind='image'` with the
 * thumbnail as its source, so an audio reference previewed as nothing and a
 * video reference previewed as a still cover. The activity feed already does
 * this correctly (`ProjectActivityButton.tsx`), and `HoverPreview` already
 * accepts `audio` / `video` plus a poster — what was missing was the rail
 * having the asset URL to give it.
 *
 * `HoverPreview` is stubbed to expose its props as data attributes: the claim
 * under test is what the rail DECLARES, and asserting on a rendered MediaPlayer
 * would be asserting on HoverPreview's own behaviour, which has its own tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  focusToRailItem,
  type ReferenceRailItem,
} from '@web/spaces/canvas/generate/derive-references';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';

vi.mock('@web/spaces/canvas/nodes/_shared/HoverPreview', () => ({
  HoverPreview: ({
    kind,
    src,
    poster,
    text,
    emptyHint,
    dimmed,
    children,
  }: {
    kind: string;
    src?: string;
    poster?: string;
    text?: string;
    emptyHint?: string;
    dimmed?: boolean;
    children: React.ReactNode;
  }): React.JSX.Element => (
    <div
      data-testid='preview'
      data-kind={kind}
      data-src={src ?? ''}
      data-poster={poster ?? ''}
      data-text={text ?? ''}
      data-empty-hint={emptyHint ?? ''}
      data-dimmed={dimmed === true ? 'true' : 'false'}
    >
      {children}
    </div>
  ),
}));

const ROWS: ReferenceRailItem[] = [
  {
    refId: 'e-text',
    sourceNodeId: 'n-text',
    sourceNodeType: 'text',
    sourceNodeName: 'Script',
    textContent: 'a wide shot',
  },
  {
    refId: 'e-image',
    sourceNodeId: 'n-image',
    sourceNodeType: 'image',
    sourceNodeName: 'Character',
    thumbnail: 'https://cdn/char.png',
    mediaUrl: 'https://cdn/char.png',
  },
  {
    refId: 'e-audio',
    sourceNodeId: 'n-audio',
    sourceNodeType: 'audio',
    sourceNodeName: 'Narration',
    mediaUrl: 'https://cdn/voice.m4a',
  },
  {
    refId: 'e-video',
    sourceNodeId: 'n-video',
    sourceNodeType: 'video',
    sourceNodeName: 'Camera move',
    thumbnail: 'https://cdn/cover.jpg',
    mediaUrl: 'https://cdn/clip.mp4',
  },
];

/**
 * Reads back the props the rail declared, row by row.
 * @returns One record per row, in rail order.
 */
function declared(): Array<Record<string, string>> {
  return screen.getAllByTestId('preview').map((el) => ({
    kind: el.getAttribute('data-kind') ?? '',
    src: el.getAttribute('data-src') ?? '',
    poster: el.getAttribute('data-poster') ?? '',
    text: el.getAttribute('data-text') ?? '',
    emptyHint: el.getAttribute('data-empty-hint') ?? '',
    dimmed: el.getAttribute('data-dimmed') ?? '',
  }));
}

describe('ReferenceRail — the hover preview gets the real modality', () => {
  it('declares audio as audio and video as video, each with its own asset', () => {
    render(
      <ReferenceRail
        references={ROWS}
        onRemove={() => {}}
        onInsert={() => {}}
        modeTakesReferences
        allowedSourceTypes={['image']}
      />,
    );
    const rows = declared();
    expect(rows[0]).toMatchObject({ kind: 'text', text: 'a wide shot' });
    expect(rows[1]).toMatchObject({
      kind: 'image',
      src: 'https://cdn/char.png',
    });
    // Audio has no still to show, which is exactly why it needs the asset
    // rather than the thumbnail — the old wiring gave it neither.
    expect(rows[2]).toMatchObject({
      kind: 'audio',
      src: 'https://cdn/voice.m4a',
      poster: '',
    });
    // Video plays the file and shows the cover while it loads.
    expect(rows[3]).toMatchObject({
      kind: 'video',
      src: 'https://cdn/clip.mp4',
      poster: 'https://cdn/cover.jpg',
    });
  });

  it('previews at full strength even in a mode that dims the rail', () => {
    // The dim says "this mode does not use references"; it does not say "you
    // may not look at this". User 2026-08-13: 「hover 的时候还是可以显示效果
    // 图的」. The row's opacity is on the row, and the card is portaled out of
    // it, so the preview is unaffected — and nothing re-applies the dim here.
    render(
      <ReferenceRail
        references={ROWS}
        onRemove={() => {}}
        onInsert={() => {}}
        modeTakesReferences={false}
        allowedSourceTypes={[]}
      />,
    );
    for (const row of declared()) {
      expect(row.dimmed).toBe('false');
    }
  });

  it('claims nothing to play when the source has produced nothing yet', () => {
    // A video node connected before it generated has neither cover nor asset.
    // There is no thumbnail fallback here on purpose — a thumbnail is a still
    // and the media source is the asset, so the preview says the row is empty
    // rather than pointing at something it cannot play.
    render(
      <ReferenceRail
        references={[
          {
            refId: 'e-empty',
            sourceNodeId: 'n-empty',
            sourceNodeType: 'video',
            sourceNodeName: 'Not yet',
          },
        ]}
        onRemove={() => {}}
        onInsert={() => {}}
        modeTakesReferences
        allowedSourceTypes={['image']}
      />,
    );
    expect(declared()[0]).toMatchObject({ kind: 'video', src: '', poster: '' });
    // ...and it says so, rather than opening an empty card.
    expect(declared()[0]?.emptyHint).not.toBe('');
  });

  it('calls a row empty by its ASSET, not by whether it has a still', () => {
    // Two rows that the old thumbnail-keyed test got backwards. An audio node
    // never has a thumbnail, full or not, so every audio reference was called
    // empty; a coverless video (#1821) has a file to play, and was called
    // empty too. Both were answers to "is there a still?", which is not the
    // question the hint asks.
    render(
      <ReferenceRail
        references={[
          {
            refId: 'e-aud',
            sourceNodeId: 'n-aud',
            sourceNodeType: 'audio',
            sourceNodeName: 'Narration',
            mediaUrl: 'https://cdn/voice.m4a',
          },
          {
            refId: 'e-vid',
            sourceNodeId: 'n-vid',
            sourceNodeType: 'video',
            sourceNodeName: 'Coverless',
            mediaUrl: 'https://cdn/clip.mp4',
          },
        ]}
        onRemove={() => {}}
        onInsert={() => {}}
        modeTakesReferences
        allowedSourceTypes={['image']}
      />,
    );
    for (const row of declared()) {
      expect(row.emptyHint).toBe('');
    }
  });
});

describe('ReferenceRail — a focus crop previews the crop', () => {
  it('shows the crop rather than calling it empty', () => {
    // Built by the row's OTHER producer. `deriveReferences` and
    // `focusToRailItem` both make rail rows, so a field the rail now reads
    // has to be set by both — this test exists because the first version of
    // mediaUrl was set by one of them, which left every crop chip previewing
    // "not generated yet" over a crop that was right there.
    render(
      <ReferenceRail
        references={[
          focusToRailItem({ id: 'c1', url: 'https://cdn/crop.png', name: 'Face' }),
        ]}
        onRemove={() => {}}
        onInsert={() => {}}
        modeTakesReferences
        allowedSourceTypes={['image']}
      />,
    );
    expect(declared()[0]).toMatchObject({
      kind: 'image',
      src: 'https://cdn/crop.png',
      emptyHint: '',
    });
  });
});
