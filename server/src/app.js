const path = require("path");
const express = require("express");
const fs = require("fs");
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
  // Serve exported files for download
  const exportsRoot = path.join(__dirname, "..", "exports");
  try { fs.mkdirSync(exportsRoot, { recursive: true }); } catch (_) {}
  app.use("/downloads", express.static(exportsRoot, { extensions: ["csv", "edf", "json", "bdf"] }));

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

  // Facial expression page
  app.get('/Facial_expression', (_req, res) => {
    res.sendFile(path.join(webDir, 'Facial_expression.html'));
  });

  // Records page
  app.get('/Records', (_req, res) => {
    res.sendFile(path.join(webDir, 'Records.html'));
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

  // Stream control: start/stop fac (facial expression) subscription
  app.post("/api/stream/fac/start", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const headsetId = req.body && req.body.headsetId ? String(req.body.headsetId) : undefined;
      await cortex.ensureReadyForStreams(headsetId);
      await cortex.subscribe(["fac"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/stream/fac/stop", apiAuth, limiter, async (_req, res) => {
    try {
      await cortex.unsubscribe(["fac"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // ----- Records API -----
  // Start a record, optionally subscribe to selected streams first
  app.post('/api/record/start', apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const { headsetId, subscribeStreams, title, description, subjectName, tags, experimentId } = req.body || {};
      if (!title) return res.status(400).json({ ok: false, error: 'Missing title' });
      await cortex.ensureReadyForStreams(headsetId);
      if (Array.isArray(subscribeStreams) && subscribeStreams.length) {
        await cortex.subscribe(subscribeStreams.map(String));
      }
      const result = await cortex.createRecord({ title: String(title), description, subjectName, tags, experimentId });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Stop the current record (by session)
  app.post('/api/record/stop', apiAuth, limiter, async (_req, res) => {
    try {
      const result = await cortex.stopRecord();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Export a record and return downloadable URLs
  app.post('/api/record/export', apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const { recordId, exportStreams, format, version, includeMarkerExtraInfos, includeSurvey, includeDemographics, includeDeprecatedPM } = req.body || {};
      if (!recordId) return res.status(400).json({ ok: false, error: 'Missing recordId' });
      const streams = Array.isArray(exportStreams) && exportStreams.length ? exportStreams.map(String) : ['EEG'];
      const fmt = (format || 'CSV').toUpperCase();
      const ver = version || (fmt === 'CSV' ? 'V2' : undefined);

      // create unique subfolder
      const safeId = String(recordId).replace(/[^a-zA-Z0-9_-]/g, '');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const subdir = `${safeId || 'record'}_${stamp}`;
      const folder = path.join(exportsRoot, subdir);
      try { fs.mkdirSync(folder, { recursive: true }); } catch (_) {}

      const result = await cortex.exportRecordWithRetry({
        recordIds: [recordId],
        folder,
        streamTypes: streams,
        format: fmt,
        version: ver,
        includeMarkerExtraInfos: !!includeMarkerExtraInfos,
        includeSurvey: !!includeSurvey,
        includeDemographics: !!includeDemographics,
        includeDeprecatedPM: !!includeDeprecatedPM,
      });

      // Collect file list in the subdir
      let files = [];
      try {
        files = fs.readdirSync(folder).map((f) => ({ name: f, url: `/downloads/${subdir}/${encodeURIComponent(f)}` }));
      } catch (_) {}

      res.json({ ok: true, export: result, folder: `/downloads/${subdir}`, files });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  return app;
}

module.exports = { createApp };
