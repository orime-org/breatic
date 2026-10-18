// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Music, Play } from 'lucide-react';
import { ASK_USER_OTHER_MAX_CHARS, getLocale } from '@breatic/shared';
import type { AskUserAnswer, AskUserQuestion } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import { Input } from '@web/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import { ProposalAction, ProposalActions } from '@web/pages/project/chat/ProposalActions';
import type { ChatQuestionnaire } from '@web/pages/project/chat/types';
import { HoverPreview } from '@web/spaces/canvas/nodes/_shared/HoverPreview';

/** What the reader has given on one question so far. */
interface Given {
  /** The labels of the options picked. */
  selected: string[];
  /** What is on the question's Other line. */
  other: string;
}

/** Nothing given yet. */
const NOTHING: Given = { selected: [], other: '' };

interface QuestionnaireCardProps {
  /** The card and where it stands. */
  questionnaire: ChatQuestionnaire;
  /**
   * Send the answers; resolves when the turn they resume is over. Absent where
   * the card is only read, which leaves a waiting card with nothing to press.
   */
  onAnswer?: (toolCallId: string, answers: AskUserAnswer['answers']) => Promise<void>;
  /** A turn is running in the conversation; the press waits for it to end. */
  busy?: boolean;
}

/**
 * The answers worth sending: each question with a pick or words, in order.
 * @param given - What was given on each question.
 * @returns The answers, skipped questions left out.
 */
function answersOf(given: readonly Given[]): AskUserAnswer['answers'] {
  return given.flatMap((one, index) => {
    const other = one.other.trim();
    if (one.selected.length === 0 && other === '') return [];
    return [{ index, selected: one.selected, ...(other === '' ? {} : { other }) }];
  });
}

/**
 * A question's label, numbered as the card numbers it.
 * @param root0 - The component props.
 * @param root0.n - Its number, counting from 1.
 * @param root0.header - Its short label.
 * @returns The label.
 */
function QuestionLabel({ n, header }: { n: number; header: string }): React.JSX.Element {
  return (
    <span
      data-testid='questionnaire-question-label'
      className='whitespace-nowrap rounded-chrome-sm bg-accent px-1.5 text-xs text-muted-foreground'
    >
      {`${String(n)}. ${header}`}
    </span>
  );
}

/**
 * A questionnaire the agent put to the reader (inner#1542): numbered
 * questions answered by clicking or writing, one press to send them all.
 *
 * Answered, it reads as each question with its answer; replied to by a
 * message instead, it is one line that opens onto the questions, read-only.
 * @param root0 - The component props.
 * @param root0.questionnaire - The card and where it stands.
 * @param root0.onAnswer - Sends the answers.
 * @param root0.busy - A turn is running in the conversation.
 * @returns The card.
 */
export const QuestionnaireCard = React.memo(function QuestionnaireCard({
  questionnaire,
  onAnswer,
  busy = false,
}: QuestionnaireCardProps): React.JSX.Element {
  return (
    <div
      data-testid='questionnaire-card'
      className='mt-2 flex flex-col gap-3 rounded-overlay border border-border bg-popover px-3 py-2.5'
    >
      {questionnaire.state === 'awaiting' ? (
        <WaitingCard questionnaire={questionnaire} onAnswer={onAnswer} busy={busy} />
      ) : questionnaire.state === 'answered' ? (
        <AnsweredSummary questions={questionnaire.questions} answers={questionnaire.answers ?? []} />
      ) : (
        <RepliedLine questions={questionnaire.questions} />
      )}
    </div>
  );
});

/**
 * The card while it waits: every question to answer, and the press.
 * @param root0 - The component props.
 * @param root0.questionnaire - The card.
 * @param root0.onAnswer - Sends the answers.
 * @param root0.busy - A turn is running in the conversation.
 * @returns The questions and the press.
 */
