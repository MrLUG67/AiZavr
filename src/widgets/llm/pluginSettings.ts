// Общие настройки LLM-плагинов (OpenRouter, Gemini): конфиг, маскировка ключа,
// трёхвкладочная форма (избранные / полный список / API Key).

import type {
  WidgetCapabilities,
  FormDoc,
  ControlNode,
  ModelTableRow,
  ModelCapabilities,
  ModelTableModalityFilterUi,
} from '../host/types';
import { formatCapabilitiesHint } from './capabilities';
import { lt } from './i18n';
import { t } from '../../i18n';

/** Подписи фильтра модальностей над таблицей моделей (общие для всех LLM-плагинов).
 *  Функция, а не константа: строки берутся при сборке формы, чтобы смена языка
 *  подхватывалась пересборкой (@@lang). */
export function modalityFilterUi(): ModelTableModalityFilterUi {
  return {
    inputLabel: lt('modality.inputLabel'),
    outputLabel: lt('modality.outputLabel'),
    inputHint: lt('modality.inputHint'),
    outputHint: lt('modality.outputHint'),
  };
}

/**
 * Потолок длины ответа модели по умолчанию (max_tokens / maxOutputTokens).
 * Раньше был жёстко зашит в api.ts каждого LLM-плагина; теперь выносится в
 * настройки, а это значение остаётся дефолтом. Не даём модели резервировать
 * весь выходной лимит и экономим платную/бесплатную квоту.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** Границы допустимого значения потолка (защита от опечаток в форме). */
export const MIN_MAX_OUTPUT_TOKENS = 1;
export const MAX_MAX_OUTPUT_TOKENS = 1_000_000;

export interface LlmPluginConfig {
  selectedModelId: string;
  favoriteModelIds: string[];
  /**
   * Потолок длины ответа модели (max_tokens). Необязателен: если не задан —
   * используется DEFAULT_MAX_OUTPUT_TOKENS.
   */
  maxOutputTokens?: number;
  /**
   * Оценки пользователя 1–5 по id модели (локально, на будущее).
   * Пока не используется в UI; зарезервировано под звёзды на ответах LLM
   * и возможное облачное усреднение.
   */
  modelRatings?: Record<string, number>;
}

/** Разобрать/валидировать потолок ответа: целое в допустимых границах либо undefined. */
export function parseMaxOutputTokens(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const int = Math.floor(n);
  if (int < MIN_MAX_OUTPUT_TOKENS) return undefined;
  return Math.min(int, MAX_MAX_OUTPUT_TOKENS);
}

export interface LlmModelRow {
  id: string;
  name: string;
  contextWindow: number;
  /** Устаревает: подпись для comment, если нет capabilities. */
  extra?: string;
  capabilities?: ModelCapabilities;
}

export interface LlmSettingsFormState {
  hasApiKey: boolean;
  maskedKey: string | null;
  selectedModelId: string;
  favoriteModelIds: string[];
  /** Текущий потолок длины ответа модели (для поля формы). */
  maxOutputTokens: number;
  models: LlmModelRow[];
  loadingModels: boolean;
  error: string | null;
  keyVerifyStatus?: 'idle' | 'checking' | 'ok' | 'fail';
  keyVerifyMessage?: string | null;
  /** Фильтр модальностей над таблицей (OpenRouter). */
  modalityFilter?: ModelTableModalityFilterUi;
}

export interface LlmSettingsLabels {
  pluginId: string;
  title: string;
  keysUrl: string;
  keysLinkLabel: string;
  keyInstructions: string;
  keyPlaceholder: string;
}

export function parseLlmConfig(raw: string | null, defaultModel: string): LlmPluginConfig {
  if (!raw) return { selectedModelId: defaultModel, favoriteModelIds: [] };
  try {
    const o = JSON.parse(raw) as {
      selectedModelId?: unknown;
      favoriteModelIds?: unknown;
      maxOutputTokens?: unknown;
      modelRatings?: unknown;
    };
    const selectedModelId =
      typeof o.selectedModelId === 'string' && o.selectedModelId
        ? o.selectedModelId
        : defaultModel;
    const favoriteModelIds = Array.isArray(o.favoriteModelIds)
      ? o.favoriteModelIds.filter((x): x is string => typeof x === 'string')
      : [];
    const maxOutputTokens = parseMaxOutputTokens(o.maxOutputTokens);
    const modelRatings = parseModelRatings(o.modelRatings);
    return {
      selectedModelId,
      favoriteModelIds,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(modelRatings ? { modelRatings } : {}),
    };
  } catch {
    return { selectedModelId: defaultModel, favoriteModelIds: [] };
  }
}

