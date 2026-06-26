// src/dialog/useDialogController.ts
// Контроллер основного диалога (шаги 2-3 расщепления контроллер<->презентация).
// Держит ДАННЫЕ и ОПЕРАЦИИ диалога: состояние беседы, БД через invoke, вызовы
// LLM, работа с деревом, развилка/маркеры/отправка. В DOM сам НЕ лезет — весь
// скролл/геометрия/рефы вынесены в useDialogScroll за императивный handle;
// оркестрация (выбор ветки, ветвление, навигация) дёргает методы handle.
//
// App.tsx остаётся тонкой оболочкой: получает из контроллера те же имена, что и
// раньше (рефы/скролл-функции ре-экспортируются из handle).

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { WidgetFacts, NodeView, ModelFacts, HelpDoc, PreviewDoc, PreviewHandlers, SettingsDoc } from "../widgets/host/types";
import { parseArtifactExtra, parseMessageAttachments } from "./artifactMedia";
import type { CapabilityDeps } from "../widgets/host/capabilities";
import {
  getActiveLlmProvider,
  getActiveLlmProviderId,
  getRegisteredLlmProviderIds,
  setActiveLlmProvider,
  subscribeLlmProvider,
} from "../widgets/llm/registry";
import { t } from "../i18n";
import type {
  Message,
  MarkerData,
  RootActions,
  DbDialog,
  DbNode,
  Notebook,
  SendResult,
  BranchCard,
  Tag,
} from "./types";
import { buildLlmMessages } from "./buildLlmMessages";
import { dispatchWidgetMsg } from "../widgets/host/widgetDispatch";
import { useDialogScroll, type DialogScrollHandle } from "./useDialogScroll";

// Полная выдача контроллера. DialogView получает её одним пропсом и читает нужное
// — так вся разметка/дизайн живёт в DialogView, а контроллер не приходится
// трогать при изменении внешнего вида диалога.
export type DialogController = ReturnType<typeof useDialogController>;

