import { MAX_REQUEST_BYTES } from './transport.mjs';

export const DEFAULT_LANE = Symbol('implicit response lane');
export const laneOf = event => event.stream_id ?? DEFAULT_LANE;

export class PendingResponses {
  constructor() { this.lanes = new Map(); this.size = 0; }
  push(lane, value) {
    if (!this.lanes.has(lane)) this.lanes.set(lane, []);
    this.lanes.get(lane).push(value); this.size++;
  }
  peek(lane) { return this.lanes.get(lane)?.[0]; }
  shift(lane) {
    const queue = this.lanes.get(lane);
    if (!queue?.length) return;
    this.size--; const value = queue.shift();
    if (!queue.length) this.lanes.delete(lane);
    return value;
  }
  delete(lane) {
    this.size -= this.lanes.get(lane)?.length || 0;
    this.lanes.delete(lane);
  }
}

// Connection-local references only. Shared history items count once; neither
// serialized chat copies nor synthetic summaries are kept on disk.
export class HistoryCache {
  constructor({ maxBytes = MAX_REQUEST_BYTES, maxEntries = 64 } = {}) {
    this.maxBytes = maxBytes; this.maxEntries = maxEntries;
    this.entries = new Map(); this.refs = new Map(); this.sizes = new WeakMap();
    this.latest = new Map(); this.bytes = 0;
  }
  get(id) {
    const entry = this.entries.get(id);
    if (entry) { this.entries.delete(id); this.entries.set(id, entry); }
    return entry;
  }
  itemBytes(item) {
    if (item && typeof item === 'object') {
      if (!this.sizes.has(item)) this.sizes.set(item, Buffer.byteLength(JSON.stringify(item)));
      return this.sizes.get(item);
    }
    return Buffer.byteLength(JSON.stringify(item) ?? 'null');
  }
  delete(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id); this.bytes -= entry.overhead;
    for (const item of entry.input) {
      const ref = this.refs.get(item);
      if (--ref.count === 0) { this.bytes -= ref.bytes; this.refs.delete(item); }
    }
    if (this.latest.get(entry.lane) === id) this.latest.delete(entry.lane);
  }
  set(id, entry) {
    this.delete(id);
    const overhead = Buffer.byteLength(JSON.stringify(entry.defaults)) + entry.input.length * 8;
    const unique = new Set(entry.input);
    const windowBytes = overhead + [...unique].reduce((sum, item) => sum + this.itemBytes(item), 0);
    if (windowBytes > this.maxBytes) return false;
    for (const item of entry.input) {
      let ref = this.refs.get(item);
      if (!ref) { ref = { count: 0, bytes: this.itemBytes(item) }; this.refs.set(item, ref); this.bytes += ref.bytes; }
      ref.count++;
    }
    this.bytes += overhead;
    this.entries.set(id, { ...entry, bytes: windowBytes, overhead });
    this.latest.set(entry.lane, id);
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const victim = [...this.entries].find(([key, value]) => this.latest.get(value.lane) !== key)?.[0]
        ?? this.entries.keys().next().value;
      this.delete(victim);
    }
    return this.entries.has(id);
  }
}
