import { useMediaQuery } from '@librechat/client';
import { useIsExodeEmbed } from './protocol';

/**
 * Whether to lay out for a small screen — never in the exode embed.
 *
 * A media query measures the iframe document, not the outer window, and the embed's frame is a
 * fraction of the host page (the assistant panel is ~450px). So a desktop user trips
 * `(max-width: 768px)` and gets the mobile layout inside the panel: a `position: fixed`
 * slide-over drawer, the icon rail the embed deliberately hides, and — worst of all — the chat
 * column shifted right by `translateX(min(85vw, 380px))` and marked `inert`, which left the
 * embed looking like the chat had flown off the right edge and stopped accepting input.
 *
 * The embed always takes the desktop path; its own chrome is already sized for a narrow frame.
 */
export function useIsSmallScreen(): boolean {
  const isSmallViewport = useMediaQuery('(max-width: 768px)');
  const isExodeEmbed = useIsExodeEmbed();
  return isExodeEmbed ? false : isSmallViewport;
}
