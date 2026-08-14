import type { IAgent } from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type { ExodeReprovisionAgentsDeps } from './reprovision';
import { classifyAgentKind, reprovisionAgents } from './reprovision';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

type StubAgent = Pick<IAgent, 'id' | 'provider' | 'model'>;

const AGENTS: StubAgent[] = [
  { id: 'agent_a', provider: 'anthropic', model: 'claude-opus-4-8' },
  { id: 'agent_b', provider: 'openai', model: 'gpt-4o' },
  { id: 'agent_c', provider: 'qwen', model: 'qwen-max' },
];

/** Emulates the `$or: [{provider: {$ne}}, {model: {$ne}}]` filter Mongo would apply. */
function applyStaleFilter(filter: FilterQuery<IAgent>): IAgent[] {
  const clauses = filter.$or as [{ provider: { $ne: string } }, { model: { $ne: string } }];
  const [{ provider }, { model }] = clauses;
  return AGENTS.filter(
    (a) => a.provider !== provider.$ne || a.model !== model.$ne,
  ) as unknown as IAgent[];
}

/** `jest.Mock` so the assertions can reach `.mock.calls`, intersected with the real dep
 *  signatures so the stubs stay honest about what the implementation may call. */
type MockedDeps = {
  getAgents: jest.Mock & ExodeReprovisionAgentsDeps['getAgents'];
  updateAgent: jest.Mock & ExodeReprovisionAgentsDeps['updateAgent'];
};

function makeDeps(overrides: Partial<MockedDeps> = {}): MockedDeps & ExodeReprovisionAgentsDeps {
  const getAgents = jest.fn(async (filter: FilterQuery<IAgent>) =>
    applyStaleFilter(filter),
  ) as MockedDeps['getAgents'];
  const updateAgent = jest.fn(
    async (searchParameter: FilterQuery<IAgent>) =>
      ({ id: searchParameter.id }) as unknown as IAgent,
  ) as MockedDeps['updateAgent'];
  return { getAgents, updateAgent, ...overrides };
}

