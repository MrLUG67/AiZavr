// Плагин Google Gemini — бесплатный доступ к LLM по API-ключу из Google AI Studio.
// Шестерёнка открывает трёхвкладочную форму: избранные / все модели / API Key.
// Конфиг хранится в файле ядра через cap.config (D-095).

import type {
  WidgetDef,
  WidgetFacts,
  WidgetMsg,
  WidgetCapabilities,
  ViewResult,
  ControlNode,
  ChatMessage,
  FormDoc,
} from '../host/types';
import type { LlmProvider } from '../llm/types';
import {
  registerLlmProvider,
  unregisterLlmProvider,
  setActiveLlmProvider,
  getActiveLlmProviderId,
} from '../llm/registry';
import {
  parseLlmConfig,
  saveLlmConfig,
  maskApiKey,
  buildLlmSettingsForm,
  configFromFormValues,
  applyRemoveFavorite,
  seedFavoritesIfEmpty,
  modalityFilterUi,
  type LlmPluginConfig,
  type LlmModelRow,
} from '../llm/pluginSettings';
import { dispatchWidgetMsg } from '../host/widgetDispatch';
import { fetchModels, chatCompletion, type GeminiModel } from './api';
import { ct } from './i18n';

const PLUGIN_ID = 'gemini';
const PLUGIN_VERSION = '0.1.0';
const SECRET_PROVIDER_ID = 'gemini';
const LS_MODEL = 'gemini.selectedModel';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const KEYS_URL = 'https://aistudio.google.com/apikey';

interface State {
  settingsOpen: boolean;
  hasApiKey: boolean;
  selectedModelId: string;
  favoriteModelIds: string[];
  models: GeminiModel[];
  loadingModels: boolean;
  error: string | null;
  keyVerifyStatus: 'idle' | 'checking' | 'ok' | 'fail';
  keyVerifyMessage: string | null;
}

function text(value: string, muted = false): ControlNode {
  return { kind: 'text', value, tone: muted ? 'muted' : 'normal' };
}

// Пригодна для обработки диалога только модель с текстовым выходом.
function canProcessDialog(model: GeminiModel): boolean {
  return model.capabilities.out.txt;
}

function resolveSelectedModelId(models: GeminiModel[], preferred: string): string {
  if (models.some((m) => m.id === preferred)) return preferred;
  const dialogCapable = models.find((m) => canProcessDialog(m));
  return dialogCapable?.id ?? models[0]?.id ?? preferred;
}

function toModelRows(models: GeminiModel[]): LlmModelRow[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    capabilities: m.capabilities,
  }));
}

function migrateModelFromLocalStorage(): string | null {
  try {
    const v = localStorage.getItem(LS_MODEL);
    if (v === null) return null;
    localStorage.removeItem(LS_MODEL);
    return v || null;
  } catch {
    return null;
  }
}

const liveState: { current: State } = {
  current: {
    settingsOpen: false,
    hasApiKey: false,
    selectedModelId: DEFAULT_MODEL,
    favoriteModelIds: [],
    models: [],
    loadingModels: false,
    error: null,
    keyVerifyStatus: 'idle',
    keyVerifyMessage: null,
  },
};

// ---------------------------------------------------------------------------
// Авто-восстановление при сетевом сбое (нет интернета на старте и т.п.).
// fetch без связи бросает TypeError → это transient: модели не загрузились не
// из-за плохого ключа, а из-за сети. Снимать Gemini «навсегда» нельзя: повторяем
// ограниченно с нарастающей паузой и сразу пробуем при возврате связи (событие
// 'online'). Ошибки ключа/HTTP (Error из friendlyError) НЕ повторяем — сами не
// починятся. Повтор шлём как обычное TEA-сообщение retryLoad самому виджету.
// ---------------------------------------------------------------------------
const AUTO_RETRY_DELAYS_MS = [3000, 8000, 20000];
let autoRetryTimer: ReturnType<typeof setTimeout> | null = null;
let autoRetryAttempt = 0;
let onlineListenerBound = false;

function clearAutoRetry(): void {
  if (autoRetryTimer !== null) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }
  autoRetryAttempt = 0;
}