function WaitingCard({ questionnaire, onAnswer, busy }: QuestionnaireCardProps): React.JSX.Element {
  const t = useTranslation();
  const { toolCallId, questions } = questionnaire;
  const [given, setGiven] = React.useState<Given[]>(() => questions.map(() => NOTHING));
  const [sending, setSending] = React.useState(false);
  const answers = React.useMemo(() => answersOf(given), [given]);
  const atLeastOne = t('chat.questionnaire.atLeastOne');

  const change = React.useCallback((index: number, next: Given) => {
    setGiven((all) => all.map((one, i) => (i === index ? next : one)));
  }, []);

  const submit = React.useCallback(async () => {
    if (answers.length === 0) {
      toast.warning(atLeastOne);
      return;
    }
    if (onAnswer === undefined) return;
    setSending(true);
    try {
      await onAnswer(toolCallId, answers);
    } finally {
      setSending(false);
    }
  }, [answers, atLeastOne, onAnswer, toolCallId]);

  return (
    <>
      {questions.map((question, index) => (
        <QuestionField
          key={`${String(index)}-${question.header}`}
          n={index + 1}
          question={question}
          given={given[index] ?? NOTHING}
          disabled={sending}
          onChange={(next) => change(index, next)}
        />
      ))}
      <div className='flex flex-col items-center gap-1.5'>
        <ProposalActions>
          <ProposalAction
            data-testid='questionnaire-submit'
            loading={sending || busy === true}
            aria-disabled={answers.length === 0 ? true : undefined}
            className={cn(answers.length === 0 && 'opacity-50')}
            onClick={() => void submit()}
          >
            {t('chat.questionnaire.submit')}
          </ProposalAction>
        </ProposalActions>
        <p data-testid='questionnaire-hint' className='text-center text-xs text-muted-foreground'>
          {t('chat.questionnaire.hint')}
        </p>
      </div>
    </>
  );
}

interface QuestionFieldProps {
  /** Its number, counting from 1. */
  n: number;
  /** The question. */
  question: AskUserQuestion;
  /** What has been given on it. */
  given: Given;
  /** Whether the answers are on their way, which holds everything still. */
  disabled: boolean;
  /** Called with what is given on it now. */
  onChange: (next: Given) => void;
}

/**
 * One question: its label and text, its options, and its Other line.
 *
 * On a question that takes one answer, a pick and words on the Other line
 * replace each other, and a second click on the pick lets go of it.
 * @param root0 - The component props.
 * @param root0.n - Its number.
 * @param root0.question - The question.
 * @param root0.given - What has been given.
 * @param root0.disabled - Whether everything is held still.
 * @param root0.onChange - Called with what is given now.
 * @returns The question's block.
 */
