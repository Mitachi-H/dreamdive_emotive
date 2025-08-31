const config = require("../config");

// Validate a provided token string against configured API token.
// If no token configured, accept all (no auth required).
function isTokenValid(provided) {
  const expected = config.apiToken;
  if (!expected) return true;
  return provided === expected;
}

// Express middleware enforcing Bearer token auth if configured.
function apiAuth(req, res, next) {
  if (!config.apiToken) return next();
  const auth = req.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && isTokenValid(m[1])) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

module.exports = { isTokenValid, apiAuth };

