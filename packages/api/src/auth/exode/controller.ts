import { logger } from '@librechat/data-schemas';
import { SystemRoles } from 'librechat-data-provider';
import type { IUser, IPluginAuth, BalanceConfig } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { ExodeUserDeps } from './user';
import type { ExodeExchangeResponse } from './types';
import type { Fetch } from './client';
import { getExodeAuthConfig, getExodeEmbedConfig, EXODE_MCP_AUTH_FIELD } from './config';
import { exchangeExodeBootstrap } from './client';
import { exodeExchangeInputSchema, ExodeExchangeError } from './types';
import { serializeExodeUser, upsertExodeUser } from './user';

interface MCPManager {
  disconnectUserConnection: (userId: string, serverName: string) => Promise<void>;
}

export interface ExodeExchangeDeps extends ExodeUserDeps {
  generateToken: (user: IUser, expiresIn?: number) => Promise<string>;
  updateUserPluginAuth: (
    userId: string,
    authField: string,
    pluginKey: string,
    value: string,
  ) => Promise<IPluginAuth | Error>;
  invalidateCachedTools: (options: { userId: string; serverName: string }) => Promise<void>;
  getMCPManager: () => MCPManager;
  getTenantId: () => string | undefined;
  /**
   * Resolved per request, not at construction: the app config is loaded asynchronously and can
   * change without a restart, so capturing it once would pin the balance settings forever.
   */
  getAppConfig?: (options?: { role?: string }) => Promise<{ balance?: BalanceConfig } | undefined>;
  fetcher?: Fetch;
  now?: () => number;
}

/**
 * Normalize the claimed parent origin. Diagnostics only — never an authorization decision.
 *
 * Who may embed the chat is not decided here, and cannot be: the set of school domains lives in
 * main and grows on onboarding, not on deploy. The boundary is the bootstrap token itself —
 * single-use, bound to one handshake id, minted by main only for a signed-in exode session — so
 * an origin nobody vouched for still gets nowhere. Passing it upstream keeps main's rejection
 * logs able to name the page that tried.
 */
function normalizeParentOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    throw new ExodeExchangeError('INVALID_HANDSHAKE', 400, 'Invalid parent origin');
  }
}

function sendError(error: ExodeExchangeError, res: Parameters<RequestHandler>[1]): void {
  res.status(error.status).json({
    code: error.code,
    message: error.message,
  });
}

export function createExodeConfigController(): RequestHandler {
  return (_req, res) => {
    res.status(200).json(getExodeEmbedConfig());
  };
}

export function createExodeExchangeController(deps: ExodeExchangeDeps): RequestHandler {
  return async (req, res) => {
    const parsed = exodeExchangeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        new ExodeExchangeError('INVALID_HANDSHAKE', 400, 'Invalid exchange request'),
        res,
      );
    }

    try {
      const config = getExodeAuthConfig();
      const parentOrigin = normalizeParentOrigin(parsed.data.parentOrigin);
      const exchange = await exchangeExodeBootstrap(
        { ...parsed.data, parentOrigin },
        config,
        deps.fetcher,
      );
      /** Same balance settings every other registration path uses (see AuthService.registerUser) */
      const appConfig = await deps.getAppConfig?.({ role: SystemRoles.USER });

      const user = await upsertExodeUser(exchange.identity, config.issuer, deps.getTenantId(), {
        ...deps,
        balanceConfig: appConfig?.balance,
      });
      const userId = String(user._id);
      const pluginKey = `mcp_${config.mcpServerName}`;
      const pluginAuth = await deps.updateUserPluginAuth(
        userId,
        EXODE_MCP_AUTH_FIELD,
        pluginKey,
        exchange.token,
      );
      if (pluginAuth instanceof Error) {
        throw pluginAuth;
      }

      const mcpManager = deps.getMCPManager();
      await Promise.all([
        mcpManager.disconnectUserConnection(userId, config.mcpServerName),
        deps.invalidateCachedTools({ userId, serverName: config.mcpServerName }),
      ]);

      const token = await deps.generateToken(user, config.embedJwtTtlMs);
      const now = deps.now?.() ?? Date.now();
      const response: ExodeExchangeResponse = {
        token,
        tokenExpiresAt: new Date(now + config.embedJwtTtlMs).toISOString(),
        mcpExpiresAt: exchange.expiresAt,
        user: serializeExodeUser(user),
        /** Forwarded verbatim — only exode knows which agents this principal may open */
        agents: exchange.agents,
      };
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof ExodeExchangeError) {
        return sendError(error, res);
      }
      const details = error instanceof Error ? { name: error.name, message: error.message } : {};
      logger.error('[exodeExchange] Failed to establish embedded session', details);
      return sendError(
        new ExodeExchangeError('INTERNAL_ERROR', 500, 'Failed to establish embedded session'),
        res,
      );
    }
  };
}
