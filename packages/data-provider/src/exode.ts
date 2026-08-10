/**
 * Origin matching for the exode iframe bridge.
 *
 * Lives here rather than next to either consumer because the same list is enforced at three
 * points that MUST agree: the CSP `frame-ancestors` header the server sets on an embed request,
 * the server-side gate on the token exchange, and the client-side check on every inbound
 * `postMessage`. A page that passes one gate but not another fails in a way that reads like a
 * bug rather than a config error, so all three go through this module.
 */

/** Host prefix marking an entry as "any subdomain of the rest". */
const WILDCARD_PREFIX = '*.';

export function isWildcardOrigin(entry: string): boolean {
  return entry.includes(`://${WILDCARD_PREFIX}`);
}

/**
 * Whether `origin` is covered by one of `allowedOrigins`.
 *
 * An entry like `https://*.example.com` matches any subdomain at any depth — `a.example.com`
 * and `a.b.example.com` both pass, and the bare `example.com` does not. That is deliberately
 * the same rule CSP applies to a `frame-ancestors` host wildcard, so the browser and the server
 * never disagree about who may embed. Entries without a wildcard compare exactly.
 *
 * Scheme and port must always match exactly; the wildcard only ever widens the host.
 */
export function isAllowedExodeOrigin(origin: string, allowedOrigins: string[]): boolean {
  let parsed: URL;

  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  return allowedOrigins.some((entry) => {
    if (entry === origin) {
      return true;
    }

    if (!isWildcardOrigin(entry)) {
      return false;
    }

    let pattern: URL;

    try {
      pattern = new URL(entry);
    } catch {
      return false;
    }

    if (pattern.protocol !== parsed.protocol || pattern.port !== parsed.port) {
      return false;
    }

    /** `*.example.com` -> `.example.com`, so the suffix test also demands a label before it */
    const suffix = pattern.hostname.slice(WILDCARD_PREFIX.length - 1);

    return parsed.hostname.endsWith(suffix) && parsed.hostname.length > suffix.length;
  });
}

/**
 * Concrete origins the embedded chat may hand to `postMessage` before a handshake has pinned
 * down its parent.
 *
 * `postMessage` needs a real origin — a wildcard entry is rejected as an invalid target — so the
 * parent is read from the referrer, which is the embedding page, and accepted only if the
 * allow-list covers it. Without a usable referrer (a parent sending `Referrer-Policy:
 * no-referrer`, say) the wildcards are unusable and only the exact entries can be addressed;
 * broadcasting to those is harmless, since the browser drops a message whose target origin does
 * not match the actual parent.
 */
export function resolveExodeTargetOrigins(allowedOrigins: string[], referrer?: string): string[] {
  if (referrer) {
    try {
      const { origin } = new URL(referrer);

      if (isAllowedExodeOrigin(origin, allowedOrigins)) {
        return [origin];
      }
    } catch {
      /* fall through to the exact entries below */
    }
  }

  return allowedOrigins.filter((entry) => !isWildcardOrigin(entry));
}
