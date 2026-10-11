import { badRequest } from '../lib/errors';

/**
 * Starter model catalog for the Studio. Each entry says which settings the UI should show, which
 * media inputs the model accepts, and how to turn a generation request into the platform call.
 *
 * Request shapes follow the open-source studio at github.com/wide-trace/open-higgsfield (the only
 * public reference for the platform contract). Entries with `verified: false` have parameters that
 * were not fully visible there - check them against your Higgsfield API docs. To add a model, add an
 * entry here; nothing else needs to change.
 */
export type MediaRole = 'start' | 'end' | 'reference' | 'video' | 'audio';

export type SettingSpec =
  | { type: 'enum'; label: string; values: string[]; default: string }
  | { type: 'range'; label: string; min: number; max: number; step?: number; default: number }
  | { type: 'boolean'; label: string; default: boolean };

export interface Plane {
  prompt: string;
  settings: Record<string, any>;
  media: Partial<Record<MediaRole, string[]>>;
}

export interface StudioModel {
  id: string;
  label: string;
  surface: 'image' | 'video';
  description: string;
  roles: Partial<Record<MediaRole, number>>;
  settings: Record<string, SettingSpec>;
  verified: boolean;
  note?: string;
  build: (p: Plane) => { path: string; body: Record<string, unknown> };
}

const ASPECT_IMAGE = ['1:1', '3:4', '4:3', '9:16', '16:9'];
const ASPECT_VIDEO = ['16:9', '9:16', '1:1'];

const soulSettings: Record<string, SettingSpec> = {
  aspectRatio: { type: 'enum', label: 'Aspect ratio', values: ASPECT_IMAGE, default: '1:1' },
  resolution: { type: 'enum', label: 'Resolution', values: ['720p', '1080p'], default: '720p' },
  batchSize: { type: 'enum', label: 'Images per generation', values: ['1', '4'], default: '1' },
  enhancePrompt: { type: 'boolean', label: 'Enhance prompt', default: false },
};

const soulBuild = (path: string) => (p: Plane) => ({
  path,
  body: {
    prompt: p.prompt,
    batch_size: Number(p.settings.batchSize),
    resolution: p.settings.resolution,
    aspect_ratio: p.settings.aspectRatio,
    enhance_prompt: p.settings.enhancePrompt,
  },
});

const klingStdSettings: Record<string, SettingSpec> = {
  aspectRatio: { type: 'enum', label: 'Aspect ratio (text-to-video)', values: ASPECT_VIDEO, default: '16:9' },
  duration: { type: 'range', label: 'Duration (seconds)', min: 3, max: 15, step: 1, default: 5 },
  sound: { type: 'boolean', label: 'Generate sound', default: true },
  cfgScale: { type: 'range', label: 'Prompt adherence (cfg scale)', min: 0, max: 1, step: 0.01, default: 0.5 },
  multiShots: { type: 'boolean', label: 'Multi-shot', default: false },
};

const klingBuild = (tier: 'std' | 'pro' | '4k') => (p: Plane) => {
  const start = p.media.start?.[0];
  const end = p.media.end?.[0];
  const common = {
    prompt: p.prompt,
    sound: p.settings.sound ? 'on' : 'off',
    duration: p.settings.duration,
    cfg_scale: p.settings.cfgScale,
    multi_shots: p.settings.multiShots,
  };
  return start
    ? { path: `kling-video/v3.0/${tier}/image-to-video`, body: { ...common, image_url: start, ...(end ? { last_image_url: end } : {}) } }
    : { path: `kling-video/v3.0/${tier}/text-to-video`, body: { ...common, aspect_ratio: p.settings.aspectRatio } };
};

