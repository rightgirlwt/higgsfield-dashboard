import { badRequest } from '../lib/errors';

/**
 * Studio model catalog - DATA, not code. Every model has one or more MODES (text-to-video,
 * image-to-video, reference-to-video...), and each mode lists the exact platform path, the settings it
 * accepts, and the media inputs (images, video, audio, characters) it takes.
 *
 * Source of truth: Higgsfield's own per-model API reference pages (open.higgsfield.ai/models/<path>/api-reference),
 * read on 2026-10-12. Setting keys are the platform's parameter names. To add a model, add an entry here;
 * the request builder, validation, UI form and price handling all derive from this data.
 */
export type MediaRole = 'start' | 'end' | 'reference' | 'video' | 'audio';

export type ParamSpec =
  | { type: 'enum'; label: string; values: string[]; default: string; numeric?: boolean; advanced?: boolean }
  | { type: 'int'; label: string; min: number; max: number; default: number; advanced?: boolean }
  | { type: 'number'; label: string; min: number; max: number; step: number; default: number; advanced?: boolean }
  | { type: 'boolean'; label: string; default: boolean; as?: 'bool' | 'onoff' | 'yesno'; advanced?: boolean }
  | { type: 'text'; label: string; maxLength: number; advanced?: boolean }
  | { type: 'seed'; label: string; min: number; max: number; advanced?: boolean }
  /** A trained Soul ID character (UUID), chosen from the account's characters. */
  | { type: 'character'; label: string; advanced?: boolean };

export interface MediaInput {
  /** Platform parameter name, e.g. image_url or image_urls. */
  param: string;
  role: MediaRole;
  label: string;
  hint?: string;
  required?: boolean;
  /** Max number of files. `array` = sent as a list; otherwise a single URL. */
  max: number;
  array: boolean;
}

export interface StudioMode {
  id: string;
  label: string;
  path: string;
  /** Default true. */
  promptRequired?: boolean;
  params: Record<string, ParamSpec>;
  media: MediaInput[];
}

export interface StudioModel {
  id: string;
  label: string;
  surface: 'image' | 'video';
  family: string;
  description: string;
  /** Admin-set prices are per generated image ('output') or per second of video ('second'). */
  priceUnit: 'output' | 'second';
  modes: StudioMode[];
  note?: string;
}

// ---- helpers ------------------------------------------------------------------------------------
const enumP = (label: string, values: string[], def: string, extra: { numeric?: boolean; advanced?: boolean } = {}): ParamSpec => ({ type: 'enum', label, values, default: def, ...extra });
const intP = (label: string, min: number, max: number, def: number, advanced = false): ParamSpec => ({ type: 'int', label, min, max, default: def, advanced });
const boolP = (label: string, def: boolean, as: 'bool' | 'onoff' | 'yesno' = 'bool', advanced = false): ParamSpec => ({ type: 'boolean', label, default: def, as, advanced });
const seedP = (max = 2147483647, min = 0): ParamSpec => ({ type: 'seed', label: 'Seed (optional)', min, max, advanced: true });

const img = (param: string, role: MediaRole, label: string, o: { required?: boolean; max?: number; array?: boolean; hint?: string } = {}): MediaInput => ({
  param, role, label, required: o.required, max: o.max ?? 1, array: o.array ?? false, hint: o.hint,
});

const ASPECT_VIDEO_BASIC = ['16:9', '9:16', '1:1'];
const ASPECT_SEEDANCE = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const ASPECT_SOUL = ['4:3', '1:1', '3:4', '16:9', '9:16', '2:3', '3:2'];

// ---- images -------------------------------------------------------------------------------------
const soulCommon = (mode: 'text' | 'image'): Record<string, ParamSpec> => ({
  batch_size: enumP('Images per generation', ['1', '4'], '1', { numeric: true }),
  resolution: enumP('Resolution', ['720p', '1080p'], '720p'),
  aspect_ratio: enumP('Aspect ratio', ASPECT_SOUL, '4:3'),
  ...(mode === 'text' ? { enhance_prompt: boolP('Enhance prompt', true) } : {}),
  custom_reference_id: { type: 'character', label: 'Character (Soul ID)' },
  custom_reference_strength: { type: 'number', label: 'Character strength', min: 0, max: 1, step: 0.05, default: 1, advanced: true },
  seed: seedP(1000000, 1),
});

