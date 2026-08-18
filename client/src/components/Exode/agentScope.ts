import { EModelEndpoint, isEphemeralAgentId } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import { clearModelForNonEphemeralAgent } from '~/utils';

/**
 * Pin a conversation to the agent this embed was opened with. Mutates in place.
 *
 * The embed has no agent picker — the frame is scoped to the single agent exode provisioned for
 * this principal, and the only thing that ever names it is the `agent_id` the bridge writes onto
 * the URL. That param is turned into conversation state exactly once per frame load (ChatRoute's
 * query-param path, gated by the `hasSetConversation` ref in `Root`). Every later new
 * conversation — the sidebar's "New chat", the keyboard shortcut — is rebuilt from the default
 * endpoint and carries no agent, so the first send fails with `agent_id is required in request
 * body` until the whole iframe is reloaded.
 *
 * A conversation that already names a real agent is left alone: that is one loaded from the
 * server, and it knows which agent actually wrote it better than the latch does.
 */
export function scopeConversationToExodeAgent(
  conversation: TConversation,
  latchedAgentId: string | undefined,
): void {
  if (latchedAgentId == null || latchedAgentId === '') {
    return;
  }

  const currentAgentId = conversation.agent_id;
  if (currentAgentId != null && currentAgentId !== '' && !isEphemeralAgentId(currentAgentId)) {
    return;
  }

  conversation.endpoint = EModelEndpoint.agents;
  conversation.endpointType = undefined;
  conversation.agent_id = latchedAgentId;
  /** An agent brings its own model; leaving the default endpoint's model set mixes the two. */
  clearModelForNonEphemeralAgent(conversation);
}
