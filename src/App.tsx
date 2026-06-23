import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { WidgetPanel } from "./widgets/host/WidgetPanel";
import { MenuBar } from "./components/MenuBar";
import { NotebooksPanel } from "./components/NotebooksPanel";
import type { WidgetFacts, NodeView, ModelFacts, HelpDoc } from "./widgets/host/types";
import type { CapabilityDeps } from "./widgets/host/capabilities";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getActiveLlmProvider,
  getActiveLlmProviderId,
  subscribeLlmProvider,
} from "./widgets/llm/registry";
import { t, useLang } from "./i18n";

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  nodeId: string;
  nodeType: string;             // user_message | assistant_message | unanswered_placeholder
  childrenCount: number;         // total, включая удалённые
  deletedChildrenCount: number;  // только удалённые (D-050)
  markers: MarkerData[];         // маркеры на этом узле (D-058)
}
interface MarkerData {
  id: string;
  nodeId: string;
  label: string;
  comment: string | null;
}

interface DbDialog {
  id: string;
  title: string;
  notebook_id: string | null;
  root_node_id: string | null;
  active_leaf_id: string | null;
}

interface DbNode {
  id: string;
  parent_id: string | null;
  dialog_id: string;
  node_type: string;
  content: string;
  active_child_id: string | null;
  children_count: number;
  branch_name: string | null;
  last_visited_leaf_id: string | null;
  is_deleted: boolean;
}

interface Notebook {
  id: string;
  parent_notebook_id: string | null;
  name: string;
  kind: string;
}

interface SendResult {
  query_id: string;
  placeholder_id: string;
}