function QuestionField({ n, question, given, disabled, onChange }: QuestionFieldProps): React.JSX.Element {
  const t = useTranslation();
  const idBase = React.useId();
  const withMedia = question.options.some((option) => option.media !== undefined);

  /**
   * Pick or let go of one option.
   * @param label - The option's label.
   */
  const toggle = (label: string): void => {
    const picked = given.selected.includes(label);
    if (question.multiSelect) {
      onChange({ ...given, selected: picked ? given.selected.filter((l) => l !== label) : [...given.selected, label] });
      return;
    }
    onChange({ selected: picked ? [] : [label], other: picked ? given.other : '' });
  };

  /**
   * Take what is on the Other line now.
   * @param other - The line's text.
   */
  const write = (other: string): void => {
    onChange({ selected: !question.multiSelect && other.trim() !== '' ? [] : given.selected, other });
  };

  return (
    <div data-testid='questionnaire-question' className='flex flex-col gap-1.5'>
      <div className='flex flex-wrap items-baseline gap-x-1.5 gap-y-1'>
        <QuestionLabel n={n} header={question.header} />
        <span className='min-w-0 break-words text-sm font-medium text-foreground'>{question.question}</span>
        {question.multiSelect ? (
          <span className='text-xs text-muted-foreground'>{t('chat.questionnaire.multi')}</span>
        ) : null}
      </div>
      {withMedia && question.multiSelect ? (
        <div className='grid grid-cols-3 gap-1.5'>
          {question.options.map((option, i) => {
            const id = `${idBase}-${String(i)}`;
            return (
              <MediaTile key={option.label} id={id} option={option}>
                <Checkbox
                  id={id}
                  checked={given.selected.includes(option.label)}
                  disabled={disabled}
                  onCheckedChange={() => toggle(option.label)}
                />
              </MediaTile>
            );
          })}
        </div>
      ) : withMedia ? (
        <RadioGroup
          value={given.selected[0] ?? ''}
          disabled={disabled}
          onValueChange={(label) => toggle(label)}
          className='grid grid-cols-3 gap-1.5'
          aria-label={question.question}
        >
          {question.options.map((option, i) => {
            const id = `${idBase}-${String(i)}`;
            const picked = given.selected[0] === option.label;
            return (
              <MediaTile key={option.label} id={id} option={option}>
                <RadioGroupItem id={id} value={option.label} onClick={picked ? () => toggle(option.label) : undefined} />
              </MediaTile>
            );
          })}
        </RadioGroup>
      ) : question.multiSelect ? (
        <div className='flex flex-col gap-1'>
          {question.options.map((option, i) => {
            const id = `${idBase}-${String(i)}`;
            return (
              <OptionRow key={option.label} id={id} label={option.label} description={option.description}>
                <Checkbox
                  id={id}
                  checked={given.selected.includes(option.label)}
                  disabled={disabled}
                  onCheckedChange={() => toggle(option.label)}
                />
              </OptionRow>
            );
          })}
        </div>
      ) : question.options.length > 0 ? (
        <RadioGroup
          value={given.selected[0] ?? ''}
          disabled={disabled}
          onValueChange={(label) => toggle(label)}
          className='gap-1'
          aria-label={question.question}
        >
          {question.options.map((option, i) => {
            const id = `${idBase}-${String(i)}`;
            const picked = given.selected[0] === option.label;
            return (
              <OptionRow key={option.label} id={id} label={option.label} description={option.description}>
                {/* A click on the pick lets go of it: Radix keeps a checked
                    radio checked and says nothing, so the second click is
                    caught here. */}
                <RadioGroupItem id={id} value={option.label} onClick={picked ? () => toggle(option.label) : undefined} />
              </OptionRow>
            );
          })}
        </RadioGroup>
      ) : null}
      <Input
        value={given.other}
        disabled={disabled}
        maxLength={ASK_USER_OTHER_MAX_CHARS}
        autoComplete='off'
        placeholder={t('chat.questionnaire.other')}
        aria-label={`${String(n)}. ${question.header} ${t('chat.questionnaire.other')}`}
        onChange={(event) => write(event.target.value)}
        className='h-8 text-xs'
      />
    </div>
  );
}

/**
 * One option as a row: its control, then its label and description, the
 * whole row clickable through the label.
 * @param root0 - The component props.
 * @param root0.id - The control's id.
 * @param root0.label - The option's label.
 * @param root0.description - Its line of description, if any.
 * @param root0.children - The control.
 * @returns The row.
 */
function OptionRow({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className='flex items-start gap-2 rounded-chrome border border-border px-2 py-1.5'>
      <span className='mt-0.5 flex'>{children}</span>
      <label htmlFor={id} className='flex min-w-0 flex-1 cursor-pointer flex-col'>
        <span className='break-words text-sm text-foreground'>{label}</span>
        {description ? <span className='break-words text-xs text-muted-foreground'>{description}</span> : null}
      </label>
    </div>
  );
}

/**
 * An option shown by its picture, the cover of its clip, or the name of its
 * sound, with the full thing on hover; picked through the same control in
 * front of its name a text option has, the whole tile clickable through the
 * label.
 * @param root0 - The component props.
 * @param root0.id - The control's id.
 * @param root0.option - The option.
 * @param root0.children - The control.
 * @returns The tile.
 */
