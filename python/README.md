# Python Dashboard Samples

This folder contains a minimal Python example to build dashboards against the Node server in this repo. It connects via the same REST + WebSocket API used by the web dashboards.

## Sleep Detection (Streamlit)

Path: `python/sleep_dashboard/app.py`

Features:
- Starts `pow`, `mot`, `dev`, `fac` streams via REST
- Connects to `ws://<server>/ws` and consumes stream payloads
- Computes theta/alpha ratio, beta_rel, motion magnitude and performs a simple sleep-stage heuristic (Wake/Light/REM/Deep)
- Shows current stage and a small time-series chart

### Setup

Option A: Quick, all-in-one

```
bash scripts/setup.sh
```

Option B: Manual setup

1) Ensure the Node server is running

```
cd server
npm install
npm start
# -> http://localhost:3000
```

2) (Optional) If you set `API_AUTH_TOKEN` in `server/.env`, note the token. You will need it for both REST and WS.

3) Create a venv and install Python deps

```
python3 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r python/requirements.txt
```

### Run

```
streamlit run python/sleep_dashboard/app.py
```

In the app:
- Server URL: `http://localhost:3000` (change if remote)
- API Token: set if the server is protected (blank if not)
- Click Start to subscribe and begin receiving data; Stop to unsubscribe

Notes:
- This is a minimal sample intended for local development. It uses the same data contract as the web dashboards.
- If you are not receiving data, ensure a headset is connected and streams are started (the app triggers start automatically on Start).
