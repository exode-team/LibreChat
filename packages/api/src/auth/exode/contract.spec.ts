/**
 * Pins the exchange contract against what exode-main actually sends.
 *
 * These two repos deploy separately and the schema is validated with `safeParse`, so a mismatch
 * does not fail loudly — it turns every handshake into a generic 502 "chat unavailable" with the
 * real cause hidden. That is exactly what happened: main omitted `userId`/`userUuid`, which the
 * schema requires but nothing downstream reads, and the bridge could never complete.
 */
import { exodeMainResponseSchema } from './types';

/**
 * Exactly what exode-main's knowledge-chat.controller now returns.
 *
 * `userUuid` is a short id, not a UUID — copied from a live staging token. The name misleads,
 * and the schema believed it: `z.string().uuid()` rejected every real exchange.
 */
const payload = {
  payload: {
    token: 'a'.repeat(64),
    expiresAt: new Date().toISOString(),
    identity: {
      subject: 'b'.repeat(64),
      userId: 1798,
      userUuid: 'RNzffmwSR1mQ',
      name: 'Elmir Ismailzada',
      schoolId: 9,
      sellerId: undefined,
      libreChatUserId: 'lc-user-1',
    },
    agents: { knowledge: 'agent_router', assistant: 'agent_assist' },
  },
};

describe('exode main exchange contract', () => {
  it('accepts what exode-main actually sends', () => {
    const parsed = exodeMainResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.error(JSON.stringify(parsed.error.issues, null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('still accepts a user with no profile name via the uuid fallback', () => {
    const p = {
      payload: {
        ...payload.payload,
        identity: { ...payload.payload.identity, name: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
      },
    };
    expect(exodeMainResponseSchema.safeParse(p).success).toBe(true);
  });

  /**
   * A field nothing downstream depends on must never cost the user their session — these all
   * used to be hard rejections that surfaced as a blank frame and a generic 502.
   */
  it.each([
    ['a non-UUID userUuid', { userUuid: 'RNzffmwSR1mQ' }],
    ['an empty name', { name: '' }],
    ['a missing name', { name: undefined }],
    ['a malformed avatar', { avatar: 'not-a-url' }],
    ['an empty avatar', { avatar: '' }],
  ])('survives %s', (_label, override) => {
    const p = {
      payload: {
        ...payload.payload,
        identity: { ...payload.payload.identity, ...override },
      },
    };
    expect(exodeMainResponseSchema.safeParse(p).success).toBe(true);
  });

  it('drops a malformed avatar rather than passing it through', () => {
    const p = {
      payload: {
        ...payload.payload,
        identity: { ...payload.payload.identity, avatar: 'not-a-url' },
      },
    };
    const parsed = exodeMainResponseSchema.safeParse(p);
    expect(parsed.success && parsed.data.payload.identity.avatar).toBeUndefined();
  });
});

describe('regression', () => {
  it('rejects the pre-fix payload that omitted userId/userUuid', () => {
    const broken = {
      payload: {
        ...payload.payload,
        identity: { subject: 'b'.repeat(64), name: 'X', libreChatUserId: 'lc-1' },
      },
    };
    expect(exodeMainResponseSchema.safeParse(broken).success).toBe(false);
  });
});
