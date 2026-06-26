// src/widgets/tagger/index.ts
// Тегизатор — родной брат Компрессора. Анализирует выбранный маркерами диапазон
// активной беседы отдельной LLM (свой коннект/модель/промпт) и предлагает теги;
// по подтверждению теги уходят в справочник и присваиваются всей беседе (merge).

import type {
  WidgetDef,
  WidgetFacts,
  WidgetMsg,
  WidgetCapabilities,
  ViewResult,
  ControlNode,
  ChatMessage,
  SettingsDoc,
} from '../host/types';
import type { LlmProvider } from '../llm/types';
import { registerTaggingProvider } from '../llm/taggingRegistry';
import { chatCompletion as openRouterChat } from '../openrouter/api';
import { chatCompletion as geminiChat } from '../gemini/api';
import { dispatchWidgetMsg } from '../host/widgetDispatch';
import { buildTranscript } from '../shared/buildTranscript';
import {
  buildTaggingMessages,
  defaultTaggingPrompt,
  resolveSystemPrompt,
  parseTagCsv,
} from './prompts';
import { ct } from './i18n';
import {
  PLUGIN_ID,
  type BackendId,
  type TaggerConfig,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  buildSettingsDoc,
  configFromSettingsDoc,
  loadModelsForBackend,
  providerReady,
} from './settings';

const PLUGIN_VERSION = '0.1.0';
const MAX_DIALOG_TAGS = 7;

const LS_PROVIDER = 'tagger.providerId';
const LS_MODEL = 'tagger.modelId';
const LS_PROMPT = 'tagger.systemPrompt';

interface BranchMarker {
  nodeId: string;
  index: number;
  label: string;
  comment: string | null;
}

interface State {
  settingsCenterOpen: boolean;
  config: TaggerConfig;
  models: { id: string; name: string }[];
  hasApiKey: boolean;
  startNodeId: string | null;
  startLabel: string | null;
  startComment: string | null;
  endNodeId: string | null;
  endLabel: string | null;
  endComment: string | null;
  busy: boolean;
  previewPending: boolean;
  done: boolean;
  error: string | null;
}

const liveState: { current: State } = {
  current: makeInitialState(),
};

function readBackend(): BackendId {
  try {
    const v = localStorage.getItem(LS_PROVIDER);
    return v === 'gemini' ? 'gemini' : 'openrouter';
  } catch {
    return DEFAULT_PROVIDER;
  }
}

