import { logger } from '@librechat/data-schemas';
import { z } from 'zod';
import type { RequestHandler } from 'express';
import type { Fetch } from './client';
import type { ExodeAuthConfig } from './config';
import { getExodeAuthConfig, getExodeEmbedConfig } from './config';

/**
 * Frame-ancestors for the embedded chat, decided per request by asking exode.
 *
 * The chat cannot hold the allow-list itself: schools live on domains main assigns (or on
 * customers' own), and that set changes on onboarding, not on deploy. So the page is served
 * with `frame-ancestors 'self'` by default, widened to the embedding origin only after main
 * confirms a school lives there (`POST api/v2/auth/ai-chat/embed-origin`).
 *
 * This header is defense in depth, not the authorization boundary — that is the exchange,
 * which binds the one-shot bootstrap token to the school of `parentOrigin`. The CSP only
 * stops a hostile page from even rendering the chat shell before any token exists.
 */

const EMBED_ORIGIN_TIMEOUT_MS = 5_000;
const EMBED_ORIGIN_CACHE_TTL_MS = 60_000;
const EMBED_ORIGIN_CACHE_MAX = 500;

const embedOriginResponseSchema = z.object({
  payload: z.object({ allowed: z.boolean() }),
});

/**
 * Whether exode vouches for `origin` as a school site. Fail-closed: an unreachable or
 * malformed answer reads as "not allowed" — the page still renders standalone, and the
 * exchange (which needs main anyway) is down too, so nothing usable is lost.
 */
export async function checkExodeEmbedOrigin(
  origin: string,
  config: ExodeAuthConfig,
  fetcher: Fetch = fetch,
): Promise<boolean> {
  const endpoint = new URL('api/v2/auth/ai-chat/embed-origin', config.mainUrl).toString();

  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-id': config.serviceId,
        'x-service-secret': config.serviceSecret,
      },
      body: JSON.stringify({ origin }),
      signal: AbortSignal.timeout(EMBED_ORIGIN_TIMEOUT_MS),
    });

    if (!response.ok) {
      return false;
    }

    const parsed = embedOriginResponseSchema.safeParse(await response.json());
    return parsed.success && parsed.data.payload.allowed;
  } catch (error) {
    logger.error('[exodeEmbed] Could not verify the embed origin with Exode', {
      endpoint,
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Origin of the page that navigated the iframe, as the browser reported it — or null */
function refererOrigin(referer: string | undefined): string | null {
  if (!referer) {
    return null;
  }
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export interface ExodeFrameAncestorsDeps {
  fetcher?: Fetch;
  now?: () => number;
}

/**
 * Express middleware: sets `Content-Security-Policy: frame-ancestors` on document responses.
 *
 * Mounted app-wide (index.html is served from three places — `/index.html`, the static root
 * and the SPA fallback), so it first filters itself down to GET requests that can actually
 * be a document; API routes and hashed assets pass through untouched.
 *
 * - Integration disabled (standalone LibreChat) — no header, behavior unchanged.
 * - No usable `Referer`, or main does not know the origin — `'self'`: the app still works
 *   top-level and in same-origin frames, but a foreign page cannot embed it.
 * - Main confirms the origin — `'self' <origin>`.
 *
 * Verdicts are cached for a minute so one school page load costs one upstream call, not one
 * per asset-revalidating navigation; the cache is bounded and evicts oldest-first.
 */
export function createExodeFrameAncestorsMiddleware(
  deps: ExodeFrameAncestorsDeps = {},
): RequestHandler {
  const cache = new Map<string, { allowed: boolean; expiresAt: number }>();
  const now = deps.now ?? Date.now;

  return async (req, res, next) => {
    const isDocumentPath = !/\.(?!html$)[a-z0-9]+$/i.test(req.path) && !req.path.startsWith('/api/');

    if (req.method !== 'GET' || !isDocumentPath || !getExodeEmbedConfig().enabled) {
      return next();
    }

    const origin = refererOrigin(req.headers.referer);

    if (!origin || origin === `${req.protocol}://${req.get('host')}`) {
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      return next();
    }

    const cached = cache.get(origin);
    const allowed =
      cached && cached.expiresAt > now()
        ? cached.allowed
        : await checkExodeEmbedOrigin(origin, getExodeAuthConfig(), deps.fetcher);

    if (!cached || cached.expiresAt <= now()) {
      if (cache.size >= EMBED_ORIGIN_CACHE_MAX) {
        cache.delete(cache.keys().next().value as string);
      }
      cache.set(origin, { allowed, expiresAt: now() + EMBED_ORIGIN_CACHE_TTL_MS });
    }

    res.setHeader(
      'Content-Security-Policy',
      allowed ? `frame-ancestors 'self' ${origin}` : "frame-ancestors 'self'",
    );
    return next();
  };
}
