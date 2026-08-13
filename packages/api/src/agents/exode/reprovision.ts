import { logger } from '@librechat/data-schemas';
import type { IAgent } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { FilterQuery } from 'mongoose';
import { z } from 'zod';

/**
 * Explicitly annotated because this package builds with `--isolatedDeclarations`: an inferred
 * Zod schema type cannot be emitted into the .d.ts without re-checking the whole expression.
 */
export const exodeReprovisionAgentsInputSchema: z.ZodObject<{
  provider: z.ZodString;
  model: z.ZodString;
  model_parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  instructions_by_kind: z.ZodOptional<
    z.ZodObject<{
      space: z.ZodString;
      router: z.ZodString;
      assistant: z.ZodString;
      knowledge: z.ZodString;
    }>
  >;
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
  /**
   * The system prompt each agent kind should now carry, keyed by kind. Optional: omit it and
   * this behaves exactly as it did when it only repointed provider/model.
   *
   * The caller cannot address agents individually — it holds no list of them (see the ACL note
   * on {@link reprovisionAgents}) and LibreChat stores no exode "kind" field — so it sends one
   * prompt per kind and this route decides which each agent gets. See {@link classifyAgentKind}.
   */
  instructions_by_kind: z
    .object({
      space: z.string().min(1),
      router: z.string().min(1),
      assistant: z.string().min(1),
      knowledge: z.string().min(1),
    })
    .optional(),
  /** Report what would change, and how each agent was classified, without writing. */
  dry_run: z.boolean().optional(),
});

/** The exode agent kinds, as `agent_provisioning.py` defines them. */
export type ExodeAgentKind = 'space' | 'router' | 'assistant' | 'knowledge';

export interface ExodeReprovisionAgentsDeps {
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

export interface ExodeReprovisionAgentsResult {
  total: number;
  changed: number;
  unchanged: number;
  failed: number;
  dryRun: boolean;
  /** Agent ids that could not be updated, so the caller can log something actionable. */
  failedIds: string[];
  /** How many agents were classified as each kind. Always carries every kind; all four stay
   *  zero when no instructions were sent, since nothing is classified in that case.
   *  A dry run returns this and writes nothing, which is how an operator checks the
   *  classification before trusting it. */
  byKind: Record<ExodeAgentKind, number>;
}

/** The shape {@link classifyAgentKind} reads. Declared locally because `subagents` is optional
 *  on the stored document and absent from agents that never had it configured. */
type ClassifiableAgent = {
  tools?: string[] | null;
  description?: string | null;
  subagents?: unknown;
};

/**
 * Work out which exode agent kind a stored LibreChat agent is.
 *
 * LibreChat has no field for it: `agent_provisioning.py` expresses the kind purely through the
 * tools, description and subagents it writes at creation. So the kind is recovered from those,
 * in an order chosen so that an ambiguous agent fails safe.
 *
 * The two genuine ambiguities, and why the order resolves them:
 *
 *   - A knowledge-disabled SPACE agent and a ROUTER both have an empty `tools` array. A space
 *     agent is the only kind given a `description` (`agent_description` returns "" for the
 *     others), so the description settles it first. If neither a description nor `subagents` is
 *     present — a router created but not yet pointed at any space, since `create_agent` does not
 *     send `subagents` — the tie goes to ROUTER: router instructions on a space agent make it
 *     report that no spaces are available, whereas space instructions on a router make it claim
 *     documents it has no way to reach.
 *   - An ASSISTANT and a knowledge-disabled legacy agent have identical tools. They also get
 *     identical instructions (`_kind_instructions` returns `_BASE_INSTRUCTIONS` for both), so
 *     the ambiguity has no consequence and both are reported as `assistant`.
 */
export function classifyAgentKind(agent: ClassifiableAgent): ExodeAgentKind {
  if (agent.subagents != null) {
    return 'router';
  }
  if (typeof agent.description === 'string' && agent.description.trim() !== '') {
    return 'space';
  }

  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const hasFileSearch = tools.includes('file_search');
  const hasOtherTools = tools.some((tool) => tool !== 'file_search');

  if (hasFileSearch) {
    return hasOtherTools ? 'knowledge' : 'space';
  }
  return tools.length === 0 ? 'router' : 'assistant';
}

function emptyByKind(): Record<ExodeAgentKind, number> {
  return { space: 0, router: 0, assistant: 0, knowledge: 0 };
}

/**
 * Bring every Agent in line with the deployment's current configuration: the LLM
 * provider/model, and — when the caller sends them — the per-kind system instructions.
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
 * `instructions` has exactly the same problem and it bites harder, because a prompt is where the
 * product's guardrails live: an agent created before a fix to the grounding rules keeps answering
 * under the old ones forever. Only two narrow paths ever rewrote a prompt — toggling an agent's
 * knowledge base, and repointing a router at its spaces — so a prompt change reached existing
 * agents only if something unrelated happened to touch them. Sending the instructions here makes
 * a deploy sufficient on its own.
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
export async function reprovisionAgents(
  deps: ExodeReprovisionAgentsDeps,
  input: {
    provider: string;
    model: string;
    model_parameters?: Record<string, unknown>;
    instructionsByKind?: Record<ExodeAgentKind, string>;
    dryRun?: boolean;
  },
): Promise<ExodeReprovisionAgentsResult> {
  const { provider, model, model_parameters, instructionsByKind, dryRun = false } = input;

  /**
   * Without instructions, only agents not already on the target provider/model are worth
   * touching — that keeps the write set and the log honest. With instructions, that filter would
   * skip every agent already on the right provider, which is most of them and exactly the ones
   * whose prompt is stale, so the sweep has to consider all of them and let `updateAgent`'s
   * own no-op guard decide what actually changes.
   */
  const candidates = await deps.getAgents(
    instructionsByKind
      ? {}
      : { $or: [{ provider: { $ne: provider } }, { model: { $ne: model } }] },
  );

