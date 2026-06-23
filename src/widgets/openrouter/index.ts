// Плагин OpenRouter — связь с LLM вынесена из ядра.
// Шестерёнка (левый верх) открывает оверлей настройки API-ключа.
// Чекбокс «Использовать для ответов» выбирает активный LLM-плагин.

import type {
  WidgetDef,
  WidgetFacts,
  WidgetMsg,
  WidgetCapabilities,
  ViewResult,
  ControlNode,
  ChatMessage,
} from '../host/types';
import type { LlmProvider } from '../llm/types';
import {
  registerLlmProvider,
  unregisterLlmProvider,
  setActiveLlmProvider,
  getActiveLlmProviderId,
} from '../llm/registry';
import { fetchModels, chatCompletion, type OpenRouterModel } from './api';

const PLUGIN_ID = 'openrouter';
const PLUGIN_VERSION = '0.1.0';
const SECRET_PROVIDER_ID = 'openrouter';
const LS_MODEL = 'openrouter.selectedModel';
const DEFAULT_MODEL = 'anthropic/claude-haiku-4-5';

interface State {
  configOpen: boolean;
  apiKeyInput: string;
  hasApiKey: boolean;
  selectedModelId: string;
  models: OpenRouterModel[];
  loadingModels: boolean;
  pickingModel: boolean;
  modelFilter: string;
  error: string | null;
}

function text(value: string, muted = false): ControlNode {
  return { kind: 'text', value, tone: muted ? 'muted' : 'normal' };
}

