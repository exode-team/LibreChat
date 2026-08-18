import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import { scopeConversationToExodeAgent } from './agentScope';

const buildConversation = (overrides: Partial<TConversation> = {}): TConversation =>
  ({
    conversationId: Constants.NEW_CONVO,
    title: 'New Chat',
    endpoint: EModelEndpoint.agents,
    ...overrides,
  }) as TConversation;

describe('scopeConversationToExodeAgent', () => {
  it('pins a freshly built default conversation to the latched agent', () => {
    const conversation = buildConversation({ model: 'claude-opus-4-5' });

    scopeConversationToExodeAgent(conversation, 'agent_knowledge');

    expect(conversation.agent_id).toBe('agent_knowledge');
    expect(conversation.endpoint).toBe(EModelEndpoint.agents);
    /** The agent brings its own model — leaving the endpoint default set mixes the two */
    expect(conversation.model).toBeUndefined();
  });

  it('replaces an ephemeral agent, which the chat route rejects the same way as none', () => {
    const conversation = buildConversation({ agent_id: Constants.EPHEMERAL_AGENT_ID as string });

    scopeConversationToExodeAgent(conversation, 'agent_knowledge');

    expect(conversation.agent_id).toBe('agent_knowledge');
  });

  it('moves a non-agents default endpoint onto the embed agent', () => {
    const conversation = buildConversation({
      endpoint: EModelEndpoint.anthropic,
      endpointType: EModelEndpoint.anthropic,
    });

    scopeConversationToExodeAgent(conversation, 'agent_assistant');

    expect(conversation.endpoint).toBe(EModelEndpoint.agents);
    expect(conversation.endpointType).toBeUndefined();
    expect(conversation.agent_id).toBe('agent_assistant');
  });

  it('leaves a conversation that already names a real agent alone', () => {
    const conversation = buildConversation({
      conversationId: 'convo-1',
      agent_id: 'agent_written_by',
    });

    scopeConversationToExodeAgent(conversation, 'agent_knowledge');

    expect(conversation.agent_id).toBe('agent_written_by');
  });

  it.each([undefined, ''])('changes nothing outside the embed (latch %p)', (latched) => {
    const conversation = buildConversation({ model: 'claude-opus-4-5' });

    scopeConversationToExodeAgent(conversation, latched);

    expect(conversation.agent_id).toBeUndefined();
    expect(conversation.model).toBe('claude-opus-4-5');
  });
});
