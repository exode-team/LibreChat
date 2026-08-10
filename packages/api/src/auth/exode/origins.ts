import { logger } from '@librechat/data-schemas';
import { isAllowedExodeOrigin } from 'librechat-data-provider';

import { getExodeAuthConfig, getExodeEmbedConfig } from './config';
import type { ExodeAuthConfig } from './config';
import type { Fetch } from './client';

/**
 * Is this origin allowed to embed the chat?
 *
 * `EXODE_EMBED_ORIGINS` alone cannot answer that. Schools live on domains exode assigns — a base
 * `*.exode.biz` subdomain for most, the customer's own domain for the rest — and that set grows
 * when a school is onboarded, not when this service is deployed. So an origin the env does not
 * list is referred to main, which owns the mapping.
 *
 * The env list stays as the fast path and as the offline answer: if main is unreachable, the
 * configured origins still work and everything else is refused, which is exactly the behaviour
 * from before this lookup existed.
 */

/** Long enough that a busy school costs one call per window, short enough to follow a rename */
const POSITIVE_TTL_MS = 5 * 60 * 1000;

/**
 * Much shorter than a positive answer: a school onboarded a minute ago should not stay locked
 * out for the whole window, and a hostile origin is cheap to re-ask.
 */
const NEGATIVE_TTL_MS = 60 * 1000;

/** Any caller can put an arbitrary origin in a Referer, so the cache needs a ceiling */
const MAX_ENTRIES = 1_000;

interface CacheEntry {
  allowed: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function readCache(origin: string, now: number): boolean | undefined {
  const entry = cache.get(origin);

  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= now) {
    cache.delete(origin);
    return undefined;
  }

  return entry.allowed;
}

function writeCache(origin: string, allowed: boolean, now: number): void {
  /** Wholesale clear rather than LRU bookkeeping: the miss costs one request, and this is a cache */
  if (cache.size >= MAX_ENTRIES) {
    cache.clear();
  }

  cache.set(origin, {
    allowed,
    expiresAt: now + (allowed ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

/** Exported for tests — module state would otherwise leak between cases */
export function clearExodeOriginCache(): void {
  cache.clear();
}

async function askMain(
  origin: string,
  config: ExodeAuthConfig,
  fetcher: Fetch,
): Promise<boolean | undefined> {
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
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as { allowed?: unknown };

    return typeof body?.allowed === 'boolean' ? body.allowed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `origin` may embed the chat, consulting main for anything the env does not already
 * cover. An unreachable or malformed answer from main is treated as "not allowed" — the caller
 * cannot tell that apart from a genuine refusal, which is the safe way round.
 */
export async function isEmbeddableExodeOrigin(
  origin: string,
  config: ExodeAuthConfig,
  fetcher: Fetch = fetch,
  now: number = Date.now(),
): Promise<boolean> {
  if (isAllowedExodeOrigin(origin, config.allowedOrigins)) {
    return true;
  }

  const cached = readCache(origin, now);

  if (cached !== undefined) {
    return cached;
  }

  const answer = await askMain(origin, config, fetcher);

  if (answer === undefined) {
    logger.warn(`[exodeOrigins] Could not resolve '${origin}' with main; refusing the embed`);
    return false;
  }

  writeCache(origin, answer, now);

  return answer;
}

/**
 * The `frame-ancestors` list for one embed response.
 *
 * The configured origins are always present; the referring page is added when main recognises it,
 * which is what lets a school on its own domain frame the chat without anyone editing env. The
 * referrer is the only hint available at render time — no token has been presented yet — and it
 * is never trusted on its own: it is merely the candidate this asks main about.
 */
export async function resolveExodeFrameAncestors(
  referer: string | undefined,
  config: ExodeAuthConfig,
  fetcher: Fetch = fetch,
): Promise<string[]> {
  if (!referer) {
    return config.allowedOrigins;
  }

  let origin: string;

  try {
    origin = new URL(referer).origin;
  } catch {
    return config.allowedOrigins;
  }

  if (isAllowedExodeOrigin(origin, config.allowedOrigins)) {
    return config.allowedOrigins;
  }

  return (await isEmbeddableExodeOrigin(origin, config, fetcher))
    ? [...config.allowedOrigins, origin]
    : config.allowedOrigins;
}

/**
 * The `frame-ancestors` value for an embed response — the async counterpart of
 * `getExodeFrameAncestors`, which can only report what the env lists.
 *
 * Falls back to that static answer whenever the bridge is not fully configured, so a deployment
 * that never set the EXODE_* variables behaves exactly as before and never reaches main. Reading
 * the private config is safe under that guard: `enabled` already requires every value it needs.
 */
export async function resolveExodeFrameAncestorsHeader(
  referer: string | undefined,
  fetcher: Fetch = fetch,
): Promise<string> {
  const { enabled, allowedOrigins } = getExodeEmbedConfig();

  const ancestors = enabled
    ? await resolveExodeFrameAncestors(referer, getExodeAuthConfig(), fetcher)
    : allowedOrigins;

  return ancestors.length > 0 ? ancestors.join(' ') : "'none'";
}
