import { useContext, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeContext } from '@librechat/client';
import type { ReactNode } from 'react';
import type { TExodeExchangeResponse } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { useExodeExchangeMutation, useExodeEmbedConfigQuery } from '~/data-provider/Auth';
import { applyExodeAccent } from './useExodeTheme';
import {
  EXODE_EMBED_PROTOCOL,
  EXODE_SESSION_EXPIRED_EVENT,
  exodeHostMessageSchema,
  getLatchedExodeAgentKind,
  type ExodeBridgeMessage,
} from './protocol';

interface ExodeBridgeProps {
  children: ReactNode;
}

interface Handshake {
  handshakeId: string;
  requestId: string;
  /** False for a token refresh, which must not navigate away from the open conversation */
  initial: boolean;
}

interface BrowserSafeError {
  code: string;
  retryable: boolean;
}

const KNOWN_ERROR_CODES = new Set([
  'INVALID_HANDSHAKE',
  'BOOTSTRAP_INVALID',
  'AI_CHAT_FORBIDDEN',
  'AI_CHAT_LIMIT',
  'EXODE_UNAVAILABLE',
  'IDENTITY_CONFLICT',
  'INTERNAL_ERROR',
]);

function getBrowserSafeError(error: unknown): BrowserSafeError {
  if (typeof error !== 'object' || error === null || !('response' in error)) {
    return { code: 'EXODE_UNAVAILABLE', retryable: true };
  }

  const response = (error as { response?: { status?: number; data?: { code?: string } } }).response;
  const code = response?.data?.code;
  const safeCode = code && KNOWN_ERROR_CODES.has(code) ? code : 'EXODE_UNAVAILABLE';
  const retryable = response?.status === 429 || (response?.status ?? 500) >= 500;
  return { code: safeCode, retryable };
}

/**
 * Renew ahead of expiry, but never spend more than half the lifetime on the lead: with a short
 * configured TTL a fixed lead would land in the past and turn refresh into a once-a-second loop.
 */
function getRefreshAt(expiresAt: string, lead: number): number {
  const expiry = Date.parse(expiresAt);
  return expiry - Math.min(lead, Math.floor((expiry - Date.now()) / 2));
}

function getRefreshDelay(session: TExodeExchangeResponse): number {
  const tokenRefreshAt = getRefreshAt(session.tokenExpiresAt, 90_000);
  const mcpRefreshAt = getRefreshAt(session.mcpExpiresAt, 120_000);
  return Math.max(1_000, Math.min(tokenRefreshAt, mcpRefreshAt) - Date.now());
}

/**
 * Back off on every consecutive failure instead of retrying at a fixed interval.
 *
 * The exchange is rate limited, and a limiter counts the requests it rejects — so a steady retry
 * keeps the window topped up and the frame never recovers within it. Doubling from 5s to a
 * 5-minute ceiling lets the window drain, and the delay resets the moment a handshake succeeds.
 */
const HANDSHAKE_RETRY_BASE_MS = 5_000;
const HANDSHAKE_RETRY_MAX_MS = 300_000;

function getHandshakeRetryDelay(attempt: number): number {
  return Math.min(HANDSHAKE_RETRY_BASE_MS * 2 ** attempt, HANDSHAKE_RETRY_MAX_MS);
}