  const result: ExodeReprovisionAgentsResult = {
    total: candidates.length,
    changed: 0,
    unchanged: 0,
    failed: 0,
    dryRun,
    failedIds: [],
    byKind: emptyByKind(),
  };

  const baseUpdate: Record<string, unknown> = { provider, model };
  if (model_parameters !== undefined) {
    baseUpdate.model_parameters = model_parameters;
  }

  for (const agent of candidates) {
    let updateData = baseUpdate;

    if (instructionsByKind) {
      const kind = classifyAgentKind(agent as unknown as ClassifiableAgent);
      result.byKind[kind] += 1;
      updateData = { ...baseUpdate, instructions: instructionsByKind[kind] };
    }

    if (dryRun) {
      continue;
    }

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
        `[exode/reprovision] Failed to reprovision agent ${agent.id} at ${provider}/${model}`,
        error,
      );
    }
  }

  return result;
}

/**
 * Admin-gated HTTP surface for {@link reprovisionAgents}.
 *
 * Guarded by `requireJwtAuth` + ACCESS_ADMIN at the route, so the caller is an authenticated
 * LibreChat admin — the ms-ai service account already signs in as one to drive the agent APIs,
 * so this introduces no new shared secret.
 */
export function createExodeReprovisionAgentsController(
  deps: ExodeReprovisionAgentsDeps,
): RequestHandler {
  return async (req, res) => {
    const parsed = exodeReprovisionAgentsInputSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Invalid agent reprovisioning request',
      });
      return;
    }

    const {
      provider,
      model,
      model_parameters,
      instructions_by_kind: instructionsByKind,
      dry_run: dryRun,
    } = parsed.data;

    try {
      const result = await reprovisionAgents(deps, {
        provider,
        model,
        model_parameters,
        instructionsByKind,
        dryRun,
      });

      const kinds = instructionsByKind
        ? ` instructions=yes byKind=${JSON.stringify(result.byKind)}`
        : '';
      logger.info(
        `[exode/reprovision] provider=${provider} model=${model} ` +
          `total=${result.total} changed=${result.changed} unchanged=${result.unchanged} ` +
          `failed=${result.failed} dryRun=${result.dryRun}${kinds}`,
      );

      res.status(200).json(result);
    } catch (error) {
      logger.error('[exode/reprovision] Agent reprovisioning failed', error);
      res.status(500).json({
        error: 'REPROVISION_FAILED',
        message: 'Failed to reprovision agents',
      });
    }
  };
}
