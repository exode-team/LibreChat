import { useEffect } from 'react';
import { EXODE_ACCENT_PATTERN, useIsExodeEmbed } from './protocol';

/**
 * Applies the school's accent to the embedded chat.
 *
 * Exported because the bridge repeats it on every `exode-ai-chat:theme` push: the accent is
 * per-school and can change while the frame is alive, and it lives in an inline variable rather
 * than in `exode-theme.css`, which only carries the default.
 */
export function applyExodeAccent(accent: string | null | undefined): void {
  if (accent != null && EXODE_ACCENT_PATTERN.test(accent)) {
    document.documentElement.style.setProperty('--exode-accent', accent);
  }
}

/**
 * Applies exode's design tokens to the embedded chat.
 *
 * Sets `data-exode-embed` on <html>, which is the scope `exode-theme.css` hangs
 * off — standalone LibreChat never gets the attribute and keeps its own palette.
 *
 * The accent is per-school (exode applies it at runtime from
 * `SchoolStore.preferences.colorVariables`), so it cannot live in the stylesheet:
 * the host forwards it as `?accent=%23fa6c1c` and it is set as an inline
 * variable here. Anything that is not a plain hex colour is ignored, leaving the
 * stylesheet's default. Later changes arrive over the bridge, not in the URL.
 */
export function useExodeTheme(): void {
  const isExodeEmbed = useIsExodeEmbed();

  useEffect(() => {
    if (!isExodeEmbed) {
      return;
    }

    document.documentElement.setAttribute('data-exode-embed', '');

    applyExodeAccent(new URLSearchParams(window.location.search).get('accent'));

    /* No cleanup that removes the attribute: the latch means an embedded page
       stays embedded for its whole life, and tearing the theme down on an
       internal navigation would flash LibreChat's palette mid-session. */
  }, [isExodeEmbed]);
}
