#!/usr/bin/env python3
"""
### Python 仮想環境(venv)の作成と依存関係の導入

ターミナルで以下を実行：

```bash
cd python
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```


EOG HTTP pusher for Arduino UNO + AD8232.

Reads CSV lines: millis,raw,lop,lon from a serial port and batches them to
  POST /api/eog/push  (JSON)
on the dashboard server. The server broadcasts them over WebSocket as type "eog".

Usage:
  python eog_http_push.py --server http://localhost:3000 --port /dev/tty.usbmodemXXXX --token YOUR_TOKEN

No external dependencies beyond pyserial.
"""
from __future__ import annotations
import argparse, json, sys, time
from typing import List, Dict, Any
import serial
from serial.tools import list_ports
from urllib.request import Request, urlopen

def auto_detect_port() -> str | None:
    ports = list(list_ports.comports())
    cand = [p.device for p in ports if any(k in (p.description or '').lower() for k in ('arduino','wch','usb serial'))
            or any(k in (p.device or '').lower() for k in ('usbmodem','usbserial','ttyacm','ttyusb'))]
    return cand[0] if cand else (ports[0].device if ports else None)

def post_json(url: str, body: Dict[str, Any], token: str = '') -> Dict[str, Any]:
    data = json.dumps(body).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = Request(url, data=data, headers=headers, method='POST')
    with urlopen(req, timeout=5) as resp:
        ct = resp.headers.get('Content-Type', '')
        raw = resp.read()
        if 'application/json' in ct:
            return json.loads(raw.decode('utf-8'))
        return {'ok': True, 'raw': raw.decode('utf-8', errors='ignore')}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--server', type=str, default='http://localhost:3000')
    ap.add_argument('--port', type=str, default='')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--aref', type=float, default=3.3)
    ap.add_argument('--batch', type=int, default=40, help='samples per POST')
    ap.add_argument('--token', type=str, default='', help='API_AUTH_TOKEN if server requires it')
    ap.add_argument('--verbose', action='store_true', help='print POST results and basic stats')
    args = ap.parse_args()

    port = args.port or auto_detect_port()
    if not port:
        print('No serial port found. Use --port')
        sys.exit(2)
    print(f'Using serial {port} @ {args.baud} baud, aref={args.aref}')
    ser = serial.Serial(port, args.baud, timeout=0.1)
    time.sleep(1.2)  # Arduino auto reset wait

    url = args.server.rstrip('/') + '/api/eog/push'
    buf: List[Dict[str, Any]] = []
    # Align sample timestamps to device millis to keep spacing stable (like Web Serial implementation)
    ms0 = None  # first seen device millis
    epoch0 = None  # wall-clock epoch (ms) aligned to ms0
    last_post = time.time()
    try:
        while True:
            line = ser.readline()
            if not line:
                # Flush periodically even without new samples
                if buf and (time.time() - last_post) > 0.25:
                    try:
                        r = post_json(url, { 'aref': args.aref, 'samples': buf }, token=args.token)
                        if args.verbose:
                            print(f'POST ok: {r}')
                    except Exception as e:
                        print('POST error:', e)
                    buf.clear()
                    last_post = time.time()
                continue
            try:
                s = line.decode('utf-8', errors='ignore').strip()
                parts = s.split(',')
                if len(parts) < 2:
                    continue
                ms = int(parts[0])
                raw = int(parts[1])
                # tolerate 2–4 columns: ms,raw[,lop[,lon]]
                lop = int(parts[2]) if len(parts) >= 3 and parts[2] != '' else 0
                lon = int(parts[3]) if len(parts) >= 4 and parts[3] != '' else 0

                # Initialize alignment anchors on first valid sample
                now_ms = int(time.time() * 1000)
                if ms0 is None:
                    ms0 = ms
                    epoch0 = now_ms
                # Align incoming millis to wall clock to produce epoch_ms
                epoch_ms = epoch0 + (ms - ms0)

                buf.append({ 'epoch_ms': epoch_ms, 'raw': raw, 'lop': lop, 'lon': lon })
                if len(buf) >= args.batch:
                    try:
                        r = post_json(url, { 'aref': args.aref, 'samples': buf }, token=args.token)
                        if args.verbose:
                            print(f'POST ok: {r}')
                    except Exception as e:
                        print('POST error:', e)
                    buf.clear()
                    last_post = time.time()
            except Exception:
                # ignore parse errors
                continue
    except KeyboardInterrupt:
        pass
    finally:
        try: ser.close()
        except: pass

if __name__ == '__main__':
    main()