export default function ExodeBridge({ children }: ExodeBridgeProps) {
  const navigate = useNavigate();
  const { setTheme } = useContext(ThemeContext);
  const { data: config } = useExodeEmbedConfigQuery();
  const { mutateAsync: exchange } = useExodeExchangeMutation();
  const { acceptExternalSession, clearExternalSession } = useAuthContext();

  useEffect(() => {
    if (config?.enabled !== true || config.protocol !== EXODE_EMBED_PROTOCOL) {
      return;
    }

    let activeOrigin: string | undefined;
    let currentHandshake: Handshake | undefined;
    let refreshTimer: number | undefined;
    let retryTimer: number | undefined;
    let refreshDueAt: number | undefined;
    let failedAttempts = 0;
    let exchangeInFlight = false;

    /**
     * Broadcast until a handshake pins the parent down, then address it exactly.
     *
     * The chat does not know which host framed it — school domains live in main and change on
     * onboarding, not on deploy — so the opening `ready` has nowhere specific to go. Safe to
     * broadcast because nothing the bridge sends outward is a secret: a freshly minted handshake
     * id, and error codes. Everything that matters travels the other way, and the bootstrap
     * token answering it is single-use and bound to that handshake id.
     */
    const post = (message: ExodeBridgeMessage, origin?: string) => {
      window.parent.postMessage(message, origin ?? activeOrigin ?? '*');
    };

    const beginHandshake = (type: 'exode-ai-chat:ready' | 'exode-ai-chat:refresh-required') => {
      currentHandshake = {
        handshakeId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        initial: type === 'exode-ai-chat:ready',
      };
      post(
        {
          protocol: EXODE_EMBED_PROTOCOL,
          source: 'exode-ai-chat',
          type,
          requestId: currentHandshake.requestId,
          payload: { handshakeId: currentHandshake.handshakeId },
        },
        activeOrigin,
      );
    };

    /**
     * A failed exchange consumed the open handshake, and the host only ever authenticates in
     * response to a bridge message — without a new handshake a transient failure would leave the
     * frame unauthenticated until a full iframe reload.
     */
    const scheduleHandshakeRetry = (initial: boolean) => {
      if (retryTimer != null) {
        window.clearTimeout(retryTimer);
      }
      const delay = getHandshakeRetryDelay(failedAttempts);
      failedAttempts += 1;
      retryTimer = window.setTimeout(
        () => beginHandshake(initial ? 'exode-ai-chat:ready' : 'exode-ai-chat:refresh-required'),
        delay,
      );
    };

    const scheduleRefresh = (session: TExodeExchangeResponse) => {
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      const delay = getRefreshDelay(session);
      refreshDueAt = Date.now() + delay;
      refreshTimer = window.setTimeout(
        () => beginHandshake('exode-ai-chat:refresh-required'),
        delay,
      );
    };

    /** AuthContext saw a 401 the refresh cycle missed — ask the host for a fresh token now */
    const handleSessionExpired = () => {
      if (exchangeInFlight) {
        return;
      }
      beginHandshake('exode-ai-chat:refresh-required');
    };

    /**
     * Background tabs throttle timers, so a due refresh may never have fired while hidden.
     * Catch up the moment the tab becomes visible, before the stale token starts failing calls.
     */
    const handleVisibilityChange = () => {
      if (
        document.visibilityState !== 'visible' ||
        exchangeInFlight ||
        currentHandshake != null ||
        refreshDueAt == null ||
        Date.now() < refreshDueAt
      ) {
        return;
      }
      beginHandshake('exode-ai-chat:refresh-required');
    };

    /**
     * The framing page is the only accepted sender; which page that is, main decides.
     *
     * There is no origin allow-list to check against — it would have to enumerate every school
     * domain — so the gate is the bootstrap token the host answers with: minted by main for a
     * signed-in exode session, valid once, and tied to the handshake id issued just above. A
     * stranger who frames the chat can talk to this listener and still establish nothing.
     */
    const handleMessage = async (event: MessageEvent) => {
      if (event.source !== window.parent) {
        return;
      }

      const parsed = exodeHostMessageSchema.safeParse(event.data);
      if (!parsed.success) {
        return;
      }

      const message = parsed.data;
      if (message.type === 'exode-ai-chat:theme') {
        /**
         * Persisted through ThemeProvider rather than by toggling the class directly: its own
         * effect re-applies the class from state, so a direct toggle would be undone by the next
         * render. Writing `color-theme` also fixes the reload flash — the pre-React bootstrap in
         * index.html reads that key, so a dark host no longer flashes light on refresh.
         */
        setTheme(message.payload.scheme);
        applyExodeAccent(message.payload.accent);
        return;
      }

      if (message.type === 'exode-ai-chat:logout') {
        if (refreshTimer != null) {
          window.clearTimeout(refreshTimer);
        }
        if (retryTimer != null) {
          window.clearTimeout(retryTimer);
        }
        currentHandshake = undefined;
        refreshDueAt = undefined;
        exchangeInFlight = false;
        clearExternalSession();
        return;
      }

      const handshake = currentHandshake;
      if (
        exchangeInFlight ||
        !handshake ||
        message.requestId !== handshake.requestId ||
        message.payload.handshakeId !== handshake.handshakeId
      ) {
        return;
      }

      exchangeInFlight = true;
      activeOrigin = event.origin;
      try {
        /**
         * The requested kind goes with the exchange, so exode returns exactly one agent id.
         * Asking for both and choosing here would let the knowledge frame open the assistant.
         */
        const kind =
          getLatchedExodeAgentKind(window.location.search) === 'knowledge'
            ? 'Knowledge'
            : 'Assistant';

        const session = await exchange({
          kind,
          token: message.payload.token,
          handshakeId: handshake.handshakeId,
          parentOrigin: event.origin,
        });
        if (currentHandshake !== handshake) {
          return;
        }
        currentHandshake = undefined;
        failedAttempts = 0;
        acceptExternalSession(session);
        scheduleRefresh(session);

        /**
         * Open the agent exode provisioned for this principal.
         *
         * Only done on the initial handshake: a refresh renews the token mid-conversation, and
         * navigating then would throw the user back to an empty chat.
         */
        const agentId = session.agents?.[getLatchedExodeAgentKind(window.location.search)];

        if (agentId != null && agentId !== '' && handshake.initial) {
          const params = new URLSearchParams(window.location.search);

          if (params.get('agent_id') !== agentId) {
            params.set('agent_id', agentId);
            navigate(`/c/new?${params.toString()}`, { replace: true });
          }
        }
        post(
          {
            protocol: EXODE_EMBED_PROTOCOL,
            source: 'exode-ai-chat',
            type: 'exode-ai-chat:authenticated',
            requestId: message.requestId,
            payload: {},
          },
          event.origin,
        );
      } catch (error) {
        const safeError = getBrowserSafeError(error);
        currentHandshake = undefined;
        post(
          {
            protocol: EXODE_EMBED_PROTOCOL,
            source: 'exode-ai-chat',
            type: 'exode-ai-chat:error',
            requestId: message.requestId,
            payload: safeError,
          },
          event.origin,
        );
        if (safeError.retryable) {
          scheduleHandshakeRetry(handshake.initial);
        }
      } finally {
        exchangeInFlight = false;
      }
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener(EXODE_SESSION_EXPIRED_EVENT, handleSessionExpired);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    beginHandshake('exode-ai-chat:ready');

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener(EXODE_SESSION_EXPIRED_EVENT, handleSessionExpired);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      if (retryTimer != null) {
        window.clearTimeout(retryTimer);
      }
      clearExternalSession();
    };
  }, [acceptExternalSession, clearExternalSession, config, exchange, navigate, setTheme]);

  return children;
}
