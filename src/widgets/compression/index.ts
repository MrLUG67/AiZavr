// src/widgets/compression/index.ts
// Плагин сжатия — второй живой WidgetDef и первый с капабилити (D-066/D-068).
//
// ЯДРО даёт крепление (compression.attach) и разворачивание линейного диапазона
// (resolveLinearRange) для дайджеста. ПЛАГИН ведёт UX и СОБИРАЕТ резюме. В MVP
// резюме собирает детерминированная ЗАГЛУШКА (D-056): без model.call — просто
// дайджест диапазона.
//
// Упрощённая модель (по решению отладки):
//   - сжатие ТОЛЬКО на участке между ДВУМЯ МАРКЕРАМИ (начало + конец);
//   - сжимается только ТЕКУЩИЙ диалог, а он ЛИНЕЕН.
//
// РЕАКТИВНОСТЬ (вместо ручного «Обновить»): списки маркеров строятся прямо из
// facts.activeBranch (узлы теперь несут свои метки, NodeView.markers). Ядро
// перерисовывает view при изменении ветки, поэтому поставленный/снятый в центре
// маркер появляется/исчезает в плагине сам, без pull и без F5. В update фактов
// нет, поэтому выбор хранит только nodeId — подписи берём во view из факта.

import type {
  WidgetDef,
  WidgetFacts,
  WidgetMsg,
  WidgetCapabilities,
  ViewResult,
  ControlNode,
  NodeView,
} from '../host/types';

interface State {
  startNodeId: string | null;
  startLabel: string | null;   // подпись/комментарий выбранной метки — приходят с
  startComment: string | null; // событием выбора (в update фактов нет), нужны для
  endNodeId: string | null;    // шапки дайджеста («Начало …, Конец …»).
  endLabel: string | null;
  endComment: string | null;
  done: boolean;        // показать «свёрнуто» после успешного крепления
  error: string | null; // мягкая операционная ошибка (не падение хоста)
}

const PLUGIN_ID = 'compression';
const PLUGIN_VERSION = '0.1.0';
const ALGORITHM = 'digest-stub-v1';

// Маркер на активной ветке: узел + его порядковая позиция (корень->лист) +
// подпись/комментарий первой метки (UI ставит одну метку на узел).
interface BranchMarker {
  nodeId: string;
  index: number;
  label: string;
  comment: string | null;
}

// Метки активной ветки в порядке корень->лист. D-058: метка только на A-узле,
// поэтому отдельная проверка типа не нужна — берём всё, что несёт markers.
function branchMarkers(facts: WidgetFacts): BranchMarker[] {
  const out: BranchMarker[] = [];
  facts.activeBranch.forEach((n, i) => {
    const mk = n.markers[0];
    if (mk) out.push({ nodeId: n.id, index: i, label: mk.label, comment: mk.comment });
  });
  return out;
}

// Однострочное превью текста узла: схлопываем пробелы, режем по длине.
function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Подпись метки для шапки: «label : comment» или просто «label» без коммента.
function markerTag(label: string | null, comment: string | null): string {
  const l = label ?? '?';
  return comment ? `${l} : ${comment}` : l;
}

// Детерминированный дайджест диапазона (D-056, без модели). range[0] — якорь
// (верхний A): он остаётся ДОСЛОВНО выше маркера (D-063), в резюме не входит.
// В шапку кладём границы (метка+комментарий начала/конца) — для отладки видно,
// какой именно участок свёрнут.
function buildDigest(
  range: NodeView[],
  start: { label: string | null; comment: string | null },
  end: { label: string | null; comment: string | null },
): string {
  const body = range
    .slice(1)
    .filter(
      (n) => n.nodeType === 'user_message' || n.nodeType === 'assistant_message',
    );
  const lines = body.map((n) => {
    const who = n.nodeType === 'user_message' ? 'В' : 'О';
    return `${who}: ${oneLine(n.text, 140)}`;
  });
  const head =
    `[Черновое резюме без модели, ${body.length} сообщ. ` +
    `Начало "${markerTag(start.label, start.comment)}", ` +
    `Конец "${markerTag(end.label, end.comment)}"]`;
  return head + '\n' + lines.join('\n');
}

function text(value: string, muted = false): ControlNode {
  return { kind: 'text', value, tone: muted ? 'muted' : 'normal' };
}