const SOUL_2: StudioModel = {
  id: 'soul-2',
  label: 'Soul 2',
  surface: 'image',
  family: 'Higgsfield',
  description: 'Realistic portraits and fashion images. Add a Soul ID character to keep the same person across images.',
  priceUnit: 'output',
  modes: [
    { id: 'text', label: 'Text → Image', path: 'higgsfield-ai/soul/v2/standard', params: soulCommon('text'), media: [] },
    {
      id: 'image',
      label: 'Image → Image',
      path: 'higgsfield-ai/soul/v2/image-to-image',
      params: soulCommon('image'),
      media: [img('image_url', 'start', 'Reference image', { required: true, hint: 'Required, even when you also pick a character.' })],
    },
  ],
};

const IMAGE_MODELS: StudioModel[] = [
  SOUL_2,
  {
    id: 'grok-image',
    label: 'Grok Imagine 2.0 (image)',
    surface: 'image',
    family: 'xAI',
    description: 'Generates images and makes precise edits while keeping detail. Add input images to edit.',
    priceUnit: 'output',
    modes: [
      {
        id: 'image',
        label: 'Generate / Edit',
        path: 'xai/grok-imagine-image-2.0',
        params: {
          quality: enumP('Quality', ['low', 'medium'], 'medium'),
          resolution: enumP('Resolution', ['1k', '2k'], '1k'),
          aspect_ratio: enumP('Aspect ratio', ['auto', '1:1', '1:2', '2:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'], 'auto'),
        },
        media: [img('image_urls', 'reference', 'Input images (optional)', { max: 5, array: true, hint: 'Add images to edit or guide the result.' })],
      },
    ],
    note: 'The maximum number of input images is not documented; 5 is a cautious limit.',
  },
  {
    id: 'ideogram-4',
    label: 'Ideogram 4.0',
    surface: 'image',
    family: 'Ideogram',
    description: 'Images and edits with accurate multilingual text, for posters, packaging and layouts.',
    priceUnit: 'output',
    modes: [
      {
        id: 'image',
        label: 'Generate / Edit',
        path: 'ideogram/v4.0',
        params: {
          aspect_ratio: enumP('Aspect ratio', ['1:1', '1:2', '2:1', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '5:8', '8:5', '3:4', '4:3', '9:22', '22:9', '9:23', '23:9', '3:8', '8:3', '5:12', '12:5', '1:3', '3:1'], '1:1'),
          rendering_speed: enumP('Rendering speed', ['TURBO', 'DEFAULT', 'QUALITY'], 'DEFAULT'),
          image_weight: intP('Keep input image (1–100)', 1, 100, 50, true),
        },
        media: [img('image_url', 'start', 'Input image (optional)', { hint: 'Add an image to edit; the slider sets how much of it is preserved.' })],
      },
    ],
  },
  {
    id: 'recraft-4-1',
    label: 'Recraft 4.1',
    surface: 'image',
    family: 'Recraft',
    description: 'Images and illustrations that fit a brand style.',
    priceUnit: 'output',
    modes: [
      {
        id: 'text',
        label: 'Text → Image',
        path: 'recraft/v4.1/text-to-image',
        params: {
          aspect_ratio: enumP('Aspect ratio', ['1:1', '2:1', '1:2', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '6:10', '14:10', '10:14', '16:9', '9:16'], '1:1'),
          output_format: enumP('Format', ['jpg', 'png', 'webp'], 'jpg'),
        },
        media: [],
      },
    ],
  },
  {
    id: 'qwen-image-3',
    label: 'Qwen Image 3',
    surface: 'image',
    family: 'Alibaba',
    description: 'Text-to-image and reference-based editing, English or Chinese prompts.',
    priceUnit: 'output',
    modes: [
      {
        id: 'text',
        label: 'Text → Image',
        path: 'alibaba/qwen-image-3/text-to-image',
        params: {
          resolution: enumP('Resolution', ['1k', '2k'], '1k'),
          aspect_ratio: enumP('Aspect ratio', ['1:1', '2:3', '3:2', '3:4', '4:3', '7:9', '9:7', '9:16', '16:9', '21:9'], '1:1'),
          prompt_extend: boolP('Improve prompt', true),
          enable_thinking: boolP('Use reasoning', true, 'bool', true),
          prompt_extend_mode: enumP('Prompt improvement', ['direct', 'agent'], 'direct', { advanced: true }),
          negative_prompt: { type: 'text', label: 'Negative prompt (avoid)', maxLength: 1000, advanced: true },
          seed: seedP(),
        },
        media: [],
      },
      {
        id: 'edit',
        label: 'Edit with images',
        path: 'alibaba/qwen-image-3/edit',
        params: {
          resolution: enumP('Resolution', ['1k', '2k'], '1k'),
          aspect_ratio: enumP('Aspect ratio', ['1:1', '2:3', '3:2', '3:4', '4:3', '7:9', '9:7', '9:16', '16:9', '21:9'], '1:1'),
          prompt_extend: boolP('Improve prompt', true),
          enable_thinking: boolP('Use reasoning', true, 'bool', true),
          negative_prompt: { type: 'text', label: 'Negative prompt (avoid)', maxLength: 1000, advanced: true },
          seed: seedP(),
        },
        media: [img('image_urls', 'reference', 'Images to edit (1–3)', { required: true, max: 3, array: true })],
      },
    ],
  },
  {
    id: 'z-image-turbo',
    label: 'Z-Image Turbo',
    surface: 'image',
    family: 'Alibaba',
    description: 'Fast, low-cost images with clear English and Chinese text.',
    priceUnit: 'output',
    modes: [
      {
        id: 'text',
        label: 'Text → Image',
        path: 'z-image/turbo',
        params: {
          resolution: enumP('Resolution', ['1k', '2k'], '1k'),
          aspect_ratio: enumP('Aspect ratio', ['1:1', '2:3', '3:2', '3:4', '4:3', '7:9', '9:7', '9:16', '16:9', '21:9'], '1:1'),
          prompt_extend: boolP('Improve prompt (higher price tier)', false),
          seed: seedP(),
        },
        media: [],
      },
    ],
  },
];