function parseModelRatings(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && v >= 1 && v <= 5 && Number.isInteger(v)) {
      out[id] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function saveLlmConfig(
  cap: WidgetCapabilities,
  pluginId: string,
  config: LlmPluginConfig,
): Promise<void> {
  try {
    await cap.config.save(JSON.stringify(config, null, 2));
  } catch (e) {
    console.error(`[${pluginId}] save config failed`, e);
  }
}

/** Маскировка ключа: начало + «…» + конец (как sk-or-v1-557…2d5 / AQ.Ab8…G8jw). */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return '••••••••';
  const headLen = Math.min(12, Math.ceil(trimmed.length * 0.35));
  const tailLen = Math.min(4, Math.floor(trimmed.length * 0.15));
  if (headLen + tailLen + 3 >= trimmed.length) {
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-3)}`;
  }
  return `${trimmed.slice(0, headLen)}…${trimmed.slice(-tailLen)}`;
}

export function serializeFavorites(ids: string[]): string {
  return JSON.stringify(ids);
}

export function parseFavoritesFromValues(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return [...fallback];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [...fallback];
    return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    return [...fallback];
  }
}

function modelComment(m: LlmModelRow): string {
  const parts = [`${m.contextWindow.toLocaleString()} токенов`];
  if (m.extra) parts.push(m.extra);
  return parts.join(' · ');
}

function toTableRows(models: LlmModelRow[]): ModelTableRow[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    capabilities: m.capabilities,
    comment: m.capabilities
      ? formatCapabilitiesHint(m.capabilities)
      : modelComment(m),
  }));
}

function text(value: string, muted = false): ControlNode {
  return { kind: 'text', value, tone: muted ? 'muted' : 'normal' };
}

export function buildLlmSettingsForm(
  labels: LlmSettingsLabels,
  state: LlmSettingsFormState,
): FormDoc {
  const favorites = state.favoriteModelIds;
  const favoriteModels = state.models.filter((m) => favorites.includes(m.id));
  const effectiveModelId = favoriteModels.some((m) => m.id === state.selectedModelId)
    ? state.selectedModelId
    : (favoriteModels[0]?.id ?? state.selectedModelId);

  const modelChildren: ControlNode[] =
    !state.hasApiKey
      ? [text(lt('favorites.noKeyFirst'), true)]
      : state.loadingModels
        ? [text(t('app.settings.loadingModels'), true)]
        : favoriteModels.length === 0
          ? [text(lt('favorites.empty'), true)]
          : [
              {
                kind: 'field',
                label: lt('favorites.modelLabel'),
                hint: lt('favorites.modelHint'),
                child: {
                  kind: 'favoriteModelList',
                  name: 'modelId',
                  value: effectiveModelId,
                  items: favoriteModels.map((m) => ({
                    id: m.id,
                    label: m.name,
                  })),
                  onRemove: { type: 'FORM_REMOVE_FAVORITE' },
                },
              },
            ];

  // Потолок длины ответа модели — доступен всегда, не зависит от ключа/моделей.
  const maxTokensField: ControlNode = {
    kind: 'field',
    label: lt('maxTokens.label'),
    hint: lt('maxTokens.hint', { default: DEFAULT_MAX_OUTPUT_TOKENS }),
    child: {
      kind: 'textInput',
      name: 'maxOutputTokens',
      value: String(state.maxOutputTokens),
      placeholder: String(DEFAULT_MAX_OUTPUT_TOKENS),
    },
  };

  const favoritesTab: ControlNode = {
    kind: 'stack',
    children: [...modelChildren, maxTokensField],
  };

  const allModelsTab: ControlNode = {
    kind: 'stack',
    children: [
      text(lt('allModels.hint'), true),
      {
        kind: 'modelTable',
        name: 'favoriteModelIds',
        value: serializeFavorites(favorites),
        rows: toTableRows(state.models),
        disabled: state.loadingModels || !state.hasApiKey,
        searchPlaceholder: lt('allModels.searchPlaceholder'),
        modalityFilter: state.modalityFilter,
      },
    ],
  };

  const apiKeyChildren: ControlNode[] = [];

  if (state.hasApiKey && state.maskedKey) {
    apiKeyChildren.push({
      kind: 'row',
      children: [
        text(lt('apiKey.current', { key: state.maskedKey })),
        { kind: 'spacer' },
        {
          kind: 'iconButton',
          icon: '−',
          title: lt('apiKey.delete'),
          onClick: { type: 'FORM_DELETE_KEY' },
        },
      ],
    });
  }

  apiKeyChildren.push(
    text(labels.keyInstructions, true),
    { kind: 'link', label: labels.keysLinkLabel, href: labels.keysUrl },
    {
      kind: 'field',
      label: lt('apiKey.new'),
      hint: state.hasApiKey
        ? lt('apiKey.replaceHint')
        : lt('apiKey.saveHint'),
      child: {
        kind: 'textInput',
        name: 'apiKey',
        value: '',
        inputType: 'password',
        placeholder: labels.keyPlaceholder,
      },
    },
    {
      kind: 'row',
      children: [
        {
          kind: 'button',
          label: state.keyVerifyStatus === 'checking' ? lt('apiKey.checking') : lt('apiKey.verify'),
          disabled: state.keyVerifyStatus === 'checking',
          onClick: { type: 'FORM_VERIFY_KEY' },
        },
        {
          kind: 'button',
          label: lt('apiKey.save'),
          primary: true,
          onClick: { type: 'FORM_SAVE_KEY' },
        },
      ],
    },
  );

  if (state.keyVerifyStatus === 'ok' && state.keyVerifyMessage) {
    apiKeyChildren.push(text(state.keyVerifyMessage, true));
  }
  if (state.keyVerifyStatus === 'fail' && state.keyVerifyMessage) {
    apiKeyChildren.push(text(state.keyVerifyMessage));
  }

  const apiKeyTab: ControlNode = { kind: 'stack', children: apiKeyChildren };

  return {
    widgetId: labels.pluginId,
    title: labels.title,
    submitLabel: t('app.settings.apply'),
    cancelLabel: t('app.settings.cancel'),
    submitMsg: { type: 'FORM_SUBMIT' },
    cancelMsg: { type: 'FORM_CANCEL' },
    busy: state.loadingModels || state.keyVerifyStatus === 'checking',
    error: state.error,
    body: {
      kind: 'tabs',
      tabs: [
        { id: 'favorites', label: lt('tab.favorites'), child: favoritesTab },
        { id: 'all', label: lt('tab.allModels'), child: allModelsTab },
        { id: 'apikey', label: lt('tab.apiKey'), child: apiKeyTab },
      ],
    },
  };
}

/** Убрать модель из избранного (форма, без закрытия модалки). */
export function applyRemoveFavorite(
  state: { favoriteModelIds: string[]; selectedModelId: string },
  modelId: string,
  values?: Record<string, string>,
): { favoriteModelIds: string[]; selectedModelId: string } {
  const favs = parseFavoritesFromValues(values?.favoriteModelIds, state.favoriteModelIds).filter(
    (id) => id !== modelId,
  );
  let selected = values?.modelId ?? state.selectedModelId;
  if (selected === modelId) {
    selected = favs[0] ?? state.selectedModelId;
  }
  return { favoriteModelIds: favs, selectedModelId: selected };
}

/** Собрать конфиг из снимка формы. */
export function configFromFormValues(
  values: Record<string, string>,
  prev: LlmPluginConfig,
): LlmPluginConfig {
  const maxOutputTokens =
    parseMaxOutputTokens(values.maxOutputTokens) ?? prev.maxOutputTokens;
  return {
    selectedModelId: values.modelId || prev.selectedModelId,
    favoriteModelIds: parseFavoritesFromValues(values.favoriteModelIds, prev.favoriteModelIds),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(prev.modelRatings ? { modelRatings: prev.modelRatings } : {}),
  };
}

/** Если избранное пусто — добавить выбранную модель (первый запуск). */
export function seedFavoritesIfEmpty(
  config: LlmPluginConfig,
  modelIds: string[],
): LlmPluginConfig {
  if (config.favoriteModelIds.length > 0) return config;
  const seed = config.selectedModelId;
  if (modelIds.includes(seed)) {
    return { ...config, favoriteModelIds: [seed] };
  }
  if (modelIds.length > 0) {
    return { ...config, favoriteModelIds: [modelIds[0]], selectedModelId: modelIds[0] };
  }
  return config;
}
