import { useLocation } from 'react-router-dom';
import { z } from 'zod';

export const EXODE_EMBED_QUERY = 'embed=exode';
export const EXODE_EMBED_PROTOCOL = 1 as const;

/**
 * In-page event AuthContext dispatches when the embedded session dies server-side (a 401 outside
 * the bridge's own refresh cycle — e.g. the timer was throttled in a background tab). The bridge
 * answers by opening a refresh handshake; without it the embed would just go blank.
 */
export const EXODE_SESSION_EXPIRED_EVENT = 'exode-ai-chat:session-expired';

const envelopeSchema = z.object({
  protocol: z.literal(EXODE_EMBED_PROTOCOL),
  source: z.literal('exode-host'),
  requestId: z.string().uuid(),
});

const authenticateSchema = envelopeSchema.extend({
  type: z.literal('exode-ai-chat:authenticate'),
  payload: z.object({
    token: z.string().min(16).max(16_384),
    handshakeId: z.string().uuid(),
  }),
});

const logoutSchema = envelopeSchema.extend({
  type: z.literal('exode-ai-chat:logout'),
  payload: z.object({}).optional(),
});

/** Only ever a CSS colour, and only from the host — never interpolated as markup. */
export const EXODE_ACCENT_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The host's colour scheme, pushed instead of being carried in the URL.
 *
 * The theme changes while the frame is alive — the user flips it in exode, or the school is
 * rebranded — and a query param would mean a new `src`, i.e. a reload that throws away the open
 * conversation. The initial values still ride in the URL (`?accent=`, `?scheme=`), because they
 * have to be known before first paint; everything after that arrives here.
 */
const themeSchema = envelopeSchema.extend({
  type: z.literal('exode-ai-chat:theme'),
  payload: z.object({
    scheme: z.enum(['light', 'dark']),
    accent: z.string().regex(EXODE_ACCENT_PATTERN).optional(),
  }),
});

export const exodeHostMessageSchema = z.discriminatedUnion('type', [
  authenticateSchema,
  logoutSchema,
  themeSchema,
]);

export type ExodeHostTheme = z.infer<typeof themeSchema>['payload'];

export type ExodeHostMessage = z.infer<typeof exodeHostMessageSchema>;

export interface ExodeBridgeMessage {
  protocol: typeof EXODE_EMBED_PROTOCOL;
  source: 'exode-ai-chat';
  type:
    | 'exode-ai-chat:ready'
    | 'exode-ai-chat:authenticated'
    | 'exode-ai-chat:refresh-required'
    | 'exode-ai-chat:error';
  requestId: string;
  payload: object;
}

export function isExodeEmbedLocation(pathname: string, search: string): boolean {
  if (pathname === '/embed/exode') {
    return true;
  }
  return new URLSearchParams(search).get('embed') === 'exode';
}

/**
 * Cross-origin access to `window.top` throws — and that can only happen inside a foreign frame,
 * so a throw counts as framed.
 */
function isEmbeddedFrame(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * The embed markers are only meaningful inside the host's iframe. A copy-pasted or crafted
 * `?embed=exode` URL opened in a normal tab must not latch embed mode — Login/Startup render
 * nothing for an unauthenticated embed, so latching would blank the credential UI for the whole
 * SPA session.
 */
export function shouldLatchExodeEmbed(pathname: string, search: string): boolean {
  return isEmbeddedFrame() && isExodeEmbedLocation(pathname, search);
}

/**
 * True once this page load has EVER been the exode embed.
 *
 * Sticky for the lifetime of the page load, mirroring `AuthLayout`'s latch
 * (routes/index.tsx). LibreChat's own navigation — opening a conversation from
 * the sidebar, starting a new chat — rewrites the URL without `?embed=exode`,
 * so a live read of the location would flip back to false mid-session and the
 * embed's chrome-free rendering would come undone. An embedded session stays
 * embedded until the iframe reloads; a normal page load never becomes one.
 */
let exodeEmbedLatch = false;

export function useIsExodeEmbed(): boolean {
  const location = useLocation();
  if (!exodeEmbedLatch && shouldLatchExodeEmbed(location.pathname, location.search)) {
    exodeEmbedLatch = true;
  }
  return exodeEmbedLatch;
}

/**
 * The `agent_id` Bridge.tsx wrote onto the URL after the initial handshake, latched for the
 * lifetime of the page load.
 *
 * Needed for the same reason as the embed latch above: once the user opens an existing
 * conversation from the sidebar, LibreChat navigates to `/c/<conversationId>` and the query
 * string is gone. Without latching, the sidebar's own agent filter would lose track of which
 * agent this embed is scoped to right as soon as a conversation from that same list is opened.
 */
let exodeAgentIdLatch: string | undefined;

export function useExodeAgentId(): string | undefined {
  const location = useLocation();
  if (exodeAgentIdLatch == null) {
    const agentId = new URLSearchParams(location.search).get('agent_id');
    if (agentId) {
      exodeAgentIdLatch = agentId;
    }
  }
  return exodeAgentIdLatch;
}

/** Test-only: latched module state needs resetting between cases, same as the embed latch. */
export function resetExodeAgentIdLatchForTests(): void {
  exodeAgentIdLatch = undefined;
}

/** Test-only: the latch is module state, so it survives between cases otherwise. */
export function resetExodeEmbedLatchForTests(): void {
  exodeEmbedLatch = false;
}

/** Which provisioned agent the host wants this frame to open */
export type ExodeAgentKind = 'knowledge' | 'assistant';

/**
 * Reads the requested agent from the embed URL.
 *
 * Carried in the URL rather than in a postMessage: the host already controls the iframe `src`,
 * and the value has to survive the bridge's own navigation to the conversation. Anything other
 * than the two known kinds falls back to `assistant` — the host must never be able to name an
 * arbitrary agent, since exode decides which ids this principal may actually open.
 */
export function getExodeAgentKind(search: string): ExodeAgentKind {
  return new URLSearchParams(search).get('agent') === 'knowledge' ? 'knowledge' : 'assistant';
}

/**
 * The kind latched from the first URL this page load saw, same pattern as the latches above.
 *
 * LibreChat's own navigation strips `?agent=` from the query, but which grant this frame holds
 * must never change mid-session — a knowledge frame re-reading the stripped URL on token refresh
 * would fall back to `assistant` and request the MCP-enabled grant it must not have.
 */
let exodeAgentKindLatch: ExodeAgentKind | undefined;

export function getLatchedExodeAgentKind(search: string): ExodeAgentKind {
  exodeAgentKindLatch ??= getExodeAgentKind(search);
  return exodeAgentKindLatch;
}

/** Test-only: latched module state needs resetting between cases, same as the latches above. */
export function resetExodeAgentKindLatchForTests(): void {
  exodeAgentKindLatch = undefined;
}
