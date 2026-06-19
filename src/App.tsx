import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { WidgetPanel } from "./widgets/host/WidgetPanel";
import type { WidgetFacts, NodeView } from "./widgets/host/types";
import type { CapabilityDeps } from "./widgets/host/capabilities";

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

interface DepthIndicators {
  depth_left: number;
  branches_right: number;
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
    if (n.node_type === "user_message") {
      out.push({ role: "user", content: n.content });
    } else if (n.node_type === "assistant_message") {
      out.push({ role: "assistant", content: n.content });
    }
    // прочие служебные типы — в LLM не идут
  });

  return out;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [dialogId, setDialogId] = useState<string | null>(null);
  const [lastNodeId, setLastNodeId] = useState<string | null>(null);
  // Граница ПРОСМОТРА (нижний частично видимый узел). Эфемерна: не в БД,
  // отдельна от рабочего курсора lastNodeId (скролл не двигает рабочую позицию).
  // Дефолт — последний узел (низ ленты при свежей загрузке).
  const [visibleBoundaryNodeId, setVisibleBoundaryNodeId] = useState<string | null>(null);
  const [depth, setDepth] = useState<DepthIndicators>({ depth_left: 0, branches_right: 0 });

  // Ветвление
  const [branchingFromId, setBranchingFromId] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState("");
  
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
  const [deletedForkNodeId, setDeletedForkNodeId] = useState<string | null>(null);
  const [deletedForkCards, setDeletedForkCards] = useState<BranchCard[]>([]);

  const messagesRef = useRef<HTMLDivElement>(null);
  const messageEls = useRef<(HTMLDivElement | null)[]>([]);
  const messagesDataRef = useRef<Message[]>([]); // зеркало messages для onFocus (стабильный колбэк)

  // Редактирование имени карточки
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  const clickTimer = useRef<number | null>(null);

  // API key
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState("");

  const MODEL = "anthropic/claude-haiku-4-5";
  // Окно модели для светофора. ВРЕМЕННО 2000 для проверки на коротком диалоге;
  // реальное окно claude-haiku-4-5 = 200000. Со слоем ролей (v0.2) — из реестра
  // моделей. ВАЖНО: это число ПЕРЕБИВАЕТ WINDOW_FALLBACK внутри context-meter.
  const MODEL_WINDOW = 200000;

  // ---------------------------------------------------------------------------
  // Инициализация
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function init() {
      const key = await invoke<string | null>("cmd_get_api_key", { providerId: "openrouter" });
      if (!key) { setHasApiKey(false); return; }
      setHasApiKey(true);
      await initDialog();
    }
    init().catch(console.error);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editingNodeId) return;

      if (e.key === "F2" && forkMode) {
        e.preventDefault();
        const card = forkCards[forkActiveIdx];
        if (card) startEditing(card.nodeId);
        return;
      }

      if (e.key === "Enter" && forkMode) {
        e.preventDefault();
        selectForkCard(forkActiveIdx);
        return;
      }

      if (!e.ctrlKey) return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        handleCtrlUp();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        handleCtrlDown();
      } else if (e.key === "ArrowLeft" && forkMode) {
        e.preventDefault();
        setForkActiveIdx(i => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight" && forkMode) {
        e.preventDefault();
        setForkActiveIdx(i => Math.min(forkCards.length - 1, i + 1));
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
    }),
    [onFocus, dialogId],
  );

  // ---------------------------------------------------------------------------
  // Диалог
  // ---------------------------------------------------------------------------

  async function initDialog() {
    const dialogs = await invoke<DbDialog[]>("cmd_list_dialogs");
    if (dialogs.length > 0) {
      const d = dialogs[0];
      setDialogId(d.id);
      await loadBranch(d.id);
    } else {
      const d = await invoke<DbDialog>("cmd_create_dialog", { title: "New conversation", notebookId: null });
      setDialogId(d.id);
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
        n.node_type === "unanswered_placeholder"
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

    if (branch.length > 0) {
      setLastNodeId(branch[branch.length - 1].id);
    }

    const indicators = await invoke<DepthIndicators>("cmd_get_depth_indicators", { dialogId: dId });
    setDepth(indicators);
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

    try {
      await invoke("cmd_select_branch", {
        dialogId,
        forkNodeId,
        childId: card.nodeId,
      });
    } catch (e) {
      console.error("select_branch failed:", e);
    }

    await closeForkMode();
    await loadBranch(dialogId);
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

  // Ctrl+Up — ищем развилку с > 1 ВИДИМЫХ веток (D-049: удалённые не в счёт)
  function handleCtrlUp() {
    if (forkMode) return;
    const container = messagesRef.current;
    if (!container) return;

    const containerTop = container.getBoundingClientRect().top;
    const viewportHeight = container.clientHeight;

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const visibleCount = m.childrenCount - m.deletedChildrenCount;
      if (visibleCount <= 1) continue;
      const el = messageEls.current[i];
      if (!el) continue;
      const relTop = el.getBoundingClientRect().top - containerTop;
      if (relTop < viewportHeight) {
        openForkMode(m.nodeId);
        return;
      }
    }

    container.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleCtrlDown() {
    if (forkMode) selectForkCard(forkActiveIdx);
  }

  // ---------------------------------------------------------------------------
  // Отправка сообщений
  // ---------------------------------------------------------------------------

  async function saveApiKey() {
    setKeyError("");
    const trimmed = keyInput.trim();
    if (!trimmed) { setKeyError("Key cannot be empty."); return; }
    try {
      await invoke("cmd_set_api_key", { providerId: "openrouter", apiKey: trimmed });
      setHasApiKey(true);
      setKeyInput("");
      await initDialog();
    } catch (e) {
      setKeyError(`Failed to save key: ${e}`);
    }
  }

  async function sendMessage() {
    if (!input.trim() || loading || !dialogId) return;
    const userText = input.trim();
    setInput("");
    setLoading(true);
    await doSend(dialogId, lastNodeId, userText);
    setLoading(false);
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
    if (!branchInput.trim() || loading || !dialogId || !branchingFromId) return;
    const userText = branchInput.trim();
    const parentId = branchingFromId;
    setBranchInput("");
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
      const response = await invoke<string>("send_message", { messages: llmMessages, modelId: MODEL });

      await invoke<DbNode>("cmd_resolve_answer", {
        placeholderId: sent.placeholder_id,
        content: response,
        modelId: MODEL,
        modelRole: "main_dialog",
        tokensCount: 0,
      });
      await loadBranch(dialogId);
    } catch (e) {
      // Ответ не получен — заглушка остаётся в дереве, в ленте покажется
      // серой плашкой "ответ не получен". Просто перечитываем ветку.
      console.error("sendBranch failed:", e);
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
      const response = await invoke<string>("send_message", { messages: llmMessages, modelId: MODEL });

      await invoke<DbNode>("cmd_resolve_answer", {
        placeholderId: sent.placeholder_id,
        content: response,
        modelId: MODEL,
        modelRole: "main_dialog",
        tokensCount: 0,
      });

      await loadBranch(dId);
    } catch (e) {
      // LLM не ответил: заглушка остаётся unanswered_placeholder.
      // В ленте — серая плашка "ответ не получен". Ничего не перезаписываем.
      console.error("resolve_answer/send_message failed:", e);
      await loadBranch(dId);
    }
  }

  // ---------------------------------------------------------------------------
  // Рендер
  // ---------------------------------------------------------------------------

  if (hasApiKey === null) {
    return <main className="container"><p className="loading">Loading...</p></main>;
  }

  if (hasApiKey === false) {
    return (
      <main className="container">
        <h1>AiZavr</h1>
        <div className="setup">
          <p>Enter your <a href="https://openrouter.ai/keys" target="_blank">OpenRouter API key</a> to get started.</p>
          <div className="input-row">
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveApiKey()}
              placeholder="sk-or-..."
            />
            <button onClick={saveApiKey}>Save</button>
          </div>
          {keyError && <p className="error">{keyError}</p>}
        </div>
      </main>
    );
  }

  const isBlocked = forkMode || deletedMode;

  // Факты для виджет-панели (D-072). activeBranch — проекция messages в NodeView;
  // parentId восстановлен из порядка (ветка линейна: родитель i-го = i-1-й).
  const activeBranch: NodeView[] = messages.map((m, i) => ({
    id: m.nodeId,
    parentId: i > 0 ? messages[i - 1].nodeId : null,
    nodeType: m.nodeType as NodeView["nodeType"],
    text: m.content,
    hasMarker: m.markers.length > 0,
  }));

