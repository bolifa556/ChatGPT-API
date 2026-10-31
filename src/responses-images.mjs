import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hosted = item => item?.type === 'image_generation_call';
const invalid = message => Object.assign(new Error(message), { status: 502, code: 'invalid_upstream_image_response' });

function save(file, bytes, replace = false) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      if (!fs.lstatSync(file).isFile()) throw new Error('Invalid existing image file');
      if (fs.readFileSync(file).equals(bytes)) return;
      if (!replace) throw new Error('Invalid existing image file');
    }
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    throw Object.assign(new Error('The generated image could not be saved in the client image directory.'), { status: 502, code: 'image_storage_unavailable' });
  } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}

// The native core accepts assistant input_image content for display/editing,
// but Responses upstreams validate assistant output messages as text/refusal.
// Reverse ONLY our image presentation, never user uploads or native tool output.
// This is the already-generated result, not a new tool invocation or user turn.
export function restoreHostedImageHistory(payload, codexHome) {
  if (!Array.isArray(payload?.input)) return { payload, changed: false };
  const ids = new Map(); let changed = false;
  let input = payload.input.map(item => {
    if (item?.type !== 'message' || item.role !== 'assistant' || !/^msg_[a-f0-9]{32}$/.test(item.id || '') ||
        item.status && item.status !== 'completed' || !Array.isArray(item.content) || item.content.length !== 2) return item;
    const [text, image] = item.content;
    if (text?.type !== 'output_text' || image?.type !== 'input_image') return item;
    const reference = /^!\[\]\(<[^\r\n]+\/generated_images\/chatgpt-api\/([a-f0-9]{64})\.(png|jpeg|webp)>\)$/.exec(text.text);
    const data = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.image_url || '');
    if (!reference || !data || reference[2] !== data[1]) return item;
    const bytes = Buffer.from(data[2], 'base64'), digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== reference[1]) return item;
    // 3.1.8 did not keep the original result metadata. Its image bytes still
    // suffice for the documented result schema; use a stable result ID.
    let result = { type: 'image_generation_call', id: 'ig_' + item.id.slice(4), status: 'completed' };
    if (codexHome) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.resolve(codexHome, 'generated_images', 'chatgpt-api', item.id + '.response.json'), 'utf8'));
        if (saved.version === 1 && saved.digest === digest && saved.item?.type === 'image_generation_call' &&
            saved.item.status === 'completed' && typeof saved.item.id === 'string') result = saved.item;
      } catch {} // A moved/older image retains the self-contained result above.
    }
    changed = true; ids.set(item.id, result.id);
    return { ...result, result: data[2] };
  });
  if (!changed) return { payload, changed: false };
  input = input.map(item => item?.type === 'item_reference' && ids.has(item.id) ? { ...item, id: ids.get(item.id) } : item);
  return { payload: { ...payload, input }, changed: true };
}

function imageBytes(result) {
  if (typeof result !== 'string' || !result.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(result)) {
    throw invalid('The completed image result is missing valid base64 image data.');
  }
  const bytes = Buffer.from(result, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== result.replace(/=+$/, '')) throw invalid('The image result contains invalid base64 data.');
  const format = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
    : bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpeg'
      : bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  if (!format) throw invalid('The image result is not a supported PNG, JPEG or WebP image.');
  return { bytes, format };
}