function MediaTile({
  id,
  option,
  children,
}: {
  id: string;
  option: AskUserQuestion['options'][number];
  children: React.ReactNode;
}): React.JSX.Element {
  const media = option.media;
  const still = media?.kind === 'image' ? media.url : media?.kind === 'video' ? media.poster : undefined;
  return (
    <label
      htmlFor={id}
      data-testid='questionnaire-tile'
      className='flex cursor-pointer flex-col overflow-hidden rounded-chrome border border-border'
    >
      {/* Opens upward: the chat column has no room on either side of it. */}
      <HoverPreview
        kind={media?.kind ?? 'image'}
        src={media?.url}
        poster={media?.kind === 'video' ? media.poster : undefined}
        alt={option.label}
        side='top'
      >
        {/* `overflow-hidden` lets the 4:3 box hold: a box whose overflow is
            visible grows to fit a taller picture. */}
        <span className='flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-accent text-muted-foreground'>
          {still ? (
            <img src={still} alt='' className='size-full object-cover' />
          ) : media?.kind === 'audio' ? (
            <Music className='size-5' aria-hidden='true' />
          ) : (
            <Play className='size-5' aria-hidden='true' />
          )}
        </span>
      </HoverPreview>
      <span className='flex min-w-0 items-center gap-1.5 px-1.5 py-1'>
        {children}
        <span className='min-w-0 flex-1 truncate text-xs text-foreground'>{option.label}</span>
      </span>
    </label>
  );
}

/**
 * The card once answered: each question with what was given, or that it was
 * skipped.
 * @param root0 - The component props.
 * @param root0.questions - The questions.
 * @param root0.answers - The answers given.
 * @returns The summary.
 */
function AnsweredSummary({
  questions,
  answers,
}: {
  questions: AskUserQuestion[];
  answers: AskUserAnswer['answers'];
}): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex flex-col gap-1'>
      {questions.map((question, index) => {
        const answer = answers.find((a) => a.index === index);
        const given = [...(answer?.selected ?? []), ...(answer?.other === undefined ? [] : [answer.other])];
        return (
          <div
            key={`${String(index)}-${question.header}`}
            data-testid='questionnaire-summary-row'
            className='flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm'
          >
            <QuestionLabel n={index + 1} header={question.header} />
            {given.length === 0 ? (
              <span data-testid='questionnaire-skipped' className='text-muted-foreground'>
                {t('chat.questionnaire.skipped')}
              </span>
            ) : (
              <span data-testid='questionnaire-answer' className='min-w-0 break-words text-foreground'>
                {new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(given)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The card once the reader wrote a message instead: one line, opening onto
 * the questions as they were asked, read-only.
 * @param root0 - The component props.
 * @param root0.questions - The questions.
 * @returns The line, and the questions when open.
 */
function RepliedLine({ questions }: { questions: AskUserQuestion[] }): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  return (
    <div className='flex flex-col gap-2'>
      <Button
        type='button'
        variant={null}
        size={null}
        data-testid='questionnaire-replied-toggle'
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className='flex w-full items-center justify-between text-left text-sm text-muted-foreground hover-enabled:text-foreground'
      >
        <span>{t('chat.questionnaire.replied')}</span>
        <span className='text-xs'>{open ? t('chat.questionnaire.hide') : t('chat.questionnaire.show')}</span>
      </Button>
      {open ? (
        <div data-testid='questionnaire-readonly' className='flex flex-col gap-1.5'>
          {questions.map((question, index) => (
            <div key={`${String(index)}-${question.header}`} className='flex flex-col gap-0.5'>
              <div className='flex flex-wrap items-baseline gap-x-1.5 gap-y-1'>
                <QuestionLabel n={index + 1} header={question.header} />
                <span className='min-w-0 break-words text-sm text-foreground'>{question.question}</span>
                {question.multiSelect ? (
                  <span className='text-xs text-muted-foreground'>{t('chat.questionnaire.multi')}</span>
                ) : null}
              </div>
              {question.options.length > 0 ? (
                <div className='flex flex-wrap gap-x-2 text-xs text-muted-foreground'>
                  {question.options.map((option) => (
                    <span key={option.label} className='min-w-0 break-words'>
                      {option.label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
