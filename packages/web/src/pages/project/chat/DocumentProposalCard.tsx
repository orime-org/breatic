// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { diffWords, type Change } from 'diff';
import * as React from 'react';
import { useParams } from 'react-router-dom';

import { getLocale, hasWords, type DocumentProposal } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { docName } from '@web/data/yjs/manager';
import { useTranslation } from '@web/i18n/use-translation';
import { projectUuidFromRouteParam } from '@web/lib/project-route';
import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';
import { peekDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { ourMediaPrefix, ownMediaOnly, type WrittenBlock } from '@web/spaces/document/document-external-media';
import { markdownBlocks } from '@web/spaces/document/document-markdown';
import { landedAt } from '@web/spaces/document/document-proposal-landing';
import {
  useDocumentProposals,
  type DocumentProposalCardState,
  type LandingAction,
} from '@web/stores/document-proposals';

interface DocumentProposalCardProps {
  /** The edit the Agent proposed, as the tool answered with it. */
  proposal: DocumentProposal;
}

/** The line a finished press shows, by how it ended; `failed` and `applied` depend on the press. */
const STATUS_KEY: Readonly<Record<Exclude<DocumentProposalCardState, 'working' | 'applied' | 'failed'>, string>> = {
  changed: 'chat.documentProposal.changed',
  blockGone: 'chat.documentProposal.blockGone',
  readOnly: 'chat.documentProposal.readOnly',
  spaceGone: 'chat.documentProposal.spaceGone',
};

/** How a block with no words is named on the card, by its BlockNote type. */
const BLOCK_NAME_KEY: Readonly<Record<string, string>> = {
  paragraph: 'spaces.document.commands.paragraph',
  heading: 'chat.documentProposal.headingBlock',
  quote: 'spaces.document.commands.quote',
  bulletListItem: 'spaces.document.commands.bulletList',
  numberedListItem: 'spaces.document.commands.orderedList',
  checkListItem: 'spaces.document.commands.taskList',
  codeBlock: 'spaces.document.commands.codeBlock',
  divider: 'spaces.document.commands.divider',
  table: 'spaces.document.commands.table',
  image: 'spaces.document.media.image',
  video: 'spaces.document.media.video',
  audio: 'spaces.document.media.audio',
};

/** What a press puts in the document: a comment either way, else the rewrite or the insert itself. */
type PressKind = 'comment' | 'rewrite' | 'insert';

/** The line a press that landed shows. */
const APPLIED_KEY: Readonly<Record<PressKind, string>> = {
  comment: 'chat.documentProposal.appliedComment',
  rewrite: 'chat.documentProposal.appliedRewrite',
  insert: 'chat.documentProposal.appliedInsert',
};

/** The line a press that failed shows. */
const FAILED_KEY: Readonly<Record<PressKind, string>> = {
  comment: 'chat.documentProposal.failedComment',
  rewrite: 'chat.documentProposal.failedRewrite',
  insert: 'chat.documentProposal.failedInsert',
};

/**
 * What a press puts in the document.
 * @param proposal - The proposal.
 * @param action - What was pressed.
 * @returns The kind of change.
 */
function pressKind(proposal: DocumentProposal, action: LandingAction): PressKind {
  return action === 'comment' ? 'comment' : proposal.kind === 'insert' ? 'insert' : 'rewrite';
}

/**
 * How long the word-by-word comparison may run on the page's thread. Two
 * passages that share almost nothing (a table translated whole) take seconds
 * to compare, and past this the card shows the whole passage out and the
 * whole rewrite in.
 */
const DIFF_TIMEOUT_MS = 100;

/** What landing a proposal's body would leave out, once its Markdown is read. */
interface MediaLeftOut {
  /** How many media in it are not files in this project. */
  count: number;
  /** Whether anything else is left to write. */
  writable: boolean;
}

/**
 * How many media a rewrite or an insert would leave out when it lands, judged
 * by the rule a paste follows.
 * @param proposal - The proposal.
 * @returns The count, and whether anything else would be written.
 */
function useMediaLeftOut(proposal: DocumentProposal): MediaLeftOut {
  const [leftOut, setLeftOut] = React.useState<MediaLeftOut>({ count: 0, writable: true });
  React.useEffect(() => {
    if (proposal.kind === 'comment') return undefined;
    let live = true;
    void markdownBlocks(proposal.body).then((blocks) => {
      if (!live) return;
      const kept = ownMediaOnly(blocks.map((b) => b.block as WrittenBlock), ourMediaPrefix());
      setLeftOut({ count: kept.count, writable: kept.blocks.length > 0 });
    });
    return () => {
      live = false;
    };
  }, [proposal]);
  return leftOut;
}

/**
 * The rewritten passage's words set against the original's, once its
 * Markdown is read.
 * @param proposal - A rewrite.
 * @returns The changes, or null until they are worked out.
 */
function useRewriteChanges(proposal: DocumentProposal): Change[] | null {
  const [changes, setChanges] = React.useState<Change[] | null>(null);
  React.useEffect(() => {
    if (proposal.kind !== 'rewrite') return undefined;
    let live = true;
    void markdownBlocks(proposal.body).then((blocks) => {
      if (!live) return;
      const rewritten = blocks.map((b) => b.text).join('\n');
      const intlSegmenter = new Intl.Segmenter(getLocale(), { granularity: 'word' });
      setChanges(
        diffWords(proposal.original, rewritten, { intlSegmenter, timeout: DIFF_TIMEOUT_MS }) ?? [
          { value: proposal.original, removed: true, added: false, count: 0 },
          { value: rewritten, added: true, removed: false, count: 0 },
        ],
      );
    });
    return () => {
      live = false;
    };
  }, [proposal]);
  return changes;
}

/**
 * A card that lands an Agent's comment, rewrite or insert in a document
 * (inner#1509). It says which document and passage, what would change, and
 * offers the press; the project page opens the document and the document
 * Space lands it, then the card says how that ended.
 *
 * Whether it landed is read off the open document whenever the document
 * changes, so a reload knows too and an undo takes the card back; while the
 * document is open it is the truth, over what a press reported. Pressing
 * again checks the same thing first, so nothing lands twice; "View" only
 * shows where it is.
 * @param root0 - The component props.
 * @param root0.proposal - The edit the Agent proposed.
 * @returns The card.
 */
export const DocumentProposalCard = React.memo(function DocumentProposalCard({
  proposal,
}: DocumentProposalCardProps): React.JSX.Element {
  const t = useTranslation();
  const { projectId: routeParam = '' } = useParams<{ projectId: string }>();
  const projectId = projectUuidFromRouteParam(routeParam);
  const card = useDocumentProposals((s) => s.cards[proposal.proposalId]);
  const viewing = useDocumentProposals((s) => s.pending[proposal.proposalId]?.action === 'view');
  const docVersion = useDocumentProposals((s) => s.docVersion[proposal.spaceId] ?? 0);
  const start = useDocumentProposals((s) => s.start);
  const view = useDocumentProposals((s) => s.view);
  const changes = useRewriteChanges(proposal);
  const media = useMediaLeftOut(proposal);

  // Read again whenever the document changes or this card's press ends.
  const read = React.useMemo(() => {
    const handle = peekDocumentEditor(docName.documentSpace(projectId, proposal.spaceId));
    return handle === undefined ? { open: false, landed: null } : { open: true, landed: landedAt(handle, proposal)?.how ?? null };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the document or this card's state changes
  }, [projectId, proposal, docVersion, card?.state]);

  const working = card?.state === 'working';
  const reported = read.open && card?.state === 'applied' ? undefined : card?.state;
  const state: DocumentProposalCardState | 'idle' = working ? 'working' : read.landed !== null ? 'applied' : reported ?? 'idle';
  const action: LandingAction | undefined = !working && read.landed !== null ? read.landed : card?.action;

  const onComment = React.useCallback(() => {
    start(proposal, 'comment');
  }, [proposal, start]);
  const onWrite = React.useCallback(() => {
    start(proposal, 'write');
  }, [proposal, start]);
  const onView = React.useCallback(() => {
    view(proposal, action ?? 'write');
  }, [action, proposal, view]);

  const where = t(proposal.kind === 'insert' ? 'chat.documentProposal.whereInsert' : 'chat.documentProposal.where', {
    name: proposal.spaceName,
  });
  const place =
    proposal.kind === 'insert' && proposal.blockId === null ? t('chat.documentProposal.end') : proposal.heading;
  const held = state !== 'idle' && state !== 'failed';
  // A comment hangs on words; a block with none (an empty code block, an
  // image, a table of empty cells) has nowhere to put it.
  const commentable = proposal.kind !== 'insert' && hasWords(proposal.original);

  let status: string | null = null;
  if (state === 'applied' && action !== undefined) status = t(APPLIED_KEY[pressKind(proposal, action)]);
  else if (state === 'failed' && action !== undefined) status = t(FAILED_KEY[pressKind(proposal, action)]);
  else if (state !== 'idle' && state !== 'working' && state !== 'applied' && state !== 'failed') status = t(STATUS_KEY[state]);

  return (
    <div
      data-testid='document-proposal-card'
      data-state={state}
      className='mt-2 flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5'
    >
      <div className='text-sm font-semibold text-foreground'>{proposal.title}</div>
      <div data-testid='document-proposal-where' className='text-xs text-muted-foreground'>
        {place === '' ? where : `${where} · ${place}`}
      </div>
      {proposal.kind === 'comment' ? (
        <>
          <div
            data-testid='document-proposal-quote'
            className='line-clamp-2 border-l border-border pl-2 text-xs text-muted-foreground'
          >
            {proposal.quote}
          </div>
          <div className='whitespace-pre-wrap text-xs text-foreground'>{proposal.body}</div>
        </>
      ) : null}
      {proposal.kind === 'rewrite' ? (
        <div className='whitespace-pre-wrap rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground'>
          {(changes ?? [{ value: proposal.original, added: false, removed: false, count: 0 }]).map((part, i) =>
            part.removed ? (
              <del key={i} data-testid='document-proposal-removed' className='text-status-error line-through'>
                {part.value}
              </del>
            ) : part.added ? (
              <ins key={i} data-testid='document-proposal-added' className='text-status-success no-underline'>
                {part.value}
              </ins>
            ) : (
              <span key={i}>{part.value}</span>
            ),
          )}
        </div>
      ) : null}
      {proposal.kind === 'rewrite' && proposal.lossy ? (
        <div data-testid='document-proposal-lossy' className='text-xs text-muted-foreground'>
          {t('chat.documentProposal.lossy')}
        </div>
      ) : null}
      {proposal.kind === 'insert' && proposal.blockId !== null ? (
        <div className='flex flex-col gap-1'>
          <div data-testid='document-proposal-anchor-label' className='text-xs text-muted-foreground'>
            {t('chat.documentProposal.insertAfter')}
          </div>
          <div
            data-testid='document-proposal-anchor'
            className='line-clamp-2 border-l border-border pl-2 text-xs text-muted-foreground'
          >
            {hasWords(proposal.original)
              ? proposal.original
              : t(BLOCK_NAME_KEY[proposal.blockType ?? ''] ?? 'spaces.document.commands.paragraph')}
          </div>
        </div>
      ) : null}
      {proposal.kind === 'insert' ? (
        <div className='rounded-md border border-border bg-background px-2 py-1.5'>
          <MarkdownMessage content={proposal.body} size='xs' />
        </div>
      ) : null}
      {media.count > 0 ? (
        <div data-testid='document-proposal-media-left-out' className='text-xs text-muted-foreground'>
          {t('chat.documentProposal.mediaLeftOut', { count: media.count })}
        </div>
      ) : null}
      {status === null ? null : (
        <div
          data-testid='document-proposal-status'
          className={state === 'failed' ? 'text-xs text-status-error' : 'text-xs text-muted-foreground'}
        >
          {status}
        </div>
      )}
      {state === 'applied' ? (
        <Button
          type='button'
          variant='outline'
          size='sm'
          loading={viewing}
          onClick={onView}
          className='w-full max-w-[270px] self-center'
        >
          {t('chat.documentProposal.view')}
        </Button>
      ) : (
        <div className='flex w-full max-w-[270px] gap-2 self-center'>
          {commentable ? (
            <Button
              type='button'
              variant='outline'
              size='sm'
              loading={working && card?.action === 'comment'}
              disabled={held && !(working && card?.action === 'comment')}
              onClick={onComment}
              className='flex-1'
            >
              {t('chat.documentProposal.addComment')}
            </Button>
          ) : null}
          {proposal.kind === 'comment' || !media.writable ? null : (
            <Button
              type='button'
              variant='outline'
              size='sm'
              loading={working && card?.action === 'write'}
              disabled={held && !(working && card?.action === 'write')}
              onClick={onWrite}
              className='flex-1'
            >
              {t(proposal.kind === 'insert' ? 'chat.documentProposal.insert' : 'chat.documentProposal.apply')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
});