// ---- video --------------------------------------------------------------------------------------
const klingMain = (tier: 'std' | 'pro' | '4k'): StudioMode[] => [
  {
    id: 'text',
    label: 'Text → Video',
    path: `kling-video/v3.0/${tier}/text-to-video`,
    params: {
      aspect_ratio: enumP('Aspect ratio', ASPECT_VIDEO_BASIC, '16:9'),
      duration: intP('Duration (seconds)', 3, 15, 5),
      sound: boolP('Generate sound', true, 'onoff'),
      cfg_scale: { type: 'number', label: 'Prompt adherence (CFG)', min: 0, max: 1, step: 0.05, default: 0.5, advanced: true },
      multi_shots: boolP('Multi-shot', false, 'bool', true),
    },
    media: [],
  },
  {
    id: 'image',
    label: 'Image → Video',
    path: `kling-video/v3.0/${tier}/image-to-video`,
    promptRequired: false,
    params: {
      duration: intP('Duration (seconds)', 3, 15, 5),
      sound: boolP('Generate sound', true, 'onoff'),
      cfg_scale: { type: 'number', label: 'Prompt adherence (CFG)', min: 0, max: 1, step: 0.05, default: 0.5, advanced: true },
      multi_shots: boolP('Multi-shot', false, 'bool', true),
    },
    media: [img('image_url', 'start', 'Start frame', { required: true }), img('last_image_url', 'end', 'End frame (optional)')],
  },
];