const facts: WidgetFacts = {
    activeDialogId: dialogId,
    cursorNodeId: lastNodeId,
    visibleBoundaryNodeId,
    activeBranch,
    model: { id: MODEL, contextWindow: MODEL_WINDOW },   // D-081: факт модели вместо голого окна
  };

  return (
    <div className="app-shell">
    <main className="container">
      <h1>AiZavr</h1>

      {/* Индикаторы глубины */}
      <div className="depth-indicators">
        <div className="depth-left">
          {Array.from({ length: depth.depth_left }).map((_, i) => (
            <span key={i} className="depth-bar" />
          ))}
        </div>
        <div className="depth-right">
          {Array.from({ length: depth.branches_right }).map((_, i) => (
            <span key={i} className="depth-bar" />
          ))}
        </div>
      </div>

      {/* Режим развилки */}
      {forkMode && (
        <div className="fork-overlay">
          <div className="fork-header">
            <span className="fork-title">Выбор ветки</span>
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
                    {card.isActive && <span className="fork-card-badge">текущая</span>}

                    <button
                      className="fork-card-menu-btn"
                      title="Меню ветки"
                      onClick={e => {
                        e.stopPropagation();
                        setMenuNodeId(menuNodeId === card.nodeId ? null : card.nodeId);
                      }}
                    >
                      ⋮
                    </button>

                    {menuNodeId === card.nodeId && (
                      <div className="fork-card-menu" onClick={e => e.stopPropagation()}>
                        <button onClick={() => startEditing(card.nodeId)}>Редактировать</button>
                        <button
                          onClick={() => deleteCardBranch(card.nodeId)}
                          style={{ color: "#c0392b" }}
                        >
                          Удалить ветку
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="fork-hint">Ctrl+← → или мышь · Enter / Ctrl+↓ / клик — перейти · F2 / двойной клик — переименовать</div>
        </div>
      )}

      {/* Режим восстановления удалённых веток (D-050) */}
      {deletedMode && (
        <div className="deleted-overlay">
          <div className="fork-header">
            <span className="deleted-title">Удалённые ветки</span>
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
                  Восстановить
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Сообщения */}
      <div className="messages" ref={messagesRef}>
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
                  <p className="unanswered-note">Ответ не получен</p>
                </div>
              </div>
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
                      title={`Развилка (${visibleCount} ветки)`}
                      onClick={() => openForkMode(m.nodeId)}
                    >
                      ⑂
                    </button>
                  )}

                  {m.deletedChildrenCount > 0 && (
                    <button
                      className="fork-btn--deleted"
                      title={`Удалённые ветки: ${m.deletedChildrenCount}`}
                      onClick={() => openDeletedMode(m.nodeId)}
                    >
                      ⑂{m.deletedChildrenCount > 1 ? ` ×${m.deletedChildrenCount}` : ""}
                    </button>
                  )}

                  {m.childrenCount > 0 && (
                    <button
                      className="branch-btn"
                      title="Создать ветку"
                      onClick={() => {
                        setBranchingFromId(branchingFromId === m.nodeId ? null : m.nodeId);
                        setBranchInput("");
                      }}
                    >
                      +
                    </button>
                  )}

                  {m.markers.length === 0 ? (
                    <button
                      className="marker-btn"
                      title="Поставить маркер"
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
                        title={`Снять маркер ${m.markers[0].label}`}
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
                            title="Двойной клик — редактировать"
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
                    placeholder="Комментарий (необязательно)..."
                  />
                  <button onClick={() => createMarker(m.nodeId)}>✓</button>
                  <button onClick={() => setMarkingNodeId(null)}>✕</button>
                </div>
              )}

              {branchingFromId === m.nodeId && (
                <div className="branch-input-row">
                  <input
                    autoFocus
                    value={branchInput}
                    onChange={e => setBranchInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendBranch()}
                    placeholder="Альтернативный вопрос..."
                    disabled={loading}
                  />
                  <button onClick={sendBranch} disabled={loading}>→</button>
                  <button onClick={() => setBranchingFromId(null)}>✕</button>
                </div>
              )}
            </div>
          );
        })}
        {loading && <p className="loading">Думаю...</p>}
      </div>

      {/* Поле ввода */}
      <div className="input-row">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && sendMessage()}
          placeholder="Введите сообщение..."
          disabled={loading || !dialogId || isBlocked}
        />
        <button onClick={sendMessage} disabled={loading || !dialogId || isBlocked}>
          Отправить
        </button>
      </div>
    </main>
    <WidgetPanel facts={facts} capabilityDeps={capabilityDeps} />
    </div>
  );
}

export default App;