export function useDialogController() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Последняя ошибка отправки в LLM — показываем причину, а не только серую
  // плашку "ответ не получен". Сбрасывается при следующей удачной отправке.
  const [sendError, setSendError] = useState<string | null>(null);
  const [dialogId, setDialogId] = useState<string | null>(null);
  const [lastNodeId, setLastNodeId] = useState<string | null>(null);

  // Действия корня (D-090): данные A0-анкора для хедера над лентой (⚑#0/+/⑂).
  // null — пока беседа не загружена либо у неё нет анкора (старые данные).
  const [rootActions, setRootActions] = useState<RootActions | null>(null);

  // Дерево блокнотов/бесед — единый источник правды (его читают и шапка, и
  // левая панель). Панель владеет UI-состоянием (раскрытие/меню), но не данными.
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [dialogs, setDialogs] = useState<DbDialog[]>([]);

  // Редактирование заголовка беседы в шапке (двойной клик).
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTags, setEditingTags] = useState(false);
  const [dialogTags, setDialogTags] = useState<Tag[]>([]);
  // Граница ПРОСМОТРА (нижний частично видимый узел). Эфемерна: не в БД,
  // отдельна от рабочего курсора lastNodeId (скролл не двигает рабочую позицию).
  // Считается скролл-слоем (observer) и кладётся сюда через onVisibleBoundaryChange.
  const [visibleBoundaryNodeId, setVisibleBoundaryNodeId] = useState<string | null>(null);

  // Ветвление. Альтернативный запрос вводится в общем нижнем поле (composer),
  // отдельного встроенного инпута больше нет. branchingFromId != null —
  // признак режима «альтернативный запрос» для этого A-узла.
  const [branchingFromId, setBranchingFromId] = useState<string | null>(null);

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

  // Режим восстановления удалённых веток (D-050)
  const [deletedMode, setDeletedMode] = useState(false);
  // Значение не читается (оверлей удалённых не ссылается на A-узел) — держим
  // только сеттер; иначе noUnusedLocals валит сборку (TS6133).
  const [, setDeletedForkNodeId] = useState<string | null>(null);
  const [deletedForkCards, setDeletedForkCards] = useState<BranchCard[]>([]);

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
  // Готовые (зарегистрированные) LLM-провайдеры — только их можно выбрать активными.
  const [readyLlmProviderIds, setReadyLlmProviderIds] = useState<string[]>(
    () => getRegisteredLlmProviderIds(),
  );
  // Справка плагина в центре (вместо диалога). null — скрыта.
  const [helpDoc, setHelpDoc] = useState<HelpDoc | null>(null);
  const [previewDoc, setPreviewDoc] = useState<PreviewDoc | null>(null);
  const previewHandlersRef = useRef<PreviewHandlers | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [settingsDoc, setSettingsDoc] = useState<SettingsDoc | null>(null);
  const [openingArtifactId, setOpeningArtifactId] = useState<string | null>(null);
  const [openingAttachmentKey, setOpeningAttachmentKey] = useState<string | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const settingsWidgetIdRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Скролл/DOM-слой за императивным handle. Контроллер отдаёт ему ДАННЫЕ и
  // получает обратно ровно один факт (граница просмотра) + операции скролла.
  // scrollRef — стабильная ссылка на последний handle: нужна там, где колбэк
  // обязан остаться стабильным (onFocus в capabilityDeps) или вызывается из
  // подписки (клавиатура), чтобы не тащить handle в зависимости.
  // ---------------------------------------------------------------------------
  const scrollRef = useRef<DialogScrollHandle | null>(null);
  const scroll = useDialogScroll({
    messages,
    loading,
    sendError,
    forkMode,
    onOpenFork: (nodeId) => { void openForkMode(nodeId); },
    onCloseFork: () => { void closeForkMode(); },
    onVisibleBoundaryChange: setVisibleBoundaryNodeId,
  });
  scrollRef.current = scroll;

  // ---------------------------------------------------------------------------
  // Инициализация
  // ---------------------------------------------------------------------------

  useEffect(() => {
    initDialog().catch(console.error);
  }, []);

  useEffect(() => {
    const updateLlm = () => {
      setActiveLlmProviderId(getActiveLlmProviderId());
      setReadyLlmProviderIds(getRegisteredLlmProviderIds());
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
          scrollRef.current?.navigateUp();
          return;
        }
        if (e.ctrlKey && e.key === "ArrowDown") {
          e.preventDefault();
          scrollRef.current?.navigateDown();
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
        scrollRef.current?.navigateUp();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollRef.current?.navigateDown();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [forkMode, forkCards, forkActiveIdx, messages, dialogId, editingNodeId]);

  // Намерение фокуса от плагина (D-072): доскроллить к узлу в центральном потоке.
  // Плагин в DOM не лезет — просит, контроллер исполняет через скролл-слой.
  // Стабильный колбэк (scrollRef всегда указывает на свежий handle), чтобы
  // capabilityDeps не пересобирался каждый рендер.
  const onFocus = useCallback((nodeId: string) => {
    scrollRef.current?.focusNode(nodeId);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewDoc(null);
    previewHandlersRef.current = null;
    setPreviewBusy(false);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsDoc(null);
    settingsWidgetIdRef.current = null;
  }, []);

  const confirmPreview = useCallback(async (payload?: { tags?: string[] }) => {
    const handlers = previewHandlersRef.current;
    if (!handlers || previewBusy) return;
    setPreviewBusy(true);
    try {
      await handlers.onConfirm(payload);
      if (handlers.widgetId && handlers.confirmMsg) {
        dispatchWidgetMsg(handlers.widgetId, handlers.confirmMsg);
      }
      closePreview();
    } catch (e) {
      console.error("preview confirm failed:", e);
      setPreviewBusy(false);
    }
  }, [previewBusy, closePreview]);

  const cancelPreview = useCallback(() => {
    const handlers = previewHandlersRef.current;
    handlers?.onCancel?.();
    if (handlers?.widgetId && handlers.cancelMsg) {
      dispatchWidgetMsg(handlers.widgetId, handlers.cancelMsg);
    }
    closePreview();
  }, [closePreview]);

  // Зависимости капабилити для виджетов. Пересобираются только при смене диалога.
  const capabilityDeps = useMemo<CapabilityDeps>(
    () => ({
      onFocus,
      getActiveDialogId: () => dialogId,
      onTreeChanged: () => { if (dialogId) loadBranch(dialogId); },
      onDialogTagsChanged: () => { if (dialogId) loadDialogTags(dialogId); },
      onOpenHelp: (doc) => {
        closePreview();
        closeSettings();
        setHelpDoc(doc);
      },
      onOpenPreview: (doc, handlers) => {
        closeSettings();
        setHelpDoc(null);
        setPreviewDoc(doc);
        previewHandlersRef.current = handlers;
      },
      onClosePreview: closePreview,
      onOpenSettings: (doc) => {
        closePreview();
        setHelpDoc(null);
        setSettingsDoc(doc);
        settingsWidgetIdRef.current = doc.widgetId;
      },
      onRefreshSettings: (doc) => {
        setSettingsDoc(doc);
      },
      onCloseSettings: closeSettings,
    }),
    [onFocus, dialogId, closePreview, closeSettings],
  );

  const applySettings = useCallback(() => {
    const wid = settingsWidgetIdRef.current;
    if (!wid || !settingsDoc) return;
    dispatchWidgetMsg(wid, { type: 'SETTINGS_APPLY', value: settingsDoc });
  }, [settingsDoc]);

  const cancelSettings = useCallback(() => {
    const wid = settingsWidgetIdRef.current;
    if (wid) dispatchWidgetMsg(wid, { type: 'SETTINGS_CANCEL' });
  }, []);

  const patchSettingsDoc = useCallback((patch: Partial<SettingsDoc>) => {
    setSettingsDoc((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const notifySettingsWidget = useCallback((msg: { type: string; value?: unknown; [key: string]: unknown }) => {
    const wid = settingsWidgetIdRef.current;
    if (wid) dispatchWidgetMsg(wid, msg);
  }, []);

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
      await loadDialogTags(d.id);
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

  async function loadDialogTags(dId: string) {
    try {
      const tags = await invoke<Tag[]>("cmd_get_dialog_tags", { dialogId: dId });
      setDialogTags(tags);
    } catch (e) {
      console.error("get_dialog_tags failed:", e);
      setDialogTags([]);
    }
  }

  // Подсказка «похожих» тегов из справочника (нечёткое ранжирование в ядре).
  async function suggestTags(query: string): Promise<Tag[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      return await invoke<Tag[]>("cmd_suggest_tags", { query: q, limit: 8 });
    } catch (e) {
      console.error("suggest_tags failed:", e);
      return [];
    }
  }

  // Добавить тег беседе: либо готовый из справочника (есть tagId), либо новый по
  // тексту (ядро создаст/найдёт его в справочнике). Тег вводится по одному.
  async function addTag(arg: { tagId?: string; display?: string }) {
    if (!dialogId) return;
    try {
      let tagId = arg.tagId;
      if (!tagId) {
        const display = (arg.display ?? "").trim();
        if (!display) return;
        const tag = await invoke<Tag>("cmd_get_or_create_tag", { display });
        tagId = tag.id;
      }
      await invoke("cmd_add_dialog_tag", { dialogId, tagId });
      await loadDialogTags(dialogId);
    } catch (e) {
      console.error("add_dialog_tag failed:", e);
    }
  }

  async function removeTag(tagId: string) {
    if (!dialogId) return;
    try {
      await invoke("cmd_remove_dialog_tag", { dialogId, tagId });
      await loadDialogTags(dialogId);
    } catch (e) {
      console.error("remove_dialog_tag failed:", e);
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
      await loadDialogTags(id);
      await loadBranch(id);
    } else {
      setDialogTags([]);
      setEditingTags(false);
      setMessages([]);
      setLastNodeId(null);
      setRootActions(null);
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
        n.node_type === "compression_placeholder" ||
        n.node_type === "artifact"
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
          artifact: n.node_type === "artifact" ? parseArtifactExtra(n.extra) : null,
          attachments:
            n.node_type === "assistant_message"
              ? parseMessageAttachments(n.extra)
              : [],
          modelId: n.model_id,
          pluginId: n.plugin_id,
        };
      })
    );

    setMessages(restored);

    // Действия корня (D-090): A0-анкор — это root_anchor С родителем (Q0 —
    // root_anchor без родителя). Сам A0 в ленту не идёт, но его маркер #0 и
    // счётчики веток нужны для хедера над лентой.
    const a0 = branch.find(
      (n) => n.node_type === "root_anchor" && n.parent_id !== null,
    );
    if (a0) {
      const [deleted, rawMarkers] = await Promise.all([
        invoke<DbNode[]>("cmd_get_deleted_children", { nodeId: a0.id }),
        invoke<any[]>("cmd_get_markers_for_node", { nodeId: a0.id }),
      ]);
      setRootActions({
        nodeId: a0.id,
        childrenCount: a0.children_count,
        deletedChildrenCount: deleted.length,
        markers: rawMarkers.map((m) => ({
          id: m.id,
          nodeId: m.node_id,
          label: m.label,
          comment: m.comment,
        })),
      });
    } else {
      setRootActions(null);
    }

    // Обрезаем хвост рефов от прошлой (возможно более длинной) ветки, чтобы
    // observer не цеплял протухшие узлы.
    scrollRef.current?.trimMessageEls(restored.length);

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
    scrollRef.current?.setStickToBottom(false);
    setTimeout(() => scrollRef.current?.scrollToNodeTop(childId), 0);
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
        scrollRef.current?.setStickToBottom(false);
        setTimeout(() => {
          scrollRef.current?.scrollBranchBaseIntoView(nodeId);
          scrollRef.current?.focusComposer();
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

  // ---------------------------------------------------------------------------
  // Артефакты (D-091/D-092)
  // ---------------------------------------------------------------------------

  async function attachArtifactFromDisk() {
    if (!dialogId || attachBusy || loading) return;
    try {
      const selected = await open({ multiple: false, directory: false });
      if (!selected || Array.isArray(selected)) return;
      setAttachBusy(true);
      setSendError(null);
      await invoke("cmd_attach_artifact", { dialogId, sourcePath: selected });
      await loadBranch(dialogId);
      scrollRef.current?.scrollToBottom();
    } catch (e) {
      console.error("attach_artifact failed:", e);
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttachBusy(false);
    }
  }

  async function openMessageAttachment(messageNodeId: string, index: number) {
    const key = `${messageNodeId}:${index}`;
    if (openingAttachmentKey) return;
    setOpeningAttachmentKey(key);
    try {
      setSendError(null);
      await invoke("cmd_open_message_attachment", { messageNodeId, index });
    } catch (e) {
      console.error("open_message_attachment failed:", e);
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningAttachmentKey(null);
    }
  }

  async function openArtifact(nodeId: string) {
    if (openingArtifactId) return;
    setOpeningArtifactId(nodeId);
    try {
      setSendError(null);
      await invoke("cmd_open_artifact", { nodeId });
    } catch (e) {
      console.error("open_artifact failed:", e);
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningArtifactId(null);
    }
  }

  // Запись ответа в БД с устойчивостью к вложениям: пробуем с картинками, а
  // если invoke падает (например, объём base64 не прошёл через IPC) — повторяем
  // без media, чтобы текст ответа НЕ потерялся ("ответ есть, картинки нет").
  async function resolveAnswerResilient(
    placeholderId: string,
    pluginId: string,
    response: { content: string; modelId: string; tokensInput: number; tokensOutput: number; media?: { mime: string; extension: string; base64: string }[] },
  ): Promise<void> {
    const hasMedia = !!response.media?.length;
    if (hasMedia) {
      console.log(
        `resolve_answer: media=${response.media!.length}`,
        response.media!.map((m) => `${m.mime}/${m.base64.length}b64`),
      );
    }
    const base = {
      placeholderId,
      content: response.content,
      modelId: response.modelId,
      modelRole: "main_dialog",
      pluginId,
      tokensCount: response.tokensInput + response.tokensOutput,
    };
    try {
      await invoke<DbNode>("cmd_resolve_answer", {
        ...base,
        media: hasMedia ? response.media : null,
      });
      setSendError(null);
    } catch (e) {
      if (!hasMedia) throw e;
      console.error("resolve_answer with media failed, retrying text-only:", e);
      await invoke<DbNode>("cmd_resolve_answer", { ...base, media: null });
      setSendError(
        "Картинки не удалось сохранить (см. консоль). Текст ответа сохранён.",
      );
    }
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

      await resolveAnswerResilient(sent.placeholder_id, provider.pluginId, response);
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

      await resolveAnswerResilient(sent.placeholder_id, provider.pluginId, response);
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
  // Производные значения для рендера
  // ---------------------------------------------------------------------------

  const isBlocked = forkMode || deletedMode;

  // Факты для виджет-панели (D-072). activeBranch — проекция messages в NodeView.
  // D-090: добавляем A0-анкор в начало как скрытый root_anchor, чтобы плагины
  // (в т.ч. компрессор) видели корневой маркер #0 в общем потоке фактов.
  const activeBranch: NodeView[] = (() => {
    const base: NodeView[] = messages.map((m, i) => ({
      id: m.nodeId,
      parentId: i > 0 ? messages[i - 1].nodeId : null,
      nodeType: m.nodeType as NodeView["nodeType"],
      text: m.content,
      // Метки едут как факт: плагины (сжатие) строят списки прямо из ветки и
      // обновляются реактивно при постановке/снятии маркера — без ручного refresh.
      markers: m.markers.map(mk => ({ id: mk.id, label: mk.label, comment: mk.comment })),
    }));
    if (!rootActions) return base;
    return [
      {
        id: rootActions.nodeId,
        parentId: null,
        nodeType: "root_anchor",
        text: "",
        markers: rootActions.markers.map((mk) => ({
          id: mk.id,
          label: mk.label,
          comment: mk.comment,
        })),
      },
      ...base,
    ];
  })();

  const facts: WidgetFacts = {
    activeDialogId: dialogId,
    cursorNodeId: lastNodeId,
    visibleBoundaryNodeId,
    activeBranch,
    model: modelFacts,
    activeLlmProviderId,
    // Виджетам теги едут строками (display-имена) — контракт WidgetFacts.
    dialogTags: dialogTags.map((tg) => tg.display_name),
  };

  // ---------------------------------------------------------------------------
  // Выдача контроллера. Скролл-значения/рефы ре-экспортируются из handle, чтобы
  // App.tsx получал те же имена, что и раньше (на шаге 4 их будет брать DialogView
  // напрямую из useDialogScroll).
  // ---------------------------------------------------------------------------

  return {
    // данные дерева/беседы
    notebooks,
    dialogs,
    dialogId,
    // лента и ввод
    messages,
    input,
    setInput,
    loading,
    sendError,
    setSendError,
    // заголовок
    editingTitle,
    setEditingTitle,
    titleDraft,
    setTitleDraft,
    editingTags,
    setEditingTags,
    dialogTags,
    addTag,
    removeTag,
    suggestTags,
    // справка плагина
    helpDoc,
    setHelpDoc,
    previewDoc,
    previewBusy,
    confirmPreview,
    cancelPreview,
    settingsDoc,
    applySettings,
    cancelSettings,
    patchSettingsDoc,
    notifySettingsWidget,
    // действия корня (D-090)
    rootActions,
    // ветвление
    branchingFromId,
    // композер (из скролл-слоя)
    composerHeight: scroll.composerHeight,
    composerRef: scroll.composerRef,
    startComposerResize: scroll.startComposerResize,
    // скролл (из скролл-слоя)
    stickToBottom: scroll.stickToBottom,
    scrollToBottom: scroll.scrollToBottom,
    messagesRef: scroll.messagesRef,
    messageEls: scroll.messageEls,
    handleMessagesScroll: scroll.handleMessagesScroll,
    // маркеры
    markingNodeId,
    setMarkingNodeId,
    markerComment,
    setMarkerComment,
    editingMarkerId,
    editingMarkerText,
    setEditingMarkerText,
    nextMarkerLabel,
    createMarker,
    deleteMarker,
    startEditingMarker,
    cancelEditingMarker,
    saveMarkerComment,
    // развилка
    forkMode,
    forkCards,
    forkActiveIdx,
    setForkActiveIdx,
    cardsRef: scroll.cardsRef,
    openForkMode,
    closeForkMode,
    selectForkCard,
    handleCardClick,
    handleCardDoubleClick,
    deleteCardBranch,
    // удалённые ветки
    deletedMode,
    deletedForkCards,
    openDeletedMode,
    closeDeletedMode,
    restoreBranch,
    // редактирование имени карточки
    editingNodeId,
    editingText,
    setEditingText,
    startEditing,
    saveEditing,
    cancelEditing,
    menuNodeId,
    setMenuNodeId,
    // меню/операции беседы
    reloadTree,
    patchDialogTitle,
    openDialog,
    commitTitle,
    // отправка
    submitComposer,
    cancelBranching,
    toggleBranching,
    attachArtifactFromDisk,
    attachBusy,
    openArtifact,
    openingArtifactId,
    openMessageAttachment,
    openingAttachmentKey,
    // производное
    isBlocked,
    facts,
    capabilityDeps,
    // выбор активного LLM-провайдера (радио в хедере панели)
    llmSelection: {
      activeId: activeLlmProviderId,
      readyIds: readyLlmProviderIds,
      onSelect: (id: string) => { setActiveLlmProvider(id); },
    },
  };
}
