// src/widgets/save-dialog/index.ts
// «Сохранить диалог» — выбираем пару Начало–Конец маркерами (как компрессор/
// тегизатор), затем «Сохранить как…»: формат (TXT/DOC/HTML; PDF позже), опции
// встраивания картинок и модели, и алиасы для вопроса/ответа. Сборку документа
// делает export.ts, запись файла — capability export (ядро пишет ФС).

import type {
  WidgetDef,
  WidgetFacts,
  WidgetMsg,
  WidgetCapabilities,
  ViewResult,
  ControlNode,
  FormDoc,
  ExportNode,
} from '../host/types';
import { dispatchWidgetMsg } from '../host/widgetDispatch';
import { resolveModelName } from '../llm/registry';
import { ct } from './i18n';
import {
  type SaveFormat,
  type ExportOptions,
  buildDocument,
  collectImageRefs,
} from './export';

const PLUGIN_ID = 'save-dialog';
const PLUGIN_VERSION = '0.1.0';

interface State {
  format: SaveFormat;
  embedImages: boolean;
  embedModel: boolean;
  aliasQuestion: string;
  aliasAnswer: string;
  startNodeId: string | null;
  startLabel: string | null;
  startComment: string | null;
  endNodeId: string | null;
  endLabel: string | null;
  endComment: string | null;
  busy: boolean;
  done: boolean;
  error: string | null;
}

interface BranchMarker {
  nodeId: string;
  index: number;
  label: string;
  comment: string | null;
}

const liveState: { current: State } = { current: makeInitialState() };

function makeInitialState(): State {
  return {
    format: 'txt',
    embedImages: true,
    embedModel: true,
    aliasQuestion: 'Q:',
    aliasAnswer: 'A:',
    startNodeId: null,
    startLabel: null,
    startComment: null,
    endNodeId: null,
    endLabel: null,
    endComment: null,
    busy: false,
    done: false,
    error: null,
  };
}

// ---- конфиг плагина (cap.config, D-095): запоминаем последние опции ----

function isSaveFormat(v: unknown): v is SaveFormat {
  return v === 'txt' || v === 'doc' || v === 'html' || v === 'pdf';
}

interface SavedConfig {
  format: SaveFormat;
  embedImages: boolean;
  embedModel: boolean;
  aliasQuestion: string;
  aliasAnswer: string;
}

function parseConfig(raw: string | null): Partial<SavedConfig> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Partial<SavedConfig>;
    const format: SaveFormat = isSaveFormat(o.format) ? o.format : 'txt';
    return {
      format,
      embedImages: typeof o.embedImages === 'boolean' ? o.embedImages : undefined,
      embedModel: typeof o.embedModel === 'boolean' ? o.embedModel : undefined,
      aliasQuestion: typeof o.aliasQuestion === 'string' ? o.aliasQuestion : undefined,
      aliasAnswer: typeof o.aliasAnswer === 'string' ? o.aliasAnswer : undefined,
    };
  } catch {
    return {};
  }
}