function scheduleAutoRetry(): void {
  if (autoRetryTimer !== null) return; // уже запланировано
  if (autoRetryAttempt >= AUTO_RETRY_DELAYS_MS.length) return; // исчерпали — ждём 'online'/ручной повтор
  const delay = AUTO_RETRY_DELAYS_MS[autoRetryAttempt];
  autoRetryAttempt += 1;
  autoRetryTimer = setTimeout(() => {
    autoRetryTimer = null;
    const s = liveState.current;
    if (s.hasApiKey && !isReady(s)) {
      dispatchWidgetMsg(PLUGIN_ID, { type: 'retryLoad' });
    }
  }, delay);
}

// Связь вернулась — пробуем сразу и перезапускаем backoff с нуля.
function ensureOnlineListener(): void {
  if (onlineListenerBound) return;
  onlineListenerBound = true;
  window.addEventListener('online', () => {
    const s = liveState.current;
    if (s.hasApiKey && !isReady(s)) {
      clearAutoRetry();
      dispatchWidgetMsg(PLUGIN_ID, { type: 'retryLoad' });
    }
  });
}

function makeProvider(cap: WidgetCapabilities): LlmProvider {
  return {
    pluginId: PLUGIN_ID,
    isReady() {
      return isReady(liveState.current);
    },
    getModelFacts() {
      const s = liveState.current;
      const m = s.models.find((x) => x.id === s.selectedModelId);
      return {
        id: s.selectedModelId,
        contextWindow: m?.contextWindow ?? 1_000_000,
      };
    },
    async generateResponse(messages: ChatMessage[], _role: string) {
      const s = liveState.current;
      const apiKey = await cap.secrets.get(SECRET_PROVIDER_ID);
      if (!apiKey) throw new Error('Gemini API key not set');
      const m = s.models.find((x) => x.id === s.selectedModelId);
      return chatCompletion(apiKey, s.selectedModelId, messages, m);
    },
  };
}

function isReady(state: State): boolean {
  const selected = state.models.find((m) => m.id === state.selectedModelId);
  return (
    state.hasApiKey &&
    state.models.length > 0 &&
    selected !== undefined &&
    canProcessDialog(selected)
  );
}

function syncProvider(state: State, cap: WidgetCapabilities): void {
  liveState.current = state;
  if (isReady(state)) {
    registerLlmProvider(makeProvider(cap));
  } else {
    unregisterLlmProvider(PLUGIN_ID);
  }
}

async function loadModels(
  cap: WidgetCapabilities,
  apiKey?: string,
): Promise<{ models: GeminiModel[]; error: string | null; transient: boolean }> {
  const key = apiKey ?? (await cap.secrets.get(SECRET_PROVIDER_ID));
  if (!key) return { models: [], error: 'API key not set', transient: false };
  try {
    const models = await fetchModels(key);
    return { models, error: null, transient: false };
  } catch (e) {
    // fetch при отсутствии сети бросает TypeError → transient (повторяемо).
    // HTTP/ключевые ошибки приходят как Error из friendlyError — не transient.
    const transient = e instanceof TypeError;
    const error = transient
      ? ct('error.noConnection')
      : String(e);
    return { models: [], error, transient };
  }
}

async function adoptModels(
  state: State,
  models: GeminiModel[],
  error: string | null,
  cap: WidgetCapabilities,
  config: LlmPluginConfig,
): Promise<State> {
  let nextConfig = seedFavoritesIfEmpty(
    config,
    models.map((m) => m.id),
  );
  if (models.length > 0 && !models.some((m) => m.id === nextConfig.selectedModelId)) {
    nextConfig = {
      ...nextConfig,
      selectedModelId: resolveSelectedModelId(models, nextConfig.selectedModelId),
    };
    await saveLlmConfig(cap, PLUGIN_ID, nextConfig);
  }
  return {
    ...state,
    models,
    loadingModels: false,
    error,
    selectedModelId: nextConfig.selectedModelId,
    favoriteModelIds: nextConfig.favoriteModelIds,
  };
}

