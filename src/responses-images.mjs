import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hosted = item => item?.type === 'image_generation_call';
const invalid = message => Object.assign(new Error(message), { status: 502, code: 'invalid_upstream_image_response' });

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
      const file = path.join(this.directory, crypto.createHash('sha256').update(bytes).digest('hex') + '.' + format);
      const temporary = file + '.' + crypto.randomUUID() + '.tmp';
      try {
        fs.mkdirSync(this.directory, { recursive: true });
        if (fs.existsSync(file)) {
          if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(bytes)) throw new Error('Invalid existing image file');
        } else {
          fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, file);
        }
      } catch {
        throw Object.assign(new Error('The generated image could not be saved in the client image directory.'), { status: 502, code: 'image_storage_unavailable' });
      } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
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
