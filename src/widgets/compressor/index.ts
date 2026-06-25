// src/widgets/compressor/index.ts
// LLM-уплотнитель: модель в настройках (⚙), инструкция редактируется в панели.

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
import { registerCompressionProvider } from '../llm/compressionRegistry';
import { fetchModels as fetchOpenRouterModels, chatCompletion as openRouterChat } from '../openrouter/api';
import { fetchModels as fetchGeminiModels, chatCompletion as geminiChat } from '../gemini/api';
import { buildTranscript } from './buildTranscript';
import {
  buildCompressionMessages,
  DEFAULT_COMPRESSION_SYSTEM_PROMPT,
  resolveSystemPrompt,
} from './prompts';

const PLUGIN_ID = 'compressor';
const PLUGIN_VERSION = '0.1.0';
const ALGORITHM = 'llm-v1';

const LS_PROVIDER = 'compressor.providerId';
const LS_MODEL = 'compressor.modelId';
const LS_PROMPT = 'compressor.systemPrompt';
const DEFAULT_PROVIDER = 'openrouter';
const DEFAULT_MODELS: Record<string, string> = {
  openrouter: 'anthropic/claude-haiku-4-5',
  gemini: 'gemini-2.5-flash',
};

type BackendId = 'openrouter' | 'gemini';

interface BranchMarker {
  nodeId: string;
  index: number;
  label: string;
  comment: string | null;
}

interface State {
  settingsOpen: boolean;
  startNodeId: string | null;
  startLabel: string | null;
  startComment: string | null;
  endNodeId: string | null;
  endLabel: string | null;
  endComment: string | null;
  systemPrompt: string;
  backend: BackendId;
  modelId: string;
  models: { id: string; name: string }[];
  pickingModel: boolean;
  modelFilter: string;
  hasApiKey: boolean;
  busy: boolean;
  previewPending: boolean;
  done: boolean;
  error: string | null;
}

const liveState: { current: State } = {
  current: makeInitialState(),
};

function makeInitialState(): State {
  return {
    settingsOpen: false,
    startNodeId: null,
    startLabel: null,
    startComment: null,
    endNodeId: null,
    endLabel: null,
    endComment: null,
    systemPrompt: readSystemPrompt(),
    backend: readBackend(),
    modelId: readModel(),
    models: [],
    pickingModel: false,
    modelFilter: '',
    hasApiKey: false,
    busy: false,
    previewPending: false,
    done: false,
    error: null,
  };
}

function readBackend(): BackendId {
  try {
    const v = localStorage.getItem(LS_PROVIDER);
    return v === 'gemini' ? 'gemini' : 'openrouter';
  } catch {
    return DEFAULT_PROVIDER as BackendId;
  }
}