async function buildSettingsForm(state: State, cap: WidgetCapabilities): Promise<FormDoc> {
  let maskedKey: string | null = null;
  if (state.hasApiKey) {
    const key = await cap.secrets.get(SECRET_PROVIDER_ID);
    if (key) maskedKey = maskApiKey(key);
  }
  return buildLlmSettingsForm(
    {
      pluginId: PLUGIN_ID,
      title: ct('settings.title'),
      keysUrl: KEYS_URL,
      keysLinkLabel: ct('settings.keysLink'),
      keyInstructions: ct('settings.keyInstructions'),
      keyPlaceholder: state.hasApiKey ? '••••••••' : 'AIza...',
    },
    {
      hasApiKey: state.hasApiKey,
      maskedKey,
      selectedModelId: state.selectedModelId,
      favoriteModelIds: state.favoriteModelIds,
      models: toModelRows(state.models),
      loadingModels: state.loadingModels,
      error: state.error,
      keyVerifyStatus: state.keyVerifyStatus,
      keyVerifyMessage: state.keyVerifyMessage,
      modalityFilter: modalityFilterUi(),
    },
  );
}

async function openSettingsForm(state: State, cap: WidgetCapabilities): Promise<void> {
  cap.ui.openForm(await buildSettingsForm(state, cap));
  if (state.hasApiKey && state.models.length === 0) {
    const loading = { ...state, loadingModels: true };
    cap.ui.refreshForm(await buildSettingsForm(loading, cap));
    const { models, error } = await loadModels(cap);
    const config: LlmPluginConfig = {
      selectedModelId: state.selectedModelId,
      favoriteModelIds: state.favoriteModelIds,
    };
    const next = await adoptModels(loading, models, error, cap, config);
    liveState.current = next;
    cap.ui.refreshForm(await buildSettingsForm(next, cap));
  }
}

async function refreshSettingsForm(state: State, cap: WidgetCapabilities): Promise<void> {
  cap.ui.refreshForm(await buildSettingsForm(state, cap));
}