function readModel(backend: BackendId): string {
  try {
    const saved = localStorage.getItem(LS_MODEL);
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT_MODELS[backend];
}

function readSystemPrompt(): string {
  try {
    const saved = localStorage.getItem(LS_PROMPT);
    if (saved !== null) return resolveSystemPrompt(saved);
  } catch {
    /* ignore */
  }
  return defaultTaggingPrompt();
}

function readConfig(): TaggerConfig {
  const backend = readBackend();
  return {
    backend,
    modelId: readModel(backend),
    systemPrompt: readSystemPrompt(),
  };
}

function saveConfig(config: TaggerConfig): void {
  try {
    localStorage.setItem(LS_PROVIDER, config.backend);
    localStorage.setItem(LS_MODEL, config.modelId);
    localStorage.setItem(LS_PROMPT, resolveSystemPrompt(config.systemPrompt));
  } catch {
    /* ignore */
  }
}

function makeInitialState(): State {
  const config = readConfig();
  return {
    settingsCenterOpen: false,
    config,
    models: [],
    hasApiKey: false,
    startNodeId: null,
    startLabel: null,
    startComment: null,
    endNodeId: null,
    endLabel: null,
    endComment: null,
    busy: false,
    previewPending: false,
    done: false,
    error: null,
  };
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

function makeTaggingProvider(config: TaggerConfig, cap: WidgetCapabilities): LlmProvider {
  const { backend, modelId } = config;
  return {
    pluginId: `${PLUGIN_ID}:${backend}`,
    isReady() {
      const s = liveState.current;
      return s.hasApiKey && !!s.config.modelId;
    },
    getModelFacts() {
      return { id: modelId, contextWindow: 200000 };
    },
    async generateResponse(messages: ChatMessage[], _role: string) {
      const apiKey = await cap.secrets.get(backend);
      if (!apiKey) throw new Error(ct('error.apiKeyMissing', { backend }));
      if (backend === 'gemini') {
        return geminiChat(apiKey, modelId, messages);
      }
      return openRouterChat(apiKey, modelId, messages);
    },
  };
}

function syncTaggingProvider(state: State, cap: WidgetCapabilities): void {
  liveState.current = state;
  if (state.hasApiKey && state.config.modelId) {
    registerTaggingProvider(makeTaggingProvider(state.config, cap));
  } else {
    registerTaggingProvider(null);
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

async function refreshHasApiKey(
  state: State,
  cap: WidgetCapabilities,
): Promise<boolean> {
  return providerReady(state.config.backend, cap);
}

async function openSettingsCenter(state: State, cap: WidgetCapabilities): Promise<void> {
  const loadingDoc = await buildSettingsDoc(cap, state.config, state.models, {
    loadingModels: true,
  });
  cap.ui.openSettings(loadingDoc);

  const { models, error } = await loadModelsForBackend(state.config.backend, cap);
  let modelId = state.config.modelId;
  if (models.length > 0 && !models.some((m) => m.id === modelId)) {
    modelId = models[0].id;
  }
  const doc = await buildSettingsDoc(
    cap,
    { ...state.config, modelId },
    models,
    { error },
  );
  cap.ui.refreshSettings(doc);
}

async function runTag(state: State, cap: WidgetCapabilities): Promise<void> {
  const systemPrompt = resolveSystemPrompt(state.config.systemPrompt);
  try {
    const range = await cap.markers.resolveLinearRange(
      state.startNodeId!,
      state.endNodeId!,
    );
    const transcript = buildTranscript(
      range,
      { label: state.startLabel, comment: state.startComment },
      { label: state.endLabel, comment: state.endComment },
      {
        user: ct('transcript.user'),
        assistant: ct('transcript.assistant'),
        header: (count, start, end) =>
          ct('transcript.header', { count, start, end }),
      },
    );
    const dictionary = await cap.tags.listDictionary();
    const messages = buildTaggingMessages(transcript, systemPrompt, dictionary);
    const answer = await cap.model.call('tagging', messages);
    const proposed = parseTagCsv(answer);

    if (proposed.length === 0) {
      dispatchWidgetMsg(PLUGIN_ID, {
        type: 'TAG_FAIL',
        error: ct('error.noTags'),
      });
      return;
    }

    cap.ui.openPreview(
      {
        title: ct('preview.title'),
        text: proposed.join(', '),
        widgetId: PLUGIN_ID,
        tags: proposed,
      },
      {
        onConfirm: async (payload) => {
          // WYSIWYG: привязываем ровно то, что осталось в превью после правки
          // чипов (пользователь мог убрать лишние). Без слияния со старыми.
          const finalTags = (payload?.tags ?? proposed).slice(0, MAX_DIALOG_TAGS);
          await cap.tags.setForActiveDialog(finalTags, 'llm');
        },
        onCancel: () => {},
        widgetId: PLUGIN_ID,
        confirmMsg: { type: 'PREVIEW_CONFIRMED' },
        cancelMsg: { type: 'PREVIEW_CANCELLED' },
      },
    );

    dispatchWidgetMsg(PLUGIN_ID, {
      type: 'TAG_DONE',
      previewPending: true,
    });
  } catch (e) {
    dispatchWidgetMsg(PLUGIN_ID, {
      type: 'TAG_FAIL',
      error: String(e),
    });
  }
}

export const tagger: WidgetDef<State> = {
  manifest: {
    id: PLUGIN_ID,
    title: ct('title'),
    icon: 'tags',
    defaultOpen: true,
    order: 30,
    surface: 'panel',
    supportedModels: '*',
    capabilities: [
      'markers.read',
      'model.call',
      'secrets',
      'ui.focus',
      'tags.read',
      'tags.write',
    ],
    author: 'core',
    version: PLUGIN_VERSION,
  },

  initialState(): State {
    return { ...liveState.current };
  },

  view(state: State, facts: WidgetFacts): ViewResult {
    if (!facts.activeDialogId) {
      return { inactive: true, reason: ct('inactive.noDialog') };
    }

    if (state.settingsCenterOpen) {
      return { inactive: true, reason: ct('inactive.settingsOpen') };
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
            title: ct('settings.gearTitle'),
            onClick: { type: 'OPEN_SETTINGS' },
          },
          { kind: 'spacer' },
        ],
      },
    ];

    if (state.error) children.push(text(ct('error.prefix', { msg: state.error }), true));
    if (state.done) children.push(text(ct('done'), true));
    if (state.previewPending) {
      children.push(text(ct('previewPending'), true));
    }
    if (!state.hasApiKey) {
      children.push(text(ct('noApiKey'), true));
    }

    children.push(text(ct('start')));
    if (starts.length === 0) {
      children.push(text(ct('needMarkers'), true));
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

    children.push(text(ct('end')));
    if (!startValid) {
      children.push(text(ct('pickStartFirst'), true));
    } else if (ends.length === 0) {
      children.push(text(ct('noEnds'), true));
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

    const ready =
      startValid &&
      endValid &&
      state.hasApiKey &&
      !state.busy &&
      !state.previewPending;

    children.push({
      kind: 'button',
      label: state.busy
        ? ct('tagging')
        : ready
          ? ct('tagRange', { start: startMark!.label, end: endMark!.label })
          : ct('tag'),
      disabled: !ready,
      primary: true,
      onClick: { type: 'TAG' },
    });

    return { kind: 'stack', children };
  },

  async update(
    msg: WidgetMsg,
    state: State,
    cap: WidgetCapabilities,
  ): Promise<State> {
    switch (msg.type) {
      case '@@mount': {
        const hasApiKey = await refreshHasApiKey(state, cap);
        const next = { ...state, hasApiKey, config: readConfig() };
        syncTaggingProvider(next, cap);
        return next;
      }

      case 'OPEN_SETTINGS': {
        const next = { ...state, settingsCenterOpen: true, error: null };
        liveState.current = next;
        await openSettingsCenter(next, cap);
        return next;
      }

      case 'SETTINGS_PROVIDER': {
        const backend = String(msg.value) as BackendId;
        const draftPrompt =
          typeof msg.prompt === 'string' ? msg.prompt : state.config.systemPrompt;
        const config: TaggerConfig = {
          ...state.config,
          backend,
          modelId: DEFAULT_MODELS[backend] ?? state.config.modelId,
          systemPrompt: draftPrompt,
        };
        cap.ui.refreshSettings(
          await buildSettingsDoc(cap, config, [], { loadingModels: true }),
        );
        const { models, error } = await loadModelsForBackend(backend, cap);
        let modelId = config.modelId;
        if (models.length > 0 && !models.some((m) => m.id === modelId)) {
          modelId = models[0].id;
        }
        cap.ui.refreshSettings(
          await buildSettingsDoc(
            cap,
            { ...config, modelId, systemPrompt: draftPrompt },
            models,
            { error },
          ),
        );
        return state;
      }

      case 'SETTINGS_APPLY': {
        const doc = msg.value as SettingsDoc;
        const config = configFromSettingsDoc(doc);
        saveConfig(config);
        const hasApiKey = await providerReady(config.backend, cap);
        const { models, error } = await loadModelsForBackend(config.backend, cap);
        const next: State = {
          ...state,
          settingsCenterOpen: false,
          config,
          models,
          hasApiKey,
          busy: false,
          error: error && !hasApiKey ? error : null,
        };
        syncTaggingProvider(next, cap);
        cap.ui.closeSettings();
        return next;
      }

      case 'SETTINGS_CANCEL': {
        cap.ui.closeSettings();
        return { ...state, settingsCenterOpen: false };
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

      case 'TAG': {
        if (!state.startNodeId || !state.endNodeId) {
          return { ...state, error: ct('error.pickRange') };
        }
        if (!state.hasApiKey) {
          return { ...state, error: ct('error.noApiKey') };
        }
        const working = { ...state, busy: true, error: null };
        liveState.current = working;
        void runTag(working, cap);
        return working;
      }

      case 'TAG_DONE':
        return {
          ...state,
          busy: false,
          previewPending: Boolean(msg.previewPending),
          error: null,
        };

      case 'TAG_FAIL':
        return {
          ...state,
          busy: false,
          previewPending: false,
          error: String(msg.error ?? ct('error.tagFailed')),
        };

      default:
        return state;
    }
  },
};
