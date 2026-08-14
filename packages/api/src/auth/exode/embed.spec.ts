import type { NextFunction, Request, Response } from 'express';
import { checkExodeEmbedOrigin, createExodeFrameAncestorsMiddleware } from './embed';
import type { ExodeAuthConfig } from './config';

const ORIGINAL_ENV = process.env;

const config: ExodeAuthConfig = {
  mainUrl: 'https://api.exode.biz/',
  serviceId: 'LibreChatBridge',
  serviceSecret: 'secret',
  issuer: 'exode-backend-main',
  embedJwtTtlMs: 300000,
  mcpServerName: 'exode',
};

function allowedResponse(allowed: boolean) {
  return new Response(JSON.stringify({ payload: { allowed } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/',
    protocol: 'https',
    headers: {},
    get: () => 'chat.exode.biz',
    ...overrides,
  } as unknown as Request;
}

function mockResponse(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  } as unknown as Response & { headers: Record<string, string> };
}

describe('checkExodeEmbedOrigin', () => {
  it('authenticates the server-to-server check and reads the verdict', async () => {
    const fetcher = jest.fn(async () => allowedResponse(true));

    await expect(checkExodeEmbedOrigin('https://school.exode.biz', config, fetcher)).resolves.toBe(
      true,
    );

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.exode.biz/api/v2/auth/ai-chat/embed-origin',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-service-id': 'LibreChatBridge',
          'x-service-secret': 'secret',
        }),
        body: JSON.stringify({ origin: 'https://school.exode.biz' }),
      }),
    );
  });

  it.each([
    ['a refusal', async () => allowedResponse(false)],
    ['an upstream error status', async () => new Response('{}', { status: 500 })],
    ['a malformed body', async () => new Response('not-json', { status: 200 })],
    [
      'an unreachable exode',
      async () => {
        throw new Error('ECONNREFUSED');
      },
    ],
  ])('fails closed on %s', async (_case, fetcher) => {
    await expect(
      checkExodeEmbedOrigin('https://school.exode.biz', config, jest.fn(fetcher)),
    ).resolves.toBe(false);
  });
});

describe('createExodeFrameAncestorsMiddleware', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      EXODE_MAIN_URL: 'https://api.exode.biz',
      EXODE_MAIN_SERVICE_ID: 'LibreChatBridge',
      EXODE_MAIN_SERVICE_SECRET: 'secret',
      EXODE_MAIN_ISSUER: 'exode-backend-main',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  async function run(
    req: Request,
    deps: Parameters<typeof createExodeFrameAncestorsMiddleware>[0] = {},
  ) {
    const middleware = createExodeFrameAncestorsMiddleware(deps);
    const res = mockResponse();
    const next = jest.fn() as NextFunction;
    await middleware(req, res, next);
    return { res, next };
  }

  it('widens frame-ancestors to an origin exode vouches for', async () => {
    const fetcher = jest.fn(async () => allowedResponse(true));

    const { res, next } = await run(
      mockRequest({ headers: { referer: 'https://school.exode.biz/education/chat' } }),
      { fetcher },
    );

    expect(res.headers['Content-Security-Policy']).toBe(
      "frame-ancestors 'self' https://school.exode.biz",
    );
    expect(next).toHaveBeenCalled();
  });

  it('answers self for an origin exode does not know', async () => {
    const fetcher = jest.fn(async () => allowedResponse(false));

    const { res } = await run(mockRequest({ headers: { referer: 'https://evil.example' } }), {
      fetcher,
    });

    expect(res.headers['Content-Security-Policy']).toBe("frame-ancestors 'self'");
  });

  it('answers self without asking exode when there is no usable referer', async () => {
    const fetcher = jest.fn();

    const { res } = await run(mockRequest(), { fetcher });

    expect(res.headers['Content-Security-Policy']).toBe("frame-ancestors 'self'");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers self without asking exode for a same-origin referer', async () => {
    const fetcher = jest.fn();

    const { res } = await run(
      mockRequest({ headers: { referer: 'https://chat.exode.biz/c/new' } }),
      { fetcher },
    );

    expect(res.headers['Content-Security-Policy']).toBe("frame-ancestors 'self'");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('caches the verdict for a minute per origin', async () => {
    const fetcher = jest.fn(async () => allowedResponse(true));
    let clock = 1_000_000;

    const middleware = createExodeFrameAncestorsMiddleware({ fetcher, now: () => clock });
    const req = mockRequest({ headers: { referer: 'https://school.exode.biz' } });

    await middleware(req, mockResponse(), jest.fn());
    await middleware(req, mockResponse(), jest.fn());
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock += 61_000;
    await middleware(req, mockResponse(), jest.fn());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a non-GET request', mockRequest({ method: 'POST' })],
    ['an API route', mockRequest({ path: '/api/auth/exode/config' })],
    ['a hashed asset', mockRequest({ path: '/assets/index-BqX3.js' })],
  ])('passes %s through without a header', async (_case, req) => {
    const { res, next } = await run(req);

    expect(res.headers['Content-Security-Policy']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('stays inert when the exode integration is disabled', async () => {
    delete process.env.EXODE_MAIN_URL;

    const { res, next } = await run(
      mockRequest({ headers: { referer: 'https://school.exode.biz' } }),
    );

    expect(res.headers['Content-Security-Policy']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