export const STUDIO_MODELS: StudioModel[] = [
  {
    id: 'soul-2',
    label: 'Soul 2',
    surface: 'image',
    description: 'Photoreal image generation.',
    roles: {},
    settings: soulSettings,
    verified: true,
    note: 'Path and fields match Higgsfield’s own Soul 2 example. The list of aspect ratios is a best guess (the example uses 4:3).',
    build: soulBuild('higgsfield-ai/soul/v2/standard'),
  },
  {
    id: 'soul-cinema',
    label: 'Soul Cinema',
    surface: 'image',
    description: 'Cinematic-look image generation.',
    roles: {},
    settings: soulSettings,
    verified: false,
    note: 'Aspect-ratio options are a best guess.',
    build: soulBuild('higgsfield-ai/soul/cinema'),
  },
  {
    id: 'flux-2',
    label: 'Flux 2',
    surface: 'image',
    description: 'Text-to-image.',
    roles: {},
    settings: {},
    verified: false,
    note: 'Only the prompt is sent; extra Flux parameters were not available to verify.',
    build: (p) => ({ path: 'flux-2-pro', body: { prompt: p.prompt } }),
  },
  {
    id: 'kling-3-turbo',
    label: 'Kling 3.0 Turbo',
    surface: 'video',
    description: 'Fast text- or image-to-video. Add a start frame for image-to-video.',
    roles: { start: 1 },
    settings: {
      aspectRatio: { type: 'enum', label: 'Aspect ratio (text-to-video)', values: ASPECT_VIDEO, default: '16:9' },
      resolution: { type: 'enum', label: 'Resolution', values: ['720p', '1080p'], default: '720p' },
      duration: { type: 'range', label: 'Duration (seconds)', min: 3, max: 15, step: 1, default: 5 },
    },
    verified: true,
    build: (p) => {
      const start = p.media.start?.[0];
      const common = { prompt: p.prompt, duration: p.settings.duration, resolution: p.settings.resolution };
      return start
        ? { path: 'kling-video/v3.0-turbo/image-to-video', body: { ...common, image_url: start } }
        : { path: 'kling-video/v3.0-turbo/text-to-video', body: { ...common, aspect_ratio: p.settings.aspectRatio } };
    },
  },
  ...(['std', 'pro', '4k'] as const).map(
    (tier): StudioModel => ({
      id: `kling-3-${tier}`,
      label: `Kling 3.0 ${{ std: 'Standard', pro: 'Pro', '4k': '4K' }[tier]}`,
      surface: 'video',
      description: 'Text- or image-to-video with optional end frame.',
      roles: { start: 1, end: 1 },
      settings: klingStdSettings,
      verified: true,
      build: klingBuild(tier),
    }),
  ),
];

export function getStudioModel(id: string): StudioModel | undefined {
  return STUDIO_MODELS.find((m) => m.id === id);
}

/** The JSON-safe view sent to the browser (no functions). */
export function publicModel(m: StudioModel, price: number | null) {
  const { build: _build, ...rest } = m;
  return { ...rest, nativeBatch: 'batchSize' in m.settings, priceUsd: price };
}

const HTTP_URL = /^https?:\/\/\S{1,2000}$/i;

/** Fill defaults and reject unknown keys / out-of-range values so bad input never reaches the platform. */
export function resolveSettings(model: StudioModel, input: Record<string, unknown> = {}): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(input)) if (!(key in model.settings)) throw badRequest(`Unknown setting "${key}" for ${model.label}`);
  for (const [key, spec] of Object.entries(model.settings)) {
    const v = input[key] ?? spec.default;
    if (spec.type === 'enum') {
      if (typeof v !== 'string' || !spec.values.includes(v)) throw badRequest(`${spec.label}: must be one of ${spec.values.join(', ')}`);
    } else if (spec.type === 'range') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max) throw badRequest(`${spec.label}: must be between ${spec.min} and ${spec.max}`);
    } else if (typeof v !== 'boolean') {
      throw badRequest(`${spec.label}: must be true or false`);
    }
    out[key] = v;
  }
  return out;
}

export function resolveMedia(model: StudioModel, input: Partial<Record<MediaRole, string[]>> = {}): Plane['media'] {
  const out: Plane['media'] = {};
  for (const [role, urls] of Object.entries(input) as [MediaRole, string[]][]) {
    if (!urls?.length) continue;
    const limit = model.roles[role] ?? 0;
    if (limit === 0) throw badRequest(`${model.label} does not accept ${role} media`);
    if (urls.length > limit) throw badRequest(`${model.label} accepts at most ${limit} ${role} input${limit > 1 ? 's' : ''}`);
    for (const u of urls) if (!HTTP_URL.test(u)) throw badRequest(`${role} inputs must be public http(s) URLs`);
    out[role] = urls;
  }
  return out;
}
