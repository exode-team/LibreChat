const express = require('express');
const {
  createExodeProvisionUserController,
  createExodeReprovisionAgentProviderController,
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

const reprovisionAgentProvider = createExodeReprovisionAgentProviderController({
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
 * Repoint every Agent at the deployment's currently configured LLM provider/model.
 *
 * An Agent records `provider`/`model` permanently at creation time and nothing re-reads the
 * environment afterward, so switching the deployment's LLM provider would otherwise strand
 * every previously-created agent on the old one. The AI service calls this on startup.
 *
 * Native route rather than a sweep over `GET`/`PATCH /api/agents` because that list is
 * ACL-scoped with no admin bypass — a REST sweep silently skips agents the service account
 * was never granted EDIT on. See `reprovisionAgentProviders` for the full rationale.
 */
router.post('/agents/reprovision-provider', reprovisionAgentProvider);

module.exports = router;
