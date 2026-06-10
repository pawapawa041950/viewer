/**
 * File Details Module
 * Shared code for displaying file and image details in both main window and viewer window.
 */

const FileDetails = (function () {
  'use strict';

  // Format file size
  function formatFileSize(bytes) {
    if (bytes == null) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  // Format date from Unix timestamp in milliseconds
  function formatDate(timestamp) {
    if (!timestamp) return '-';

    const date = new Date(timestamp);

    // Validate the date is reasonable (between 1970 and 3000)
    const year = date.getFullYear();
    if (year < 1970 || year > 3000) {
      return '-';
    }

    return date.toLocaleString('ja-JP');
  }

  // Escape HTML
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Format metadata value for better display
   * Handles special cases like long strings, JSON, and technical values
   */
  function formatMetadataValue(key, value) {
    if (!value) return '-';

    const keyLower = key.toLowerCase();
    const strValue = String(value).trim();

    // Handle common metadata keys with special formatting

    // Date/time fields
    if (keyLower.includes('date') || keyLower.includes('time') || keyLower === 'datetime') {
      // Try to parse as date
      try {
        // EXIF date format: "YYYY:MM:DD HH:MM:SS"
        const exifMatch = strValue.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
        if (exifMatch) {
          const [, y, m, d, h, min, s] = exifMatch;
          const date = new Date(y, m - 1, d, h, min, s);
          return date.toLocaleString('ja-JP');
        }
        // Try standard date parsing
        const date = new Date(strValue);
        if (!isNaN(date.getTime())) {
          return date.toLocaleString('ja-JP');
        }
      } catch (e) {
        // Fall through to default
      }
    }

    // GPS coordinates
    if (keyLower.includes('gps') && keyLower.includes('latitude')) {
      return formatGpsCoordinate(strValue, 'N', 'S');
    }
    if (keyLower.includes('gps') && keyLower.includes('longitude')) {
      return formatGpsCoordinate(strValue, 'E', 'W');
    }

    // Exposure time (shutter speed)
    if (keyLower === 'exposuretime' || keyLower === 'exposure time') {
      const num = parseFloat(strValue);
      if (!isNaN(num) && num > 0) {
        if (num < 1) {
          return `1/${Math.round(1 / num)} 秒`;
        }
        return `${num} 秒`;
      }
    }

    // F-number (aperture)
    if (keyLower === 'fnumber' || keyLower === 'f-number' || keyLower === 'aperture') {
      const num = parseFloat(strValue);
      if (!isNaN(num)) {
        return `f/${num}`;
      }
    }

    // ISO
    if (keyLower === 'isospeedratings' || keyLower === 'iso') {
      return `ISO ${strValue}`;
    }

    // Focal length
    if (keyLower.includes('focallength') && !keyLower.includes('35mm')) {
      const num = parseFloat(strValue);
      if (!isNaN(num)) {
        return `${num} mm`;
      }
    }

    // Flash
    if (keyLower === 'flash') {
      const flashCodes = {
        '0': 'フラッシュなし',
        '1': 'フラッシュ発光',
        '5': 'フラッシュ発光 (ストロボ検出なし)',
        '7': 'フラッシュ発光 (ストロボ検出)',
        '8': 'フラッシュなし (強制)',
        '9': 'フラッシュ発光 (強制)',
        '16': 'フラッシュなし (強制オフ)',
        '24': 'フラッシュなし (オート)',
        '25': 'フラッシュ発光 (オート)',
      };
      if (flashCodes[strValue]) {
        return flashCodes[strValue];
      }
    }

    // Orientation
    if (keyLower === 'orientation') {
      const orientations = {
        '1': '通常',
        '2': '左右反転',
        '3': '180°回転',
        '4': '上下反転',
        '5': '反時計回り90°+左右反転',
        '6': '時計回り90°',
        '7': '時計回り90°+左右反転',
        '8': '反時計回り90°',
      };
      if (orientations[strValue]) {
        return orientations[strValue];
      }
    }

    // Resolution unit
    if (keyLower.includes('resolutionunit')) {
      const units = { '1': 'なし', '2': 'インチ', '3': 'センチメートル' };
      if (units[strValue]) {
        return units[strValue];
      }
    }

    // Color space
    if (keyLower === 'colorspace') {
      const spaces = { '1': 'sRGB', '2': 'Adobe RGB', '65535': '未キャリブレート' };
      if (spaces[strValue]) {
        return spaces[strValue];
      }
    }

    // Metering mode
    if (keyLower === 'meteringmode') {
      const modes = {
        '0': '不明',
        '1': '平均',
        '2': '中央重点',
        '3': 'スポット',
        '4': 'マルチスポット',
        '5': 'パターン',
        '6': '部分',
      };
      if (modes[strValue]) {
        return modes[strValue];
      }
    }

    // White balance
    if (keyLower === 'whitebalance') {
      return strValue === '0' ? 'オート' : 'マニュアル';
    }

    // Exposure program
    if (keyLower === 'exposureprogram') {
      const programs = {
        '0': '未定義',
        '1': 'マニュアル',
        '2': 'プログラム',
        '3': '絞り優先',
        '4': 'シャッター優先',
        '5': 'クリエイティブ',
        '6': 'アクション',
        '7': 'ポートレート',
        '8': '風景',
      };
      if (programs[strValue]) {
        return programs[strValue];
      }
    }

    // Long text values - wrap nicely
    if (strValue.length > 50) {
      return strValue;
    }

    return strValue;
  }

  // Format GPS coordinate
  function formatGpsCoordinate(value, posChar, negChar) {
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    const abs = Math.abs(num);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = ((minFloat - min) * 60).toFixed(2);
    const dir = num >= 0 ? posChar : negChar;
    return `${deg}° ${min}' ${sec}" ${dir}`;
  }

  /**
   * Format metadata key for display
   */
  function formatMetadataKey(key) {
    // Common abbreviations and technical names to friendly names
    const keyMappings = {
      'make': 'メーカー',
      'model': 'モデル',
      'software': 'ソフトウェア',
      'datetime': '撮影日時',
      'datetimeoriginal': '撮影日時',
      'datetimedigitized': 'デジタル化日時',
      'exposuretime': '露出時間',
      'fnumber': '絞り値',
      'isospeedratings': 'ISO感度',
      'focallength': '焦点距離',
      'focallength35mm': '35mm換算焦点距離',
      'flash': 'フラッシュ',
      'orientation': '向き',
      'xresolution': 'X解像度',
      'yresolution': 'Y解像度',
      'resolutionunit': '解像度単位',
      'colorspace': '色空間',
      'meteringmode': '測光モード',
      'whitebalance': 'ホワイトバランス',
      'exposureprogram': '露出プログラム',
      'exposuremode': '露出モード',
      'exposurebias': '露出補正',
      'exposurebiasvalue': '露出補正',
      'lensmodel': 'レンズ',
      'lensmake': 'レンズメーカー',
      'artist': '作者',
      'copyright': '著作権',
      'imagedescription': '説明',
      'usercomment': 'コメント',
      'gpslatitude': 'GPS緯度',
      'gpslongitude': 'GPS経度',
      'gpsaltitude': 'GPS高度',
    };

    const keyLower = key.toLowerCase().replace(/[\s_-]/g, '');
    if (keyMappings[keyLower]) {
      return keyMappings[keyLower];
    }

    // Convert camelCase or underscore to spaces
    return key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/^\w/, c => c.toUpperCase());
  }

  /**
   * Check if a string looks like Stable Diffusion WebUI generation info
   * SD WebUI format: prompts, optional "Negative prompt:", then key-value params on last line
   */
  function isSDWebUIInfotext(text) {
    if (!text || typeof text !== 'string') return false;

    // Must contain at least some of these typical SD WebUI parameters
    const sdKeywords = ['Steps:', 'Sampler:', 'CFG scale:', 'Seed:', 'Size:', 'Model hash:', 'Model:'];
    const matchCount = sdKeywords.filter(kw => text.includes(kw)).length;

    return matchCount >= 2;
  }

  /**
   * Parse Stable Diffusion WebUI infotext into structured format
   * Format:
   *   [Positive prompt (multiline)]
   *   Negative prompt: [Negative prompt (multiline)]
   *   Steps: 20, Sampler: Euler a, CFG scale: 7, ...
   */
  function parseSDWebUIInfotext(text) {
    if (!text || typeof text !== 'string') return null;

    const result = {
      prompt: '',
      negativePrompt: '',
      parameters: {}
    };

    const lines = text.trim().split('\n');
    if (lines.length === 0) return null;

    // Find the last line with key-value parameters
    // It should have multiple "key: value" pairs separated by commas
    const paramRegex = /\s*(\w[\w \-\/]+):\s*("(?:\\.|[^\\"])+"|[^,]*)(?:,|$)/g;
    let lastLine = lines[lines.length - 1];
    let paramsLineIndex = lines.length - 1;

    // Check if last line has enough parameters
    const paramMatches = [...lastLine.matchAll(paramRegex)];
    if (paramMatches.length < 3) {
      // Last line might be part of prompts, check previous line
      if (lines.length > 1) {
        const prevLine = lines[lines.length - 2];
        const prevMatches = [...prevLine.matchAll(paramRegex)];
        if (prevMatches.length >= 3) {
          lastLine = prevLine;
          paramsLineIndex = lines.length - 2;
        }
      }
    }

    // Parse parameters from last line
    const finalParamMatches = [...lastLine.matchAll(paramRegex)];
    for (const match of finalParamMatches) {
      let key = match[1].trim();
      let value = match[2].trim();

      // Remove quotes if present
      if (value.startsWith('"') && value.endsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch (e) {
          value = value.slice(1, -1);
        }
      }

      result.parameters[key] = value;
    }

    // Parse prompts from remaining lines
    let inNegativePrompt = false;
    const promptLines = [];
    const negativePromptLines = [];

    for (let i = 0; i < paramsLineIndex; i++) {
      const line = lines[i];

      if (line.startsWith('Negative prompt:')) {
        inNegativePrompt = true;
        const rest = line.substring('Negative prompt:'.length).trim();
        if (rest) negativePromptLines.push(rest);
      } else if (inNegativePrompt) {
        negativePromptLines.push(line);
      } else {
        promptLines.push(line);
      }
    }

    result.prompt = promptLines.join('\n').trim();
    result.negativePrompt = negativePromptLines.join('\n').trim();

    // Generator detection from the Version field. Forge prefixes its version
    // with "f" (e.g. "f2.0.1v1.10.1-..."), A1111 with "v" (e.g. "v1.10.1").
    const ver = String(result.parameters.Version || '');
    let generator = 'SD WebUI';
    if (/Fooocus/i.test(text)) generator = 'Fooocus';
    else if (/^f\d/.test(ver)) generator = 'SD WebUI Forge';
    else if (/^v\d/.test(ver)) generator = 'SD WebUI (A1111)';
    result.parameters.Generator = generator;

    return result;
  }

  /**
   * Detect ComfyUI "prompt" chunk: a JSON object whose values carry `class_type`.
   */
  function isComfyUIPrompt(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return false;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch (_) { return false; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    let hits = 0;
    for (const k of Object.keys(parsed)) {
      const v = parsed[k];
      if (v && typeof v === 'object' && typeof v.class_type === 'string') {
        hits++;
        if (hits >= 2) return true;
      }
    }
    return false;
  }

  /**
   * Parse a ComfyUI "prompt" workflow JSON into the same shape as
   * parseSDWebUIInfotext: { prompt, negativePrompt, parameters }.
   * Traces sampler inputs back through the node graph to find positive /
   * negative CLIPTextEncode nodes, the model loader, and latent size.
   */
  function parseComfyUIPrompt(text) {
    let workflow;
    try { workflow = JSON.parse(text); } catch (_) { return null; }
    if (!workflow || typeof workflow !== 'object') return null;

    const nodeOf = id => {
      if (id == null) return null;
      const n = workflow[id];
      return n && typeof n === 'object' ? n : null;
    };
    const isLink = v =>
      Array.isArray(v) && v.length === 2 &&
      (typeof v[0] === 'string' || typeof v[0] === 'number');

    // Walk a CONDITIONING-typed input back until we hit a CLIPTextEncode-like node.
    function getPromptText(input) {
      if (typeof input === 'string') return input;
      if (!isLink(input)) return null;
      let node = nodeOf(input[0]);
      for (let depth = 0; node && depth < 16; depth++) {
        const ct = node.class_type || '';
        const ins = node.inputs || {};
        if (ct.startsWith('CLIPTextEncode')) {
          if (typeof ins.text === 'string') return ins.text;
          if (isLink(ins.text)) { node = nodeOf(ins.text[0]); continue; }
          return null;
        }
        // Reroute / passthrough / conditioning combinators: follow the most
        // likely upstream link.
        const next = ins.conditioning || ins.positive || ins.input
          || ins.text || ins.string || ins.value || ins[0];
        if (isLink(next)) { node = nodeOf(next[0]); continue; }
        if (typeof next === 'string') return next;
        break;
      }
      return null;
    }

    // Walk a MODEL-typed input back until we find a loader with a name.
    function getModelName(input) {
      if (typeof input === 'string') return input;
      if (!isLink(input)) return null;
      let node = nodeOf(input[0]);
      for (let depth = 0; node && depth < 16; depth++) {
        const ins = node.inputs || {};
        if (typeof ins.ckpt_name === 'string') return ins.ckpt_name;
        if (typeof ins.unet_name === 'string') return ins.unet_name;
        if (typeof ins.model_name === 'string') return ins.model_name;
        if (isLink(ins.model)) { node = nodeOf(ins.model[0]); continue; }
        break;
      }
      return null;
    }

    // Resolve a primitive sampler input that may be a literal or a link to an
    // upstream config/primitive node (rgthree "Seed" / "KSampler Config", etc).
    // `keys` lists the field names to accept on the upstream node, in order.
    function resolvePrim(input, keys) {
      if (typeof input === 'number' || typeof input === 'string') return input;
      if (!isLink(input)) return null;
      let node = nodeOf(input[0]);
      for (let depth = 0; node && depth < 8; depth++) {
        const ins = node.inputs || {};
        for (const k of keys) {
          if (typeof ins[k] === 'number' || typeof ins[k] === 'string') return ins[k];
        }
        // Follow a single passthrough/primitive output link and retry.
        const next = ins.value != null ? ins.value : ins[keys[0]];
        if (isLink(next)) { node = nodeOf(next[0]); continue; }
        break;
      }
      return null;
    }

    // Walk a LATENT-typed input back to find width/height.
    function getLatentSize(input) {
      if (!isLink(input)) return null;
      let node = nodeOf(input[0]);
      for (let depth = 0; node && depth < 16; depth++) {
        const ins = node.inputs || {};
        if (typeof ins.width === 'number' && typeof ins.height === 'number') {
          return { width: ins.width, height: ins.height };
        }
        if (isLink(ins.samples)) { node = nodeOf(ins.samples[0]); continue; }
        if (isLink(ins.latent)) { node = nodeOf(ins.latent[0]); continue; }
        if (isLink(ins.latent_image)) { node = nodeOf(ins.latent_image[0]); continue; }
        break;
      }
      return null;
    }

    const samplerClasses = new Set([
      'KSampler', 'KSamplerAdvanced',
      'SamplerCustom', 'SamplerCustomAdvanced',
    ]);
    let sampler = null;
    for (const id of Object.keys(workflow)) {
      const n = workflow[id];
      if (n && samplerClasses.has(n.class_type)) { sampler = n; break; }
    }
    // Fallback: custom sampler nodes (Impact pack's ImpactKSamplerBasicPipe,
    // etc.) aren't in the known set — recognize any *Sampler* node that carries
    // the usual sampling primitives.
    if (!sampler) {
      for (const id of Object.keys(workflow)) {
        const n = workflow[id];
        if (!n || typeof n !== 'object') continue;
        const ct = String(n.class_type || '');
        const ins = n.inputs || {};
        // `steps`/`sampler_name` may be literals or links to upstream config
        // nodes (rgthree), so test for presence, not type.
        if ((ct.includes('Sampler') || ct.includes('sampler'))
          && ('steps' in ins) && ('sampler_name' in ins)) {
          sampler = n;
          break;
        }
      }
    }

    let positive = null, negative = null, model = null;
    let steps = null, cfg = null, seed = null, samplerName = null,
      scheduler = null, denoise = null;
    let size = null;

    if (sampler) {
      const ins = sampler.inputs || {};
      // Some samplers bundle model/clip/vae/positive/negative into a single
      // *_pipe input (Impact pack's basic_pipe). Unwrap it to reach the loaders.
      let modelIn = ins.model, posIn = ins.positive, negIn = ins.negative;
      const pipeIn = ins.basic_pipe || ins.pipe;
      if (isLink(pipeIn)) {
        const pipe = nodeOf(pipeIn[0]);
        const pins = (pipe && pipe.inputs) || {};
        if (modelIn == null) modelIn = pins.model;
        if (posIn == null) posIn = pins.positive;
        if (negIn == null) negIn = pins.negative;
      }
      positive = getPromptText(posIn);
      negative = getPromptText(negIn);
      model = getModelName(modelIn);
      seed = resolvePrim(ins.seed, ['seed', 'noise_seed']);
      if (seed == null) seed = resolvePrim(ins.noise_seed, ['noise_seed', 'seed']);
      steps = resolvePrim(ins.steps, ['steps', 'steps_total']);
      cfg = resolvePrim(ins.cfg, ['cfg', 'cfg_scale']);
      const sn = resolvePrim(ins.sampler_name, ['sampler_name']);
      if (typeof sn === 'string') samplerName = sn;
      const sch = resolvePrim(ins.scheduler, ['scheduler']);
      if (typeof sch === 'string') scheduler = sch;
      denoise = resolvePrim(ins.denoise, ['denoise']);
      size = getLatentSize(ins.latent_image);
    }

    // Fallback: if sampler-trace didn't find prompts, sniff CLIPTextEncode
    // nodes by their _meta.title.
    if (!positive || !negative) {
      for (const id of Object.keys(workflow)) {
        const n = workflow[id];
        if (!n || !String(n.class_type || '').startsWith('CLIPTextEncode')) continue;
        const text = n.inputs && typeof n.inputs.text === 'string' ? n.inputs.text : null;
        if (!text) continue;
        const title = ((n._meta && n._meta.title) || '').toLowerCase();
        if (!positive && (title.includes('positive') || title.includes('ポジ'))) {
          positive = text;
        } else if (!negative && (title.includes('negative') || title.includes('ネガ'))) {
          negative = text;
        }
      }
    }

    // Auxiliary loaders (VAE / CLIP) and LoRAs — collected for the
    // parameters grid so the user can see them at a glance.
    let vae = null, clip = null;
    const loras = [];
    for (const id of Object.keys(workflow)) {
      const n = workflow[id];
      if (!n || typeof n !== 'object') continue;
      const ct = n.class_type || '';
      const ins = n.inputs || {};
      if (ct === 'VAELoader' && typeof ins.vae_name === 'string') vae = ins.vae_name;
      else if (ct === 'CLIPLoader' && typeof ins.clip_name === 'string') clip = ins.clip_name;
      else if (ct === 'DualCLIPLoader') {
        const list = [ins.clip_name1, ins.clip_name2].filter(s => typeof s === 'string');
        if (list.length) clip = list.join(' + ');
      }
      else if (ct.startsWith('LoraLoader') && typeof ins.lora_name === 'string') {
        const sm = ins.strength_model;
        const sc = ins.strength_clip;
        let suffix = '';
        if (typeof sm === 'number' && typeof sc === 'number' && sm !== sc) {
          suffix = ` (m=${sm}, c=${sc})`;
        } else if (typeof sm === 'number') {
          suffix = ` (${sm})`;
        }
        loras.push(ins.lora_name + suffix);
      }
    }

    // Global fallback: if the sampler trace couldn't reach a loader (custom
    // pipe/sampler graphs), grab the first checkpoint / UNet / diffusion loader.
    if (!model) {
      for (const id of Object.keys(workflow)) {
        const n = workflow[id];
        const ins = (n && n.inputs) || {};
        if (typeof ins.ckpt_name === 'string') { model = ins.ckpt_name; break; }
        if (typeof ins.unet_name === 'string') { model = ins.unet_name; break; }
        if (typeof ins.model_name === 'string') { model = ins.model_name; break; }
      }
    }

    // Global fallback for sampler params: rgthree-style graphs route steps/cfg/
    // sampler through Combine/Split/Switch primitive nodes the trace can't
    // follow, but a config node (e.g. "KSampler Config") holds them as literals.
    if (samplerName == null || steps == null) {
      for (const id of Object.keys(workflow)) {
        const n = workflow[id];
        const ins = (n && n.inputs) || {};
        if (typeof ins.sampler_name !== 'string') continue;
        if (samplerName == null) samplerName = ins.sampler_name;
        if (scheduler == null && typeof ins.scheduler === 'string') scheduler = ins.scheduler;
        if (cfg == null && typeof ins.cfg === 'number') cfg = ins.cfg;
        if (steps == null) {
          if (typeof ins.steps === 'number') steps = ins.steps;
          else if (typeof ins.steps_total === 'number') steps = ins.steps_total;
        }
        break;
      }
    }

    const parameters = {};
    if (steps != null) parameters['Steps'] = steps;
    if (samplerName) parameters['Sampler'] = samplerName;
    if (scheduler) parameters['Scheduler'] = scheduler;
    if (cfg != null) parameters['CFG scale'] = cfg;
    if (seed != null) parameters['Seed'] = seed;
    if (denoise != null) parameters['Denoise'] = denoise;
    if (size) parameters['Size'] = `${size.width}x${size.height}`;
    if (model) parameters['Model'] = model;
    if (vae) parameters['VAE'] = vae;
    if (clip) parameters['CLIP'] = clip;
    if (loras.length) parameters['LoRA'] = loras.join(', ');
    parameters['Generator'] = 'ComfyUI';

    return {
      prompt: positive || '',
      negativePrompt: negative || '',
      parameters,
      _source: 'comfyui',
    };
  }

  /**
   * Detect NovelAI metadata. Accepts either an array of {key,value} entries
   * (preferred — matches what the Rust side returns) or the raw text of a
   * single chunk. The strong signal is the `Software` chunk equal to "NovelAI".
   */
  function isNovelAI(metadata) {
    if (!Array.isArray(metadata)) return false;
    for (const e of metadata) {
      if (!e || typeof e.key !== 'string') continue;
      const k = e.key.toLowerCase();
      const v = typeof e.value === 'string' ? e.value.trim() : '';
      if (k === 'software' && v === 'NovelAI') return true;
      if (k === 'source' && /NovelAI Diffusion/i.test(v)) return true;
      if (k === 'title' && /NovelAI generated image/i.test(v)) return true;
    }
    return false;
  }

  /**
   * Parse NovelAI metadata into the same shape as parseSDWebUIInfotext:
   * { prompt, negativePrompt, parameters }.
   *
   * NovelAI writes a few flat tEXt chunks (Description / Source / Software)
   * plus a `Comment` chunk that contains a JSON object with the full
   * generation parameters. v4+ stores prompts inside nested
   * `v4_prompt.caption.base_caption` / `v4_negative_prompt.caption.base_caption`;
   * older versions used flat `prompt` / `uc` (= "undesired content").
   */
  function parseNovelAI(metadata) {
    const get = key => {
      for (const e of metadata) {
        if (e && typeof e.key === 'string' && e.key.toLowerCase() === key) {
          return typeof e.value === 'string' ? e.value : '';
        }
      }
      return '';
    };

    const description = get('description');
    const source = get('source');
    const commentRaw = get('comment');

    let comment = null;
    if (commentRaw) {
      try { comment = JSON.parse(commentRaw); } catch (_) { comment = null; }
    }

    let prompt = description;
    let negativePrompt = '';

    if (comment && typeof comment === 'object') {
      // v4+ first (it's the current format); fall back to flat v3 fields.
      const v4Pos = comment.v4_prompt && comment.v4_prompt.caption
        ? comment.v4_prompt.caption.base_caption : null;
      const v4Neg = comment.v4_negative_prompt && comment.v4_negative_prompt.caption
        ? comment.v4_negative_prompt.caption.base_caption : null;
      if (typeof v4Pos === 'string' && v4Pos) prompt = v4Pos;
      else if (typeof comment.prompt === 'string' && comment.prompt) prompt = comment.prompt;
      if (typeof v4Neg === 'string' && v4Neg) negativePrompt = v4Neg;
      else if (typeof comment.uc === 'string') negativePrompt = comment.uc;
    }

    const parameters = {};
    if (comment) {
      if (comment.steps != null) parameters['Steps'] = comment.steps;
      if (comment.sampler) parameters['Sampler'] = comment.sampler;
      if (comment.noise_schedule) parameters['Scheduler'] = comment.noise_schedule;
      if (comment.scale != null) parameters['CFG scale'] = comment.scale;
      if (comment.uncond_scale != null && comment.uncond_scale !== 0) {
        parameters['Uncond scale'] = comment.uncond_scale;
      }
      if (comment.cfg_rescale != null && comment.cfg_rescale !== 0) {
        parameters['CFG rescale'] = comment.cfg_rescale;
      }
      if (comment.seed != null) parameters['Seed'] = comment.seed;
      if (comment.width && comment.height) {
        parameters['Size'] = `${comment.width}x${comment.height}`;
      }
      if (comment.sm) parameters['SMEA'] = 'on';
      if (comment.sm_dyn) parameters['SMEA DYN'] = 'on';
      if (comment.dynamic_thresholding) parameters['Dynamic thresholding'] = 'on';
    }
    parameters['Model'] = source || 'NovelAI';
    parameters['Generator'] = 'NovelAI';

    return { prompt: prompt || '', negativePrompt: negativePrompt || '', parameters, _source: 'novelai' };
  }

  /**
   * Render SD WebUI infotext as formatted HTML
   */
  function renderSDWebUIInfotext(parsed) {
    if (!parsed) return '';

    let html = '<div class="sd-infotext">';

    // Prompt section
    if (parsed.prompt) {
      html += `
        <div class="sd-section">
          <div class="sd-section-header">📝 プロンプト</div>
          <div class="sd-prompt">${escapeHtml(parsed.prompt)}</div>
        </div>
      `;
    }

    // Negative prompt section
    if (parsed.negativePrompt) {
      html += `
        <div class="sd-section">
          <div class="sd-section-header">🚫 ネガティブプロンプト</div>
          <div class="sd-negative-prompt">${escapeHtml(parsed.negativePrompt)}</div>
        </div>
      `;
    }

    // Parameters section
    const params = parsed.parameters;
    if (Object.keys(params).length > 0) {
      html += `
        <div class="sd-section">
          <div class="sd-section-header">⚙️ 生成設定</div>
          <div class="sd-params-grid">
      `;

      // Priority order for common parameters
      const priorityKeys = ['Steps', 'Sampler', 'CFG scale', 'Seed', 'Size', 'Model', 'Model hash'];
      const orderedKeys = [];

      // Add priority keys first
      for (const key of priorityKeys) {
        if (params[key] !== undefined) {
          orderedKeys.push(key);
        }
      }

      // Add remaining keys (Generator is forced to the very end below)
      for (const key of Object.keys(params)) {
        if (!orderedKeys.includes(key) && key !== 'Generator') {
          orderedKeys.push(key);
        }
      }
      if (params['Generator'] !== undefined) {
        orderedKeys.push('Generator');
      }

      for (const key of orderedKeys) {
        const value = params[key];
        html += `
          <div class="sd-param">
            <span class="sd-param-key">${escapeHtml(key)}</span>
            <span class="sd-param-value">${escapeHtml(value)}</span>
          </div>
        `;
      }

      html += `
          </div>
        </div>
      `;
    }

    html += '</div>';
    return html;
  }

  /**
   * Group metadata by category for better organization
   */
  function groupMetadata(metadata) {
    const groups = {
      camera: { label: 'カメラ情報', items: [] },
      image: { label: '画像設定', items: [] },
      exposure: { label: '露出設定', items: [] },
      gps: { label: 'GPS情報', items: [] },
      other: { label: 'その他', items: [] },
    };

    const categoryMap = {
      'make': 'camera', 'model': 'camera', 'software': 'camera',
      'lensmodel': 'camera', 'lensmake': 'camera',
      'orientation': 'image', 'xresolution': 'image', 'yresolution': 'image',
      'resolutionunit': 'image', 'colorspace': 'image',
      'exposuretime': 'exposure', 'fnumber': 'exposure', 'isospeedratings': 'exposure',
      'focallength': 'exposure', 'flash': 'exposure', 'meteringmode': 'exposure',
      'whitebalance': 'exposure', 'exposureprogram': 'exposure', 'exposuremode': 'exposure',
      'exposurebias': 'exposure', 'exposurebiasvalue': 'exposure',
      'gpslatitude': 'gps', 'gpslongitude': 'gps', 'gpsaltitude': 'gps',
    };

    for (const item of metadata) {
      const keyLower = item.key.toLowerCase().replace(/[\s_-]/g, '');
      const category = categoryMap[keyLower] || 'other';
      groups[category].items.push({
        key: formatMetadataKey(item.key),
        value: formatMetadataValue(item.key, item.value),
        originalKey: item.key,
      });
    }

    return groups;
  }

  /**
   * Render image details HTML
   * @param {Object} details - Image details from Rust API
   * @param {Object} options - Rendering options
   * @returns {string} HTML string
   */
  function renderImageDetails(details, options = {}) {
    const showMetadata = options.showMetadata !== false;

    // Pre-parse generation metadata so Generator/Model can be hoisted into
    // the basic info section alongside size/date.
    let sdInfotext = null;
    let comfyPrompt = null;
    let novelai = false;
    let parsedGen = null;
    if (showMetadata && details.metadata && details.metadata.length > 0) {
      for (const item of details.metadata) {
        const keyLower = item.key.toLowerCase();
        if (keyLower === 'usercomment' || keyLower === 'parameters' || keyLower === 'comment') {
          if (isSDWebUIInfotext(item.value)) {
            sdInfotext = item.value;
            break;
          }
        }
      }
      if (!sdInfotext && isNovelAI(details.metadata)) {
        novelai = true;
      }
      if (!sdInfotext && !novelai) {
        for (const item of details.metadata) {
          const keyLower = item.key.toLowerCase();
          if (keyLower === 'prompt' && isComfyUIPrompt(item.value)) {
            comfyPrompt = item.value;
            break;
          }
        }
      }
      if (sdInfotext) parsedGen = parseSDWebUIInfotext(sdInfotext);
      else if (novelai) parsedGen = parseNovelAI(details.metadata);
      else if (comfyPrompt) parsedGen = parseComfyUIPrompt(comfyPrompt);
    }

    const generatorName = parsedGen && parsedGen.parameters
      ? parsedGen.parameters.Generator : undefined;
    const modelName = parsedGen && parsedGen.parameters
      ? parsedGen.parameters.Model : undefined;

    let genModelRow = '';
    if (generatorName || modelName) {
      genModelRow = `
        <div class="details-row">
          <div class="details-row-cell">
            <span class="details-label">Generator</span>
            <span class="details-value">${escapeHtml(generatorName || '—')}</span>
          </div>
          <div class="details-row-cell">
            <span class="details-label">Model</span>
            <span class="details-value">${escapeHtml(modelName || '—')}</span>
          </div>
        </div>
      `;
    }

    let html = `
      <div class="details-section">
        <div class="details-filename">${escapeHtml(details.name)}</div>
        <div class="details-row">
          <div class="details-row-cell">
            <span class="details-label">形式</span>
            <span class="details-value">${escapeHtml(details.format)}</span>
          </div>
          <div class="details-row-cell">
            <span class="details-label">画像サイズ</span>
            <span class="details-value">${details.width} × ${details.height}</span>
          </div>
        </div>
        <div class="details-row">
          <div class="details-row-cell">
            <span class="details-label">サイズ</span>
            <span class="details-value">${formatFileSize(details.file_size)}</span>
          </div>
          <div class="details-row-cell">
            <span class="details-label">更新日</span>
            <span class="details-value">${formatDate(details.modified_at)}</span>
          </div>
        </div>
        ${genModelRow}
      </div>
    `;

    if (showMetadata && details.metadata && details.metadata.length > 0) {
      if (parsedGen) {
        // Hoisted into the basic info section; drop from the params grid.
        delete parsedGen.parameters.Generator;
        delete parsedGen.parameters.Model;
        html += renderSDWebUIInfotext(parsedGen);

        // Hide raw chunks already represented above; for ComfyUI also hide
        // the verbose "workflow" chunk (UI graph dump); for NovelAI hide the
        // text chunks the parser already consumed.
        const otherMetadata = details.metadata.filter(item => {
          const keyLower = item.key.toLowerCase();
          if (sdInfotext) {
            return keyLower !== 'usercomment' && keyLower !== 'parameters' && keyLower !== 'comment';
          }
          if (novelai) {
            return keyLower !== 'description' && keyLower !== 'comment'
              && keyLower !== 'software' && keyLower !== 'source' && keyLower !== 'title';
          }
          return keyLower !== 'prompt' && keyLower !== 'workflow';
        });

        if (otherMetadata.length > 0) {
          const groups = groupMetadata(otherMetadata);

          for (const [groupKey, group] of Object.entries(groups)) {
            if (group.items.length === 0) continue;

            html += `
              <div class="details-section">
                <h4>${escapeHtml(group.label)}</h4>
            `;

            for (const item of group.items) {
              html += `
                <div class="details-metadata-item">
                  <div class="details-metadata-key">${escapeHtml(item.key)}</div>
                  <div class="details-metadata-value">${escapeHtml(item.value)}</div>
                </div>
              `;
            }

            html += `</div>`;
          }
        }
      } else {
        // Standard metadata display
        const groups = groupMetadata(details.metadata);

        for (const [groupKey, group] of Object.entries(groups)) {
          if (group.items.length === 0) continue;

          html += `
            <div class="details-section">
              <h4>${escapeHtml(group.label)}</h4>
          `;

          for (const item of group.items) {
            html += `
              <div class="details-metadata-item">
                <div class="details-metadata-key">${escapeHtml(item.key)}</div>
                <div class="details-metadata-value">${escapeHtml(item.value)}</div>
              </div>
            `;
          }

          html += `</div>`;
        }
      }
    }

    return html;
  }

  /**
   * Render file details HTML (for non-image files)
   * @param {Object} fileInfo - File info from Rust API
   * @param {string} fileName - Display name
   * @param {boolean} isDir - Whether it's a directory
   * @returns {string} HTML string
   */
  function renderFileDetails(fileInfo, fileName, isDir) {
    let html = `
      <div class="details-thumbnail">
        <span class="placeholder-icon">${isDir ? '📁' : '📄'}</span>
      </div>
      <div class="details-filename">${escapeHtml(fileName)}</div>
    `;

    if (fileInfo) {
      html += `<div class="details-section">`;

      if (!fileInfo.is_dir) {
        html += `
          <div class="details-row">
            <span class="details-label">サイズ</span>
            <span class="details-value">${formatFileSize(fileInfo.file_size)}</span>
          </div>
        `;
      }

      html += `
        <div class="details-row">
          <span class="details-label">更新日</span>
          <span class="details-value">${formatDate(fileInfo.modified_at)}</span>
        </div>
      </div>
      `;
    }

    return html;
  }

  // Public API
  return {
    formatFileSize,
    formatDate,
    escapeHtml,
    formatMetadataKey,
    formatMetadataValue,
    groupMetadata,
    renderImageDetails,
    renderFileDetails,
    isSDWebUIInfotext,
    parseSDWebUIInfotext,
    isComfyUIPrompt,
    parseComfyUIPrompt,
    isNovelAI,
    parseNovelAI,
  };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileDetails;
}