const klingMotion = (tier: 'std' | 'pro'): StudioModel => ({
  id: `kling-3-motion-${tier}`,
  label: `Kling 3.0 Motion Control${tier === 'pro' ? ' Pro' : ''}`,
  surface: 'video',
  family: 'Kling',
  description: 'Make a character image perform the movement from a reference video.',
  priceUnit: 'second',
  modes: [
    {
      id: 'motion',
      label: 'Image + Motion video',
      path: `kling-video/v3/motion-control/${tier}`,
      promptRequired: false,
      params: {
        keep_original_sound: boolP('Keep original sound', true, 'yesno'),
        character_orientation: enumP('Character faces', ['video', 'image'], 'video'),
      },
      media: [img('image_url', 'start', 'Character image', { required: true }), img('video_url', 'video', 'Motion video', { required: true })],
    },
  ],
  note: 'Cost depends on the motion video’s length, which this app can’t see; set the per-second price accordingly.',
});

const seedance = (version: '2.5' | '2.0'): StudioModel => {
  const is25 = version === '2.5';
  const dur = intP('Duration (seconds)', 4, is25 ? 30 : 15, 5);
  const res = enumP('Resolution', is25 ? ['480p', '720p', '1080p'] : ['480p', '720p', '1080p', '4k'], '720p');
  const fmt: Record<string, ParamSpec> = is25 ? { output_format: enumP('Format', ['mp4', 'mov'], 'mp4', { advanced: true }) } : {};
  const audio = boolP('Generate audio', true);
  const aspect = enumP('Aspect ratio', ASPECT_SEEDANCE, '16:9');
  const base = `bytedance/seedance-${version}`;
  return {
    id: `seedance-${is25 ? '2-5' : '2-0'}`,
    label: `Seedance ${version}`,
    surface: 'video',
    family: 'ByteDance',
    description: 'High-quality video from text, a start/end frame, or reference images, video and audio.',
    priceUnit: 'second',
    modes: [
      { id: 'text', label: 'Text → Video', path: `${base}/text-to-video`, params: { aspect_ratio: aspect, duration: dur, resolution: res, generate_audio: audio, ...fmt }, media: [] },
      {
        id: 'image',
        label: 'Image → Video',
        path: `${base}/image-to-video`,
        params: { duration: dur, resolution: res, generate_audio: audio, ...fmt },
        media: [img('image_url', 'start', 'Start frame', { required: true }), img('end_image_url', 'end', 'End frame (optional)')],
      },
      {
        id: 'reference',
        label: 'Reference → Video',
        path: `${base}/reference-to-video`,
        params: { aspect_ratio: aspect, duration: dur, resolution: res, generate_audio: audio, ...fmt },
        media: [
          img('image_urls', 'reference', 'Reference images (characters, objects, style)', { max: 9, array: true }),
          img('video_urls', 'video', 'Reference videos', { max: 3, array: true }),
          img('audio_urls', 'audio', 'Reference audio', { max: 3, array: true }),
        ],
      },
    ],
    note: 'Reference file limits (9 images / 3 videos / 3 audio) come from the third-party studio, not Higgsfield’s docs.',
  };
};