describe('reprovisionAgents', () => {
  it('only touches agents not already on the target provider/model', async () => {
    const deps = makeDeps();
    const result = await reprovisionAgents(deps, {
      provider: 'qwen',
      model: 'qwen-max',
      model_parameters: {},
    });

    /** agent_c is already on qwen/qwen-max and must not be rewritten. */
    expect(result.total).toBe(2);
    expect(result.changed).toBe(2);
    expect(result.failed).toBe(0);
    expect(deps.updateAgent).toHaveBeenCalledTimes(2);

    const ids = deps.updateAgent.mock.calls.map((call) => call[0].id).sort();
    expect(ids).toEqual(['agent_a', 'agent_b']);
    expect(deps.updateAgent.mock.calls[0][1]).toEqual({
      provider: 'qwen',
      model: 'qwen-max',
      model_parameters: {},
    });
  });

  it('is a no-op when every agent is already on the target', async () => {
    const deps = makeDeps({
      getAgents: jest.fn(async () => [] as IAgent[]) as MockedDeps['getAgents'],
    });
    const result = await reprovisionAgents(deps, {
      provider: 'qwen',
      model: 'qwen-max',
    });

    expect(result).toMatchObject({ total: 0, changed: 0, failed: 0 });
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('dry_run reports the pending count without writing', async () => {
    const deps = makeDeps();
    const result = await reprovisionAgents(deps, {
      provider: 'qwen',
      model: 'qwen-max',
      dryRun: true,
    });

    expect(result.total).toBe(2);
    expect(result.changed).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('one failing agent does not abandon the rest', async () => {
    const deps = makeDeps({
      updateAgent: jest.fn(async (searchParameter: FilterQuery<IAgent>) => {
        if (searchParameter.id === 'agent_a') {
          throw new Error('boom');
        }
        return { id: searchParameter.id } as unknown as IAgent;
      }) as MockedDeps['updateAgent'],
    });

    const result = await reprovisionAgents(deps, {
      provider: 'qwen',
      model: 'qwen-max',
    });

    expect(result.total).toBe(2);
    expect(result.changed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failedIds).toEqual(['agent_a']);
    expect(deps.updateAgent).toHaveBeenCalledTimes(2);
  });

  it('omits model_parameters entirely when the caller does not supply it', async () => {
    const deps = makeDeps();
    await reprovisionAgents(deps, { provider: 'qwen', model: 'qwen-max' });

    expect(deps.updateAgent.mock.calls[0][1]).toEqual({
      provider: 'qwen',
      model: 'qwen-max',
    });
  });
});

/**
 * The instructions sweep. A prompt is where the product's guardrails live, so an agent created
 * before a prompt fix keeps answering under the old rules until something rewrites it — and only
 * two narrow paths ever did.
 */
describe('reprovisionAgents — instructions', () => {
  const PROMPTS = {
    space: 'SPACE PROMPT',
    router: 'ROUTER PROMPT',
    assistant: 'ASSISTANT PROMPT',
    knowledge: 'KNOWLEDGE PROMPT',
  };

  const KINDED = [
    { id: 'space_on', provider: 'qwen', model: 'qwen-max', tools: ['file_search'] },
    { id: 'router', provider: 'qwen', model: 'qwen-max', tools: [], subagents: { enabled: true } },
    { id: 'assistant', provider: 'qwen', model: 'qwen-max', tools: ['run_query_mcp_exode'] },
  ] as unknown as IAgent[];

  function kindedDeps(): MockedDeps & ExodeReprovisionAgentsDeps {
    return makeDeps({
      getAgents: jest.fn(async () => KINDED) as MockedDeps['getAgents'],
    });
  }

  it('considers every agent, not just those on a stale provider', async () => {
    /** The provider/model filter would skip agents already on the target — which is most of
     *  them, and exactly the ones whose prompt is stale. */
    const deps = kindedDeps();
    await reprovisionAgents(deps, {
      provider: 'qwen',
      model: 'qwen-max',
      instructionsByKind: PROMPTS,
    });

    expect(deps.getAgents.mock.calls[0][0]).toEqual({});
    expect(deps.updateAgent).toHaveBeenCalledTimes(3);
  });

  it('sends each agent the prompt for its own kind', async () => {
    const deps = kindedDeps();
    await reprovisionAgents(deps, {
      provider: 'qwen',
      model: 'qwen-max',
      instructionsByKind: PROMPTS,
    });

    const sent = Object.fromEntries(
      deps.updateAgent.mock.calls.map(([where, data]) => [
        (where as { id: string }).id,
        (data as { instructions: string }).instructions,
      ]),
    );
    expect(sent).toEqual({
      space_on: PROMPTS.space,
      router: PROMPTS.router,
      assistant: PROMPTS.assistant,
    });
  });

  it('keeps repointing provider and model alongside the prompt', async () => {
    const deps = kindedDeps();
    await reprovisionAgents(deps, {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      instructionsByKind: PROMPTS,
    });

    expect(deps.updateAgent.mock.calls[0][1]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    });
  });

  it('a dry run classifies without writing, so an operator can check it first', async () => {
    const deps = kindedDeps();
    const result = await reprovisionAgents(deps, {
      provider: 'qwen',
      model: 'qwen-max',
      instructionsByKind: PROMPTS,
      dryRun: true,
    });

    expect(deps.updateAgent).not.toHaveBeenCalled();
    expect(result.byKind).toEqual({ space: 1, router: 1, assistant: 1, knowledge: 0 });
  });

  it('touches no instructions when the caller sends none', async () => {
    const deps = makeDeps();
    const result = await reprovisionAgents(deps, { provider: 'qwen', model: 'qwen-max' });

    expect(deps.updateAgent.mock.calls[0][1]).not.toHaveProperty('instructions');
    /** Every kind is still present in the response, just never incremented — nothing is
     *  classified when there are no instructions to choose between. */
    expect(result.byKind).toEqual({ space: 0, router: 0, assistant: 0, knowledge: 0 });
  });
});

/**
 * LibreChat stores no exode "kind" field — `agent_provisioning.py` expresses the kind only
 * through the tools, description and subagents it writes. These pin the recovery of it.
 */
describe('classifyAgentKind', () => {
  it('reads a space agent from its file_search tool', () => {
    expect(classifyAgentKind({ tools: ['file_search'] })).toBe('space');
  });

  it('reads a router from its subagents, even before it has any', () => {
    expect(classifyAgentKind({ tools: [], subagents: { enabled: false } })).toBe('router');
  });

  it('reads an assistant from MCP tools without file_search', () => {
    expect(classifyAgentKind({ tools: ['run_query_mcp_exode'] })).toBe('assistant');
  });

  it('reads a legacy knowledge agent from having both', () => {
    expect(classifyAgentKind({ tools: ['file_search', 'run_query_mcp_exode'] })).toBe('knowledge');
  });

  it('uses the description to tell a knowledge-disabled space from a router', () => {
    /** Both have empty tools; only a space agent is ever given a description. */
    expect(classifyAgentKind({ tools: [], description: 'Knowledge space "Sales".' })).toBe('space');
  });

  it('defaults an otherwise featureless agent to router', () => {
    /** A router created but not yet pointed at any space: `create_agent` sends no `subagents`.
     *  Router instructions on a space agent merely report no spaces available; space
     *  instructions on a router make it claim documents it cannot reach. */
    expect(classifyAgentKind({ tools: [] })).toBe('router');
  });
});
