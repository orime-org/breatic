interface TweaksLike {
  textScale: number;
  saturation: number;
  hue: number;
  radius: 'sharp' | 'round';
  neutrals: 'warm-zinc' | 'cool-slate';
}

const RADIUS_PX: Record<TweaksLike['radius'], string> = {
  sharp: '2px',
  round: '8px',
};

const NEUTRALS_HUE: Record<TweaksLike['neutrals'], string> = {
  'warm-zinc': '30',
  'cool-slate': '215',
};

/**
 * Inject Direction B tweak values into runtime CSS custom properties on
 * `:root`. Shadcn primitives + content surfaces read these vars, so a
 * tweak change instantly re-paints without a re-render of subscribing
 * components.
 *
 * `--radius-chrome` is held fixed at 6px to keep the chrome calm; only
 * the content-facing `--radius-content-*` follow the tweak.
 */
export function applyTweaks(t: TweaksLike): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--tweak-text-scale', `${t.textScale}px`);
  root.style.setProperty('--tweak-saturation', `${t.saturation}%`);
  root.style.setProperty('--tweak-hue', `${t.hue}deg`);
  root.style.setProperty('--radius-content', RADIUS_PX[t.radius]);
  root.style.setProperty('--neutrals-hue', NEUTRALS_HUE[t.neutrals]);
}