const wanParams: Record<string, ParamSpec> = {
  duration: intP('Duration (seconds)', 2, 30, 5),
  resolution: enumP('Resolution', ['480p', '720p', '1080p'], '1080p'),
  aspect_ratio: enumP('Aspect ratio', ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'], 'adaptive'),
  generate_audio: boolP('Generate sound', true),
  enable_thinking: boolP('Deep thinking', false, 'bool', true),
  seed: seedP(),
};

const MINIMAX_ASPECT = ['auto', 'adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const minimaxParams: Record<string, ParamSpec> = {
  duration: intP('Duration (seconds)', 5, 15, 5),
  resolution: enumP('Resolution', ['2K'], '2K'),
  aspect_ratio: enumP('Aspect ratio', MINIMAX_ASPECT, 'auto'),
  aigc_watermark: boolP('AIGC watermark', false, 'bool', true),
};

const ltx = (tier: 'fast' | 'pro'): StudioModel => {
  const p: Record<string, ParamSpec> = {
    duration: enumP('Duration (seconds)', ['6', '8', '10'], '6', { numeric: true }),
    resolution: enumP('Resolution', ['720p', '1080p', '2k', '4k'], '720p'),
    aspect_ratio: enumP('Aspect ratio', ['16:9', '9:16'], '16:9'),
    fps: enumP('Frames per second', ['24', '25', '48', '50'], '25', { numeric: true, advanced: true }),
    generate_audio: boolP('Generate audio', true),
    camera_movement: enumP('Camera movement', ['', 'dolly_in', 'dolly_out', 'dolly_left', 'dolly_right', 'jib_up', 'jib_down', 'static', 'focus_shift'], '', { advanced: true }),
  };
  return {
    id: `ltx-2-5-${tier}`,
    label: `LTX 2.5 ${tier === 'fast' ? 'Fast' : 'Pro'}`,
    surface: 'video',
    family: 'Lightricks',
    description: tier === 'fast' ? 'Fast video generation with optional audio.' : 'Higher-quality LTX video with optional audio.',
    priceUnit: 'second',
    modes: [
      { id: 'text', label: 'Text → Video', path: `lightricks/ltx-2.5/text-to-video/${tier}`, params: p, media: [] },
      { id: 'image', label: 'Image → Video', path: `lightricks/ltx-2.5/image-to-video/${tier}`, params: p, media: [img('image_url', 'start', 'Start frame', { required: true }), img('end_image_url', 'end', 'End frame (optional)')] },
    ],
  };
};

const VIDEO_MODELS: StudioModel[] = [
  ...(['std', 'pro', '4k'] as const).map(
    (tier): StudioModel => ({
      id: `kling-3-${tier}`,
      label: `Kling 3.0 ${{ std: 'Standard', pro: 'Pro', '4k': '4K' }[tier]}`,
      surface: 'video',
      family: 'Kling',
      description: 'Multi-shot video from text or an image, with native audio, up to 15 seconds.',
      priceUnit: 'second',
      modes: klingMain(tier),
    }),
  ),
  {
    id: 'kling-3-turbo',
    label: 'Kling 3.0 Turbo',
    surface: 'video',
    family: 'Kling',
    description: 'Faster, cheaper Kling video from text or an image.',
    priceUnit: 'second',
    modes: [
      {
        id: 'text',
        label: 'Text → Video',
        path: 'kling-video/v3.0-turbo/text-to-video',
        params: { aspect_ratio: enumP('Aspect ratio', ASPECT_VIDEO_BASIC, '16:9'), resolution: enumP('Resolution', ['720p', '1080p'], '720p'), duration: intP('Duration (seconds)', 3, 15, 5) },
        media: [],
      },
      {
        id: 'image',
        label: 'Image → Video',
        path: 'kling-video/v3.0-turbo/image-to-video',
        params: { resolution: enumP('Resolution', ['720p', '1080p'], '720p'), duration: intP('Duration (seconds)', 3, 15, 5) },
        media: [img('image_url', 'start', 'Start frame', { required: true })],
      },
    ],
  },
  klingMotion('std'),
  klingMotion('pro'),
  seedance('2.5'),
  seedance('2.0'),
  {
    id: 'wan-3',
    label: 'Wan 3.0',
    surface: 'video',
    family: 'Alibaba',
    description: 'Video up to 30 seconds from text, a first/last frame, or reference media.',
    priceUnit: 'second',
    modes: [
      { id: 'text', label: 'Text → Video', path: 'alibaba/wan-3.0/text-to-video', params: wanParams, media: [] },
      {
        id: 'image',
        label: 'Image → Video',
        path: 'alibaba/wan-3.0/image-to-video',
        params: wanParams,
        media: [img('image_url', 'start', 'First frame', { required: true }), img('end_image_url', 'end', 'Last frame (optional)')],
      },
      {
        id: 'reference',
        label: 'Reference → Video',
        path: 'alibaba/wan-3.0/reference-to-video',
        params: wanParams,
        media: [
          img('image_urls', 'reference', 'Reference images', { max: 5, array: true }),
          img('video_urls', 'video', 'Reference videos (up to 5 clips, 30s total)', { max: 5, array: true }),
          img('audio_urls', 'audio', 'Reference audio (WAV/MP3, 30s total)', { max: 5, array: true }),
        ],
      },
    ],
    note: 'Image reference count is not documented; 5 is a cautious limit.',
  },
  {
    id: 'minimax-h3',
    label: 'MiniMax H3',
    surface: 'video',
    family: 'MiniMax',
    description: '2K video up to 15 seconds from text, images, video or audio references.',
    priceUnit: 'second',
    modes: [
      { id: 'text', label: 'Text → Video', path: 'minimax/h3/text-to-video', params: minimaxParams, media: [] },
      {
        id: 'image',
        label: 'Image → Video',
        path: 'minimax/h3/image-to-video',
        params: minimaxParams,
        media: [img('image_url', 'start', 'First frame', { required: true }), img('end_image_url', 'end', 'Last frame (optional)')],
      },
      {
        id: 'reference',
        label: 'Reference → Video',
        path: 'minimax/h3/reference-to-video',
        params: minimaxParams,
        media: [
          img('image_urls', 'reference', 'Reference images', { max: 5, array: true }),
          img('video_urls', 'video', 'Reference videos', { max: 3, array: true }),
          img('audio_urls', 'audio', 'Reference audio', { max: 3, array: true }),
        ],
      },
    ],
    note: 'Reference counts are not documented; limits are cautious.',
  },
  {
    id: 'genjutsu-motion-transfer',
    label: 'Genjutsu Motion Transfer',
    surface: 'video',
    family: 'Higgsfield',
    description: 'Transform an existing video with image references (new characters, locations, styles) while keeping its motion and timing.',
    priceUnit: 'second',
    modes: [
      {
        id: 'transfer',
        label: 'Video + Images',
        path: 'higgsfield/genjutsu/motion-transfer/v1.0',
        promptRequired: false,
        params: { resolution: enumP('Resolution', ['720p', '480p', '1080p'], '720p') },
        media: [img('video_url', 'video', 'Source video (at least 4 seconds)', { required: true }), img('image_urls', 'reference', 'Character / style images', { required: true, max: 4, array: true })],
      },
    ],
    note: 'Cost depends on the source video’s length; the image limit (4) is cautious.',
  },
  ltx('fast'),
  ltx('pro'),
];

export const STUDIO_MODELS: StudioModel[] = [...IMAGE_MODELS, ...VIDEO_MODELS];

export function getStudioModel(id: string): StudioModel | undefined {
  return STUDIO_MODELS.find((m) => m.id === id);
}

/** The catalog is pure data, so it can be sent to the browser as-is (plus the admin-set price). */
export function publicModel(m: StudioModel, price: number | null) {
  return { ...m, priceUsd: price };
}

// ---- mode selection, validation, request building ---------------------------------------------
export interface Plane {
  prompt: string;
  settings: Record<string, any>;
  media: Partial<Record<MediaRole, string[]>>;
}

/** Use the requested mode, else the best match for the media provided (all required inputs present, most inputs used). */
export function pickMode(model: StudioModel, requested: string | undefined, media: Partial<Record<MediaRole, string[]>>): StudioMode {
  if (requested) {
    const m = model.modes.find((x) => x.id === requested);
    if (!m) throw badRequest(`${model.label} has no "${requested}" mode`);
    return m;
  }
  const have = (r: MediaRole) => (media[r]?.length ?? 0) > 0;
  let best = model.modes[0];
  let bestScore = -1;
  for (const m of model.modes) {
    if (m.media.some((i) => i.required && !have(i.role))) continue;
    const score = m.media.filter((i) => have(i.role)).length;
    if (score > bestScore) (best = m), (bestScore = score);
  }
  return best;
}

const HTTP_URL = /^https?:\/\/\S{1,2000}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fill defaults, reject unknown keys / bad values. Optional params with no value are omitted. */
export function resolveSettings(mode: StudioMode, input: Record<string, unknown> = {}): Record<string, any> {
  for (const key of Object.keys(input)) if (!(key in mode.params)) throw badRequest(`Unknown setting "${key}" for ${mode.label}`);
  const out: Record<string, any> = {};
  for (const [key, spec] of Object.entries(mode.params)) {
    const v = input[key];
    switch (spec.type) {
      case 'enum': {
        const val = String(v ?? spec.default);
        if (!spec.values.includes(val)) throw badRequest(`${spec.label}: must be one of ${spec.values.filter(Boolean).join(', ')}`);
        if (val !== '') out[key] = val;
        break;
      }
      case 'int':
      case 'number': {
        const val = v ?? spec.default;
        if (typeof val !== 'number' || !Number.isFinite(val) || val < spec.min || val > spec.max || (spec.type === 'int' && !Number.isInteger(val))) {
          throw badRequest(`${spec.label}: must be ${spec.type === 'int' ? 'a whole number ' : ''}between ${spec.min} and ${spec.max}`);
        }
        out[key] = val;
        break;
      }
      case 'boolean': {
        const val = v ?? spec.default;
        if (typeof val !== 'boolean') throw badRequest(`${spec.label}: must be true or false`);
        out[key] = val;
        break;
      }
      case 'text': {
        if (v === undefined || v === null || v === '') break;
        if (typeof v !== 'string' || v.length > spec.maxLength) throw badRequest(`${spec.label}: must be text up to ${spec.maxLength} characters`);
        out[key] = v;
        break;
      }
      case 'seed': {
        if (v === undefined || v === null || v === '') break;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min || v > spec.max) throw badRequest(`${spec.label}: must be a whole number from ${spec.min} to ${spec.max}`);
        out[key] = v;
        break;
      }
      case 'character': {
        if (v === undefined || v === null || v === '') break;
        if (typeof v !== 'string' || !UUID.test(v)) throw badRequest(`${spec.label}: invalid character id`);
        out[key] = v;
        break;
      }
    }
  }
  // Character strength only means something with a character.
  if ('custom_reference_strength' in out && !('custom_reference_id' in out)) delete out.custom_reference_strength;
  return out;
}

