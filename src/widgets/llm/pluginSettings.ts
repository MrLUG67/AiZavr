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

/** Подписи фильтра модальностей над таблицей моделей (общие для всех LLM-плагинов). */
export const MODALITY_FILTER_UI: ModelTableModalityFilterUi = {
  inputLabel: 'Вход — что можно отправить',
  outputLabel: 'Выход — что модель обязана вернуть',
  inputHint: 'Мягкий фильтр: модель должна принимать отмеченное (может уметь больше).',
  outputHint: 'Жёсткий фильтр: модель должна выдавать всё отмеченное.',
};

export interface LlmPluginConfig {
  selectedModelId: string;
  favoriteModelIds: string[];
  /**
   * Оценки пользователя 1–5 по id модели (локально, на будущее).
   * Пока не используется в UI; зарезервировано под звёзды на ответах LLM
   * и возможное облачное усреднение.
   */
  modelRatings?: Record<string, number>;
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
      modelRatings?: unknown;
    };
    const selectedModelId =
      typeof o.selectedModelId === 'string' && o.selectedModelId
        ? o.selectedModelId
        : defaultModel;
    const favoriteModelIds = Array.isArray(o.favoriteModelIds)
      ? o.favoriteModelIds.filter((x): x is string => typeof x === 'string')
      : [];
    const modelRatings = parseModelRatings(o.modelRatings);
    return { selectedModelId, favoriteModelIds, ...(modelRatings ? { modelRatings } : {}) };
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

  const favoritesTab: ControlNode = {
    kind: 'stack',
    children:
      !state.hasApiKey
        ? [text('Сначала укажите API-ключ на вкладке «API Key».', true)]
        : state.loadingModels
          ? [text('Загрузка моделей…', true)]
          : favoriteModels.length === 0
            ? [
                text(
                  'Нет избранных моделей. Отметьте нужные на вкладке «Все модели».',
                  true,
                ),
              ]
            : [
                {
                  kind: 'field',
                  label: 'Модель из избранных',
                  hint: 'Выберите модель для обработки диалога. «−» убирает из избранного.',
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
              ],
  };

  const allModelsTab: ControlNode = {
    kind: 'stack',
    children: [
      text(
        'Отметьте модели для избранного — они появятся на первой вкладке.',
        true,
      ),
      {
        kind: 'modelTable',
        name: 'favoriteModelIds',
        value: serializeFavorites(favorites),
        rows: toTableRows(state.models),
        disabled: state.loadingModels || !state.hasApiKey,
        searchPlaceholder: 'Фильтр по названию…',
        modalityFilter: state.modalityFilter,
      },
    ],
  };

  const apiKeyChildren: ControlNode[] = [];

  if (state.hasApiKey && state.maskedKey) {
    apiKeyChildren.push({
      kind: 'row',
      children: [
        text(`Текущий ключ: ${state.maskedKey}`),
        { kind: 'spacer' },
        {
          kind: 'iconButton',
          icon: '−',
          title: 'Удалить ключ',
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
      label: 'Новый API-ключ',
      hint: state.hasApiKey
        ? 'Введите новый ключ, чтобы заменить текущий.'
        : 'Вставьте ключ и нажмите «Сохранить ключ».',
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
          label: state.keyVerifyStatus === 'checking' ? 'Проверка…' : 'Проверить ключ',
          disabled: state.keyVerifyStatus === 'checking',
          onClick: { type: 'FORM_VERIFY_KEY' },
        },
        {
          kind: 'button',
          label: 'Сохранить ключ',
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
    submitLabel: 'Применить',
    cancelLabel: 'Отмена',
    submitMsg: { type: 'FORM_SUBMIT' },
    cancelMsg: { type: 'FORM_CANCEL' },
    busy: state.loadingModels || state.keyVerifyStatus === 'checking',
    error: state.error,
    body: {
      kind: 'tabs',
      tabs: [
        { id: 'favorites', label: 'Избранные', child: favoritesTab },
        { id: 'all', label: 'Все модели', child: allModelsTab },
        { id: 'apikey', label: 'API Key', child: apiKeyTab },
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
  return {
    selectedModelId: values.modelId || prev.selectedModelId,
    favoriteModelIds: parseFavoritesFromValues(values.favoriteModelIds, prev.favoriteModelIds),
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
