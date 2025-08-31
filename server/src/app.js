const path = require("path");
const express = require("express");

// Build an Express app with routes wired to a provided Cortex-like client.
function createApp(cortex) {
  const app = express();

  // Serve static dashboard
  const webDir = path.join(__dirname, "..", "..", "web");
  app.use(express.static(webDir));

  // Simple healthcheck
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Authentication info API (aggregates Cortex auth endpoints)
  app.get("/api/authentication", async (_req, res) => {
    try {
      await cortex.connect();
      const userLogin = await cortex
        .getUserLogin()
        .catch((e) => ({ error: e.message || String(e) }));

      // Try authorize but don't fail entire response
      let authorizeError = null;
      try {
        await cortex.authorize();
      } catch (e) {
        authorizeError = e.message || String(e);
      }

      const accessRight = await cortex
        .hasAccessRight()
        .catch((e) => ({ error: e.message || String(e) }));
      const userInfo = cortex.authToken
        ? await cortex
            .getUserInformation()
            .catch((e) => ({ error: e.message || String(e) }))
        : { error: authorizeError || "Not authorized" };
      const licenseInfo = cortex.authToken
        ? await cortex
            .getLicenseInfo()
            .catch((e) => ({ error: e.message || String(e) }))
        : { error: authorizeError || "Not authorized" };

      res.json({
        ok: true,
        userLogin,
        accessRight,
        userInfo,
        licenseInfo,
        authorizeError,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Serve the Authentication page at /authentication
  app.get("/authentication", (_req, res) => {
    const webDir = path.join(__dirname, "..", "..", "web");
    res.sendFile(path.join(webDir, "authentication.html"));
  });

  // Request access flow: user must approve in Emotiv Launcher
  app.post("/api/request-access", async (_req, res) => {
    try {
      await cortex.connect();
      const result = await cortex.requestAccess();
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  return app;
}

module.exports = { createApp };
