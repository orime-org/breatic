import type * as React from 'react';
import { Home, FolderOpen, Users, Settings as SettingsIcon } from 'lucide-react';

import { cn } from '@web/lib/utils';

export type StudioSection = 'home' | 'assets' | 'team' | 'settings';

interface StudioNavItem {
  key: StudioSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
}

const NAV_ITEMS: StudioNavItem[] = [
  { key: 'home', label: 'Projects', icon: Home },
  { key: 'assets', label: 'Assets', icon: FolderOpen, disabled: true },
  { key: 'team', label: 'Team', icon: Users, disabled: true },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
];

interface StudioNavProps {
  active: StudioSection;
  onChange: (section: StudioSection) => void;
}

/**
 * Studio left navigation — 4 items, 2 disabled in V1.
 *
 * V1 surfaces only Projects (Home) and Settings. Assets and Team are
 * disabled placeholders (filled in V2). The active item gets a
 * `bg-muted text-foreground` row; disabled items get `opacity-50`.
 * @param root0 - component props
 * @param root0.active - the currently active section, highlighted in the nav
 * @param root0.onChange - called with the chosen section when an enabled item is clicked
 * @returns the studio left navigation list.
 */
export function StudioNav({ active, onChange }: StudioNavProps): React.JSX.Element {
  return (
    <nav className='flex h-full w-56 flex-col gap-1 border-r border-border bg-card p-3'>
      <div className='mb-2 px-2 text-sm font-semibold tracking-tight'>
        breatic
      </div>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.key;
        return (
          <button
            key={item.key}
            type='button'
            disabled={item.disabled}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => !item.disabled && onChange(item.key)}
            className={cn(
              'inline-flex w-full items-center gap-2 rounded-chrome px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              item.disabled && 'pointer-events-none opacity-50',
            )}
          >
            <Icon className='h-4 w-4' />
            <span>{item.label}</span>
            {item.disabled && (
              <span className='ml-auto text-[10px] uppercase tracking-wider text-muted-foreground'>
                soon
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
