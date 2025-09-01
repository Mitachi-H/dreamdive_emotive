import json
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import requests
import streamlit as st
from matplotlib import pyplot as plt
from urllib.parse import urlparse, urlunparse, urlencode
from websocket import WebSocketApp


# ---- Constants (mirror JS sample) ----
EPOCH_SEC = 30  # window size
HOP_SEC = 5     # update cadence
CHART_WINDOW_SEC = 300  # 5 minutes


# ---- Session state helpers ----
def ensure_state():
    s = st.session_state
    # Config
    s.setdefault("server_url", "http://localhost:3000")
    s.setdefault("api_token", "")
    # Streaming & WS
    s.setdefault("streaming", False)
    s.setdefault("ws_connected", False)
    s.setdefault("ws_thread", None)
    s.setdefault("ws_app", None)
    s.setdefault("ws_stop", threading.Event())
    s.setdefault("renew_thread", None)
    s.setdefault("client_id", f"py_{int(time.time())}_{np.random.randint(1000,9999)}")
    # Labels
    s.setdefault("pow_labels", [])
    s.setdefault("mot_labels", [])
    s.setdefault("dev_labels", [])
    # Buffers
    s.setdefault("buf_pow", [])   # list of dict { t, theta, alpha, beta, betaRel, ratioTA }
    s.setdefault("buf_mot", [])   # list of dict { t, accMag }
    s.setdefault("buf_fac", [])   # list of dict { t, eyeEvent }
    s.setdefault("dev_signal", {"t": 0, "v": float("nan")})  # 0..1 or NaN
    # Classification
    s.setdefault("last_stage", None)  # { label, conf, t }
    s.setdefault("stage_history", []) # [{ t, label, conf }]
    s.setdefault("last_step_at", 0.0)
    # Concurrency
    s.setdefault("lock", threading.Lock())
    # Throttle redraws
    s.setdefault("_last_redraw", 0.0)


# ---- Utility functions ----
def now_sec() -> float:
    return time.time()


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def prune_buffer(buf: List[dict], min_t: float) -> None:
    while buf and buf[0]["t"] < min_t:
        buf.pop(0)


def avg(values: List[float]) -> float:
    arr = [v for v in values if isinstance(v, (int, float)) and math.isfinite(v)]
    if not arr:
        return float("nan")
    return float(sum(arr)) / float(len(arr))


def median(values: List[float]) -> float:
    arr = sorted([v for v in values if isinstance(v, (int, float)) and math.isfinite(v)])
    if not arr:
        return float("nan")
    m = len(arr) // 2
    if len(arr) % 2:
        return float(arr[m])
    return float(arr[m - 1] + arr[m]) / 2.0


def build_ws_url(base_url: str, token: Optional[str]) -> str:
    p = urlparse(base_url)
    scheme = "wss" if p.scheme == "https" else "ws"
    q = {} if not token else {"token": token}
    return urlunparse((scheme, p.netloc, "/ws", "", urlencode(q), ""))


