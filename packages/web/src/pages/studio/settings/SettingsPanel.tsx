import { useCurrentUserStore } from '@/stores';

/**
 * Settings panel placeholder — V1 surfaces only the viewer's identity. Tabs
 * for profile / credits / billing land in a later PR.
 */
export function SettingsPanel() {
  const user = useCurrentUserStore((s) => s.user);
  return (
    <div className='mx-auto flex max-w-2xl flex-col gap-4'>
      <header>
        <h1 className='text-xl font-semibold'>Settings</h1>
        <p className='text-sm text-muted-foreground'>
          Profile, credits and billing arrive in a later PR.
        </p>
      </header>

      <section className='rounded-lg border border-border bg-card p-5 text-card-foreground'>
        <h2 className='text-sm font-medium'>Current user</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          {user ? (
            <>
              <strong className='text-foreground'>{user.name}</strong> · {user.email}
            </>
          ) : (
            'Not signed in.'
          )}
        </p>
      </section>
    </div>
  );
}
