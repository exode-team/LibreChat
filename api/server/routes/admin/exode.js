const express = require('express');
const {
  createExodeProvisionUserController,
  createExodeReprovisionAgentsController,
} = require('@librechat/api');
const { SystemCapabilities, getTenantId } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { findUser, createUser, updateUser, getAgents, updateAgent } = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

const provisionUser = createExodeProvisionUserController({
  findUser,
  createUser,
  updateUser,
  getTenantId,
});

const reprovisionAgents = createExodeReprovisionAgentsController({
  getAgents,
  updateAgent,
});

/**
 * Server-to-server provisioning of exode principals.
 *
 * Admin-gated rather than secret-gated: the caller (the AI service) already signs in with an
 * admin service account to drive the agent APIs, so this reuses that session instead of
 * introducing another shared secret to distribute and rotate.
 */
router.use(requireJwtAuth, requireAdminAccess);

router.post('/users', provisionUser);

/**
 * Bring every Agent in line with the deployment's current configuration: the LLM provider/model,
 * and the per-kind system instructions when the caller sends them.
 *
 * An Agent records `provider`/`model` permanently at creation time and nothing re-reads the
 * environment afterward, so switching the deployment's LLM provider would otherwise strand
 * every previously-created agent on the old one. `instructions` behave the same way, and matter
 * more: a prompt is where the product's guardrails live, so without this an agent created before
 * a fix keeps answering under the old rules. The AI service calls this on startup.
 *
 * Native route rather than a sweep over `GET`/`PATCH /api/agents` because that list is
 * ACL-scoped with no admin bypass — a REST sweep silently skips agents the service account
 * was never granted EDIT on. See `reprovisionAgents` for the full rationale.
 *
 * Path kept as `reprovision-provider` for compatibility with already-deployed callers.
 */
router.post('/agents/reprovision-provider', reprovisionAgents);

module.exports = router;
