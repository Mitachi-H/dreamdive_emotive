// Simple in-memory reference manager for stream subscriptions.
// Tracks holders per stream with an expiration TTL and provides
// helpers to decide when to actually subscribe/unsubscribe upstream.

const DEFAULT_TTL_MS = 90_000; // 90s default TTL per holder

class StreamRefManager {
  constructor() {
    this._map = new Map(); // streamName -> Map(clientId -> expiryEpochMs)
  }

  _now() {
    return Date.now();
  }

  _get(stream) {
    let inner = this._map.get(stream);
    if (!inner) {
      inner = new Map();
      this._map.set(stream, inner);
    }
    return inner;
  }

  holders(stream) {
    const inner = this._map.get(stream);
    return inner ? Array.from(inner.keys()) : [];
  }

  count(stream) {
    const inner = this._map.get(stream);
    return inner ? inner.size : 0;
  }

  status(stream) {
    return { count: this.count(stream), holders: this.holders(stream) };
  }

  // Returns { first: boolean, count }
  start(stream, clientId, ttlMs = DEFAULT_TTL_MS) {
    const inner = this._get(stream);
    const before = inner.size;
    const expiry = this._now() + Math.max(1_000, ttlMs);
    inner.set(String(clientId || ''), expiry);
    return { first: before === 0, count: inner.size };
  }

  // Returns { empty: boolean, count }
  stop(stream, clientId) {
    const inner = this._get(stream);
    if (clientId !== undefined) inner.delete(String(clientId));
    const empty = inner.size === 0;
    return { empty, count: inner.size };
  }

  // Returns { count }
  renew(stream, clientId, ttlMs = DEFAULT_TTL_MS) {
    const inner = this._get(stream);
    if (!inner.has(String(clientId))) return { count: inner.size };
    const expiry = this._now() + Math.max(1_000, ttlMs);
    inner.set(String(clientId), expiry);
    return { count: inner.size };
  }

  // Remove expired holders. Returns list of stream names that became empty.
  prune(now = this._now()) {
    const becameEmpty = [];
    for (const [stream, inner] of this._map.entries()) {
      for (const [cid, expiry] of inner.entries()) {
        if (typeof expiry === 'number' && expiry <= now) inner.delete(cid);
      }
      if (inner.size === 0) becameEmpty.push(stream);
    }
    return becameEmpty;
  }
}

module.exports = new StreamRefManager();

