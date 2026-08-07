import { logger } from '@librechat/data-schemas';
import type { IAgent } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { FilterQuery } from 'mongoose';
import { z } from 'zod';

/**
 * Explicitly annotated because this package builds with `--isolatedDeclarations`: an inferred
 * Zod schema type cannot be emitted into the .d.ts without re-checking the whole expression.
 */
export const exodeReprovisionAgentProviderInputSchema: z.ZodObject<{
  provider: z.ZodString;
  model: z.ZodString;
  model_parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  dry_run: z.ZodOptional<z.ZodBoolean>;
}> = z.object({
  /**
   * The LibreChat endpoint/provider key every agent should be repointed at — "anthropic",
   * "openai", "google", or the name of an `endpoints.custom` entry (e.g. "qwen"). Not
   * validated against the live endpoint config here: a deployment may legitimately reprovision
   * ahead of the config reload that introduces the endpoint, and a wrong value is visible and
   * correctable by re-running with the right one.
   */
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  /**
   * Replaces `model_parameters` wholesale when present. The caller owns this because the
   * correct value is provider-dependent (ms-ai sends `{thinking: false}` for anthropic and
   * `{}` otherwise), and merging would strand the previous provider's keys on the agent.
   */
  model_parameters: z.record(z.string(), z.unknown()).optional(),
  /** Report what would change without writing. */
  dry_run: z.boolean().optional(),
});

export interface ExodeReprovisionAgentProviderDeps {
  getAgents: (searchParameter: FilterQuery<IAgent>) => Promise<IAgent[]>;
  updateAgent: (
    searchParameter: FilterQuery<IAgent>,
    updateData: Record<string, unknown>,
    options?: {
      updatingUserId?: string | null;
      forceVersion?: boolean;
      skipVersioning?: boolean;
    },
  ) => Promise<IAgent | null>;
}

export interface ExodeReprovisionAgentProviderResult {
  total: number;
  changed: number;
  unchanged: number;
  failed: number;
  dryRun: boolean;
  /** Agent ids that could not be updated, so the caller can log something actionable. */
  failedIds: string[];
}

/**
 * Repoint every Agent at the deployment's currently configured LLM provider/model.
 *
 * WHY THIS IS A NATIVE ROUTE rather than a loop over the public REST API:
 * `GET /api/agents` is ACL-scoped — `getListAgentsHandler` resolves the caller's accessible set
 * via `findAccessibleResources`, and there is no ADMIN bypass in `accessControlService` (the
 * `role` argument only resolves role-*principals*). A service account sweeping over REST would
 * therefore silently skip every agent it was never granted EDIT on, leaving them pinned to a
 * provider whose API key the deployment may no longer even hold. This runs against the
 * collection directly, so "every agent" means every agent.
 *
 * An Agent stores `provider`/`model` at creation time (both are `required` in the schema) and
 * nothing re-reads the environment afterward, so switching the deployment's LLM provider
 * otherwise leaves every previously-created agent talking to the old one.
 *
 * Per-agent `updateAgent` rather than a single `updateMany` — deliberately. `updateAgent`
 * maintains the agent's version history, and self-guards against duplicates: when the incoming
 * data matches the current state it returns early WITHOUT pushing a version. That makes
 * repeated runs (this is called on every ms-ai startup) idempotent and non-polluting, which a
 * raw `updateMany` would not be.
 *
 * `updatingUserId` is left null: the change is attributed to the deployment, not to the admin
 * whose token happened to authenticate the call.
 */
export async function reprovisionAgentProviders(
  deps: ExodeReprovisionAgentProviderDeps,
  input: {
    provider: string;
    model: string;
    model_parameters?: Record<string, unknown>;
    dryRun?: boolean;
  },
): Promise<ExodeReprovisionAgentProviderResult> {
  const { provider, model, model_parameters, dryRun = false } = input;

  /** Only agents not already on the target — keeps the write set and the log honest. */
  const stale = await deps.getAgents({
    $or: [{ provider: { $ne: provider } }, { model: { $ne: model } }],
  });

  const result: ExodeReprovisionAgentProviderResult = {
    total: stale.length,
    changed: 0,
    unchanged: 0,
    failed: 0,
    dryRun,
    failedIds: [],
  };

  if (dryRun || stale.length === 0) {
    return result;
  }

  const updateData: Record<string, unknown> = { provider, model };
  if (model_parameters !== undefined) {
    updateData.model_parameters = model_parameters;
  }

  for (const agent of stale) {
    try {
      /** One failure must not abandon the rest — a single agent with, say, a dangling
       *  action reference should not leave the remaining agents on the old provider. */
      const updated = await deps.updateAgent({ id: agent.id }, { ...updateData });
      if (updated) {
        result.changed += 1;
      } else {
        result.unchanged += 1;
      }
    } catch (error) {
      result.failed += 1;
      result.failedIds.push(agent.id);
      logger.error(
        `[exode/reprovision] Failed to repoint agent ${agent.id} at ${provider}/${model}`,
        error,
      );
    }
  }

  return result;
}

/**
 * Admin-gated HTTP surface for {@link reprovisionAgentProviders}.
 *
 * Guarded by `requireJwtAuth` + ACCESS_ADMIN at the route, so the caller is an authenticated
 * LibreChat admin — the ms-ai service account already signs in as one to drive the agent APIs,
 * so this introduces no new shared secret.
 */
export function createExodeReprovisionAgentProviderController(
  deps: ExodeReprovisionAgentProviderDeps,
): RequestHandler {
  return async (req, res) => {
    const parsed = exodeReprovisionAgentProviderInputSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Invalid agent reprovisioning request',
      });
      return;
    }

    const { provider, model, model_parameters, dry_run: dryRun } = parsed.data;

    try {
      const result = await reprovisionAgentProviders(deps, {
        provider,
        model,
        model_parameters,
        dryRun,
      });

      logger.info(
        `[exode/reprovision] provider=${provider} model=${model} ` +
          `total=${result.total} changed=${result.changed} unchanged=${result.unchanged} ` +
          `failed=${result.failed} dryRun=${result.dryRun}`,
      );

      res.status(200).json(result);
    } catch (error) {
      logger.error('[exode/reprovision] Agent provider reprovisioning failed', error);
      res.status(500).json({
        error: 'REPROVISION_FAILED',
        message: 'Failed to reprovision agent providers',
      });
    }
  };
}
