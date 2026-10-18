// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { ChevronDown, ChevronUp, Music, Play } from 'lucide-react';
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
import { QuestionnaireAnswerContext } from '@web/pages/project/chat/questionnaire-answer';
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
 * @param root0.className - Where it sits in its parent's layout.
 * @returns The label.
 */
function QuestionLabel({ n, header, className }: { n: number; header: string; className?: string }): React.JSX.Element {
  return (
    <span
      data-testid='questionnaire-question-label'
      className={cn('whitespace-nowrap rounded-chrome-sm bg-accent px-1.5 text-xs text-muted-foreground', className)}
    >
      {`${String(n)}. ${header}`}
    </span>
  );
}

/**
 * A question's heading: its numbered label, its text, and whether it takes
 * several answers.
 * @param root0 - The component props.
 * @param root0.n - Its number, counting from 1.
 * @param root0.question - The question.
 * @param root0.readOnly - It is a record of what was asked, quieter than a question waiting.
 * @returns The heading row.
 */
function QuestionHeading({
  n,
  question,
  readOnly = false,
}: {
  n: number;
  question: AskUserQuestion;
  readOnly?: boolean;
}): React.JSX.Element {
  const t = useTranslation();
  // The label holds the left edge and a long question wraps beside it, so
  // every heading on the card starts the same way.
  return (
    <div className='flex items-baseline gap-1.5'>
      <QuestionLabel n={n} header={question.header} className='flex-none' />
      <span
        className={cn(
          'min-w-0 break-words text-sm',
          readOnly ? 'text-muted-foreground' : 'font-medium text-foreground',
        )}
      >
        {question.question}
      </span>
      {question.multiSelect ? (
        <span className='flex-none text-xs text-muted-foreground'>{t('chat.questionnaire.multi')}</span>
      ) : null}
    </div>
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
 * @returns The card.
 */
export const QuestionnaireCard = React.memo(function QuestionnaireCard({
  questionnaire,
}: QuestionnaireCardProps): React.JSX.Element {
  return (
    <div
      data-testid='questionnaire-card'
      className='mt-2 flex flex-col gap-3 rounded-overlay border border-border bg-popover px-3 py-2.5'
    >
      {questionnaire.state === 'awaiting' ? (
        <WaitingCard questionnaire={questionnaire} />
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
 *
 * Where the answers go and whether a turn is running come from the panel's
 * context, read here, the one place that uses them: a message drawn outside
 * a panel has nowhere to send and only reads.
 * @param root0 - The component props.
 * @param root0.questionnaire - The card.
 * @returns The questions and the press.
 */
function WaitingCard({ questionnaire }: QuestionnaireCardProps): React.JSX.Element {
  const t = useTranslation();
  const answering = React.useContext(QuestionnaireAnswerContext);
  const onAnswer = answering?.answer;
  const busy = answering?.busy === true;
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
            loading={sending || busy}
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

  // With no options to pick from, the line is the answer itself, not "other".
  const ownWords = t(question.options.length === 0 ? 'chat.questionnaire.ownWords' : 'chat.questionnaire.other');
  const Item = withMedia ? MediaTile : OptionRow;
  const layout = withMedia ? 'grid grid-cols-3 gap-1.5' : 'flex flex-col gap-1';
  const items = question.options.map((option, i) => {
    const id = `${idBase}-${String(i)}`;
    return (
      <Item key={option.label} id={id} option={option} picked={given.selected.includes(option.label)}>
        {question.multiSelect ? (
          <Checkbox
            id={id}
            checked={given.selected.includes(option.label)}
            disabled={disabled}
            onCheckedChange={() => toggle(option.label)}
          />
        ) : (
          // A click on the pick lets go of it: Radix keeps a checked radio
          // checked and says nothing, so the second click is caught here.
          <RadioGroupItem
            id={id}
            value={option.label}
            onClick={given.selected[0] === option.label ? () => toggle(option.label) : undefined}
          />
        )}
      </Item>
    );
  });

  return (
    <div data-testid='questionnaire-question' className='flex flex-col gap-1.5'>
      <QuestionHeading n={n} question={question} />
      {question.options.length === 0 ? null : question.multiSelect ? (
        <div className={layout}>{items}</div>
      ) : (
        <RadioGroup
          value={given.selected[0] ?? ''}
          disabled={disabled}
          onValueChange={(label) => toggle(label)}
          className={withMedia ? layout : 'gap-1'}
          aria-label={question.question}
        >
          {items}
        </RadioGroup>
      )}
      <Input
        value={given.other}
        disabled={disabled}
        maxLength={ASK_USER_OTHER_MAX_CHARS}
        autoComplete='off'
        placeholder={ownWords}
        aria-label={`${String(n)}. ${question.header} ${ownWords}`}
        onChange={(event) => write(event.target.value)}
        className='h-8 text-xs'
      />
    </div>
  );
}

/**
 * One option as a row: its control, then its label and description, the
 * whole box clickable through the label; a picked one is drawn as picked.
 * @param root0 - The component props.
 * @param root0.id - The control's id.
 * @param root0.option - The option.
 * @param root0.picked - Whether it is picked.
 * @param root0.children - The control.
 * @returns The row.
 */
function OptionRow({
  id,
  option,
  picked,
  children,
}: {
  id: string;
  option: AskUserQuestion['options'][number];
  picked: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { label, description } = option;
  return (
    <label
      htmlFor={id}
      data-testid='questionnaire-option'
      data-picked={picked}
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-chrome border border-border px-2 py-1.5',
        // The same picked look a tile has; no fill, which would take the
        // grey description below 4.5:1.
        picked && 'border-active-border',
      )}
    >
      <span className='mt-0.5 flex'>{children}</span>
      <span className='flex min-w-0 flex-1 flex-col'>
        <span className='break-words text-sm text-foreground'>{label}</span>
        {description ? <span className='break-words text-xs text-muted-foreground'>{description}</span> : null}
      </span>
    </label>
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
 * @param root0.picked - Whether it is picked.
 * @param root0.children - The control.
 * @returns The tile.
 */
function MediaTile({
  id,
  option,
  picked,
  children,
}: {
  id: string;
  option: AskUserQuestion['options'][number];
  picked: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const media = option.media;
  const still = media?.kind === 'image' ? media.url : media?.kind === 'video' ? media.poster : undefined;
  return (
    <label
      htmlFor={id}
      data-testid='questionnaire-tile'
      data-picked={picked}
      className={cn(
        'flex cursor-pointer flex-col overflow-hidden rounded-chrome border border-border',
        picked && 'border-active-border',
      )}
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
      {/* The whole name, wrapped: the end of it is often what tells two
          pictures apart. Tiles in a row stretch to the tallest. */}
      <span className='flex min-w-0 items-start gap-1.5 px-1.5 py-1'>
        {children}
        <span className='min-w-0 flex-1 break-words text-xs text-foreground'>{option.label}</span>
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
      <p data-testid='questionnaire-summary-title' className='text-xs text-muted-foreground'>
        {t('chat.questionnaire.yourAnswers')}
      </p>
      {/* Labels in one column and answers lined up in the next, read down as
          question then answer. */}
      <div className='grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1 text-sm'>
        {questions.map((question, index) => {
          const answer = answers.find((a) => a.index === index);
          const given = [...(answer?.selected ?? []), ...(answer?.other === undefined ? [] : [answer.other])];
          return (
            <div
              key={`${String(index)}-${question.header}`}
              data-testid='questionnaire-summary-row'
              className='contents'
            >
              <QuestionLabel n={index + 1} header={question.header} className='justify-self-start' />
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
        <span className='inline-flex items-center gap-0.5 text-xs'>
          {open ? t('chat.questionnaire.hide') : t('chat.questionnaire.show')}
          {open ? <ChevronUp className='size-3' aria-hidden='true' /> : <ChevronDown className='size-3' aria-hidden='true' />}
        </span>
      </Button>
      {open ? (
        <div data-testid='questionnaire-readonly' className='flex flex-col gap-1.5'>
          {questions.map((question, index) => (
            <div key={`${String(index)}-${question.header}`} className='flex flex-col gap-0.5'>
              <QuestionHeading n={index + 1} question={question} readOnly />
              {question.options.length > 0 ? (
                <div data-testid='questionnaire-readonly-options' className='break-words text-xs text-muted-foreground'>
                  {question.options.map((option) => option.label).join(' · ')}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
