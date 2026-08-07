import type { IAgent } from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import { reprovisionAgentProviders } from './reprovision';
import type { ExodeReprovisionAgentProviderDeps } from './reprovision';

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
  getAgents: jest.Mock & ExodeReprovisionAgentProviderDeps['getAgents'];
  updateAgent: jest.Mock & ExodeReprovisionAgentProviderDeps['updateAgent'];
};

function makeDeps(
  overrides: Partial<MockedDeps> = {},
): MockedDeps & ExodeReprovisionAgentProviderDeps {
  const getAgents = jest.fn(async (filter: FilterQuery<IAgent>) =>
    applyStaleFilter(filter),
  ) as MockedDeps['getAgents'];
  const updateAgent = jest.fn(
    async (searchParameter: FilterQuery<IAgent>) =>
      ({ id: searchParameter.id }) as unknown as IAgent,
  ) as MockedDeps['updateAgent'];
  return { getAgents, updateAgent, ...overrides };
}

describe('reprovisionAgentProviders', () => {
  it('only touches agents not already on the target provider/model', async () => {
    const deps = makeDeps();
    const result = await reprovisionAgentProviders(deps, {
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
    const result = await reprovisionAgentProviders(deps, {
      provider: 'qwen',
      model: 'qwen-max',
    });

    expect(result).toMatchObject({ total: 0, changed: 0, failed: 0 });
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it('dry_run reports the pending count without writing', async () => {
    const deps = makeDeps();
    const result = await reprovisionAgentProviders(deps, {
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

    const result = await reprovisionAgentProviders(deps, {
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
    await reprovisionAgentProviders(deps, { provider: 'qwen', model: 'qwen-max' });

    expect(deps.updateAgent.mock.calls[0][1]).toEqual({
      provider: 'qwen',
      model: 'qwen-max',
    });
  });
});