async function saveConfig(cap: WidgetCapabilities, state: State): Promise<void> {
  const cfg: SavedConfig = {
    format: state.format,
    embedImages: state.embedImages,
    embedModel: state.embedModel,
    aliasQuestion: state.aliasQuestion,
    aliasAnswer: state.aliasAnswer,
  };
  try {
    await cap.config.save(JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[save-dialog] save config failed', e);
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

function resetRangePick(): Partial<State> {
  return {
    startNodeId: null,
    startLabel: null,
    startComment: null,
    endNodeId: null,
    endLabel: null,
    endComment: null,
    done: false,
    error: null,
  };
}

function buildOptionsForm(state: State): FormDoc {
  const body: ControlNode = {
    kind: 'stack',
    children: [
      {
        kind: 'field',
        label: ct('format'),
        child: {
          kind: 'radioGroup',
          name: 'format',
          value: state.format,
          options: [
            { value: 'txt', label: ct('format.txt') },
            { value: 'doc', label: ct('format.doc') },
            { value: 'html', label: ct('format.html') },
            { value: 'pdf', label: ct('format.pdf') },
          ],
        },
      },
      {
        kind: 'checkbox',
        label: ct('embedImages'),
        checked: state.embedImages,
        onChange: { type: 'TOGGLE_EMBED_IMAGES' },
      },
      {
        kind: 'checkbox',
        label: ct('embedModel'),
        checked: state.embedModel,
        onChange: { type: 'TOGGLE_EMBED_MODEL' },
      },
      {
        kind: 'field',
        label: ct('aliasQuestion'),
        child: {
          kind: 'textInput',
          name: 'aliasQuestion',
          value: state.aliasQuestion,
          placeholder: ct('aliasQuestion.placeholder'),
        },
      },
      {
        kind: 'field',
        label: ct('aliasAnswer'),
        child: {
          kind: 'textInput',
          name: 'aliasAnswer',
          value: state.aliasAnswer,
          placeholder: ct('aliasAnswer.placeholder'),
        },
      },
    ],
  };

  return {
    widgetId: PLUGIN_ID,
    title: ct('saveAs'),
    submitLabel: ct('save'),
    cancelLabel: ct('cancel'),
    submitMsg: { type: 'FORM_SUBMIT' },
    cancelMsg: { type: 'FORM_CANCEL' },
    body,
  };
}

function modelSuffix(n: ExportNode): string | null {
  const model = n.modelId ? resolveModelName(n.modelId) : null;
  const plugin = n.pluginId;
  if (!model && !plugin) return null;
  return ct('modelSuffix', { plugin: plugin ?? '—', model: model ?? '—' });
}

async function runSave(state: State, cap: WidgetCapabilities): Promise<void> {
  try {
    const nodes = await cap.export.resolveRichRange(
      state.startNodeId!,
      state.endNodeId!,
    );

    const imageDataUrls = new Map<string, string>();
    if (state.embedImages) {
      for (const ref of collectImageRefs(nodes)) {
        try {
          const img = await cap.export.loadImageBase64(ref.storagePath, ref.mime);
          imageDataUrls.set(ref.storagePath, `data:${img.mime};base64,${img.base64}`);
        } catch (e) {
          console.error('[save-dialog] image load failed', ref.storagePath, e);
        }
      }
    }

    const opts: ExportOptions = {
      embedImages: state.embedImages,
      embedModel: state.embedModel,
      aliasQuestion: state.aliasQuestion,
      aliasAnswer: state.aliasAnswer,
      aliasSummary: ct('aliasSummary'),
      imageDataUrls,
      labels: {
        documentTitle: ct('documentTitle'),
        imagePlaceholder: (f) => ct('placeholder.image', { filename: f }),
        filePlaceholder: (f) => ct('placeholder.file', { filename: f }),
      },
      modelSuffix,
    };

    const defaultName = `${ct('defaultFilename')}.${state.format}`;
    let saved: boolean;
    if (state.format === 'pdf') {
      // pdfmake тяжёлый — грузим модуль лениво, только когда реально нужен PDF.
      const { buildPdfBase64 } = await import('./pdf');
      const base64 = await buildPdfBase64(nodes, opts);
      saved = await cap.export.saveBinaryFile({ defaultName, extension: 'pdf', base64 });
    } else {
      const contents = buildDocument(state.format, nodes, opts);
      saved = await cap.export.saveFile({ defaultName, extension: state.format, contents });
    }

    dispatchWidgetMsg(PLUGIN_ID, { type: saved ? 'SAVE_DONE' : 'SAVE_CANCELLED' });
  } catch (e) {
    dispatchWidgetMsg(PLUGIN_ID, { type: 'SAVE_FAIL', error: String(e) });
  }
}

export const saveDialog: WidgetDef<State> = {
  manifest: {
    id: PLUGIN_ID,
    title: ct('title'),
    icon: 'save',
    defaultOpen: true,
    order: 40,
    surface: 'panel',
    supportedModels: '*',
    capabilities: ['markers.read', 'export.read', 'export.save', 'config'],
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

    const bm = branchMarkers(facts);
    const starts = bm.slice(0, Math.max(0, bm.length - 1));
    const startMark = bm.find((m) => m.nodeId === state.startNodeId) ?? null;
    const startValid = startMark !== null && starts.some((m) => m.nodeId === startMark.nodeId);
    const ends = startValid ? bm.filter((m) => m.index > startMark!.index) : [];
    const endMark = bm.find((m) => m.nodeId === state.endNodeId) ?? null;
    const endValid = endMark !== null && ends.some((m) => m.nodeId === endMark.nodeId);

    const children: ControlNode[] = [];

    if (state.error) children.push(text(ct('error.prefix', { msg: state.error }), true));
    if (state.done) children.push(text(ct('done'), true));

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

    const ready = startValid && endValid && !state.busy;
    children.push({
      kind: 'button',
      label: state.busy
        ? ct('saving')
        : ready
          ? ct('saveRange', { start: startMark!.label, end: endMark!.label })
          : ct('saveAs'),
      disabled: !ready,
      primary: true,
      onClick: { type: 'OPEN_FORM' },
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
        const cfg = parseConfig(await cap.config.load());
        const next: State = {
          ...state,
          format: cfg.format ?? state.format,
          embedImages: cfg.embedImages ?? state.embedImages,
          embedModel: cfg.embedModel ?? state.embedModel,
          aliasQuestion: cfg.aliasQuestion ?? state.aliasQuestion,
          aliasAnswer: cfg.aliasAnswer ?? state.aliasAnswer,
        };
        liveState.current = next;
        return next;
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
          error: null,
        };
      }

      case 'OPEN_FORM': {
        if (!state.startNodeId || !state.endNodeId) {
          return { ...state, error: ct('error.pickRange') };
        }
        cap.ui.openForm(buildOptionsForm(state));
        return state;
      }

      case 'TOGGLE_EMBED_IMAGES': {
        const next = { ...state, embedImages: Boolean(msg.value) };
        liveState.current = next;
        cap.ui.refreshForm(buildOptionsForm(next));
        return next;
      }

      case 'TOGGLE_EMBED_MODEL': {
        const next = { ...state, embedModel: Boolean(msg.value) };
        liveState.current = next;
        cap.ui.refreshForm(buildOptionsForm(next));
        return next;
      }

      case 'FORM_CANCEL': {
        cap.ui.closeForm();
        return state;
      }

      case 'FORM_SUBMIT': {
        const values =
          (msg.value as { values?: Record<string, string> } | undefined)?.values ?? {};
        const format: SaveFormat = isSaveFormat(values.format) ? values.format : 'txt';
        const next: State = {
          ...state,
          format,
          aliasQuestion:
            typeof values.aliasQuestion === 'string'
              ? values.aliasQuestion
              : state.aliasQuestion,
          aliasAnswer:
            typeof values.aliasAnswer === 'string'
              ? values.aliasAnswer
              : state.aliasAnswer,
          busy: true,
          done: false,
          error: null,
        };
        liveState.current = next;
        cap.ui.closeForm();
        await saveConfig(cap, next);
        void runSave(next, cap);
        return next;
      }

      case 'SAVE_DONE':
        return { ...state, busy: false, done: true, error: null };

      case 'SAVE_CANCELLED':
        return { ...state, busy: false, done: false, error: null };

      case 'SAVE_FAIL':
        return {
          ...state,
          busy: false,
          done: false,
          error: String(msg.error ?? ct('error.saveFailed')),
        };

      default:
        return state;
    }
  },
};