export const gemini: WidgetDef<State> = {
  manifest: {
    id: PLUGIN_ID,
    title: 'Gemini (Google)',
    icon: 'sparkles',
    defaultOpen: false,
    order: 6,
    surface: 'panel',
    supportedModels: '*',
    providesLlm: true,
    capabilities: ['secrets', 'config', 'ui.focus'],
    author: 'core',
    version: PLUGIN_VERSION,
  },

  initialState(): State {
    return { ...liveState.current };
  },

  view(state: State, facts: WidgetFacts): ViewResult {
    const isActive = facts.activeLlmProviderId === PLUGIN_ID;
    const ready = isReady(state);
    const model = state.models.find((m) => m.id === state.selectedModelId);

    const workChildren: ControlNode[] = [];

    if (!state.hasApiKey) {
      workChildren.push(text(ct('panel.noKey'), true));
    } else if (state.loadingModels) {
      workChildren.push(text(ct('panel.loadingModels'), true));
    } else if (state.models.length === 0) {
      workChildren.push(
        text(ct('panel.modelsNotLoaded'), true),
      );
      workChildren.push({
        kind: 'button',
        label: ct('panel.retry'),
        onClick: { type: 'retryLoad' },
      });
    } else {
      workChildren.push(text(ct('panel.model', { name: model?.name ?? state.selectedModelId })));
      if (model && !canProcessDialog(model)) {
        workChildren.push(
          text(ct('panel.notForDialog'), true),
        );
      } else if (model) {
        workChildren.push(
          text(ct('panel.window', { tokens: model.contextWindow.toLocaleString() }), true),
        );
      } else {
        workChildren.push(
          text(ct('panel.modelNotFound'), true),
        );
      }
      if (isActive) {
        workChildren.push(text(ct('panel.processing'), false));
      } else if (ready) {
        workChildren.push(text(ct('panel.ready'), true));
      }
    }

    if (state.error) {
      workChildren.unshift(text(state.error));
    }

    return {
      kind: 'stack',
      children: [
        {
          kind: 'row',
          children: [
            {
              kind: 'iconButton',
              icon: '⚙',
              title: ct('settings.gearTitle'),
              onClick: { type: 'OPEN_SETTINGS' },
            },
            { kind: 'spacer' },
          ],
        },
        ...workChildren,
      ],
    };
  },

  update(msg: WidgetMsg, state: State, cap: WidgetCapabilities): State | Promise<State> {
    if (msg.type === '@@mount') {
      return (async () => {
        ensureOnlineListener();
        const raw = await cap.config.load();
        let config: LlmPluginConfig;
        if (raw) {
          config = parseLlmConfig(raw, DEFAULT_MODEL);
        } else {
          const migrated = migrateModelFromLocalStorage();
          config = parseLlmConfig(
            migrated ? JSON.stringify({ selectedModelId: migrated }) : null,
            DEFAULT_MODEL,
          );
          if (migrated) await saveLlmConfig(cap, PLUGIN_ID, config);
        }

        const apiKey = await cap.secrets.get(SECRET_PROVIDER_ID);
        const hasApiKey = !!apiKey;
        let next: State = {
          ...state,
          selectedModelId: config.selectedModelId,
          favoriteModelIds: config.favoriteModelIds,
          hasApiKey,
          loadingModels: hasApiKey,
        };

        if (hasApiKey) {
          const { models, error, transient } = await loadModels(cap);
          next = await adoptModels(next, models, error, cap, config);
          // Сетевой сбой на старте — не сдаёмся: повторим сами / при возврате связи.
          if (transient) scheduleAutoRetry();
          else clearAutoRetry();
        }

        syncProvider(next, cap);
        if (isReady(next) && !getActiveLlmProviderId()) {
          setActiveLlmProvider(PLUGIN_ID);
        }
        return next;
      })();
    }

    // Смена языка при открытой форме — пересобрать её с новыми подписями.
    if (msg.type === '@@lang') {
      if (state.settingsOpen) void refreshSettingsForm(liveState.current, cap);
      return state;
    }

    if (msg.type === 'OPEN_SETTINGS') {
      const next = {
        ...state,
        settingsOpen: true,
        error: null,
        keyVerifyStatus: 'idle' as const,
        keyVerifyMessage: null,
      };
      liveState.current = next;
      void openSettingsForm(next, cap);
      return next;
    }

    if (msg.type === 'retryLoad') {
      return (async () => {
        let next: State = { ...state, loadingModels: true, error: null };
        const { models, error, transient } = await loadModels(cap);
        const config: LlmPluginConfig = {
          selectedModelId: state.selectedModelId,
          favoriteModelIds: state.favoriteModelIds,
        };
        next = await adoptModels(next, models, error, cap, config);
        // Снова сетевой сбой — планируем следующую попытку; иначе сбрасываем backoff.
        if (transient) scheduleAutoRetry();
        else clearAutoRetry();
        syncProvider(next, cap);
        if (isReady(next) && !getActiveLlmProviderId()) {
          setActiveLlmProvider(PLUGIN_ID);
        }
        return next;
      })();
    }

    if (msg.type === 'FORM_REMOVE_FAVORITE') {
      return (async () => {
        const modelId =
          (msg as { modelId?: string; value?: string }).modelId ??
          (typeof msg.value === 'string' ? msg.value : '');
        if (!modelId) return state;
        const values =
          (msg as { values?: Record<string, string> }).values ?? {};
        const applied = applyRemoveFavorite(state, modelId, values);
        const next: State = { ...state, ...applied };
        liveState.current = next;
        const raw = await cap.config.load();
        const existing = parseLlmConfig(raw, DEFAULT_MODEL);
        await saveLlmConfig(cap, PLUGIN_ID, {
          ...existing,
          selectedModelId: next.selectedModelId,
          favoriteModelIds: next.favoriteModelIds,
        });
        syncProvider(next, cap);
        await refreshSettingsForm(next, cap);
        return next;
      })();
    }

    if (msg.type === 'FORM_DELETE_KEY') {
      return (async () => {
        clearAutoRetry(); // нет ключа — повторять нечего
        await cap.secrets.delete(SECRET_PROVIDER_ID);
        if (getActiveLlmProviderId() === PLUGIN_ID) {
          setActiveLlmProvider(null);
        }
        unregisterLlmProvider(PLUGIN_ID);
        const next: State = {
          ...state,
          hasApiKey: false,
          models: [],
          loadingModels: false,
          error: null,
          keyVerifyStatus: 'idle',
          keyVerifyMessage: null,
        };
        liveState.current = next;
        await refreshSettingsForm(next, cap);
        return next;
      })();
    }

    if (msg.type === 'FORM_VERIFY_KEY') {
      return (async () => {
        const values =
          (msg.value as { values?: Record<string, string> } | undefined)?.values ?? {};
        const apiKeyInput = (values.apiKey ?? '').trim();
        if (!apiKeyInput) {
          const next: State = {
            ...state,
            keyVerifyStatus: 'fail',
            keyVerifyMessage: ct('keyVerify.enterToVerify'),
          };
          liveState.current = next;
          await refreshSettingsForm(next, cap);
          return next;
        }
        let next: State = {
          ...state,
          keyVerifyStatus: 'checking',
          keyVerifyMessage: null,
          error: null,
        };
        liveState.current = next;
        await refreshSettingsForm(next, cap);
        const { models, error } = await loadModels(cap, apiKeyInput);
        if (error || models.length === 0) {
          next = {
            ...next,
            keyVerifyStatus: 'fail',
            keyVerifyMessage: error ?? ct('keyVerify.failed'),
          };
        } else {
          next = {
            ...next,
            keyVerifyStatus: 'ok',
            keyVerifyMessage: ct('keyVerify.valid', { count: models.length }),
          };
        }
        liveState.current = next;
        await refreshSettingsForm(next, cap);
        return next;
      })();
    }

    if (msg.type === 'FORM_SAVE_KEY') {
      return (async () => {
        const values =
          (msg.value as { values?: Record<string, string> } | undefined)?.values ?? {};
        const apiKeyInput = (values.apiKey ?? '').trim();
        if (!apiKeyInput) {
          const next: State = {
            ...state,
            keyVerifyStatus: 'fail',
            keyVerifyMessage: ct('keyVerify.enterToSave'),
          };
          liveState.current = next;
          await refreshSettingsForm(next, cap);
          return next;
        }
        await cap.secrets.set(SECRET_PROVIDER_ID, apiKeyInput);
        let next: State = {
          ...state,
          hasApiKey: true,
          loadingModels: true,
          keyVerifyStatus: 'ok',
          keyVerifyMessage: ct('keyVerify.saved'),
          error: null,
        };
        liveState.current = next;
        await refreshSettingsForm(next, cap);
        const { models, error, transient } = await loadModels(cap);
        const config: LlmPluginConfig = {
          selectedModelId: state.selectedModelId,
          favoriteModelIds: state.favoriteModelIds,
        };
        next = await adoptModels(next, models, error, cap, config);
        if (transient) scheduleAutoRetry();
        else clearAutoRetry();
        syncProvider(next, cap);
        if (isReady(next) && !getActiveLlmProviderId()) {
          setActiveLlmProvider(PLUGIN_ID);
        }
        liveState.current = next;
        await refreshSettingsForm(next, cap);
        return next;
      })();
    }

    if (msg.type === 'FORM_SUBMIT') {
      return (async () => {
        const values =
          (msg.value as { values?: Record<string, string> } | undefined)?.values ?? {};
        const prevConfig: LlmPluginConfig = {
          selectedModelId: state.selectedModelId,
          favoriteModelIds: state.favoriteModelIds,
        };
        const config = configFromFormValues(values, prevConfig);

        let next: State = {
          ...state,
          settingsOpen: false,
          selectedModelId: config.selectedModelId,
          favoriteModelIds: config.favoriteModelIds,
          error: null,
          keyVerifyStatus: 'idle',
          keyVerifyMessage: null,
        };

        if (
          next.models.length > 0 &&
          !next.models.some((m) => m.id === next.selectedModelId)
        ) {
          const fallback = resolveSelectedModelId(next.models, config.selectedModelId);
          next = { ...next, selectedModelId: fallback };
          config.selectedModelId = fallback;
        }

        await saveLlmConfig(cap, PLUGIN_ID, config);
        syncProvider(next, cap);
        if (isReady(next) && !getActiveLlmProviderId()) {
          setActiveLlmProvider(PLUGIN_ID);
        }
        cap.ui.closeForm();
        return next;
      })();
    }

    if (msg.type === 'FORM_CANCEL') {
      cap.ui.closeForm();
      const next = {
        ...state,
        settingsOpen: false,
        keyVerifyStatus: 'idle' as const,
        keyVerifyMessage: null,
      };
      liveState.current = next;
      return next;
    }

    liveState.current = state;
    return state;
  },
};