function readModel(): string {
  try {
    const saved = localStorage.getItem(LS_MODEL);
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT_MODELS[readBackend()];
}

function readSystemPrompt(): string {
  try {
    const saved = localStorage.getItem(LS_PROMPT);
    if (saved !== null) return resolveSystemPrompt(saved);
  } catch {
    /* ignore */
  }
  return DEFAULT_COMPRESSION_SYSTEM_PROMPT;
}

function saveBackend(id: BackendId): void {
  try {
    localStorage.setItem(LS_PROVIDER, id);
  } catch {
    /* ignore */
  }
}

function saveModel(id: string): void {
  try {
    localStorage.setItem(LS_MODEL, id);
  } catch {
    /* ignore */
  }
}

function saveSystemPrompt(prompt: string): void {
  try {
    localStorage.setItem(LS_PROMPT, resolveSystemPrompt(prompt));
  } catch {
    /* ignore */
  }
}

function branchMarkers(facts: WidgetFacts): BranchMarker[] {
  const out: BranchMarker[] = [];
  facts.activeBranch.forEach((n, i) => {
    const mk = n.markers[0];
    if (mk) out.push({ nodeId: n.id, index: i, label: mk.label, comment: mk.comment });
  });
  return out;
}

function text(value: string, muted = false): ControlNode {
  return { kind: 'text', value, tone: muted ? 'muted' : 'normal' };
}

function makeCompressionProvider(state: State, cap: WidgetCapabilities): LlmProvider {
  const backend = state.backend;
  const modelId = state.modelId;
  return {
    pluginId: `${PLUGIN_ID}:${backend}`,
    isReady() {
      const s = liveState.current;
      return s.hasApiKey && !!s.modelId;
    },
    getModelFacts() {
      return { id: modelId, contextWindow: 200000 };
    },
    async generateResponse(messages: ChatMessage[], _role: string) {
      const apiKey = await cap.secrets.get(backend);
      if (!apiKey) throw new Error(`API-ключ ${backend} не задан`);
      if (backend === 'gemini') {
        return geminiChat(apiKey, modelId, messages);
      }
      return openRouterChat(apiKey, modelId, messages);
    },
  };
}

function syncCompressionProvider(state: State, cap: WidgetCapabilities): void {
  liveState.current = state;
  if (state.hasApiKey && state.modelId) {
    registerCompressionProvider(makeCompressionProvider(state, cap));
  } else {
    registerCompressionProvider(null);
  }
}

async function refreshApiKey(
  state: State,
  cap: WidgetCapabilities,
): Promise<boolean> {
  const key = await cap.secrets.get(state.backend);
  return !!key;
}

async function loadModelList(
  state: State,
  cap: WidgetCapabilities,
): Promise<{ models: { id: string; name: string }[]; error: string | null }> {
  const apiKey = await cap.secrets.get(state.backend);
  if (!apiKey) return { models: [], error: 'API-ключ не задан' };
  try {
    if (state.backend === 'gemini') {
      const models = await fetchGeminiModels(apiKey);
      return { models, error: null };
    }
    const models = await fetchOpenRouterModels(apiKey);
    return { models, error: null };
  } catch (e) {
    return { models: [], error: String(e) };
  }
}

function resetRangePick(): Partial<State> {
  return {
    startNodeId: null,
    startLabel: null,
    startComment: null,
    endNodeId: null,
    endLabel: null,
    endComment: null,
    previewPending: false,
    done: false,
    error: null,
  };
}

function settingsOverlay(state: State): ControlNode {
  const children: ControlNode[] = [
    text('Модель для уплотнения', true),
  ];
  if (!state.hasApiKey) {
    children.push(
      text(
        `Задайте API-ключ в плагине ${state.backend === 'gemini' ? 'Gemini' : 'OpenRouter'}.`,
        true,
      ),
    );
  }
  children.push({
    kind: 'segmented',
    options: [
      { value: 'openrouter', label: 'OpenRouter' },
      { value: 'gemini', label: 'Gemini' },
    ],
    value: state.backend,
    onChange: { type: 'PICK_BACKEND' },
  });
  children.push(text(`Модель: ${state.modelId}`, !state.hasApiKey));
  children.push({
    kind: 'button',
    label: state.pickingModel ? 'Скрыть список' : 'Выбрать модель',
    disabled: !state.hasApiKey,
    onClick: { type: 'TOGGLE_MODEL_PICKER' },
  });
  if (state.pickingModel) {
    children.push({
      kind: 'preview',
      text: state.modelFilter,
      editable: true,
      onChange: { type: 'MODEL_FILTER' },
    });
    const q = state.modelFilter.trim().toLowerCase();
    const filtered = state.models.filter(
      (m) =>
        !q ||
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q),
    );
    if (filtered.length === 0) {
      children.push(text('Список пуст. Нажмите «Загрузить модели».', true));
    } else {
      children.push({
        kind: 'list',
        items: filtered.slice(0, 40).map((m) => ({
          id: m.id,
          label: m.name,
          secondary: m.id,
          selected: m.id === state.modelId,
        })),
        onSelect: { type: 'PICK_MODEL' },
      });
    }
    children.push({
      kind: 'button',
      label: 'Загрузить модели',
      disabled: !state.hasApiKey,
      onClick: { type: 'LOAD_MODELS' },
    });
  }
  children.push({
    kind: 'row',
    children: [
      { kind: 'spacer' },
      {
        kind: 'button',
        label: 'Готово',
        primary: true,
        onClick: { type: 'SETTINGS_OK' },
      },
      { kind: 'spacer' },
    ],
  });
  return { kind: 'overlay', children };
}

const promptIsDefault = (p: string) =>
  resolveSystemPrompt(p) === DEFAULT_COMPRESSION_SYSTEM_PROMPT &&
  p.trim() === DEFAULT_COMPRESSION_SYSTEM_PROMPT.trim();