def headers(token: Optional[str]) -> Dict[str, str]:
    h = {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def http_post_json(base_url: str, path: str, body: dict, token: Optional[str]) -> dict:
    url = base_url.rstrip("/") + path
    res = requests.post(url, json=body, headers=headers(token), timeout=15)
    res.raise_for_status()
    ct = res.headers.get("content-type", "")
    return res.json() if "application/json" in ct else {"ok": True}


# ---- Feature extraction ----
def bands_from_pow_array(pow_labels: List[str], arr: List[float]) -> Dict[str, float]:
    sums = {"theta": 0.0, "alpha": 0.0, "betaL": 0.0, "betaH": 0.0, "gamma": 0.0}
    counts = {k: 0 for k in sums.keys()}
    for i, lab in enumerate(pow_labels or []):
        if i >= len(arr):
            break
        v = arr[i]
        if not isinstance(v, (int, float)) or not math.isfinite(v):
            continue
        parts = str(lab).split("/")
        if len(parts) != 2:
            continue
        band = parts[1]
        if band not in sums:
            continue
        sums[band] += float(v)
        counts[band] += 1

    def get(b: str) -> float:
        return (sums[b] / counts[b]) if counts[b] else float("nan")

    theta = get("theta")
    alpha = get("alpha")
    beta = (get("betaL") + get("betaH")) / 2.0
    total = 0.0
    for k in ("theta", "alpha", "betaL", "betaH", "gamma"):
        v = get(k)
        if math.isfinite(v):
            total += v
    beta_rel = (((get("betaL") or 0.0) + (get("betaH") or 0.0)) / total) if total > 0 else float("nan")
    ratio_ta = (theta / (alpha + 1e-6)) if (math.isfinite(theta) and math.isfinite(alpha)) else float("nan")
    return {
        "theta": theta,
        "alpha": alpha,
        "beta": beta,
        "betaRel": beta_rel,
        "ratioTA": ratio_ta,
    }


def compute_motion_rms_at(t_center: float, buf_mot: List[dict]) -> Tuple[float, float]:
    t0 = t_center - EPOCH_SEC
    window = [s for s in buf_mot if t0 <= s["t"] <= t_center]
    vals = [s["accMag"] for s in window]
    if not vals:
        return float("nan"), float("nan")
    m0 = median(vals)
    s2 = 0.0
    for v in vals:
        d = v - m0
        s2 += d * d
    rms = math.sqrt(s2 / len(vals))
    since = t_center - CHART_WINDOW_SEC
    recent_vals = [abs(s["accMag"] - m0) for s in buf_mot if since <= s["t"] <= t_center]
    peak = max(recent_vals) if recent_vals else (rms or 1.0)
    rel = (rms / (peak + 1e-6)) if peak > 0 else 0.0
    return rms, clamp(rel, 0.0, 1.0)


def compute_window_features(now_t: float, s) -> Dict[str, float]:
    with s.lock:
        prune_buffer(s.buf_pow, now_t - EPOCH_SEC)
        prune_buffer(s.buf_mot, now_t - EPOCH_SEC)
        prune_buffer(s.buf_fac, now_t - EPOCH_SEC)

        ths, als, bes, brs, ras = [], [], [], [], []
        for entry in s.buf_pow:
            if math.isfinite(entry.get("theta", float("nan"))) and math.isfinite(entry.get("alpha", float("nan"))):
                ths.append(entry["theta"]); als.append(entry["alpha"])
            if math.isfinite(entry.get("beta", float("nan"))):
                bes.append(entry["beta"])
            if math.isfinite(entry.get("betaRel", float("nan"))):
                brs.append(entry["betaRel"])
            if math.isfinite(entry.get("ratioTA", float("nan"))):
                ras.append(entry["ratioTA"])

        theta = avg(ths); alpha = avg(als); beta = avg(bes)
        beta_rel = avg(brs); ratio_ta = avg(ras)

        rms, rel = compute_motion_rms_at(now_t, s.buf_mot)

        eye_events = sum(1 for entry in s.buf_fac if entry["t"] >= now_t - EPOCH_SEC and entry.get("eyeEvent"))
        fac_rate = eye_events / EPOCH_SEC

        dev_sig = float(s.dev_signal["v"]) if (s.dev_signal and s.dev_signal.get("t", 0) > 0) else float("nan")

    return {
        "theta": theta,
        "alpha": alpha,
        "beta": beta,
        "betaRel": beta_rel,
        "ratioTA": ratio_ta,
        "motionRms": rms,
        "motionRel": rel,
        "facRate": fac_rate,
        "devSig": dev_sig,
    }


def classify(features: Dict[str, float], now_t: float, s) -> Tuple[str, float]:
    ratio_ta = features.get("ratioTA", float("nan"))
    motion_rel = features.get("motionRel", float("nan"))
    beta_rel = features.get("betaRel", float("nan"))
    fac_rate = features.get("facRate", 0.0)
    dev_sig = features.get("devSig", float("nan"))

    if not (math.isfinite(ratio_ta) and math.isfinite(motion_rel) and math.isfinite(beta_rel)):
        return "unknown", 0.0

    # Poor signal gate
    if math.isfinite(dev_sig) and dev_sig < 0.30:
        return "poor_quality", 0.0

    scores = {"Wake": 0.0, "Light": 0.0, "REM": 0.0, "Deep": 0.0}

    # Primary sleep/wake
    if ratio_ta >= 1.20 and motion_rel <= 0.15:
        scores["Light"] += 0.6
    if ratio_ta < 1.00 or motion_rel > 0.25:
        scores["Wake"] += 0.7

    # Deep sleep candidate
    if motion_rel <= 0.10 and beta_rel <= 0.22:
        scores["Deep"] += 0.4

    # REM candidate (no EOG): quiet body + higher beta_rel + eye movement events
    if motion_rel <= 0.15 and beta_rel >= 0.35 and (fac_rate or 0) > 0.02:
        scores["REM"] += 0.3

    # Fallback
    if all(v == 0 for v in scores.values()):
        scores["Light"] += 0.5

    label, conf = max(scores.items(), key=lambda kv: kv[1])

    # Hysteresis smoothing
    last = s.last_stage
    if last and last.get("label") and last.get("label") != "poor_quality" and label != last.get("label"):
        dt = now_t - (last.get("t") or 0)
        if dt < 20 and conf < 0.80:
            label, conf = last["label"], last["conf"]
        if last["label"] == "Wake" and label == "REM" and conf < 0.90:
            label, conf = last["label"], last["conf"]
        if label == "Deep" and conf < 0.70:
            label, conf = last["label"], last["conf"]

    return label, conf


# ---- WebSocket handling ----
def ws_on_open(_):
    st.session_state.ws_connected = True


def ws_on_close(_, __, ___):
    st.session_state.ws_connected = False


def ws_on_message(_, message: str):
    s = st.session_state
    try:
        data = json.loads(message)
    except Exception:
        return
    typ = data.get("type")
    payload = data.get("payload", {})
    t = float(payload.get("time", now_sec()))

    with s.lock:
        if typ == "labels":
            stream_name = payload.get("streamName")
            labels = payload.get("labels") or []
            if stream_name == "pow":
                s.pow_labels = labels
            elif stream_name == "mot":
                s.mot_labels = labels
            elif stream_name == "dev":
                s.dev_labels = labels
            return

        if typ == "pow":
            arr = payload.get("pow") or []
            if arr and s.pow_labels:
                b = bands_from_pow_array(s.pow_labels, arr)
                s.buf_pow.append({"t": t, **b})
                prune_buffer(s.buf_pow, now_sec() - CHART_WINDOW_SEC)
            return

        if typ == "mot":
            arr = payload.get("mot") or []
            if arr and s.mot_labels:
                try:
                    i_x = s.mot_labels.index("ACCX")
                    i_y = s.mot_labels.index("ACCY")
                    i_z = s.mot_labels.index("ACCZ")
                except ValueError:
                    i_x = i_y = i_z = -1
                if min(i_x, i_y, i_z) >= 0 and max(i_x, i_y, i_z) < len(arr):
                    try:
                        ax = float(arr[i_x]); ay = float(arr[i_y]); az = float(arr[i_z])
                        acc_mag = math.hypot(ax, ay, az)
                        s.buf_mot.append({"t": t, "accMag": acc_mag})
                        prune_buffer(s.buf_mot, now_sec() - CHART_WINDOW_SEC)
                    except Exception:
                        pass
            return

        if typ == "dev":
            arr = payload.get("dev") or []
            sig = float(arr[1]) if (len(arr) > 1 and isinstance(arr[1], (int, float))) else float("nan")
            if math.isfinite(sig):
                s.dev_signal = {"t": t, "v": clamp(sig, 0.0, 1.0)}
            return

        if typ == "fac":
            arr = payload.get("fac") or []
            eye_act = arr[0] if arr else None
            eye_event = (isinstance(eye_act, str) and ("look" in eye_act.lower() or "left" in eye_act.lower() or "right" in eye_act.lower()))
            s.buf_fac.append({"t": t, "eyeEvent": bool(eye_event)})
            prune_buffer(s.buf_fac, now_sec() - CHART_WINDOW_SEC)
            return


def start_ws_thread(base_url: str, token: Optional[str]):
    stop_event = st.session_state.ws_stop
    stop_event.clear()
    url = build_ws_url(base_url, token)
    app = WebSocketApp(url, on_open=ws_on_open, on_close=ws_on_close, on_message=ws_on_message)
    st.session_state.ws_app = app

    def run():
        # WebSocketApp.run_forever blocks; stop via close
        try:
            app.run_forever(ping_interval=25, ping_timeout=10)
        except Exception:
            pass
        finally:
            st.session_state.ws_connected = False

    th = threading.Thread(target=run, name="ws-thread", daemon=True)
    st.session_state.ws_thread = th
    th.start()


def stop_ws():
    app = st.session_state.ws_app
    try:
        if app:
            try:
                app.close()
            except Exception:
                pass
    finally:
        st.session_state.ws_app = None
        st.session_state.ws_thread = None
        st.session_state.ws_connected = False


def start_renew_thread(base_url: str, token: Optional[str]):
    # Renew pow lease every 30s
    def loop():
        while st.session_state.streaming:
            try:
                http_post_json(base_url, "/api/stream/pow/renew", {"ttlMs": 90_000, "clientId": st.session_state.client_id}, token)
            except Exception:
                pass
            # Sleep ~30s
            for _ in range(30):
                if not st.session_state.streaming:
                    return
                time.sleep(1)

    th = threading.Thread(target=loop, name="renew-thread", daemon=True)
    st.session_state.renew_thread = th
    th.start()


def start_streams(base_url: str, token: Optional[str]):
    # Start pow/mot/dev/fac
    body = {"clientId": st.session_state.client_id}
    http_post_json(base_url, "/api/stream/pow/start", body, token)
    http_post_json(base_url, "/api/stream/mot/start", body, token)
    http_post_json(base_url, "/api/stream/dev/start", body, token)
    http_post_json(base_url, "/api/stream/fac/start", body, token)


def stop_streams(base_url: str, token: Optional[str]):
    body = {"clientId": st.session_state.client_id}
    for stream in ("pow", "mot", "dev", "fac"):
        try:
            http_post_json(base_url, f"/api/stream/{stream}/stop", body, token)
        except Exception:
            pass


# ---- UI / App ----
def draw_chart(now_t: float, s):
    # Prepare series over last CHART_WINDOW_SEC
    x0 = now_t - CHART_WINDOW_SEC
    with s.lock:
        pow_recent = [e for e in s.buf_pow if e["t"] >= x0]
        mot_recent = [e for e in s.buf_mot if e["t"] >= x0]

    series_ta = [(e["t"], e.get("ratioTA")) for e in pow_recent if math.isfinite(e.get("ratioTA", float("nan")))]
    series_br = [(e["t"], e.get("betaRel")) for e in pow_recent if math.isfinite(e.get("betaRel", float("nan")))]

    # motion: sample smoothed rel every ~2s for chart
    series_mr = []
    step = max(2, int(CHART_WINDOW_SEC / 120))
    for t in np.arange(x0, now_t + 1e-6, step):
        rms, rel = compute_motion_rms_at(float(t), mot_recent)
        if math.isfinite(rel):
            series_mr.append((float(t), rel))

    # Plot with matplotlib (simple overlay)
    fig, ax1 = plt.subplots(figsize=(8, 3))

    if series_ta:
        xs, ys = zip(*series_ta)
        ax1.plot(xs, ys, color="#1d4ed8", label="theta/alpha")
        ax1.set_ylim(0, 3)
    if series_br:
        xs, ys = zip(*series_br)
        ax1.plot(xs, ys, color="#059669", label="beta_rel")
    ax1.set_ylabel("TA | beta_rel")
    ax1.set_xlabel("time (s)")

    ax2 = ax1.twinx()
    if series_mr:
        xs, ys = zip(*series_mr)
        ax2.plot(xs, ys, color="#d97706", label="motion", alpha=0.8)
    ax2.set_ylim(0, 1)
    ax2.set_ylabel("motionRel")

    # Legend handling
    lines, labels = [], []
    for ax in (ax1, ax2):
        for ln in ax.get_lines():
            lines.append(ln)
    labels = [ln.get_label() for ln in lines]
    if lines:
        ax1.legend(lines, labels, loc="upper left")

    st.pyplot(fig, clear_figure=True)


def main():
    st.set_page_config(page_title="Sleep Detection (Python Sample)", layout="wide")
    ensure_state()

    st.title("Sleep Detection (Python Sample)")
    with st.sidebar:
        st.header("Connection")
        st.session_state.server_url = st.text_input("Server URL", st.session_state.server_url)
        st.session_state.api_token = st.text_input("API Token (optional)", st.session_state.api_token, type="password")

        cols = st.columns(2)
        with cols[0]:
            if st.button("Start", use_container_width=True, disabled=st.session_state.streaming):
                try:
                    # mark streaming before starting background threads
                    st.session_state.streaming = True
                    start_streams(st.session_state.server_url, st.session_state.api_token or None)
                    start_ws_thread(st.session_state.server_url, st.session_state.api_token or None)
                    start_renew_thread(st.session_state.server_url, st.session_state.api_token or None)
                except Exception as e:
                    st.session_state.streaming = False
                    st.error(f"Start error: {e}")
        with cols[1]:
            if st.button("Stop", use_container_width=True, disabled=not st.session_state.streaming):
                try:
                    st.session_state.streaming = False
                    stop_ws()
                    stop_streams(st.session_state.server_url, st.session_state.api_token or None)
                except Exception as e:
                    st.error(f"Stop error: {e}")

        st.markdown("---")
        st.caption("Status")
        st.write(f"WS: {'connected' if st.session_state.ws_connected else 'disconnected'}")

    # Classification + metrics
    now_t = now_sec()
    if now_t - st.session_state.last_step_at >= HOP_SEC:
        f = compute_window_features(now_t, st.session_state)
        label, conf = classify(f, now_t, st.session_state)
        st.session_state.last_step_at = now_t

        if label not in ("poor_quality", "unknown"):
            last = st.session_state.last_stage or {}
            if (not last) or (last.get("label") != label) or (abs(conf - last.get("conf", 0.0)) > 1e-3):
                st.session_state.last_stage = {"label": label, "conf": conf, "t": now_t}
                st.session_state.stage_history.append({"t": now_t, "label": label, "conf": conf})
            else:
                st.session_state.last_stage["t"] = now_t

        # Prune history
        while st.session_state.stage_history and st.session_state.stage_history[0]["t"] < now_t - CHART_WINDOW_SEC:
            st.session_state.stage_history.pop(0)

        # Store last features for display
        st.session_state._last_features = f
        st.session_state._last_label = label
        st.session_state._last_conf = conf

    # Header cards
    cols = st.columns([2, 3])
    with cols[0]:
        label = st.session_state.get("_last_label", "unknown")
        conf = st.session_state.get("_last_conf", 0.0)
        if label == "poor_quality":
            st.subheader("Poor signal")
        elif label == "unknown":
            st.subheader("Analyzing…")
        else:
            st.subheader(f"{label} (conf {conf:.2f})")
        f = st.session_state.get("_last_features", {})
        sig_txt = f"signal {f.get('devSig', float('nan')):.2f}" if math.isfinite(f.get("devSig", float("nan"))) else ""
        ratio_txt = (f"theta/alpha {f.get('ratioTA', float('nan')):.2f} | "
                     f"beta_rel {f.get('betaRel', float('nan')):.2f} | "
                     f"motion {f.get('motionRel', float('nan')):.2f}")
        if sig_txt:
            st.caption(sig_txt)
        st.caption(ratio_txt)

    with cols[1]:
        draw_chart(now_t, st.session_state)

    # Light auto-refresh while streaming (1s)
    if st.session_state.streaming:
        # throttle to avoid tight reruns
        if now_t - st.session_state._last_redraw >= 1.0:
            st.session_state._last_redraw = now_t
            st.experimental_rerun()


if __name__ == "__main__":
    main()
