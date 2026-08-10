import { isAllowedExodeOrigin, isWildcardOrigin, resolveExodeTargetOrigins } from './exode';

describe('isAllowedExodeOrigin', () => {
  const allowed = ['https://staging.exode.biz', 'https://*.staging.exode.biz'];

  it('accepts an exact entry', () => {
    expect(isAllowedExodeOrigin('https://staging.exode.biz', allowed)).toBe(true);
  });

  it('accepts a subdomain covered by the wildcard', () => {
    expect(isAllowedExodeOrigin('https://corp.staging.exode.biz', allowed)).toBe(true);
  });

  /* CSP's host wildcard is a suffix match, so a nested subdomain passes there too — the two
   * gates have to agree or a page frames fine and then fails the token exchange. */
  it('accepts a nested subdomain, matching CSP semantics', () => {
    expect(isAllowedExodeOrigin('https://a.b.staging.exode.biz', allowed)).toBe(true);
  });

  it('rejects the bare parent of a wildcard that is not itself listed', () => {
    expect(isAllowedExodeOrigin('https://exode.biz', ['https://*.exode.biz'])).toBe(false);
  });

  it('rejects a lookalike suffix that is not a subdomain', () => {
    expect(isAllowedExodeOrigin('https://evilstaging.exode.biz', allowed)).toBe(false);
  });

  it('rejects a different scheme', () => {
    expect(isAllowedExodeOrigin('http://corp.staging.exode.biz', allowed)).toBe(false);
  });

  it('rejects a different port', () => {
    expect(isAllowedExodeOrigin('https://corp.staging.exode.biz:8443', allowed)).toBe(false);
  });

  it('rejects an unparseable origin', () => {
    expect(isAllowedExodeOrigin('not-an-origin', allowed)).toBe(false);
  });

  it('rejects everything when nothing is configured', () => {
    expect(isAllowedExodeOrigin('https://staging.exode.biz', [])).toBe(false);
  });
});

describe('isWildcardOrigin', () => {
  it('recognises a wildcard host', () => {
    expect(isWildcardOrigin('https://*.exode.biz')).toBe(true);
  });

  it('does not treat an exact origin as a wildcard', () => {
    expect(isWildcardOrigin('https://exode.biz')).toBe(false);
  });
});

describe('resolveExodeTargetOrigins', () => {
  const allowed = ['https://staging.exode.biz', 'https://*.staging.exode.biz'];

  it('pins the parent from an allowed referrer', () => {
    expect(
      resolveExodeTargetOrigins(allowed, 'https://corp.staging.exode.biz/knowledge-base'),
    ).toEqual(['https://corp.staging.exode.biz']);
  });

  /* A wildcard is not a valid postMessage target, so it must never reach the caller. */
  it('drops wildcards when the referrer is missing', () => {
    expect(resolveExodeTargetOrigins(allowed, '')).toEqual(['https://staging.exode.biz']);
  });

  it('drops wildcards when the referrer is not allowed', () => {
    expect(resolveExodeTargetOrigins(allowed, 'https://evil.example.com/')).toEqual([
      'https://staging.exode.biz',
    ]);
  });

  it('ignores an unparseable referrer', () => {
    expect(resolveExodeTargetOrigins(allowed, 'not-a-url')).toEqual(['https://staging.exode.biz']);
  });
});