// Hosted Responses image results are not native image_gen tool results. Deliver
// the same bytes as an assistant image, with a local display reference and image
// content for the client's next-turn image lookup. Never generate again here.
export class ResponseImages {
  constructor(codexHome) {
    this.directory = path.resolve(codexHome, 'generated_images', 'chatgpt-api');
    this.items = new Map();
    this.byId = new Map();
    this.nextSequence = 0;
    this.changed = false;
  }
  entry(item, index) {
    let entry = item.id ? this.byId.get(item.id) : this.items.get(index);
    if (!entry) {
      const id = 'msg_' + crypto.createHash('sha256').update(item.id || crypto.randomUUID()).digest('hex').slice(0, 32);
      entry = { index, id, added: false, done: false };
      this.items.set(index, entry);
      if (item.id) this.byId.set(item.id, entry);
    }
    return entry;
  }
  message(item, index, completed = false) {
    const entry = this.entry(item, index);
    if (item.status === 'completed' || !item.status && (completed || item.result != null)) {
      if (entry.message) {
        if (entry.result !== item.result) throw invalid('The same image item returned conflicting results.');
        return entry.message;
      }
      const { bytes, format } = imageBytes(item.result);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const file = path.join(this.directory, digest + '.' + format);
      save(file, bytes);
      const { result, ...metadata } = item;
      metadata.id ??= 'ig_' + entry.id.slice(4);
      metadata.status ??= 'completed';
      // Keep only the original result's metadata beside the image, not another
      // conversation or a second copy of the image bytes.
      save(path.join(this.directory, entry.id + '.response.json'), Buffer.from(JSON.stringify({ version: 1, digest, item: metadata })), true);
      entry.result = item.result;
      entry.message = { type: 'message', id: entry.id, role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: '![](<' + file.replaceAll('\\', '/').replaceAll('<', '%3C').replaceAll('>', '%3E') + '>)', annotations: [] },
        { type: 'input_image', image_url: 'data:image/' + format + ';base64,' + item.result },
      ] };
      return entry.message;
    }
    if (completed) throw invalid('The response completed before its image result was available.');
    return { type: 'message', id: entry.id, role: 'assistant', status: item.status === 'in_progress' ? 'in_progress' : 'incomplete', content: [] };
  }
  response(response) {
    if (!Array.isArray(response?.output) || !response.output.some(hosted)) return response;
    return { ...response, output: response.output.map((item, index) => hosted(item) ? this.message(item, index, response.status === 'completed') : item) };
  }
  complete(item, index) {
    const entry = this.entry(item, index);
    const message = this.message(item, index, !item.status || item.status === 'completed');
    if (entry.done) return [];
    const events = [];
    if (!entry.added) events.push(this.added(entry));
    if (message.status === 'completed') {
      const part = message.content[0], fields = { output_index: entry.index, item_id: message.id, content_index: 0 };
      events.push(
        { type: 'response.content_part.added', ...fields, part: { ...part, text: '' } },
        { type: 'response.output_text.delta', ...fields, delta: part.text },
        { type: 'response.output_text.done', ...fields, text: part.text },
        { type: 'response.content_part.done', ...fields, part },
      );
    }
    events.push({ type: 'response.output_item.done', output_index: entry.index, item: message });
    entry.done = true;
    return events;
  }
  added(entry) {
    entry.added = true;
    return { type: 'response.output_item.added', output_index: entry.index,
      item: { type: 'message', id: entry.id, role: 'assistant', status: 'in_progress', content: [] } };
  }
  convert(event) {
    const completed = event.type === 'response.completed' && (!event.response?.status || event.response.status === 'completed');
    let output = [event];
    if (hosted(event.item) && ['response.output_item.added', 'response.output_item.done'].includes(event.type)) {
      this.changed = true;
      const entry = this.entry(event.item, event.output_index);
      output = event.type.endsWith('.added') ? (entry.added ? [] : [this.added(entry)]) : this.complete(event.item, event.output_index);
    } else if (event.type?.startsWith('response.image_generation_call.')) {
      // Partial image previews are not final images or additional chat items.
      this.changed = true;
      output = [];
    } else if (event.response?.output?.some(hosted)) {
      this.changed = true;
      output = [];
      for (const [index, item] of event.response.output.entries()) if (hosted(item) && (item.status === 'completed' || !item.status && completed)) output.push(...this.complete(item, index));
      output.push({ ...event, response: this.response(event.response) });
    }
    if (completed && [...this.items.values()].some(entry => !entry.message)) {
      throw invalid('The response completed without a final image result.');
    }
    if (!this.changed) {
      this.nextSequence = Math.max(this.nextSequence, (event.sequence_number ?? -1) + 1);
      return output;
    }
    this.nextSequence = Math.max(this.nextSequence, (event.sequence_number ?? -1));
    return output.map(value => ({ ...value, sequence_number: this.nextSequence++ }));
  }
}
