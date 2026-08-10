import { z } from 'zod';
import type { IUser } from '@librechat/data-schemas';

export interface ExodeExchangeInput {
  token: string;
  handshakeId: string;
  parentOrigin: string;
  /**
   * Which chat is opening. Exode answers with that agent only — returning both would let the
   * knowledge frame open the MCP-enabled assistant, which the knowledge base must not reach.
   */
  kind?: 'Knowledge' | 'Assistant';
}

export interface ExodeIdentity {
  subject: string;
  userId: number;
  userUuid: string;
  name: string;
  avatar?: string;
  schoolId?: number;
  sellerId?: number;
}

/** The subset of an identity the user upsert actually consumes — admin provisioning has no more */
export type ExodeProfile = Pick<ExodeIdentity, 'subject' | 'name' | 'avatar'>;

/**
 * Agents exode provisioned for this principal.
 *
 * The chat cannot pick these itself: which agent answers depends on what the user may read,
 * which only exode knows. `knowledge` is the router over the user's spaces; `assistant` is the
 * MCP-enabled general chat. Either may be absent when that side is not configured.
 */
export interface ExodeAgents {
  knowledge?: string;
  assistant?: string;
}

export interface ExodeMainExchange {
  identity: ExodeIdentity;
  token: string;
  expiresAt: string;
  agents?: ExodeAgents;
}

export const exodeExchangeInputSchema: z.ZodType<ExodeExchangeInput> = z
  .object({
    token: z.string().min(16).max(16_384),
    handshakeId: z.string().uuid(),
    parentOrigin: z.string().min(1).max(2_048),
    kind: z.enum(['Knowledge', 'Assistant']).optional(),
  })
  .strict();

/**
 * Validate what the session actually depends on, and no more.
 *
 * Every field here is one exode may change without telling this service, and a rejection is
 * total — the user gets no chat at all. So the rule is: guard what would corrupt a session if
 * wrong (the identity we key the account on, the token, its expiry), and stay out of the way of
 * everything cosmetic. `userUuid` learned this the hard way: it was declared a UUID, exode
 * issues short ids like `RNzffmwSR1mQ`, and every single exchange failed on a field this
 * service only ever passes through.
 */
export const exodeMainResponseSchema: z.ZodType<
  { payload: ExodeMainExchange },
  z.ZodTypeDef,
  unknown
> = z.object({
  payload: z.object({
    identity: z.object({
      /** Keys the LibreChat account (`openidId`) — a wrong value hands over the wrong session */
      subject: z.string().min(16).max(256),
      userId: z.number().int().positive(),
      userUuid: z.string().min(1).max(128),
      /** Display-only, and exode does not guarantee it is set */
      name: z.string().max(256).catch(''),
      /** Cosmetic: a malformed avatar drops to none rather than costing the user their chat */
      avatar: z.string().max(2_048).url().optional().catch(undefined),
      schoolId: z.number().int().positive().optional(),
      sellerId: z.number().int().positive().optional(),
    }),
    token: z.string().min(16).max(16_384),
    expiresAt: z.string().datetime(),
    agents: z
      .object({
        knowledge: z.string().min(1).max(256).optional(),
        assistant: z.string().min(1).max(256).optional(),
      })
      .optional(),
  }),
});

export interface ExodeExchangeUser {
  id: string;
  username: string;
  email: string;
  name: string;
  avatar: string;
  role: string;
  provider: string;
  tenantId?: string;
  plugins?: string[];
  twoFactorEnabled?: boolean;
  personalization?: IUser['personalization'];
  createdAt: string;
  updatedAt: string;
}

export interface ExodeExchangeResponse {
  token: string;
  tokenExpiresAt: string;
  mcpExpiresAt: string;
  user: ExodeExchangeUser;
  agents?: ExodeAgents;
}

export class ExodeExchangeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ExodeExchangeError';
  }
}
