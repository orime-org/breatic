/**
 * Studio page — V13 greenfield M0 minimal placeholder.
 *
 * Full Studio rewrite is deferred to a separate long branch (post-M4).
 * This page exists only so the route `/workspace` resolves and the
 * tester can hop into a project to exercise the M0-M4 Project rewrite.
 *
 * No live project list yet — the user-supplied projectId in the form
 * navigates directly. The real Studio (project gallery, search, etc.)
 * comes later.
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export default function StudioPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState('');

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = projectId.trim();
    if (trimmed) {
      navigate(`/project/${trimmed}`);
    }
  }

  return (
    <div className='flex h-screen items-center justify-center bg-background text-foreground'>
      <div className='w-full max-w-md px-6 text-center'>
        <h1 className='mb-3 text-2xl font-semibold'>
          {t('studio.placeholder.title')}
        </h1>
        <p className='mb-6 text-sm text-muted-foreground'>
          {t('studio.placeholder.subtitle')}
        </p>
        <form onSubmit={handleSubmit} className='flex gap-2'>
          <input
            type='text'
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder={t('studio.placeholder.projectIdInput')}
            className='flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          />
          <Button type='submit' disabled={!projectId.trim()}>
            {t('studio.placeholder.openProject')}
          </Button>
        </form>
      </div>
    </div>
  );
}
