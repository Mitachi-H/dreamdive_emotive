const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");
const { apiAuth } = require("./utils/auth");

// Build an Express app with routes wired to a provided Cortex-like client.
function createApp(cortex) {
  const app = express();

  // Security headers (keep CSP off to not break local scripts/styles)
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));

  // Basic rate limit for API endpoints
  const limiter = rateLimit({ windowMs: 60_000, max: 120 });

  // Serve static dashboard
  const webDir = path.join(__dirname, "..", "..", "web");
  // Disable directory redirects so /pow (our route) doesn't 301 to /pow/
  app.use(express.static(webDir, { redirect: false }));

  // Simple healthcheck
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Authentication info API (aggregates Cortex auth endpoints)
  app.get("/api/authentication", apiAuth, limiter, async (_req, res) => {
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
    res.sendFile(path.join(webDir, "authentication.html"));
  });

  // Request access flow: user must approve in Emotiv Launcher
  app.post("/api/request-access", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.connect();
      const result = await cortex.requestAccess();
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Headset info: query and control
  app.get("/api/headset", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.connect();
      const list = await cortex.queryHeadsets();
      res.json({ ok: true, headsets: list });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/headset/refresh", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.connect();
      await cortex.controlDevice('refresh');
      const list = await cortex.queryHeadsets();
      res.json({ ok: true, headsets: list });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/headset/connect", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      await cortex.connect();
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
      await cortex.controlDevice('connect', id);
      const list = await cortex.queryHeadsets();
      res.json({ ok: true, headsets: list });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Headset page
  app.get('/headset', (_req, res) => {
    res.sendFile(path.join(webDir, 'headset.html'));
  });

  // Pow page
  app.get('/pow', (_req, res) => {
    res.sendFile(path.join(webDir, 'pow.html'));
  });

  // Motion page
  app.get('/motion', (_req, res) => {
    res.sendFile(path.join(webDir, 'motion.html'));
  });

  // Device information page
  app.get('/device_information', (_req, res) => {
    res.sendFile(path.join(webDir, 'device_information.html'));
  });

  // EEG Quality page
  app.get('/EEG_Quality', (_req, res) => {
    res.sendFile(path.join(webDir, 'EEG_Quality.html'));
  });

  // Performance metric page
  app.get('/Performance_metric', (_req, res) => {
    res.sendFile(path.join(webDir, 'Performance_metric.html'));
  });

  // Mental command page
  app.get('/Mental_command', (_req, res) => {
    res.sendFile(path.join(webDir, 'Mental_command.html'));
  });

  // Stream control: start/stop pow subscription
  app.post("/api/stream/pow/start", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const headsetId = req.body && req.body.headsetId ? String(req.body.headsetId) : undefined;
      await cortex.ensureReadyForStreams(headsetId);
      await cortex.subscribe(["pow"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/stream/pow/stop", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.unsubscribe(["pow"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Stream control: start/stop mot (motion) subscription
  app.post("/api/stream/mot/start", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const headsetId = req.body && req.body.headsetId ? String(req.body.headsetId) : undefined;
      await cortex.ensureReadyForStreams(headsetId);
      await cortex.subscribe(["mot"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/stream/mot/stop", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.unsubscribe(["mot"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Stream control: start/stop dev (device information) subscription
  app.post("/api/stream/dev/start", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const headsetId = req.body && req.body.headsetId ? String(req.body.headsetId) : undefined;
      await cortex.ensureReadyForStreams(headsetId);
      await cortex.subscribe(["dev"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/stream/dev/stop", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.unsubscribe(["dev"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Stream control: start/stop eq (EEG quality) subscription
  app.post("/api/stream/eq/start", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const headsetId = req.body && req.body.headsetId ? String(req.body.headsetId) : undefined;
      await cortex.ensureReadyForStreams(headsetId);
      await cortex.subscribe(["eq"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/stream/eq/stop", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.unsubscribe(["eq"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Stream control: start/stop met (performance metric) subscription
  app.post("/api/stream/met/start", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const headsetId = req.body && req.body.headsetId ? String(req.body.headsetId) : undefined;
      await cortex.ensureReadyForStreams(headsetId);
      await cortex.subscribe(["met"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/stream/met/stop", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.unsubscribe(["met"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Stream control: start/stop com (mental command) subscription
  app.post("/api/stream/com/start", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const headsetId = req.body && req.body.headsetId ? String(req.body.headsetId) : undefined;
      await cortex.ensureReadyForStreams(headsetId);
      await cortex.subscribe(["com"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/stream/com/stop", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.unsubscribe(["com"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  return app;
}

module.exports = { createApp };
