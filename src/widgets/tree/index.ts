// src/widgets/tree/index.ts
// Плагин «Дерево» — тонкий вход в нативный визуализатор всего дерева беседы.
// Топологию читает и рисует ХОСТ (TreeCanvas), плагин лишь: (1) открывает
// поверхность деревом со СВОИМИ опциями показа (openTree), (2) держит эти опции
// в конфиге плагина (cap.config, D-095) и правит их формой-настройкой.
//
// Опции применяются при СЛЕДУЮЩЕМ открытии дерева (openForm закрывает открытое
// дерево — так устроено взаимоисключение центральных поверхностей).

import type {
  WidgetDef,
  WidgetFacts,
  WidgetMsg,
  WidgetCapabilities,
  WidgetHeaderAction,
  ViewResult,
  ControlNode,
  FormDoc,
} from '../host/types';
import { ct } from './i18n';

const PLUGIN_ID = 'tree';
const PLUGIN_VERSION = '0.1.0';

interface State {
  showDeleted: boolean;
  showModelInZoom: boolean;
  showUnanswered: boolean;
}

// Кэш последнего состояния: пережить пересоздание виджета и обслужить @@lang
// (пересборка открытой формы) без потери правок.
const liveState: { current: State } = { current: makeInitialState() };

function makeInitialState(): State {
  return { showDeleted: false, showModelInZoom: true, showUnanswered: false };
}

// ---- конфиг плагина (cap.config, D-095) ----

interface SavedConfig {
  showDeleted: boolean;
  showModelInZoom: boolean;
  showUnanswered: boolean;
}

function parseConfig(raw: string | null): Partial<SavedConfig> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Partial<SavedConfig>;
    return {
      showDeleted: typeof o.showDeleted === 'boolean' ? o.showDeleted : undefined,
      showModelInZoom:
        typeof o.showModelInZoom === 'boolean' ? o.showModelInZoom : undefined,
      showUnanswered:
        typeof o.showUnanswered === 'boolean' ? o.showUnanswered : undefined,
    };
  } catch {
    return {};
  }
}

async function saveConfig(cap: WidgetCapabilities, state: State): Promise<void> {
  const cfg: SavedConfig = {
    showDeleted: state.showDeleted,
    showModelInZoom: state.showModelInZoom,
    showUnanswered: state.showUnanswered,
  };
  try {
    await cap.config.save(JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[tree] save config failed', e);
  }
}

function buildSettingsForm(state: State): FormDoc {
  const body: ControlNode = {
    kind: 'stack',
    children: [
      {
        kind: 'checkbox',
        label: ct('showDeleted'),
        checked: state.showDeleted,
        onChange: { type: 'TOGGLE_SHOW_DELETED' },
      },
      {
        kind: 'checkbox',
        label: ct('showModelInZoom'),
        checked: state.showModelInZoom,
        onChange: { type: 'TOGGLE_SHOW_MODEL' },
      },
      {
        kind: 'checkbox',
        label: ct('showUnanswered'),
        checked: state.showUnanswered,
        onChange: { type: 'TOGGLE_SHOW_UNANSWERED' },
      },
    ],
  };
  return {
    widgetId: PLUGIN_ID,
    title: ct('settings'),
    submitLabel: ct('done'),
    submitMsg: { type: 'SETTINGS_DONE' },
    cancelMsg: { type: 'SETTINGS_DONE' },
    body,
  };
}

export const tree: WidgetDef<State> = {
  manifest: {
    id: PLUGIN_ID,
    title: ct('title'),
    icon: 'git-branch',
    defaultOpen: true,
    order: 20,
    surface: 'panel',
    supportedModels: '*',
    capabilities: ['config'],
    author: 'core',
    version: PLUGIN_VERSION,
  },

  initialState(): State {
    return { ...liveState.current };
  },

  // Кнопка «Открыть дерево» живёт в ШАПКЕ секции (видна и при свёрнутом плагине).
  headerAction(facts: WidgetFacts): WidgetHeaderAction | null {
    if (!facts.activeDialogId) return null;
    return { label: ct('open'), msg: { type: 'OPEN' } };
  },

  // Тело секции: только шестерёнка настроек (прячется при сворачивании).
  view(): ViewResult {
    return {
      kind: 'row',
      children: [
        {
          kind: 'iconButton',
          icon: '⚙',
          title: ct('settings'),
          onClick: { type: 'OPEN_SETTINGS' },
        },
      ],
    };
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
          showDeleted: cfg.showDeleted ?? state.showDeleted,
          showModelInZoom: cfg.showModelInZoom ?? state.showModelInZoom,
          showUnanswered: cfg.showUnanswered ?? state.showUnanswered,
        };
        liveState.current = next;
        return next;
      }

      case '@@lang': {
        // Смена языка при открытой форме — пересобрать её из последних опций.
        cap.ui.refreshForm(buildSettingsForm(liveState.current));
        return state;
      }

      case 'OPEN': {
        cap.ui.openTree({
          widgetId: PLUGIN_ID,
          showDeleted: state.showDeleted,
          showModelInZoom: state.showModelInZoom,
          showUnanswered: state.showUnanswered,
        });
        return state;
      }

      case 'OPEN_SETTINGS': {
        cap.ui.openForm(buildSettingsForm(state));
        return state;
      }

      case 'TOGGLE_SHOW_DELETED': {
        const next = { ...state, showDeleted: Boolean(msg.value) };
        liveState.current = next;
        await saveConfig(cap, next);
        cap.ui.refreshForm(buildSettingsForm(next));
        return next;
      }

      case 'TOGGLE_SHOW_MODEL': {
        const next = { ...state, showModelInZoom: Boolean(msg.value) };
        liveState.current = next;
        await saveConfig(cap, next);
        cap.ui.refreshForm(buildSettingsForm(next));
        return next;
      }

      case 'TOGGLE_SHOW_UNANSWERED': {
        const next = { ...state, showUnanswered: Boolean(msg.value) };
        liveState.current = next;
        await saveConfig(cap, next);
        cap.ui.refreshForm(buildSettingsForm(next));
        return next;
      }

      case 'SETTINGS_DONE': {
        cap.ui.closeForm();
        return state;
      }

      default:
        return state;
    }
  },
};
