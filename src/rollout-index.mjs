// Cache routing metadata only. Native messages remain opaque. Compressed
// message frames can then pass through without decoding or recompressing them.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { atomicPrivate } from './settings.mjs';

function stamp(file) {
  const value = fs.statSync(file, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs].join(':');
}
const identity = value => [value.dev, value.ino, value.size].join(':');
function slot(bytes, length = 0) {
  const frame = zstdCompressSync(bytes), size = length && frame.length + 8 <= length ? length : frame.length + 520;
  const output = Buffer.alloc(size); frame.copy(output);
  // RFC 8878 skippable frames reserve space without adding decoded JSONL bytes.
  output.writeUInt32LE(0x184d2a50, frame.length);
  output.writeUInt32LE(size - frame.length - 8, frame.length + 4);
  return output;
}
const compactEntry = entry => ({ ...entry, records: entry.records.map(({ encoded, ...record }) => record) });
export class RolloutIndex {
  constructor(home, root, parse, lines) {
    this.home = home; this.parse = parse; this.lines = lines;
    this.file = path.join(root, 'data/cache/rollout-index.json');
    this.entries = {}; this.seen = new Set(); this.dirty = false;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if ([1, 2].includes(saved.version) && saved.home === home) this.entries = saved.entries || {};
    } catch {}
  }
  async get(file) {
    const relative = path.relative(this.home, file), token = stamp(file);
    this.seen.add(relative);
    const saved = this.entries[relative];
    if (saved?.token === token) return saved;
    const entry = { token, records: [], originalProvider: 'openai', framed: false };
    let offset = 0;
    for await (const bytes of this.lines(file)) {
      const meta = this.parse(bytes);
      if (!entry.id && meta?.id) entry.id = meta.id;
      if (meta?.provider) {
        entry.originalProvider = meta.provider;
        entry.records.push({ key: meta.key, provider: meta.provider, offset, length: bytes.length });
      }
      offset += bytes.length;
    }
    if (stamp(file) !== token) throw new Error('A conversation changed while reading its routing metadata.');
    this.entries[relative] = entry; this.dirty = true;
    return entry;
  }
  fast(file) { return !file.endsWith('.jsonl.zst') || this.entries[path.relative(this.home, file)]?.framed; }
  plan(file, goal, replace) {
    const relative = path.relative(this.home, file), entry = this.entries[relative];
    if (!entry?.reserved || stamp(file) !== entry.token) return null;
    const stat = fs.statSync(file, { bigint: true }), fd = fs.openSync(file, 'r');
    const changes = [], records = entry.records.map(record => ({ ...record, encoded: { ...record.encoded } }));
    try {
      for (const [position, record] of records.entries()) {
        const provider = goal(record, position); if (provider === record.provider) continue;
        const before = Buffer.alloc(record.length);
        if (fs.readSync(fd, before, 0, before.length, record.offset) !== before.length) throw new Error('Incomplete routing metadata slot.');
        let after = record.encoded[provider] ? Buffer.from(record.encoded[provider], 'base64') : null;
        if (!after) {
          const bytes = zstdDecompressSync(before), meta = this.parse(bytes);
          after = slot(replace(bytes, meta, provider), record.length);
          if (after.length !== record.length) return null;
          record.encoded[provider] = after.toString('base64');
        }
        if (after.length !== record.length) return null;
        changes.push({ offset: record.offset, length: record.length, before: before.toString('base64'), after });
        record.provider = provider;
      }
    } finally { fs.closeSync(fd); }
    return { file, relative, token: entry.token, identity: identity(stat), mtime: Number(stat.mtimeMs),
      original: compactEntry(entry), updated: { ...entry, records, originalProvider: records.at(-1)?.provider || entry.originalProvider }, changes };
  }
  apply(plan) {
    if (!plan.changes.length) return;
    if (stamp(plan.file) !== plan.token) throw new Error('Conversation changed before routing metadata could be updated.');
    const fd = fs.openSync(plan.file, 'r+'), stat = fs.fstatSync(fd);
    try {
      for (const change of plan.changes) if (fs.writeSync(fd, change.after, 0, change.after.length, change.offset) !== change.after.length) throw new Error('Routing metadata write was incomplete.');
      fs.futimesSync(fd, stat.atime, new Date(plan.mtime)); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.entries[plan.relative] = { ...plan.updated, token: stamp(plan.file) }; this.dirty = true;
  }
  undo(snapshots, files) {
    let moved;
    for (const saved of snapshots || []) {
      let file = path.resolve(this.home, saved.relative);
      if (!fs.existsSync(file) || identity(fs.statSync(file, { bigint: true })) !== saved.identity) {
        moved ||= new Map(files.map(file => [identity(fs.statSync(file, { bigint: true })), file]));
        file = moved.get(saved.identity); if (!file) continue;
      }
      const fd = fs.openSync(file, 'r+'), stat = fs.fstatSync(fd);
      try {
        for (const range of saved.ranges) {
          const bytes = Buffer.from(range.before, 'base64');
          const record = saved.original.records.find(record => record.offset === range.offset && record.length === range.length);
          if (bytes.length !== range.length || range.offset < 0 || range.offset + bytes.length > stat.size || !record) throw new Error('Invalid routing metadata recovery range.');
          const meta = this.parse(zstdDecompressSync(bytes));
          if (meta?.key !== record.key || meta.provider !== record.provider) throw new Error('Routing metadata recovery bytes are damaged.');
          if (fs.writeSync(fd, bytes, 0, bytes.length, range.offset) !== bytes.length) throw new Error('Routing metadata recovery write was incomplete.');
        }
        fs.futimesSync(fd, stat.atime, new Date(saved.mtime)); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const relative = path.relative(this.home, file), cached = this.entries[relative];
      this.entries[relative] = { ...saved.original, token: stamp(file), records: saved.original.records.map(record => ({ ...record,
        encoded: cached?.records.find(current => current.key === record.key && current.offset === record.offset)?.encoded })) };
      this.seen.add(relative); this.dirty = true;
    }
  }
  async rewrite(file, temporary, transform) {
    const entry = await this.get(file), before = fs.statSync(file);
    const compressed = file.endsWith('.jsonl.zst');
    const records = []; let position = 0, changed = false;
    const remember = (bytes, length, encoded) => {
      const meta = this.parse(bytes);
      if (meta?.provider) records.push({ key: meta.key, provider: meta.provider, offset: position, length,
        ...(encoded ? { encoded: { [meta.provider]: encoded.toString('base64') } } : {}) });
    };
    const adapt = bytes => {
      const next = transform(bytes, this.parse(bytes));
      changed ||= next !== bytes;
      return next;
    };
    const parse = this.parse, sourceLines = this.lines;
    async function* framed() {
      const iterator = sourceLines(file)[Symbol.asyncIterator]();
      let current;
      const advance = async () => {
        const next = await iterator.next();
        current = next.done ? null : { bytes: next.value, meta: parse(next.value) };
      };
      try {
        await advance();
        while (current) {
          if (current.meta?.provider) {
            const bytes = adapt(current.bytes), frame = slot(bytes);
            remember(bytes, frame.length, frame); position += frame.length;
            yield frame; await advance();
          } else {
            async function* segment() {
              while (current && !current.meta?.provider) { const bytes = current.bytes; yield bytes; await advance(); }
            }
            const source = Readable.from(segment()), compressor = createZstdCompress();
            source.once('error', error => compressor.destroy(error)); source.pipe(compressor);
            try { for await (const bytes of compressor) { position += bytes.length; yield bytes; } }
            finally { source.destroy(); compressor.destroy(); }
          }
        }
      } finally { await iterator.return?.(); }
    }
    async function* ranges() {
      const fd = fs.openSync(file, 'r');
      let start = 0;
      function* copy(end) {
        while (start < end) {
          const bytes = Buffer.allocUnsafe(Math.min(1024 * 1024, end - start));
          const length = fs.readSync(fd, bytes, 0, bytes.length, start);
          if (!length) throw new Error('Conversation ended before its recorded routing metadata.');
          start += length; position += length; yield bytes.subarray(0, length);
        }
      }
      try {
        for (const record of entry.records) {
          yield* copy(record.offset);
          const raw = Buffer.allocUnsafe(record.length);
          if (fs.readSync(fd, raw, 0, raw.length, record.offset) !== raw.length) throw new Error('Conversation routing metadata is incomplete.');
          const bytes = adapt(compressed ? zstdDecompressSync(raw) : raw);
          const output = compressed ? slot(bytes, entry.reserved ? record.length : 0) : bytes;
          remember(bytes, output.length, compressed ? output : null); position += output.length;
          yield output; start = record.offset + record.length;
        }
        yield* copy(before.size);
      } finally { fs.closeSync(fd); }
    }
    const output = fs.createWriteStream(temporary, { flags: 'wx', mode: before.mode & 0o777 });
    try {
      await pipeline(compressed && !entry.framed ? framed() : ranges(), output);
      if (stamp(file) !== entry.token) throw new Error('A conversation changed while preparing compatibility; close its other client first.');
      if (changed) {
        fs.utimesSync(temporary, before.atime, before.mtime);
        const fd = fs.openSync(temporary, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
        if (process.platform !== 'win32') {
          const directory = fs.openSync(path.dirname(file), 'r');
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
        this.entries[path.relative(this.home, file)] = { ...entry, token: stamp(file), records, framed: compressed, reserved: compressed,
          originalProvider: records.at(-1)?.provider || entry.originalProvider };
        this.dirty = true;
      }
    } finally { output.destroy(); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  save() {
    for (const key of Object.keys(this.entries)) if (!this.seen.has(key)) { delete this.entries[key]; this.dirty = true; }
    if (this.dirty) atomicPrivate(this.file, { version: 2, home: this.home, entries: this.entries });
  }
}
