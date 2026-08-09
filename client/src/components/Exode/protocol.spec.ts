import { exodeHostMessageSchema, isExodeEmbedLocation } from './protocol';

describe('Exode iframe protocol', () => {
  const validMessage = {
    protocol: 1,
    source: 'exode-host',
    type: 'exode-ai-chat:authenticate',
    requestId: '9936c8e3-87d8-4850-8a7d-7a91b902e74a',
    payload: {
      token: 'bootstrap-token-with-enough-length',
      handshakeId: 'ec150ba8-01a4-4db3-b61e-a1ca22d021ba',
    },
  };

  it('accepts the versioned authentication envelope', () => {
    expect(exodeHostMessageSchema.safeParse(validMessage).success).toBe(true);
  });

  it.each([
    { ...validMessage, protocol: 2 },
    { ...validMessage, source: 'exode-ai-chat' },
    { ...validMessage, requestId: 'not-a-uuid' },
    { ...validMessage, payload: { ...validMessage.payload, handshakeId: 'not-a-uuid' } },
  ])('rejects malformed cross-window input', (message) => {
    expect(exodeHostMessageSchema.safeParse(message).success).toBe(false);
  });

  const validTheme = {
    protocol: 1,
    source: 'exode-host',
    type: 'exode-ai-chat:theme',
    requestId: 'a2bb3f2c-2f4a-4a2e-bb0e-2b2f7a4c5d61',
    payload: { scheme: 'dark', accent: '#fa6c1c' },
  };

  it('accepts a theme push with and without an accent', () => {
    expect(exodeHostMessageSchema.safeParse(validTheme).success).toBe(true);
    expect(exodeHostMessageSchema.safeParse({ ...validTheme, payload: { scheme: 'light' } }).success).toBe(
      true,
    );
  });

  it.each([
    { ...validTheme, payload: { scheme: 'system' } },
    { ...validTheme, payload: { ...validTheme.payload, accent: 'red' } },
    { ...validTheme, payload: { ...validTheme.payload, accent: 'url(evil)' } },
    { ...validTheme, type: 'exode-ai-chat:unknown' },
  ])('rejects a theme push that could restyle the frame arbitrarily', (message) => {
    expect(exodeHostMessageSchema.safeParse(message).success).toBe(false);
  });

  it('detects only the Exode entry route and explicit query marker', () => {
    expect(isExodeEmbedLocation('/embed/exode', '')).toBe(true);
    expect(isExodeEmbedLocation('/c/new', '?embed=exode')).toBe(true);
    expect(isExodeEmbedLocation('/c/new', '?embed=other')).toBe(false);
  });
});