interface BranchCard {
  nodeId: string;
  branchName: string;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Сборка цепочки для LLM
// ---------------------------------------------------------------------------

// Превращает линейную ветку узлов в сообщения для LLM.
// Правило: unanswered_placeholder — служебная заглушка-ответ.
//   - заглушка В СЕРЕДИНЕ ветки = холостой Q из прошлого сбоя: срезаем
//     и её, и Q над ней (для модели этой пары не было).
//   - заглушка НА КОНЦЕ ветки = текущий ожидающий запрос: её Q обязан уйти
//     в LLM (на него и ждём ответ), пропускаем только саму пустую заглушку.
function buildLlmMessages(nodes: DbNode[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  const lastIdx = nodes.length - 1;

  nodes.forEach((n, idx) => {
    if (n.node_type === "unanswered_placeholder") {
      if (idx === lastIdx) {
        // Текущий запрос: Q уже добавлен предыдущей итерацией, его оставляем.
        // Саму заглушку (пустую) в модель не шлём.
        return;
      }
      // Холостой Q из прошлого: срезаем заглушку и Q над ней.
      if (out.length > 0 && out[out.length - 1].role === "user") {
        out.pop();
      }
      return;
    }
    // Узел-резюме сжатия (S): уходит в модель как вводный контекст вместо
    // свёрнутого диапазона (D-060). Структурно сидит в Q-слоте -> роль user.
    if (n.node_type === "compressed_summary") {
      out.push({
        role: "user",
        content: `[Сжатое резюме предыдущего участка беседы]\n${n.content}`,
      });
      return;
    }
    // Заглушка под S — служебная, в модель НЕ идёт (D-061).
    if (n.node_type === "compression_placeholder") {
      return;
    }
    if (n.node_type === "user_message") {
      out.push({ role: "user", content: n.content });
    } else if (n.node_type === "assistant_message") {
      out.push({ role: "assistant", content: n.content });
    }
    // прочие служебные типы — в LLM не идут
  });

  // Склейка соседних сообщений одной роли: после среза заглушек и вставки S
  // могут оказаться два user подряд (S + новый вопрос). Сливаем, чтобы не
  // ломать чередование ролей у провайдера.
  const merged: LlmMessage[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  useLang(); // перерисовка при смене языка
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Последняя ошибка отправки в LLM — показываем причину, а не только серую
  // плашку "ответ не получен". Сбрасывается при следующей удачной отправке.
  const [sendError, setSendError] = useState<string | null>(null);
  const [dialogId, setDialogId] = useState<string | null>(null);
  const [lastNodeId, setLastNodeId] = useState<string | null>(null);

  // Дерево блокнотов/бесед — единый источник правды (его читают и шапка, и
  // левая панель). Панель владеет UI-состоянием (раскрытие/меню), но не данными.
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [dialogs, setDialogs] = useState<DbDialog[]>([]);

  // Редактирование заголовка беседы в шапке (двойной клик).
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // Граница ПРОСМОТРА (нижний частично видимый узел). Эфемерна: не в БД,
  // отдельна от рабочего курсора lastNodeId (скролл не двигает рабочую позицию).
  // Дефолт — последний узел (низ ленты при свежей загрузке).
  const [visibleBoundaryNodeId, setVisibleBoundaryNodeId] = useState<string | null>(null);

  // Ветвление. Альтернативный запрос вводится в общем нижнем поле (composer),
  // отдельного встроенного инпута больше нет. branchingFromId != null —
  // признак режима «альтернативный запрос» для этого A-узла.
  const [branchingFromId, setBranchingFromId] = useState<string | null>(null);

  // Нижнее поле ввода (composer): высота тянется за верхнюю границу.
  const [composerHeight, setComposerHeight] = useState(120);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Автоскролл ленты: пока пользователь не увёл взгляд вверх вручную, держим
  // низ ленты приклеенным — последняя строка отправленного видна над полем.
  const [stickToBottom, setStickToBottom] = useState(true);
  
  // Маркеры (D-058) — раскрытое поле комментария при постановке
  const [markingNodeId, setMarkingNodeId] = useState<string | null>(null);
  const [markerComment, setMarkerComment] = useState("");
  
  // Маркеры — редактирование комментария существующего маркера
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);
  const [editingMarkerText, setEditingMarkerText] = useState("");
  
  // Режим развилки
  const [forkMode, setForkMode] = useState(false);
  const [forkNodeId, setForkNodeId] = useState<string | null>(null);
  const [forkCards, setForkCards] = useState<BranchCard[]>([]);
  const [forkActiveIdx, setForkActiveIdx] = useState(0);
  const cardsRef = useRef<HTMLDivElement>(null);

  // Режим восстановления удалённых веток (D-050)
  const [deletedMode, setDeletedMode] = useState(false);
  // Значение не читается (оверлей удалённых не ссылается на A-узел) — держим
  // только сеттер; иначе noUnusedLocals валит сборку (TS6133).
  const [, setDeletedForkNodeId] = useState<string | null>(null);
  const [deletedForkCards, setDeletedForkCards] = useState<BranchCard[]>([]);

  const messagesRef = useRef<HTMLDivElement>(null);
  const messageEls = useRef<(HTMLDivElement | null)[]>([]);
  const messagesDataRef = useRef<Message[]>([]); // зеркало messages для onFocus (стабильный колбэк)

  // Редактирование имени карточки
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  const clickTimer = useRef<number | null>(null);

  // Активная модель — от LLM-плагина (OpenRouter), не от ядра.
  const [modelFacts, setModelFacts] = useState<ModelFacts>({
    id: "",
    contextWindow: 200000,
  });
  const [activeLlmProviderId, setActiveLlmProviderId] = useState<string | null>(
    () => getActiveLlmProviderId(),
  );
  // Справка плагина в центре (вместо диалога). null — скрыта.
  const [helpDoc, setHelpDoc] = useState<HelpDoc | null>(null);

  // ---------------------------------------------------------------------------
  // Инициализация
  // ---------------------------------------------------------------------------

  useEffect(() => {
    initDialog().catch(console.error);
  }, []);

  useEffect(() => {
    const updateLlm = () => {
      setActiveLlmProviderId(getActiveLlmProviderId());
      const provider = getActiveLlmProvider();
      if (provider?.isReady()) {
        setModelFacts(provider.getModelFacts());
      } else {
        setModelFacts({ id: "", contextWindow: 200000 });
      }
    };
    updateLlm();
    return subscribeLlmProvider(updateLlm);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editingNodeId) return;

      // Режим развилки: плашки альтернатив внизу.
      if (forkMode) {
        if (e.key === "F2") {
          e.preventDefault();
          const card = forkCards[forkActiveIdx];
          if (card) startEditing(card.nodeId);
          return;
        }
        // Ctrl+↑/↓ — НЕ проваливаемся, а едем дальше к следующему
        // маркеру/развилке в этом направлении (плашки закроются).
        if (e.ctrlKey && e.key === "ArrowUp") {
          e.preventDefault();
          navigateUp();
          return;
        }
        if (e.ctrlKey && e.key === "ArrowDown") {
          e.preventDefault();
          navigateDown();
          return;
        }
        // Enter или ↓ (без Ctrl) — проваливаемся в выбранную ветку.
        if (e.key === "Enter" || (e.key === "ArrowDown" && !e.ctrlKey)) {
          e.preventDefault();
          selectForkCard(forkActiveIdx);
          return;
        }
        // ←/→ — выбор варианта; с Ctrl — к крайнему левому/правому.
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setForkActiveIdx(i => (e.ctrlKey ? 0 : Math.max(0, i - 1)));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setForkActiveIdx(i => (e.ctrlKey ? forkCards.length - 1 : Math.min(forkCards.length - 1, i + 1)));
          return;
        }
        return;
      }

      if (!e.ctrlKey) return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateUp();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateDown();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [forkMode, forkCards, forkActiveIdx, messages, dialogId, editingNodeId]);

  useEffect(() => {
    const el = cardsRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      el!.scrollLeft += e.deltaY;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [forkMode]);

  // Граница просмотра: следим, какой узел — нижний частично видимый.
  // IntersectionObserver на messageEls (root = контейнер ленты). На остановке
  // скролла берём МАКСИМАЛЬНЫЙ видимый индекс -> его nodeId = граница
  // (visibleBoundaryNodeId эфемерен, считается из вьюпорта). debounce гасит
  // дребезг — обновляем факт по затиханию, не на каждый кадр.
  useEffect(() => {
    const root = messagesRef.current;
    if (!root || messages.length === 0) {
      setVisibleBoundaryNodeId(null);
      return;
    }

    const visible = new Set<number>();
    let timer: number | null = null;

    const recompute = () => {
      if (visible.size === 0) return;
      const maxIdx = Math.max(...visible);
      const node = messages[maxIdx];
      if (node) setVisibleBoundaryNodeId(node.nodeId);
    };

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(recompute, 350);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.msgIdx);
          if (Number.isNaN(idx)) continue;
          if (e.isIntersecting) visible.add(idx);
          else visible.delete(idx);
        }
        schedule();
      },
      { root, threshold: 0 },
    );

    for (let i = 0; i < messages.length; i++) {
      const el = messageEls.current[i];
      if (el) observer.observe(el);
    }

