const path = require("path");
const express = require("express");
const fs = require("fs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("./config");
const { apiAuth } = require("./utils/auth");
const streamRefs = require("./utils/streamManager");

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
  // Dashboards discovery API (non-invasive): reads web/dashboards/*/manifest.json
  app.get("/api/dashboards", apiAuth, async (_req, res) => {
    try {
      const dashboardsRoot = path.join(webDir, "dashboards");
      let items = [];
      try {
        const entries = fs.readdirSync(dashboardsRoot, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          const dir = path.join(dashboardsRoot, ent.name);
          const manifestPath = path.join(dir, "manifest.json");
          if (!fs.existsSync(manifestPath)) continue;
          try {
            const raw = fs.readFileSync(manifestPath, "utf8");
            const manifest = JSON.parse(raw);
            items.push({
              name: ent.name,
              title: manifest.title || ent.name,
              description: manifest.description || "",
              path: `/dashboards/${encodeURIComponent(ent.name)}`,
              icon: manifest.icon || null,
              tags: Array.isArray(manifest.tags) ? manifest.tags : [],
            });
          } catch (_) { /* skip broken manifest */ }
        }
      } catch (_) { /* no dashboards dir */ }
      res.json({ ok: true, dashboards: items });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Convenience routes so /dashboards and /dashboards/:name work without trailing slash
  app.get("/dashboards", (_req, res) => {
    res.sendFile(path.join(webDir, "dashboards", "index.html"));
  });
  // Only accept safe names; avoid matching files like /dashboards/index.js
  // Redirect to a trailing slash so relative imports like `./index.js` resolve under the folder
  app.get("/dashboards/:name([A-Za-z0-9_-]+)", (req, res) => {
    const name = req.params.name;
    const dir = path.join(webDir, "dashboards", name);
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(404).send("Not Found");
    } catch (_) { return res.status(404).send("Not Found"); }
    res.redirect(302, `/dashboards/${encodeURIComponent(name)}/`);
  });
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

  // Helpers to hash remote address for fallback client identity
  const clientKeyFromReq = (req) => {
    const hdrId = req.get('x-client-id');
    if (hdrId) return String(hdrId);
    if (req.body && req.body.clientId) return String(req.body.clientId);
    // Fallback: remote IP
    return String(req.ip || req.connection?.remoteAddress || '');
  };

  // Stream control: start/stop pow subscription with ref counting
  app.post("/api/stream/pow/start", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const headsetId = req.body && req.body.headsetId ? String(req.body.headsetId) : undefined;
      const clientId = clientKeyFromReq(req);
      const { first } = streamRefs.start('pow', clientId);
      if (first) {
        await cortex.ensureReadyForStreams(headsetId);
        await cortex.subscribe(["pow"]);
      }
      const status = streamRefs.status('pow');
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/stream/pow/stop", apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const clientId = clientKeyFromReq(req);
      const { empty } = streamRefs.stop('pow', clientId);
      if (empty) await cortex.unsubscribe(["pow"]);
      const status = streamRefs.status('pow');
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // Pow: status and renew endpoints
  app.get('/api/stream/pow/status', apiAuth, limiter, async (_req, res) => {
    try {
      const status = streamRefs.status('pow');
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post('/api/stream/pow/renew', apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const clientId = clientKeyFromReq(req);
      const ttlMs = req.body && req.body.ttlMs ? Number(req.body.ttlMs) : undefined;
      streamRefs.renew('pow', clientId, ttlMs);
      const status = streamRefs.status('pow');
      res.json({ ok: true, status });
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

  // Facial expression: get/set threshold for an action
  app.post('/api/fac/threshold', apiAuth, limiter, express.json(), async (req, res) => {
    try {
      const { status, action, value, profile, session, headsetId } = req.body || {};
      const st = String(status || '').toLowerCase();
      if (st !== 'get' && st !== 'set') return res.status(400).json({ ok: false, error: 'status must be "get" or "set"' });
      if (!action || typeof action !== 'string') return res.status(400).json({ ok: false, error: 'Missing action' });
      // Map UI synonyms to Cortex canonical tokens
      const mapFacAction = (s) => {
        const x = String(s || '').toLowerCase();
        if (x === 'blink') return 'blink';
        if (x === 'winkl' || x === 'wink_left' || x === 'winkleft') return 'winkLeft';
        if (x === 'winkr' || x === 'wink_right' || x === 'winkright') return 'winkRight';
        if (x === 'lookl' || x === 'lookleft' || x === 'lookr' || x === 'lookright' || x === 'horieye' || x === 'hori_eye' || x === 'hori') return 'horiEye';
        if (s === 'winkL' || s === 'winkR' || s === 'lookL' || s === 'lookR') return mapFacAction(s.toLowerCase());
        // passthrough for already canonical like 'winkLeft', 'winkRight', 'horiEye'
        if (s === 'winkLeft' || s === 'winkRight' || s === 'horiEye') return s;
        return null;
      };
      const actionCanon = mapFacAction(action);
      if (!actionCanon) return res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
      if (st === 'set') {
        const v = Number(value);
        if (!Number.isFinite(v)) return res.status(400).json({ ok: false, error: 'value must be a number' });
        if (v < 0 || v > 1000) return res.status(400).json({ ok: false, error: 'value must be between 0 and 1000' });
      }
      // Ensure authorized and have session (unless explicit profile provided)
      if (!session && !profile) {
        await cortex.ensureReadyForStreams(headsetId);
      } else {
        // At least ensure we are authorized
        await cortex.connect();
        await cortex.authorize();
      }
      const result = await cortex.facialExpressionThreshold({ status: st, action: actionCanon, value, profile, session });
      res.json({ ok: true, result });
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
