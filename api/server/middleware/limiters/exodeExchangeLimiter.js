const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts } = require('@librechat/api');
const { logViolation } = require('~/cache');

/**
 * Rate limit for the exode embed token exchange.
 *
 * Separate from `loginLimiter` because the two guard different things. That one throttles
 * password guessing, where a handful of tries per window is the whole point. Here the credential
 * is a signed single-use token bound to a handshake id — unguessable, and already burned by main
 * on first use — so the limit is not what stops an attacker. It only caps the damage a runaway
 * frame can do.
 *
 * Meanwhile a legitimate embed spends attempts just by existing: one per iframe load, one per
 * token refresh (every few minutes), one more each time the student reloads the page. At
 * `loginLimiter`'s 7-per-5-minutes that is a lockout during ordinary use, which is exactly what
 * staging hit.
 */
const {
  EXODE_EXCHANGE_WINDOW = 5,
  EXODE_EXCHANGE_MAX = 60,
  EXODE_EXCHANGE_VIOLATION_SCORE: score,
} = process.env;

const windowMs = EXODE_EXCHANGE_WINDOW * 60 * 1000;
const max = EXODE_EXCHANGE_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many chat session attempts, please try again after ${windowInMinutes} minutes.`;

const handler = async (req, res) => {
  const type = ViolationTypes.LOGINS;
  const errorMessage = { type, max, windowInMinutes };

  await logViolation(req, res, type, errorMessage, score);
  return res.status(429).json({ code: 'AI_CHAT_LIMIT', message });
};

const exodeExchangeLimiter = rateLimit({
  windowMs,
  max,
  handler,
  keyGenerator: removePorts,
  store: limiterCache('exode_exchange_limiter'),
});

module.exports = exodeExchangeLimiter;