export const compressor: WidgetDef<State> = {
  manifest: {
    id: PLUGIN_ID,
    title: 'Уплотнитель',
    icon: 'shrink',
    defaultOpen: true,
    order: 20,
    surface: 'panel',
    supportedModels: '*',
    capabilities: [
      'markers.read',
      'compression.attach',
      'model.call',
      'secrets',
      'ui.focus',
    ],
    author: 'core',
    version: PLUGIN_VERSION,
  },

  initialState(): State {
    return { ...liveState.current };
  },

  view(state: State, facts: WidgetFacts): ViewResult {
    if (!facts.activeDialogId) {
      return { inactive: true, reason: 'Нет активной беседы' };
    }

    const bm = branchMarkers(facts);
    const starts = bm.slice(0, Math.max(0, bm.length - 1));
    const startMark = bm.find((m) => m.nodeId === state.startNodeId) ?? null;
    const startValid = startMark !== null && starts.some((m) => m.nodeId === startMark.nodeId);
    const ends = startValid ? bm.filter((m) => m.index > startMark!.index) : [];
    const endMark = bm.find((m) => m.nodeId === state.endNodeId) ?? null;
    const endValid = endMark !== null && ends.some((m) => m.nodeId === endMark.nodeId);

    const children: ControlNode[] = [
      {
        kind: 'row',
        children: [
          {
            kind: 'iconButton',
            icon: '⚙',
            title: 'Модель уплотнения',
            onClick: { type: 'OPEN_SETTINGS' },
          },
          { kind: 'spacer' },
          text(
            state.hasApiKey
              ? `${state.backend === 'gemini' ? 'Gemini' : 'OR'} · ${state.modelId}`
              : 'Модель не настроена',
            !state.hasApiKey,
          ),
        ],
      },
    ];

    if (state.error) children.push(text(`Ошибка: ${state.error}`, true));
    if (state.done) children.push(text('Фрагмент свёрнут.', true));
    if (state.previewPending) {
      children.push(text('Превью в центре — подтвердите или откажитесь.', true));
    }
    if (state.busy) children.push(text('Запрос к модели…', true));
    if (!state.hasApiKey) {
      children.push(text('Настройте модель уплотнения (⚙).', true));
    }

    children.push(text('Инструкция для модели'));
    children.push({
      kind: 'preview',
      text: state.systemPrompt,
      editable: true,
      onChange: { type: 'PROMPT_EDIT' },
    });
    children.push({
      kind: 'button',
      label: 'Сбросить инструкцию',
      disabled: promptIsDefault(state.systemPrompt),
      onClick: { type: 'RESET_PROMPT' },
    });

    children.push(text('Начало (маркер)'));
    if (starts.length === 0) {
      children.push(text('Нужно ≥2 маркеров на ветке.', true));
    } else {
      children.push({
        kind: 'list',
        items: starts.map((m) => ({
          id: m.nodeId,
          label: m.label,
          secondary: m.comment ?? undefined,
          selected: m.nodeId === state.startNodeId,
        })),
        onSelect: { type: 'PICK_START' },
      });
    }

    children.push(text('Конец (маркер)'));
    if (!startValid) {
      children.push(text('Сначала выберите начало.', true));
    } else if (ends.length === 0) {
      children.push(text('Нет маркеров ниже начала.', true));
    } else {
      children.push({
        kind: 'list',
        items: ends.map((m) => ({
          id: m.nodeId,
          label: m.label,
          secondary: m.comment ?? undefined,
          selected: m.nodeId === state.endNodeId,
        })),
        onSelect: { type: 'PICK_END' },
      });
    }

    const ready = startValid && endValid && state.hasApiKey && !state.busy;
    children.push({
      kind: 'button',
      label: state.busy
        ? 'Уплотнение…'
        : ready
          ? `Уплотнить ${startMark!.label} → ${endMark!.label}`
          : 'Уплотнить',
      disabled: !ready || state.previewPending,
      primary: true,
      onClick: { type: 'COMPRESS' },
    });

    if (state.settingsOpen) {
      children.push(settingsOverlay(state));
    }

    return { kind: 'stack', children };
  },

  async update(
    msg: WidgetMsg,
    state: State,
    cap: WidgetCapabilities,
  ): Promise<State> {
    switch (msg.type) {
      case '@@mount': {
        const hasApiKey = await refreshApiKey(state, cap);
        const systemPrompt = readSystemPrompt();
        const next = { ...state, hasApiKey, systemPrompt };
        syncCompressionProvider(next, cap);
        return next;
      }

      case 'OPEN_SETTINGS':
        return { ...state, settingsOpen: true, error: null };

      case 'SETTINGS_OK':
        return { ...state, settingsOpen: false, pickingModel: false };

      case 'PICK_BACKEND': {
        const backend = String(msg.value) as BackendId;
        const modelId = DEFAULT_MODELS[backend] ?? state.modelId;
        saveBackend(backend);
        saveModel(modelId);
        const hasApiKey = await refreshApiKey({ ...state, backend }, cap);
        const next = {
          ...state,
          backend,
          modelId,
          models: [],
          pickingModel: false,
          modelFilter: '',
          hasApiKey,
          error: null,
        };
        syncCompressionProvider(next, cap);
        return next;
      }

      case 'TOGGLE_MODEL_PICKER':
        return { ...state, pickingModel: !state.pickingModel, error: null };

      case 'MODEL_FILTER':
        return { ...state, modelFilter: String(msg.value ?? ''), error: null };

      case 'LOAD_MODELS': {
        const { models, error } = await loadModelList(state, cap);
        return { ...state, models, error };
      }

      case 'PICK_MODEL': {
        const modelId = String(msg.value);
        saveModel(modelId);
        const next = { ...state, modelId, pickingModel: false, error: null };
        syncCompressionProvider(next, cap);
        return next;
      }

      case 'PROMPT_EDIT': {
        const raw = String(msg.value ?? '');
        const systemPrompt = resolveSystemPrompt(raw);
        saveSystemPrompt(systemPrompt);
        return { ...state, systemPrompt, error: null };
      }

      case 'RESET_PROMPT': {
        saveSystemPrompt(DEFAULT_COMPRESSION_SYSTEM_PROMPT);
        return { ...state, systemPrompt: DEFAULT_COMPRESSION_SYSTEM_PROMPT, error: null };
      }

      case 'PICK_START': {
        cap.ui.focus(String(msg.value));
        return {
          ...state,
          ...resetRangePick(),
          startNodeId: String(msg.value),
          startLabel: typeof msg.label === 'string' ? msg.label : null,
          startComment: typeof msg.secondary === 'string' ? msg.secondary : null,
        };
      }

      case 'PICK_END': {
        cap.ui.focus(String(msg.value));
        return {
          ...state,
          endNodeId: String(msg.value),
          endLabel: typeof msg.label === 'string' ? msg.label : null,
          endComment: typeof msg.secondary === 'string' ? msg.secondary : null,
          done: false,
          previewPending: false,
          error: null,
        };
      }

      case 'PREVIEW_CONFIRMED':
        return {
          ...state,
          ...resetRangePick(),
          done: true,
          busy: false,
        };

      case 'PREVIEW_CANCELLED':
        return { ...state, previewPending: false, busy: false, error: null };

      case 'COMPRESS': {
        if (!state.startNodeId || !state.endNodeId) {
          return { ...state, error: 'выберите начало и конец' };
        }
        const systemPrompt = resolveSystemPrompt(state.systemPrompt);
        const working = { ...state, systemPrompt, busy: true, error: null };
        liveState.current = working;
        if (systemPrompt !== state.systemPrompt) {
          saveSystemPrompt(systemPrompt);
        }
        try {
          const range = await cap.markers.resolveLinearRange(
            state.startNodeId,
            state.endNodeId,
          );
          const transcript = buildTranscript(
            range,
            { label: state.startLabel, comment: state.startComment },
            { label: state.endLabel, comment: state.endComment },
          );
          const messages = buildCompressionMessages(transcript, systemPrompt);
          const summary = await cap.model.call('compression', messages);
          const modelId = liveState.current.modelId;

          const attachArgs = {
            startNodeId: state.startNodeId,
            endNodeId: state.endNodeId,
            summaryText: summary,
            placeholderText: null,
            modelId,
            provenance: {
              pluginId: PLUGIN_ID,
              pluginVersion: PLUGIN_VERSION,
              algorithm: ALGORITHM,
              params: {
                backend: state.backend,
                transcriptChars: transcript.length,
                customPrompt: systemPrompt !== DEFAULT_COMPRESSION_SYSTEM_PROMPT,
              },
            },
          };

          cap.ui.openPreview(
            {
              title: 'Превью уплотнения',
              text: summary,
            },
            {
              onConfirm: async () => {
                await cap.compression.attach(attachArgs);
              },
              onCancel: () => {},
              widgetId: PLUGIN_ID,
              confirmMsg: { type: 'PREVIEW_CONFIRMED' },
              cancelMsg: { type: 'PREVIEW_CANCELLED' },
            },
          );

          return { ...working, busy: false, previewPending: true };
        } catch (e) {
          return { ...state, busy: false, error: String(e) };
        }
      }

      default:
        return state;
    }
  },
};
