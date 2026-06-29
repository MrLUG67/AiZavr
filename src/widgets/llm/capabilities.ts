// Нормализованные возможности LLM-моделей и фильтр по модальностям.
// Используется плагинами OpenRouter и Gemini (вкладка «Все модели»).

import type { ModalityFlags, ModelCapabilities } from '../host/types';

export type { ModalityFlags, ModelCapabilities };

// Контракт фильтра:
// - Ни одной галочки на обеих сторонах → фильтр выключен, показываем все строки.
// - Хотя бы одна галочка на входе ИЛИ выходе → фильтр включён для этой стороны.
// - ВХОД (мягкий): каждая отмеченная категория должна быть у model.in (модель может
//   уметь больше — multimodal in не отсекается).
// - ВЫХОД (жёсткий): каждая отмеченная категория должна быть у model.out (нужен
//   полный набор отмеченного).
// - 3D и прочие спецформаты → флаг other.

/** Категории модальностей в UI (без отдельной колонки 3D). */
export type ModalityKind = 'txt' | 'img' | 'vid' | 'aud' | 'other';

export const MODALITY_KINDS: readonly ModalityKind[] = [
  'txt',
  'img',
  'vid',
  'aud',
  'other',
] as const;

export const MODALITY_LABELS: Record<ModalityKind, string> = {
  txt: 'Текст',
  img: 'Изображение',
  vid: 'Видео',
  aud: 'Аудио',
  other: 'Прочее',
};

/** Состояние фильтра в UI (эфемерное, не в конфиге плагина). */
export interface ModalityFilterState {
  input: ModalityFlags;
  output: ModalityFlags;
}

export function emptyModalityFlags(): ModalityFlags {
  return { txt: false, img: false, vid: false, aud: false, other: false };
}

export function emptyModalityFilter(): ModalityFilterState {
  return { input: emptyModalityFlags(), output: emptyModalityFlags() };
}

/** Есть ли хотя бы одна отмеченная категория на стороне. */
export function sideFilterActive(flags: ModalityFlags): boolean {
  return MODALITY_KINDS.some((k) => flags[k]);
}

/** Фильтр включён, если отмечено что-то на входе или на выходе. */
export function modalityFilterActive(filter: ModalityFilterState): boolean {
  return sideFilterActive(filter.input) || sideFilterActive(filter.output);
}

/**
 * ВХОД (мягкий): все отмеченные в фильтре категории ⊆ model.in.
 * ВЫХОД (жёсткий): все отмеченные в фильтре категории ⊆ model.out.
 * Неактивная сторона фильтра не проверяется.
 */
