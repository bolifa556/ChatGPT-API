import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Agent } from 'undici';
import { requestWithAbort as request } from './transport.mjs';
import { contextFields } from './model-context.mjs';
import { readSettings, settingsRevision, publicModelId, atomicPrivate, redact } from './settings.mjs';

const TTL = 24 * 60 * 60 * 1000;
const fields = ['id', 'type', 'capabilities', 'supported_endpoints', 'output_modalities', 'architecture',
  'service_tiers', 'additional_speed_tiers', 'default_service_tier', ...contextFields];
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const fingerprint = profile => crypto.createHash('sha256').update(profile.baseUrl + '\n' + profile.apiKey).digest('hex');
export class GatewaySources {
  constructor(root, env, { transport = 'direct', tunnelPort = 18003, baseOverride = '' } = {}) {
    this.root = root; this.env = env; this.transport = transport; this.tunnelPort = tunnelPort;
    this.baseOverride = baseOverride;
    this.agents = new Map(); this.settings = readSettings(root, env); this.revision = settingsRevision(this.settings);
    this.secrets = new Set(this.settings.providers.map(profile => profile.apiKey).filter(Boolean));
    this.file = path.join(root, 'data/cache/gateway-sources.json');
    this.saved = readJson(this.file) || { version: 1, sources: [] };
    this.models = []; this.sources = [];
  }
  profiles() {
    return this.settings.providers.filter(provider => provider.enabled).sort((a, b) => Number(b.id === this.settings.preferredProviderId) - Number(a.id === this.settings.preferredProviderId));
  }
  profile(id) { return this.settings.providers.find(provider => provider.id === id && provider.enabled); }
  base(profile) { return profile.id === 'default' && this.baseOverride ? this.baseOverride : profile.baseUrl; }
  identity(profile) { return fingerprint({ ...profile, baseUrl: this.base(profile) }); }
  dispatcher(profile) {
    const key = profile.baseUrl + '\n' + (profile.id === 'default' ? this.transport : 'direct');
    if (!this.agents.has(key)) {
      const url = new URL(profile.baseUrl);
      this.agents.set(key, new Agent(profile.id === 'default' && this.transport === 'ssh'
        ? { connect: { hostname: '127.0.0.1', port: this.tunnelPort, servername: url.hostname } } : {}));
    }
    return this.agents.get(key);
  }
  target(model, catalog = this.models) {
    const metadata = catalog.find(candidate => candidate.id === model);
    const profile = this.profile(metadata?._providerId || 'default');
    if (!profile || !metadata) throw Object.assign(new Error('The selected API model or source is no longer enabled.'), { status: 400, code: 'unknown_model' });
    return { profile, base: this.base(profile), dispatcher: this.dispatcher(profile), model: metadata._upstreamId || metadata.id };
  }
  adoptLegacy(catalog) {
    const profile = this.profile('default');
    if (!profile || this.saved.sources.some(source => source.id === 'default') || catalog?.sourceId !== this.identity(profile)) return;
    const models = (catalog.gatewayModels?.length ? catalog.gatewayModels : (catalog.gatewayIds || []).map(id => ({ id })));
    this.saved.sources.push({ id: 'default', fingerprint: this.identity(profile), checkedAt: catalog.gatewayAt, models });
  }
  collect(records) {
    const seen = new Set(), models = [], sources = [];
    for (const profile of this.profiles()) {
      const record = records.find(source => source.id === profile.id && source.fingerprint === this.identity(profile));
      if (!record || !Number.isFinite(Date.parse(record.checkedAt)) || Date.now() - Date.parse(record.checkedAt) >= TTL) continue;
      sources.push(record);
      for (const original of record.models || []) {
        const id = publicModelId(profile.id, original.id);
        if (seen.has(id)) throw new Error('Duplicate public model identity: ' + id);
        seen.add(id); models.push({ ...original, id, _providerId: profile.id, _upstreamId: original.id });
      }
    }
    this.models = models; this.sources = sources;
    return models;
  }
  loadCached(legacy) { this.adoptLegacy(legacy); return this.collect(this.saved.sources || []); }
  async discover() {
    this.settings = readSettings(this.root, this.env); this.revision = settingsRevision(this.settings);
    for (const profile of this.settings.providers) if (profile.apiKey) this.secrets.add(profile.apiKey);
    const records = [], statuses = [];
    await Promise.all(this.profiles().map(async profile => {
      const previous = (this.saved.sources || []).find(source => source.id === profile.id && source.fingerprint === this.identity(profile));
      const status = { id: profile.id, name: profile.name, fingerprint: this.identity(profile), ready: false, models: 0, checkedAt: new Date().toISOString() };
      try {
        if (!profile.apiKey || !profile.baseUrl) throw new Error('API URL or Key is missing.');
        const up = await request(this.base(profile) + '/models', { dispatcher: this.dispatcher(profile),
          headers: { authorization: 'Bearer ' + profile.apiKey, accept: 'application/json', 'accept-encoding': 'identity' },
          signal: AbortSignal.timeout(12000), headersTimeout: 12000, bodyTimeout: 12000 });
        const body = await up.body.text();
        if (up.statusCode < 200 || up.statusCode >= 300) throw new Error('HTTP ' + up.statusCode);
        const data = JSON.parse(body), ids = new Set();
        const models = (data.data || []).filter(item => typeof item?.id === 'string' && item.id && item.id.length <= 500 && !ids.has(item.id) && ids.add(item.id))
          .map(item => Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, item[key]])));
        if (!models.length) throw new Error('Gateway returned no models.');
        const record = { id: profile.id, fingerprint: this.identity(profile), checkedAt: new Date().toISOString(), models };
        records.push(record); Object.assign(status, { ready: true, checkedAt: record.checkedAt, models: models.length });
      } catch (error) {
        status.error = redact(error.message, this.settings);
        if (previous && Date.now() - Date.parse(previous.checkedAt) < TTL) {
          records.push(previous); Object.assign(status, { cached: true, cachedAt: previous.checkedAt, models: previous.models.length });
        }
      }
      statuses.push(status);
    }));
    this.saved = { version: 1, revision: this.revision, sources: records, statuses };
    atomicPrivate(this.file, this.saved); this.collect(records);
    const ordered = this.profiles().map(profile => statuses.find(status => status.id === profile.id));
    return { ready: statuses.some(status => status.ready), checkedAt: new Date().toISOString(), models: this.models.length,
      ...(statuses.some(status => status.cached) ? { cached: true } : {}), sources: ordered,
      ...(!statuses.some(status => status.ready) ? { error: statuses.map(status => status.name + ': ' + status.error).join('; ') } : {}) };
  }
  async close() { await Promise.all([...this.agents.values()].map(agent => agent.close())); }
  destroy() { for (const agent of this.agents.values()) agent.destroy(); }
}