function readSavedModel(): string {
  try {
    return localStorage.getItem(LS_MODEL) ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

function saveModel(id: string): void {
  try {
    localStorage.setItem(LS_MODEL, id);
  } catch {
    /* ignore */
  }
}

const liveState: { current: State } = {
  current: {
    configOpen: false,
    apiKeyInput: '',
    hasApiKey: false,
    selectedModelId: readSavedModel(),
    models: [],
    loadingModels: false,
    pickingModel: false,
    modelFilter: '',
    error: null,
  },
};

function makeProvider(cap: WidgetCapabilities): LlmProvider {
  return {
    pluginId: PLUGIN_ID,
    isReady() {
      const s = liveState.current;
      return s.hasApiKey && !!s.selectedModelId;
    },
    getModelFacts() {
      const s = liveState.current;
      const m = s.models.find((x) => x.id === s.selectedModelId);
      return {
        id: s.selectedModelId,
        contextWindow: m?.contextWindow ?? 200000,
      };
    },
    async generateResponse(messages: ChatMessage[], _role: string) {
      const s = liveState.current;
      const apiKey = await cap.secrets.get(SECRET_PROVIDER_ID);
      if (!apiKey) throw new Error('OpenRouter API key not set');
      return chatCompletion(apiKey, s.selectedModelId, messages);
    },
  };
}

function syncProvider(state: State, cap: WidgetCapabilities): void {
  liveState.current = state;
  const isActive = getActiveLlmProviderId() === PLUGIN_ID;
  if (state.hasApiKey && state.selectedModelId && isActive) {
    registerLlmProvider(makeProvider(cap));
  } else {
    unregisterLlmProvider(PLUGIN_ID);
  }
}

async function loadModels(
  cap: WidgetCapabilities,
): Promise<{ models: OpenRouterModel[]; error: string | null }> {
  const apiKey = await cap.secrets.get(SECRET_PROVIDER_ID);
  if (!apiKey) return { models: [], error: 'API key not set' };
  try {
    const models = await fetchModels(apiKey);
    return { models, error: null };
  } catch (e) {
    return { models: [], error: String(e) };
  }
}

function filteredModels(state: State): OpenRouterModel[] {
  const q = state.modelFilter.trim().toLowerCase();
  if (!q) return state.models;
  return state.models.filter(
    (m) =>
      m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
  );
}

function configOverlay(state: State): ControlNode {
  return {
    kind: 'overlay',
    children: [
      text(
        state.hasApiKey
          ? 'Введите новый ключ, чтобы заменить текущий.'
          : 'API-ключ OpenRouter (openrouter.ai/keys)',
        true,
      ),
      {
        kind: 'preview',
        text: state.apiKeyInput,
        editable: true,
        inputType: 'password',
        onChange: { type: 'apiKeyInput' },
      },
      ...(state.hasApiKey
        ? [
            {
              kind: 'button' as const,
              label: 'Удалить ключ',
              onClick: { type: 'deleteApiKey' },
            },
          ]
        : []),
      {
        kind: 'row',
        children: [
          { kind: 'spacer' },
          {
            kind: 'button',
            label: 'Ок',
            primary: true,
            onClick: { type: 'configOk' },
          },
          { kind: 'spacer' },
        ],
      },
    ],
  };
}

export const openrouter: WidgetDef<State> = {
  manifest: {
    id: PLUGIN_ID,
    title: 'OpenRouter',
    icon: 'bot',
    defaultOpen: true,
    order: 5,
    surface: 'panel',
    supportedModels: '*',
    capabilities: ['secrets'],
    author: 'core',
    version: PLUGIN_VERSION,
  },

  initialState(): State {
    return {
      configOpen: false,
      apiKeyInput: '',
      hasApiKey: false,
      selectedModelId: readSavedModel(),
      models: [],
      loadingModels: false,
      pickingModel: false,
      modelFilter: '',
      error: null,
    };
  },

  view(state: State, facts: WidgetFacts): ViewResult {
    const isActive = facts.activeLlmProviderId === PLUGIN_ID;
    const model = state.models.find((m) => m.id === state.selectedModelId);
    const visibleModels = filteredModels(state);

    const workChildren: ControlNode[] = [];

    if (!state.hasApiKey) {
      workChildren.push(
        text('Укажите API-ключ (⚙ вверху слева)', true),
      );
    } else if (state.loadingModels) {
      workChildren.push(text('Загрузка моделей…', true));
    } else {
      workChildren.push(
        text(`Модель: ${model?.name ?? state.selectedModelId}`),
        text(
          model
            ? `Окно: ${model.contextWindow.toLocaleString()} токенов`
            : 'Модель не найдена в списке — выберите другую',
          true,
        ),
      );

      if (state.pickingModel) {
        workChildren.push({
          kind: 'preview',
          text: state.modelFilter,
          editable: true,
          onChange: { type: 'modelFilter' },
        });
        if (visibleModels.length === 0) {
          workChildren.push(text('Нет моделей по фильтру', true));
        } else {
          workChildren.push({
            kind: 'list',
            items: visibleModels.slice(0, 80).map((m) => ({
              id: m.id,
              label: m.name,
              secondary: m.id,
              selected: m.id === state.selectedModelId,
            })),
            onSelect: { type: 'selectModel' },
          });
          if (visibleModels.length > 80) {
            workChildren.push(
              text(`Показано 80 из ${visibleModels.length}. Уточните фильтр.`, true),
            );
          }
        }
      } else {
        workChildren.push({
          kind: 'button',
          label: 'Сменить модель',
          onClick: { type: 'togglePickModel' },
        });
      }

      if (!isActive) {
        workChildren.push(
          text('Включите «Использовать для ответов»', true),
        );
      } else {
        workChildren.push(text('Готов к обработке диалога', true));
      }
    }

    if (state.error) {
      workChildren.unshift(text(state.error));
    }

    const children: ControlNode[] = [
      {
        kind: 'row',
        children: [
          {
            kind: 'iconButton',
            icon: '⚙',
            title: 'Настройки API-ключа',
            onClick: { type: 'openConfig' },
          },
          { kind: 'spacer' },
          {
            kind: 'checkbox',
            label: 'Использовать для ответов',
            checked: isActive,
            disabled: !state.hasApiKey,
            onChange: { type: 'toggleActive' },
          },
        ],
      },
      ...workChildren,
    ];

    if (state.configOpen) {
      children.push(configOverlay(state));
    }

    return { kind: 'stack', children };
  },

  update(msg: WidgetMsg, state: State, cap: WidgetCapabilities): State | Promise<State> {
    if (msg.type === '@@mount') {
      return (async () => {
        const apiKey = await cap.secrets.get(SECRET_PROVIDER_ID);
        const hasApiKey = !!apiKey;
        let next: State = {
          ...state,
          hasApiKey,
          configOpen: !hasApiKey,
          loadingModels: hasApiKey,
        };

        if (hasApiKey) {
          const { models, error } = await loadModels(cap);
          next = { ...next, models, loadingModels: false, error };
          if (
            models.length > 0 &&
            !models.some((m) => m.id === next.selectedModelId)
          ) {
            next = { ...next, selectedModelId: models[0].id };
            saveModel(models[0].id);
          }
          const active = getActiveLlmProviderId();
          if (!active || active === PLUGIN_ID) {
            setActiveLlmProvider(PLUGIN_ID);
          }
        }

        syncProvider(next, cap);
        return next;
      })();
    }

    if (msg.type === 'openConfig') {
      const next = { ...state, configOpen: true, apiKeyInput: '', error: null };
      liveState.current = next;
      return next;
    }

    if (msg.type === 'configOk') {
      const trimmed = state.apiKeyInput.trim();
      if (trimmed) {
        return (async () => {
          await cap.secrets.set(SECRET_PROVIDER_ID, trimmed);
          let next: State = {
            ...state,
            apiKeyInput: '',
            hasApiKey: true,
            configOpen: false,
            loadingModels: true,
            error: null,
          };
          const { models, error } = await loadModels(cap);
          next = { ...next, models, loadingModels: false, error };
          if (
            models.length > 0 &&
            !models.some((m) => m.id === next.selectedModelId)
          ) {
            next = { ...next, selectedModelId: models[0].id };
            saveModel(models[0].id);
          }
          if (!getActiveLlmProviderId()) {
            setActiveLlmProvider(PLUGIN_ID);
          }
          syncProvider(next, cap);
          return next;
        })();
      }
      const next = { ...state, configOpen: false };
      liveState.current = next;
      return next;
    }

    if (msg.type === 'apiKeyInput') {
      const next = { ...state, apiKeyInput: String(msg.value ?? '') };
      liveState.current = next;
      return next;
    }

    if (msg.type === 'deleteApiKey') {
      return (async () => {
        await cap.secrets.delete(SECRET_PROVIDER_ID);
        if (getActiveLlmProviderId() === PLUGIN_ID) {
          setActiveLlmProvider(null);
        }
        unregisterLlmProvider(PLUGIN_ID);
        const next: State = {
          ...state,
          apiKeyInput: '',
          hasApiKey: false,
          models: [],
          configOpen: true,
          error: null,
        };
        liveState.current = next;
        return next;
      })();
    }

    if (msg.type === 'toggleActive') {
      const checked = Boolean(msg.value);
      if (checked) {
        setActiveLlmProvider(PLUGIN_ID);
        syncProvider(state, cap);
      } else if (getActiveLlmProviderId() === PLUGIN_ID) {
        setActiveLlmProvider(null);
        unregisterLlmProvider(PLUGIN_ID);
      }
      return state;
    }

    if (msg.type === 'selectModel') {
      const modelId = String(msg.value ?? '');
      if (!modelId) return state;
      saveModel(modelId);
      const next = {
        ...state,
        selectedModelId: modelId,
        pickingModel: false,
        modelFilter: '',
        error: null,
      };
      syncProvider(next, cap);
      return next;
    }

    if (msg.type === 'togglePickModel') {
      const next = {
        ...state,
        pickingModel: !state.pickingModel,
        modelFilter: '',
      };
      liveState.current = next;
      return next;
    }

    if (msg.type === 'modelFilter') {
      const next = { ...state, modelFilter: String(msg.value ?? '') };
      liveState.current = next;
      return next;
    }

    liveState.current = state;
    return state;
  },
};