export function resolveMedia(mode: StudioMode, input: Partial<Record<MediaRole, string[]>> = {}): Plane['media'] {
  const out: Plane['media'] = {};
  const allowed = new Map(mode.media.map((m) => [m.role, m]));
  for (const [role, urls] of Object.entries(input) as [MediaRole, string[]][]) {
    if (!urls?.length) continue;
    const spec = allowed.get(role);
    if (!spec) throw badRequest(`${mode.label} does not accept ${role} inputs`);
    if (urls.length > spec.max) throw badRequest(`${spec.label}: at most ${spec.max} file${spec.max > 1 ? 's' : ''}`);
    for (const u of urls) if (!HTTP_URL.test(u)) throw badRequest(`${spec.label}: must be a public http(s) URL`);
    out[role] = urls;
  }
  for (const spec of mode.media) if (spec.required && !out[spec.role]?.length) throw badRequest(`${spec.label} is required for ${mode.label}`);
  return out;
}

/** Turn a validated request into the platform path + JSON body. */
export function buildRequest(mode: StudioMode, p: Plane): { path: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {};
  if (p.prompt) body.prompt = p.prompt;
  for (const [key, spec] of Object.entries(mode.params)) {
    const v = p.settings[key];
    if (v === undefined) continue;
    if (spec.type === 'enum' && spec.numeric) body[key] = Number(v);
    else if (spec.type === 'boolean' && spec.as === 'onoff') body[key] = v ? 'on' : 'off';
    else if (spec.type === 'boolean' && spec.as === 'yesno') body[key] = v ? 'yes' : 'no';
    else body[key] = v;
  }
  for (const m of mode.media) {
    const urls = p.media[m.role];
    if (!urls?.length) continue;
    body[m.param] = m.array ? urls : urls[0];
  }
  return { path: mode.path, body };
}

/** How many outputs one request produces (Soul can return a batch of 4). */
export function outputsPerRequest(settings: Record<string, any>): number {
  return typeof settings.batch_size === 'number' ? settings.batch_size : 1;
}