export const compression: WidgetDef<State> = {
  manifest: {
    id: PLUGIN_ID,
    title: 'Сжатие',
    icon: 'archive',
    defaultOpen: true,
    order: 20, // после светофора (10)
    surface: 'panel',
    supportedModels: '*', // дайджест-заглушка модель-агностична (D-082)
    capabilities: ['markers.read', 'compression.attach', 'ui.focus'], // disclosure (D-073)
    author: 'core',
    version: PLUGIN_VERSION,
  },

  initialState(): State {
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
  },

  view(state: State, facts: WidgetFacts): ViewResult {
    // ТОНКИЙ рубеж (D-083): без беседы сжимать нечего. Плашку рисует хост.
    if (!facts.activeDialogId) {
      return { inactive: true, reason: 'Нет активной беседы' };
    }

    const bm = branchMarkers(facts);

    // Начало — любой маркер, у которого ниже на ветке есть хотя бы ещё один
    // маркер (иначе сжимать не с чем). bm отсортирован по index -> все, кроме
    // последнего.
    const starts = bm.slice(0, Math.max(0, bm.length - 1));

    const startMark = bm.find((m) => m.nodeId === state.startNodeId) ?? null;
    const startValid = startMark !== null && starts.some((m) => m.nodeId === startMark.nodeId);

    // Конец — маркер строго ниже выбранного начала.
    const ends = startValid ? bm.filter((m) => m.index > startMark!.index) : [];
    const endMark = bm.find((m) => m.nodeId === state.endNodeId) ?? null;
    const endValid = endMark !== null && ends.some((m) => m.nodeId === endMark.nodeId);

    const children: ControlNode[] = [];
    if (state.error) children.push(text(`Ошибка: ${state.error}`, true));
    if (state.done) children.push(text('Фрагмент свёрнут.', true));

    // --- начало ---
    children.push(text('Начало (маркер)'));
    if (starts.length === 0) {
      children.push(text('Нужно ≥2 маркеров на ветке. Поставьте ⚑ на ответы.', true));
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

    // --- конец ---
    children.push(text('Конец (маркер)'));
    if (!startValid) {
      children.push(text('Сначала выберите начало.', true));
    } else if (ends.length === 0) {
      children.push(text('Нет маркеров-концов ниже начала.', true));
    } else {
      children.push({
        kind: 'list',
        items: ends.map((m) => ({
          id: m.nodeId,
          label: m.label,
          secondary: m.comment ?? undefined, // п.2: комментарии и у концов
          selected: m.nodeId === state.endNodeId,
        })),
        onSelect: { type: 'PICK_END' },
      });
    }

    // --- действие ---
    const ready = startValid && endValid;
    children.push({
      kind: 'button',
      label: ready
        ? `Уплотнить ${startMark!.label} → ${endMark!.label}`
        : 'Уплотнить',
      disabled: !ready,
      onClick: { type: 'ATTACH' },
    });

    return { kind: 'stack', children };
  },

  async update(
    msg: WidgetMsg,
    state: State,
    cap: WidgetCapabilities,
  ): Promise<State> {
    switch (msg.type) {
      case 'PICK_START': {
        const nodeId = String(msg.value);
        const label = typeof msg.label === 'string' ? msg.label : null;
        const comment = typeof msg.secondary === 'string' ? msg.secondary : null;
        cap.ui.focus(nodeId); // подсветить начало в центре (D-072)
        // Сброс конца: ниже нового начала старый конец может быть невалиден.
        return {
          ...state,
          startNodeId: nodeId,
          startLabel: label,
          startComment: comment,
          endNodeId: null,
          endLabel: null,
          endComment: null,
          done: false,
          error: null,
        };
      }

      case 'PICK_END': {
        const nodeId = String(msg.value);
        const label = typeof msg.label === 'string' ? msg.label : null;
        const comment = typeof msg.secondary === 'string' ? msg.secondary : null;
        cap.ui.focus(nodeId);
        return {
          ...state,
          endNodeId: nodeId,
          endLabel: label,
          endComment: comment,
          done: false,
          error: null,
        };
      }

      case 'ATTACH': {
        if (!state.startNodeId || !state.endNodeId) {
          return { ...state, error: 'выберите начало и конец' };
        }
        try {
          // Дайджест собираем молча (без preview) и сразу крепим. Диапазон берём
          // у ядра — оно же страхует линейность/«живость» (D-066).
          const range = await cap.markers.resolveLinearRange(
            state.startNodeId,
            state.endNodeId,
          );
          await cap.compression.attach({
            startNodeId: state.startNodeId,
            endNodeId: state.endNodeId,
            summaryText: buildDigest(
              range,
              { label: state.startLabel, comment: state.startComment },
              { label: state.endLabel, comment: state.endComment },
            ),
            placeholderText: null, // D-061: текст заглушки опционален
            modelId: null, // D-088: детерминированная заглушка — без модели
            provenance: {
              pluginId: PLUGIN_ID,
              pluginVersion: PLUGIN_VERSION,
              algorithm: ALGORITHM,
              params: {},
            },
          });
          // Сбрасываем выбор; списки сами обновятся из новой ветки (реактивно).
          return {
            startNodeId: null,
            startLabel: null,
            startComment: null,
            endNodeId: null,
            endLabel: null,
            endComment: null,
            done: true,
            error: null,
          };
        } catch (e) {
          return { ...state, error: String(e) };
        }
      }

      default:
        return state;
    }
  },
};