export function matchesModalityFilter(
  model: ModelCapabilities,
  filter: ModalityFilterState,
): boolean {
  if (!modalityFilterActive(filter)) return true;

  if (sideFilterActive(filter.input)) {
    for (const k of MODALITY_KINDS) {
      if (filter.input[k] && !model.in[k]) return false;
    }
  }

  if (sideFilterActive(filter.output)) {
    for (const k of MODALITY_KINDS) {
      if (filter.output[k] && !model.out[k]) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Маппинг сырья OpenRouter API → ModalityFlags
// ---------------------------------------------------------------------------

const OR_INPUT_TXT = new Set(['text']);
const OR_INPUT_IMG = new Set(['image', 'file']);
const OR_INPUT_VID = new Set(['video']);
const OR_INPUT_AUD = new Set(['audio']);
const OR_OUTPUT_TXT = new Set(['text']);
const OR_OUTPUT_IMG = new Set(['image']);
const OR_OUTPUT_VID = new Set(['video']);
const OR_OUTPUT_AUD = new Set(['audio', 'speech']);
const OR_OUTPUT_OTHER = new Set([
  'embeddings',
  'rerank',
  'transcription',
  // эвристика: 3D и прочее без явного API-тега
]);

function flagsFromOpenRouterList(
  modalities: string[],
  map: {
    txt: Set<string>;
    img: Set<string>;
    vid: Set<string>;
    aud: Set<string>;
    other: Set<string>;
  },
): ModalityFlags {
  const lower = modalities.map((m) => m.toLowerCase());
  const hit = (set: Set<string>) => lower.some((m) => set.has(m));
  const known = new Set([
    ...map.txt,
    ...map.img,
    ...map.vid,
    ...map.aud,
    ...map.other,
  ]);
  const hasUnknown = lower.some((m) => !known.has(m));
  return {
    txt: hit(map.txt),
    img: hit(map.img),
    vid: hit(map.vid),
    aud: hit(map.aud),
    other: hit(map.other) || hasUnknown,
  };
}

/** Нормализация architecture OpenRouter в единый контракт. */
export function capabilitiesFromOpenRouter(
  inputModalities: string[] | undefined,
  outputModalities: string[] | undefined,
): ModelCapabilities {
  const inRaw = inputModalities ?? [];
  const outRaw = outputModalities ?? [];
  const inp = flagsFromOpenRouterList(inRaw, {
    txt: OR_INPUT_TXT,
    img: OR_INPUT_IMG,
    vid: OR_INPUT_VID,
    aud: OR_INPUT_AUD,
    other: new Set(),
  });
  const out = flagsFromOpenRouterList(outRaw, {
    txt: OR_OUTPUT_TXT,
    img: OR_OUTPUT_IMG,
    vid: OR_OUTPUT_VID,
    aud: OR_OUTPUT_AUD,
    other: OR_OUTPUT_OTHER,
  });
  // Пустой output у API → по умолчанию текст (чатовые модели).
  if (!MODALITY_KINDS.some((k) => out[k]) && outRaw.length === 0) {
    out.txt = true;
  }
  if (!MODALITY_KINDS.some((k) => inp[k]) && inRaw.length === 0) {
    inp.txt = true;
  }
  return { in: inp, out };
}

// ---------------------------------------------------------------------------
// Маппинг сырья Gemini API → ModalityFlags (ЭВРИСТИКА).
// В models.list у Gemini нет явных input/output-модальностей, поэтому выводим их
// из supportedGenerationMethods + по имени модели. Менее точно, чем у OpenRouter
// (где модальности приходят явно), но достаточно для фильтра «текст / картинка /
// аудио / видео». Неизвестное → other.
// ---------------------------------------------------------------------------
export function capabilitiesFromGemini(
  modelId: string,
  supportedGenerationMethods: string[] | undefined,
): ModelCapabilities {
  const id = modelId.toLowerCase();
  const methods = (supportedGenerationMethods ?? []).map((m) => m.toLowerCase());

  const hasGenerate =
    methods.includes('generatecontent') || methods.includes('bidigeneratecontent');
  const isEmbedding =
    methods.includes('embedcontent') ||
    methods.includes('embedtext') ||
    /embedding|embed-|text-embedding/.test(id);
  const isImagen = /imagen/.test(id);
  const isVeo = /veo/.test(id);
  const isTts = /tts/.test(id);

  // Выходные модальности.
  const imageOut =
    isImagen || /image-generation|image-preview|flash-image|-image(\b|$)/.test(id);
  const audioOut = isTts || /native-audio|audio-dialog/.test(id);
  const videoOut = isVeo;
  // Текст на выходе: обычные чат-модели (generateContent) и мультимодальные,
  // которые отдают текст вперемешку с картинкой. Чистые imagen/veo/tts/embedding —
  // без текста.
  const textOut =
    hasGenerate && !isEmbedding && !isImagen && !isVeo && !isTts;

  const out: ModalityFlags = {
    txt: textOut,
    img: imageOut,
    vid: videoOut,
    aud: audioOut,
    other: isEmbedding,
  };
  // Ничего не распознали, но это генеративная модель → пусть будет текст.
  if (!MODALITY_KINDS.some((k) => out[k])) {
    if (hasGenerate) out.txt = true;
    else out.other = true;
  }

  // Входные модальности. Современные чат-модели Gemini мультимодальны на вход
  // (текст+картинка+аудио+видео). Спецмодели (embedding/imagen/tts) — текст.
  const multimodalIn = hasGenerate && !isEmbedding;
  const inp: ModalityFlags = {
    txt: true,
    img: multimodalIn,
    vid: multimodalIn,
    aud: multimodalIn,
    other: false,
  };

  return { in: inp, out };
}

/** Краткая подпись для колонки «Комментарий» (без рейтинга). */
export function formatCapabilitiesHint(cap: ModelCapabilities): string {
  const inParts: string[] = [];
  const outParts: string[] = [];
  for (const k of MODALITY_KINDS) {
    if (cap.in[k]) inParts.push(MODALITY_LABELS[k]);
    if (cap.out[k]) outParts.push(MODALITY_LABELS[k]);
  }
  const inStr = inParts.length ? inParts.join(', ') : '—';
  const outStr = outParts.length ? outParts.join(', ') : '—';
  return `вх: ${inStr} · вых: ${outStr}`;
}