    // Первичный расчёт без скролла: низ ленты виден -> граница = последний узел.
    setVisibleBoundaryNodeId(messages[messages.length - 1].nodeId);

    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [messages]);

  // Автоскролл: при любом изменении ленты (ответ, запрос, заглушка, «Думаю»)
  // доезжаем до низа, ЕСЛИ пользователь не отлистал вверх. useLayoutEffect —
  // чтобы прыжок случился до отрисовки и без мигания. composerHeight в deps:
  // когда поле растёт и лента сжимается, низ тоже подтягиваем.
  useLayoutEffect(() => {
    if (!stickToBottom) return;
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading, sendError, composerHeight, stickToBottom]);

  // Признак «прилипания» к низу: пользователь у самого низа -> держим автоскролл;
  // отлистал вверх -> отпускаем, ничего не дёргаем под руками.
  function handleMessagesScroll() {
    const el = messagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom < 40);
  }

  // Кнопка-стрелка вниз: доезжаем до низа и снова приклеиваемся.
  function scrollToBottom() {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  }

  // Позиционирование на ветвлении: ставим к низу области сообщений последнюю
  // строку БАЗОВОГО запроса этой ветки — вопроса, который идёт сразу за
  // выбранным A-узлом. Тогда старый вопрос видно прямо над полем с надписью
  // «Альтернативный запрос:». Если следующий узел не Q — берём сам A-узел.
  function scrollBranchBaseIntoView(assistantNodeId: string) {
    const arr = messagesDataRef.current;
    const idx = arr.findIndex(m => m.nodeId === assistantNodeId);
    if (idx < 0) return;
    let targetIdx = idx;
    if (idx + 1 < arr.length && arr[idx + 1].role === "user") targetIdx = idx + 1;
    const el = messageEls.current[targetIdx];
    el?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  // Тянем верхнюю границу поля ввода: вверх — выше, вниз — ниже. Границы
  // 60px..60% высоты окна, чтобы лента не схлопнулась.
  function startComposerResize(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = composerHeight;
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY; // тянем вверх -> dy>0 -> поле выше
      const h = Math.min(window.innerHeight * 0.6, Math.max(60, startH + dy));
      setComposerHeight(h);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Зеркало messages для стабильных колбэков (onFocus не держит messages в deps).
  messagesDataRef.current = messages;

  // Намерение фокуса от плагина (D-072): доскроллить к узлу в центральном потоке.
  // Плагин в DOM не лезет — просит, App исполняет через messageEls.
  const onFocus = useCallback((nodeId: string) => {
    const arr = messagesDataRef.current;
    const i = arr.findIndex((m) => m.nodeId === nodeId);
    if (i < 0) return;
    const el = messageEls.current[i];
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // Зависимости капабилити для виджетов. Пересобираются только при смене диалога.
  const capabilityDeps = useMemo<CapabilityDeps>(
    () => ({
      onFocus,
      getActiveDialogId: () => dialogId,
      // Ядровая операция плагина изменила дерево (attach сжатия сдвинул курсор
      // на заглушку под S) — перечитываем активную ветку.
      onTreeChanged: () => { if (dialogId) loadBranch(dialogId); },
      // Плагин просит показать справку в центре — кладём в состояние, рендерим
      // оверлей поверх диалога с кнопкой «Закрыть».
      onOpenHelp: (doc) => setHelpDoc(doc),
    }),
    [onFocus, dialogId],
  );

  // ---------------------------------------------------------------------------
  // Диалог
  // ---------------------------------------------------------------------------

  // Перечитать дерево блокнотов и список бесед (структурные изменения).
  const reloadTree = useCallback(async () => {
    const [nbs, dls] = await Promise.all([
      invoke<Notebook[]>("cmd_list_notebooks"),
      invoke<DbDialog[]>("cmd_list_dialogs"),
    ]);
    setNotebooks(nbs);
    setDialogs(dls);
  }, []);

  // Точечно обновить имя беседы в общем списке — мгновенно и без перестроения
  // дерева (раскрытые ветки остаются раскрытыми). Используют и шапка, и панель.
  const patchDialogTitle = useCallback((id: string, title: string) => {
    setDialogs((prev) => prev.map((d) => (d.id === id ? { ...d, title } : d)));
  }, []);

  async function initDialog() {
    // Беседы живут в блокнотах и создаются из левой панели. На старте грузим
    // дерево и открываем самую свежую беседу вне корзины (если есть); иначе
    // ждём выбора в панели «Блокноты» — ничего не автосоздаём.
    const [nbs, dls] = await Promise.all([
      invoke<Notebook[]>("cmd_list_notebooks"),
      invoke<DbDialog[]>("cmd_list_dialogs"),
    ]);
    setNotebooks(nbs);
    setDialogs(dls);
    const d = dls.find((x) => x.notebook_id !== "trash") ?? null;
    if (d) {
      setDialogId(d.id);
      await loadBranch(d.id);
    }
  }

  // Сохранить имя беседы из шапки. Пустое или неизменное — игнор.
  async function commitTitle() {
    const title = titleDraft.trim();
    setEditingTitle(false);
    if (!dialogId || !title) return;
    const cur = dialogs.find((d) => d.id === dialogId)?.title ?? "";
    if (title === cur) return;
    try {
      await invoke("cmd_update_dialog_title", { dialogId, title });
      patchDialogTitle(dialogId, title);
    } catch (e) {
      console.error("update_dialog_title failed:", e);
    }
  }

  // Открыть беседу из панели блокнотов (или очистить центр при null).
  // Выходим из служебных режимов, чтобы не показать чужую развилку/ветки.
  async function openDialog(id: string | null) {
    setForkMode(false);
    setForkNodeId(null);
    setForkCards([]);
    setDeletedMode(false);
    setBranchingFromId(null);
    setSendError(null);
    setDialogId(id);
    if (id) {
      await loadBranch(id);
    } else {
      setMessages([]);
      setLastNodeId(null);
    }
  }

  async function loadBranch(dId: string) {
    const branch = await invoke<DbNode[]>("cmd_get_branch", { dialogId: dId });

    // Узлы для ПОКАЗА: реплики + холостые заглушки (рисуем серой плашкой).
    // Прочие служебные типы (system, context_migration, compression_*) в ленту
    // не идут. Заглушка показывается, но как "ответ не получен".
    const visible = branch.filter(
      n =>
        n.node_type === "user_message" ||
        n.node_type === "assistant_message" ||
        n.node_type === "unanswered_placeholder" ||
        n.node_type === "compressed_summary" ||
        n.node_type === "compression_placeholder"
    );

    const restored: Message[] = await Promise.all(
      visible.map(async (n) => {
        let deletedCount = 0;
        let markers: MarkerData[] = [];
        // Удалённые ветки и маркеры считаем только под реальными ответами
        // (маркер только на A-узле, D-058; под заглушкой веток нет — она лист).
        if (n.node_type === "assistant_message") {
          const deleted = await invoke<DbNode[]>("cmd_get_deleted_children", { nodeId: n.id });
          deletedCount = deleted.length;

          const rawMarkers = await invoke<any[]>("cmd_get_markers_for_node", { nodeId: n.id });
          markers = rawMarkers.map(m => ({
            id: m.id,
            nodeId: m.node_id,
            label: m.label,
            comment: m.comment,
          }));
        }
        return {
          role: n.node_type === "user_message" ? "user" : "assistant" as "user" | "assistant",
          content: n.content,
          nodeId: n.id,
          nodeType: n.node_type,
          childrenCount: n.children_count,
          deletedChildrenCount: deletedCount,
          markers,
        };
		
      })
    );

    setMessages(restored);

    // Обрезаем хвост рефов от прошлой (возможно более длинной) ветки, чтобы
    // observer не цеплял протухшие узлы. messageEls пишется по индексу i и сам
    // не сбрасывается.
    messageEls.current.length = restored.length;

    // Рабочий курсор = лист активной ветки. Для ПУСТОЙ беседы — null (а не
    // протухший узел прошлой беседы): иначе первый запрос новой беседы прицепится
    // как parent к узлу старой, и get_branch уйдёт по родителям в чужое дерево.
    setLastNodeId(branch.length > 0 ? branch[branch.length - 1].id : null);
  }

  // ---------------------------------------------------------------------------
  // Режим развилки
  // ---------------------------------------------------------------------------

  async function openForkMode(aNodeId: string) {
    // Закрываем режим восстановления если был открыт
    setDeletedMode(false);
    setDeletedForkNodeId(null);
    setDeletedForkCards([]);

    const children = await invoke<DbNode[]>("cmd_get_children", { nodeId: aNodeId });
    const aNode = await invoke<DbNode | null>("cmd_get_node", { nodeId: aNodeId });

    const cards: BranchCard[] = children.map(c => ({
      nodeId: c.id,
      branchName: c.branch_name ?? c.content.slice(0, 80),
      isActive: aNode?.active_child_id === c.id,
    }));

    const activeIdx = cards.findIndex(c => c.isActive);
    setForkCards(cards);
    setForkActiveIdx(activeIdx >= 0 ? activeIdx : 0);
    setForkNodeId(aNodeId);
    setForkMode(true);
  }

  async function closeForkMode() {
    if (clickTimer.current !== null) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    setForkMode(false);
    setForkNodeId(null);
    setForkCards([]);
    setEditingNodeId(null);
    setEditingText("");
    setMenuNodeId(null);
  }

  // ---------------------------------------------------------------------------
  // Режим восстановления удалённых веток (D-050)
  // ---------------------------------------------------------------------------

  async function openDeletedMode(aNodeId: string) {
    // Закрываем режим развилки если был открыт
    await closeForkMode();

    const deleted = await invoke<DbNode[]>("cmd_get_deleted_children", { nodeId: aNodeId });
    const cards: BranchCard[] = deleted.map(c => ({
      nodeId: c.id,
      branchName: c.branch_name ?? c.content.slice(0, 80),
      isActive: false,
    }));

    setDeletedForkCards(cards);
    setDeletedForkNodeId(aNodeId);
    setDeletedMode(true);
  }

  function closeDeletedMode() {
    setDeletedMode(false);
    setDeletedForkNodeId(null);
    setDeletedForkCards([]);
  }

  async function restoreBranch(nodeId: string) {
    if (!dialogId) return;
    try {
      await invoke("cmd_restore_branch", { nodeId });
    } catch (e) {
      console.error("restore_branch failed:", e);
      return;
    }
    closeDeletedMode();
    await loadBranch(dialogId);
  }

  // ---------------------------------------------------------------------------
  // Удаление ветки из меню карточки (D-048, D-049)
  // ---------------------------------------------------------------------------

  async function deleteCardBranch(childId: string) {
    if (!dialogId || !forkNodeId) return;
    setMenuNodeId(null);
    try {
      await invoke("cmd_delete_branch", { dialogId, forkNodeId, childId });
    } catch (e) {
      // Сюда попадаем если пытаемся удалить последнюю видимую ветку —
      // backend вернёт "cannot delete last visible branch"
      console.error("delete_branch failed:", e);
      return;
    }
    // Перезагружаем fork mode и ветку
    await openForkMode(forkNodeId);
    await loadBranch(dialogId);
  }

  // ---------------------------------------------------------------------------
  // Выбор карточки
  // ---------------------------------------------------------------------------

  async function selectForkCard(idx: number) {
    if (!dialogId || !forkNodeId) return;
    const card = forkCards[idx];
    if (!card) return;
    // card.nodeId — первый узел выбранной ветки (дочерний Q развилки).
    const childId = card.nodeId;

    try {
      await invoke("cmd_select_branch", {
        dialogId,
        forkNodeId,
        childId,
      });
    } catch (e) {
      console.error("select_branch failed:", e);
    }

    await closeForkMode();
    await loadBranch(dialogId);

    // Проваливаемся только на ПЕРВОЕ сообщение ветки (не в самый низ) — ставим
    // его к верху окна. Дальше вниз — кнопками/стрелкой справа внизу.
    setStickToBottom(false);
    setTimeout(() => {
      const i = messagesDataRef.current.findIndex(m => m.nodeId === childId);
      const el = messageEls.current[i];
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Редактирование имени карточки
  // ---------------------------------------------------------------------------

  function startEditing(nodeId: string) {
    const card = forkCards.find(c => c.nodeId === nodeId);
    if (!card) return;
    setMenuNodeId(null);
    setEditingNodeId(nodeId);
    setEditingText(card.branchName);
  }

  function cancelEditing() {
    setEditingNodeId(null);
    setEditingText("");
  }

  async function saveEditing() {
    if (!editingNodeId) return;
    const name = editingText.trim();
    if (!name) { cancelEditing(); return; }

    try {
      await invoke("cmd_set_branch_name", { nodeId: editingNodeId, name });
      setForkCards(cards =>
        cards.map(c => (c.nodeId === editingNodeId ? { ...c, branchName: name } : c))
      );
    } catch (e) {
      console.error("set_branch_name failed:", e);
    }
    cancelEditing();
  }

  function handleCardClick(idx: number) {
    if (clickTimer.current !== null) {
      clearTimeout(clickTimer.current);
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      selectForkCard(idx);
    }, 220);
  }

  function handleCardDoubleClick(nodeId: string) {
    if (clickTimer.current !== null) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    startEditing(nodeId);
  }

  // ---------------------------------------------------------------------------
  // Навигация
  // ---------------------------------------------------------------------------

  // Навигация Ctrl+↑ / Ctrl+↓ — прыжки по «точкам остановки»: это узлы с
  // маркером ИЛИ развилки (>1 видимой ветки, D-049). Узел встаёт нижней
  // строкой к низу области сообщений. Развилка дополнительно раскрывает
  // плашки альтернатив внизу.

  interface NavStop {
    nodeId: string;
    type: "marker" | "fork";
    targetScrollTop: number;
  }

  // Собираем все точки остановки в координатах контента ленты (с поправкой на
  // текущий scrollTop), плюс целевой scrollTop, чтобы низ узла лёг к низу окна.
  function collectNavStops(): NavStop[] {
    const container = messagesRef.current;
    if (!container) return [];
    const containerTop = container.getBoundingClientRect().top;
    const clientH = container.clientHeight;
    const scrollTop = container.scrollTop;
    const stops: NavStop[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const visibleCount = m.childrenCount - m.deletedChildrenCount;
      const isFork = m.role === "assistant" && visibleCount > 1;
      const isMarker = m.markers.length > 0;
      if (!isFork && !isMarker) continue;
      const el = messageEls.current[i];
      if (!el) continue;
      const relTop = el.getBoundingClientRect().top - containerTop;
      const contentBottom = relTop + scrollTop + el.offsetHeight;
      const targetScrollTop = Math.max(0, contentBottom - clientH);
      // Развилка приоритетнее маркера, если узел и то и другое.
      stops.push({ nodeId: m.nodeId, type: isFork ? "fork" : "marker", targetScrollTop });
    }
    return stops;
  }

  // Доводим низ узла к низу окна по текущей геометрии (после смены раскладки —
  // открытия/закрытия плашек — клиентская высота меняется, считаем заново).
  function scrollNodeBottomToView(nodeId: string) {
    const container = messagesRef.current;
    if (!container) return;
    const i = messagesDataRef.current.findIndex(m => m.nodeId === nodeId);
    if (i < 0) return;
    const el = messageEls.current[i];
    if (!el) return;
    const containerTop = container.getBoundingClientRect().top;
    const contentBottom =
      el.getBoundingClientRect().top - containerTop + container.scrollTop + el.offsetHeight;
    const target = Math.max(0, contentBottom - container.clientHeight);
    container.scrollTo({ top: target, behavior: "smooth" });
  }

  function applyNavStop(stop: NavStop) {
    setStickToBottom(false);
    if (stop.type === "fork") {
      openForkMode(stop.nodeId);
    } else if (forkMode) {
      closeForkMode();
    }
    // Раскладка низа меняется при открытии/закрытии плашек — скроллим после
    // коммита, по обновлённой высоте окна.
    setTimeout(() => scrollNodeBottomToView(stop.nodeId), 0);
  }

  function navigateUp() {
    const container = messagesRef.current;
    if (!container) return;
    const cur = container.scrollTop;
    const above = collectNavStops().filter(s => s.targetScrollTop < cur - 2);
    if (above.length === 0) {
      // Выше точек нет — просто к самому верху.
      if (forkMode) closeForkMode();
      setStickToBottom(false);
      container.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const next = above.reduce((a, b) => (b.targetScrollTop > a.targetScrollTop ? b : a));
    applyNavStop(next);
  }

  function navigateDown() {
    const container = messagesRef.current;
    if (!container) return;
    const cur = container.scrollTop;
    const below = collectNavStops().filter(s => s.targetScrollTop > cur + 2);
    if (below.length === 0) {
      // Ниже точек нет — к самому низу, снова приклеиваемся.
      if (forkMode) closeForkMode();
      setStickToBottom(true);
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      return;
    }
    const next = below.reduce((a, b) => (b.targetScrollTop < a.targetScrollTop ? b : a));
    applyNavStop(next);
  }

  // ---------------------------------------------------------------------------
  // Отправка сообщений
  // ---------------------------------------------------------------------------

  async function sendMessage() {
    if (!input.trim() || loading || !dialogId) return;
    const userText = input.trim();
    setInput("");
    setLoading(true);
    await doSend(dialogId, lastNodeId, userText);
    setLoading(false);
  }

  // Единая отправка из нижнего поля: в режиме ветвления уходит альтернативный
  // запрос, иначе обычный.
  function submitComposer() {
    if (branchingFromId) sendBranch();
    else sendMessage();
  }

  // Войти в режим альтернативного запроса для A-узла: общее нижнее поле
  // получает префикс «Альтернативный запрос:» и фокус. Повторный «+» — отмена.
  function toggleBranching(nodeId: string) {
    setBranchingFromId(prev => {
      const next = prev === nodeId ? null : nodeId;
      if (next) {
        // Отпускаем автоскролл (базовый вопрос не у самого низа ленты) и
        // подводим его к низу области сообщений.
        setStickToBottom(false);
        setTimeout(() => {
          scrollBranchBaseIntoView(nodeId);
          composerRef.current?.focus();
        }, 0);
      }
      return next;
    });
    setInput("");
  }

  function cancelBranching() {
    setBranchingFromId(null);
    setInput("");
  }

// ---------------------------------------------------------------------------
  // Маркеры (D-058)
  // ---------------------------------------------------------------------------

  // Следующий номер #N: max существующих по диалогу + 1.
  // Дырки от удаления НЕ переиспользуются — номера монотонно растут.
  function nextMarkerLabel(): string {
    let maxN = 0;
    for (const m of messages) {
      for (const mk of m.markers) {
        const match = mk.label.match(/^#(\d+)$/);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > maxN) maxN = n;
        }
      }
    }
    return `#${maxN + 1}`;
  }

  async function createMarker(nodeId: string) {
    if (!dialogId) return;
    const label = nextMarkerLabel();
    const comment = markerComment.trim() || null;
    try {
      await invoke("cmd_create_marker", { nodeId, label, comment });
    } catch (e) {
      console.error("create_marker failed:", e);
      return;
    }
    setMarkingNodeId(null);
    setMarkerComment("");
    await loadBranch(dialogId);
  }

  async function deleteMarker(markerId: string) {
    if (!dialogId) return;
    try {
      await invoke("cmd_delete_marker", { markerId });
    } catch (e) {
      // D-067: бэкенд не даст удалить, если на узел ссылается сжатие.
      console.error("delete_marker failed:", e);
      return;
    }
    await loadBranch(dialogId);
  }
  
  function startEditingMarker(markerId: string, currentComment: string | null) {
    setEditingMarkerId(markerId);
    setEditingMarkerText(currentComment ?? "");
  }

  function cancelEditingMarker() {
    setEditingMarkerId(null);
    setEditingMarkerText("");
  }

  async function saveMarkerComment(markerId: string, label: string) {
    if (!dialogId) return;
    const comment = editingMarkerText.trim() || null;
    try {
      // cmd_update_marker обновляет и label, и comment — label передаём
      // неизменным (#N не меняется, D: имя не правим).
      await invoke("cmd_update_marker", { markerId, label, comment });
    } catch (e) {
      console.error("update_marker failed:", e);
      return;
    }
    cancelEditingMarker();
    await loadBranch(dialogId);
  }

  async function sendBranch() {
    if (!input.trim() || loading || !dialogId || !branchingFromId) return;
    const userText = input.trim();
    const parentId = branchingFromId;
    setInput("");
    setBranchingFromId(null);
    setLoading(true);

    // Ветка идёт через тот же устойчивый поток: Q + заглушка создаются разом,
    // ответ перезаписывает заглушку. parentId — точка ветвления (A-узел).
    try {
      const sent = await invoke<SendResult>("cmd_send_user_message", {
        dialogId,
        parentId,
        content: userText,
      });

      // Показываем новое состояние сразу (Q + плашка), как при обычной отправке.
      await loadBranch(dialogId);

      const branch = await invoke<DbNode[]>("cmd_get_branch", { dialogId });
      const llmMessages = buildLlmMessages(branch);
      const provider = getActiveLlmProvider();
      if (!provider?.isReady()) {
        throw new Error(t("app.error.llmNotConfigured"));
      }
      const response = await provider.generateResponse(llmMessages, "main_dialog");

      await invoke<DbNode>("cmd_resolve_answer", {
        placeholderId: sent.placeholder_id,
        content: response.content,
        modelId: response.modelId,
        modelRole: "main_dialog",
        tokensCount: response.tokensInput + response.tokensOutput,
      });
      setSendError(null);
      await loadBranch(dialogId);
    } catch (e) {
      // Ответ не получен — заглушка остаётся в дереве, в ленте покажется
      // серой плашкой "ответ не получен". Просто перечитываем ветку.
      console.error("sendBranch failed:", e);
      setSendError(e instanceof Error ? e.message : String(e));
      await loadBranch(dialogId);
    } finally {
      setLoading(false);
    }
  }

  async function doSend(dId: string, parentId: string | null, userText: string) {
    // Устойчивый поток (D-0xx): Q + unanswered_placeholder создаются атомарно
    // ДО обращения к LLM. Если приложение упадёт / ответ не придёт — структура
    // уже регулярна, холостой Q закрыт заглушкой.
    let sent: SendResult;
    try {
      sent = await invoke<SendResult>("cmd_send_user_message", {
        dialogId: dId,
        parentId,
        content: userText,
      });
    } catch (e) {
      console.error("send_user_message failed:", e);
      return;
    }

    // Показываем Q + плашку сразу.
    await loadBranch(dId);

    try {
      const branch = await invoke<DbNode[]>("cmd_get_branch", { dialogId: dId });
      const llmMessages = buildLlmMessages(branch);
      const provider = getActiveLlmProvider();
      if (!provider?.isReady()) {
        throw new Error(t("app.error.llmNotConfigured"));
      }
      const response = await provider.generateResponse(llmMessages, "main_dialog");

      await invoke<DbNode>("cmd_resolve_answer", {
        placeholderId: sent.placeholder_id,
        content: response.content,
        modelId: response.modelId,
        modelRole: "main_dialog",
        tokensCount: response.tokensInput + response.tokensOutput,
      });

      setSendError(null);
      await loadBranch(dId);
    } catch (e) {
      // LLM не ответил: заглушка остаётся unanswered_placeholder.
      // В ленте — серая плашка "ответ не получен". Ничего не перезаписываем.
      console.error("resolve_answer/send_message failed:", e);
      setSendError(e instanceof Error ? e.message : String(e));
      await loadBranch(dId);
    }
  }

  // ---------------------------------------------------------------------------
  // Рендер
  // ---------------------------------------------------------------------------

  const isBlocked = forkMode || deletedMode;

  // Факты для виджет-панели (D-072). activeBranch — проекция messages в NodeView;
  // parentId восстановлен из порядка (ветка линейна: родитель i-го = i-1-й).
  const activeBranch: NodeView[] = messages.map((m, i) => ({
    id: m.nodeId,
    parentId: i > 0 ? messages[i - 1].nodeId : null,
    nodeType: m.nodeType as NodeView["nodeType"],
    text: m.content,
    // Метки едут как факт: плагины (сжатие) строят списки прямо из ветки и
    // обновляются реактивно при постановке/снятии маркера — без ручного refresh.
    markers: m.markers.map(mk => ({ id: mk.id, label: mk.label, comment: mk.comment })),
  }));

const facts: WidgetFacts = {
    activeDialogId: dialogId,
    cursorNodeId: lastNodeId,
    visibleBoundaryNodeId,
    activeBranch,
    model: modelFacts,
    activeLlmProviderId,
  };

  return (
    <div className="app-root">
    <MenuBar />
    <div className="app-shell">
    <NotebooksPanel
      notebooks={notebooks}
      dialogs={dialogs}
      activeDialogId={dialogId}
      onOpenDialog={openDialog}
      reloadTree={reloadTree}
      patchDialogTitle={patchDialogTitle}
    />
    <main className="container">
      {helpDoc && (
        <div className="help-doc" role="dialog" aria-label={helpDoc.title}>
          <div className="help-doc-head">
            <h2 className="help-doc-title">{helpDoc.title}</h2>
            <button
              className="help-doc-close"
              onClick={() => setHelpDoc(null)}
              title={t("app.help.closeTitle")}
            >
              ✕ {t("common.close")}
            </button>
          </div>
          <div className="help-doc-body">
            {helpDoc.paragraphs.map((p, i) => (
              <p key={i} className="help-doc-para">{p}</p>
            ))}
            {helpDoc.link && (
              <button
                className="help-doc-link"
                onClick={() => {
                  void openUrl(helpDoc.link!.href).catch((e) =>
                    console.error("openUrl failed:", e),
                  );
                }}
              >
                ↗ {helpDoc.link.label}
              </button>
            )}
          </div>
        </div>
      )}
      {dialogId ? (
        editingTitle ? (
          <input
            className="dialog-title-edit"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
              else if (e.key === "Escape") { e.preventDefault(); setEditingTitle(false); }
            }}
            onBlur={commitTitle}
          />
        ) : (
          <h1
            className="dialog-title"
            title={t("app.dialogTitle.editHint")}
            onDoubleClick={() => {
              setTitleDraft(dialogs.find((d) => d.id === dialogId)?.title ?? "");
              setEditingTitle(true);
            }}
          >
            {dialogs.find((d) => d.id === dialogId)?.title || t("common.untitled")}
          </h1>
        )
      ) : (
        <h1 className="dialog-title dialog-title--empty">{t("app.noDialog")}</h1>
      )}

      {/* Режим восстановления удалённых веток (D-050) */}
      {deletedMode && (
        <div className="deleted-overlay">
          <div className="fork-header">
            <span className="deleted-title">{t("app.deleted.title")}</span>
            <button className="fork-close-btn" onClick={closeDeletedMode}>✕</button>
          </div>
          <div className="fork-cards">
            {deletedForkCards.map(card => (
              <div key={card.nodeId} className="deleted-card">
                <span className="deleted-card-name">{card.branchName}</span>
                <button
                  className="restore-btn"
                  onClick={() => restoreBranch(card.nodeId)}
                >
                  {t("app.deleted.restore")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Сообщения */}
      <div className="messages-wrap">
      <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        {messages.map((m, i) => {
          const visibleCount = m.childrenCount - m.deletedChildrenCount;

          // Холостая заглушка: ответ не пришёл — серая некликабельная плашка.
          if (m.nodeType === "unanswered_placeholder") {
            return (
              <div
                key={i}
                className="message assistant message--unanswered"
                ref={el => { messageEls.current[i] = el; }}
                data-msg-idx={i}
              >
                <div className="message-content message-content--unanswered">
                  <p className="unanswered-note">{t("app.unanswered")}</p>
                  {i === messages.length - 1 && sendError && (
                    <p className="unanswered-error">{sendError}</p>
                  )}
                </div>
              </div>
            );
          }

          // Узел-резюме сжатия (S): нейтральная плашка по центру (НЕ пузырь
          // ассистента) — S сидит в Q-слоте, это третий вид узла, не A и не Q.
          if (m.nodeType === "compressed_summary") {
            return (
              <div
                key={i}
                className="message message--compressed"
                ref={el => { messageEls.current[i] = el; }}
                data-msg-idx={i}
              >
                <div className="message-content message-content--compressed">
                  <div className="compressed-badge">⊟ {t("app.compressed.badge")}</div>
                  <p>{m.content}</p>
                </div>
              </div>
            );
          }

          // Заглушка под S — служебный узел A-слота (D-061). В ленте не показываем,
          // но держим элемент с ref, чтобы индексация observer'а не сбилась.
          if (m.nodeType === "compression_placeholder") {
            return (
              <div
                key={i}
                className="message message--compression-placeholder"
                ref={el => { messageEls.current[i] = el; }}
                data-msg-idx={i}
              />
            );
          }

          return (
            <div
              key={i}
              className={`message ${m.role}`}
              ref={el => { messageEls.current[i] = el; }}
              data-msg-idx={i}
            >
              <div className="message-content">
                <p>{m.content}</p>
              </div>

              {m.role === "assistant" && (
                <div className="message-actions">
                  {visibleCount > 1 && (
                    <button
                      className="fork-btn"
                      title={t("app.fork.title", { count: visibleCount })}
                      onClick={() => openForkMode(m.nodeId)}
                    >
                      ⑂
                    </button>
                  )}

                  {m.deletedChildrenCount > 0 && (
                    <button
                      className="fork-btn--deleted"
                      title={t("app.deleted.countTitle", { count: m.deletedChildrenCount })}
                      onClick={() => openDeletedMode(m.nodeId)}
                    >
                      ⑂{m.deletedChildrenCount > 1 ? ` ×${m.deletedChildrenCount}` : ""}
                    </button>
                  )}

                  {m.childrenCount > 0 && (
                    <button
                      className={`branch-btn ${branchingFromId === m.nodeId ? "branch-btn--active" : ""}`}
                      title={t("app.branch.create")}
                      onClick={() => toggleBranching(m.nodeId)}
                    >
                      +
                    </button>
                  )}

                  {m.markers.length === 0 ? (
                    <button
                      className="marker-btn"
                      title={t("app.marker.set")}
                      onClick={() => {
                        setMarkingNodeId(markingNodeId === m.nodeId ? null : m.nodeId);
                        setMarkerComment("");
                      }}
                    >
                      ⚑
                    </button>
                  ) : (
                    <>
                      <button
                        className="marker-btn marker-btn--active"
                        title={t("app.marker.remove", { label: m.markers[0].label })}
                        onClick={() => deleteMarker(m.markers[0].id)}
                      >
                        ⚑ {m.markers[0].label}
                      </button>

                      {editingMarkerId === m.markers[0].id ? (
                        <textarea
                          className="marker-comment-edit"
                          autoFocus
                          value={editingMarkerText}
                          onChange={e => setEditingMarkerText(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              saveMarkerComment(m.markers[0].id, m.markers[0].label);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelEditingMarker();
                            }
                          }}
                          rows={1}
                        />
                      ) : (
                        m.markers[0].comment && (
                          <span
                            className="marker-comment"
                            title={t("app.marker.editHint")}
                            onDoubleClick={() =>
                              startEditingMarker(m.markers[0].id, m.markers[0].comment)
                            }
                          >
                            {m.markers[0].comment}
                          </span>
                        )
                      )}
                    </>
                  )}
                </div>
              )}

              {markingNodeId === m.nodeId && m.markers.length === 0 && (
                <div className="marker-input-row">
                  <span className="marker-label-preview">{nextMarkerLabel()}</span>
                  <input
                    autoFocus
                    value={markerComment}
                    onChange={e => setMarkerComment(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); createMarker(m.nodeId); }
                      else if (e.key === "Escape") { e.preventDefault(); setMarkingNodeId(null); }
                    }}
                    placeholder={t("app.marker.commentPlaceholder")}
                  />
                  <button onClick={() => createMarker(m.nodeId)}>✓</button>
                  <button onClick={() => setMarkingNodeId(null)}>✕</button>
                </div>
              )}

            </div>
          );
        })}
        {loading && <p className="loading">{t("app.thinking")}</p>}
      </div>

        {/* Стрелка вниз: активна, когда пользователь отлистал вверх. */}
        <button
          className={`scroll-bottom-btn ${stickToBottom ? "" : "is-visible"}`}
          onClick={scrollToBottom}
          title={t("app.scrollBottom")}
          aria-label={t("app.scrollBottom")}
        >
          ↓
        </button>
      </div>

      {/* Ошибка последней отправки в LLM (если была) */}
      {sendError && !loading && (
        <div className="send-error" role="alert">
          <span className="send-error-text">⚠ {sendError}</span>
          <button className="send-error-close" onClick={() => setSendError(null)} title={t("common.hide")}>×</button>
        </div>
      )}

      {/* Режим развилки: плашки альтернатив внизу окна диалога. */}
      {forkMode && (
        <div className="fork-overlay">
          <div className="fork-header">
            <span className="fork-title">{t("app.fork.choose")}</span>
            <button className="fork-close-btn" onClick={closeForkMode}>✕</button>
          </div>
          <div className="fork-cards" ref={cardsRef}>
            {forkCards.map((card, idx) => (
              <div
                key={card.nodeId}
                className={`fork-card ${idx === forkActiveIdx ? "fork-card--active" : ""} ${card.isActive ? "fork-card--current" : ""}`}
                onMouseEnter={() => setForkActiveIdx(idx)}
                onClick={() => { if (editingNodeId !== card.nodeId) handleCardClick(idx); }}
                onDoubleClick={() => handleCardDoubleClick(card.nodeId)}
              >
                {editingNodeId === card.nodeId ? (
                  <input
                    className="fork-card-edit"
                    autoFocus
                    value={editingText}
                    onChange={e => setEditingText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); saveEditing(); }
                      else if (e.key === "Escape") { e.preventDefault(); cancelEditing(); }
                    }}
                    onBlur={saveEditing}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="fork-card-name">{card.branchName}</span>
                    {card.isActive && <span className="fork-card-badge">{t("app.fork.current")}</span>}

                    <button
                      className="fork-card-menu-btn"
                      title={t("app.fork.menu")}
                      onClick={e => {
                        e.stopPropagation();
                        setMenuNodeId(menuNodeId === card.nodeId ? null : card.nodeId);
                      }}
                    >
                      ⋮
                    </button>

                    {menuNodeId === card.nodeId && (
                      <div className="fork-card-menu" onClick={e => e.stopPropagation()}>
                        <button onClick={() => startEditing(card.nodeId)}>{t("common.edit")}</button>
                        <button
                          onClick={() => deleteCardBranch(card.nodeId)}
                          style={{ color: "#c0392b" }}
                        >
                          {t("app.fork.deleteBranch")}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="fork-hint">{t("app.fork.hint")}</div>
        </div>
      )}

      {/* Поле ввода: единый composer с тянущейся верхней границей и переносом
          слов. В режиме ветвления — префикс «Альтернативный запрос:».
          В режиме развилки прячем — его место занимают плашки альтернатив. */}
      {!forkMode && (
      <div
        className={`composer ${branchingFromId ? "composer--branch" : ""}`}
        style={{ height: composerHeight }}
      >
        <div
          className="composer-resizer"
          onMouseDown={startComposerResize}
          title={t("app.composer.resizeHint")}
        />
        <div className="composer-main">
          <div className="composer-field">
            {branchingFromId && (
              <span className="composer-prefix">{t("app.composer.altPrefix")}</span>
            )}
            <textarea
              ref={composerRef}
              className="composer-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitComposer();
                } else if (e.key === "Escape" && branchingFromId) {
                  e.preventDefault();
                  cancelBranching();
                }
              }}
              placeholder={
                branchingFromId
                  ? t("app.composer.altPlaceholder")
                  : t("app.composer.placeholder")
              }
              disabled={loading || !dialogId || isBlocked}
            />
          </div>
          <div className="composer-buttons">
            {branchingFromId && (
              <button
                className="composer-cancel"
                onClick={cancelBranching}
                title={t("app.composer.cancelAlt")}
              >
                ✕
              </button>
            )}
            <button
              className="composer-send"
              onClick={submitComposer}
              disabled={loading || !dialogId || isBlocked}
            >
              {branchingFromId ? "→" : t("app.composer.send")}
            </button>
          </div>
        </div>
      </div>
      )}
    </main>
    <WidgetPanel facts={facts} capabilityDeps={capabilityDeps} />
    </div>
    </div>
  );
}

export default App;