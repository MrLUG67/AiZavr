// src/dialog/useDialogScroll.ts
// Скролл/DOM-слой основного диалога (шаг 3 расщепления). ВСЯ работа с DOM —
// рефы ленты/композера, геометрия скролла, IntersectionObserver границы
// просмотра, автоскролл-прилипание, навигация по «точкам остановки» — собрана
// здесь, за императивным handle (DialogScrollHandle). Контроллер
// (useDialogController) этот слой ВЫЗЫВАЕТ и дёргает методы handle, но сам в DOM
// больше не лезет.
//
// Граница: данные приходят параметрами (messages и пр.); наружу слой сообщает
// ровно один ФАКТ — границу просмотра (onVisibleBoundaryChange) — и зовёт
// контроллер для открытия/закрытия развилки при навигации (onOpenFork/
// onCloseFork). Геометрия и рефы наружу как данные не утекают.
//
// Поведение перенесено из App.tsx/useDialogController дословно: те же deps
// эффектов, та же математика. Функции пересоздаются каждый рендер (как раньше),
// чтобы замыкания видели свежие messages/forkMode без рассинхрона.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Message } from "./types";

export interface DialogScrollHandle {
  // рефы для разметки (App/DialogView вешает их на DOM)
  messagesRef: React.RefObject<HTMLDivElement | null>;
  messageEls: React.MutableRefObject<(HTMLDivElement | null)[]>;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  cardsRef: React.RefObject<HTMLDivElement | null>;
  // визуальное состояние, которым владеет скролл-слой
  composerHeight: number;
  stickToBottom: boolean;
  setStickToBottom: (v: boolean) => void;
  // обработчики/намерения
  handleMessagesScroll: () => void;
  scrollToBottom: () => void;
  startComposerResize: (e: React.MouseEvent) => void;
  focusNode: (nodeId: string) => void;
  focusComposer: () => void;
  scrollBranchBaseIntoView: (assistantNodeId: string) => void;
  scrollToNodeTop: (nodeId: string) => void;
  navigateUp: () => void;
  navigateDown: () => void;
  // обрезка хвоста рефов под новую длину ленты (после loadBranch)
  trimMessageEls: (len: number) => void;
}

export interface UseDialogScrollParams {
  messages: Message[];
  loading: boolean;
  sendError: string | null;
  forkMode: boolean;
  // навигация может открыть/закрыть развилку — это операции контроллера
  onOpenFork: (nodeId: string) => void;
  onCloseFork: () => void;
  // единственный факт наружу: нижний частично видимый узел (эфемерная граница)
  onVisibleBoundaryChange: (nodeId: string | null) => void;
}

export function useDialogScroll(params: UseDialogScrollParams): DialogScrollHandle {
  const { messages, loading, sendError, forkMode } = params;

  // Нижнее поле ввода (composer): высота тянется за верхнюю границу.
  const [composerHeight, setComposerHeight] = useState(120);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Автоскролл ленты: пока пользователь не увёл взгляд вверх вручную, держим
  // низ ленты приклеенным — последняя строка отправленного видна над полем.
  const [stickToBottom, setStickToBottom] = useState(true);

  const cardsRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messageEls = useRef<(HTMLDivElement | null)[]>([]);
  const messagesDataRef = useRef<Message[]>([]); // зеркало messages для стабильных колбэков

  // Зеркало messages — обновляем каждый рендер (как было в App).
  messagesDataRef.current = messages;

  // ---- горизонтальный wheel-скролл карточек развилки ----
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

  // ---- граница просмотра (IntersectionObserver) ----
  // На остановке скролла берём МАКСИМАЛЬНЫЙ видимый индекс -> его nodeId = граница.
  // debounce гасит дребезг — обновляем факт по затиханию, не на каждый кадр.
  useEffect(() => {
    const root = messagesRef.current;
    if (!root || messages.length === 0) {
      params.onVisibleBoundaryChange(null);
      return;
    }

    const visible = new Set<number>();
    let timer: number | null = null;

    const recompute = () => {
      if (visible.size === 0) return;
      const maxIdx = Math.max(...visible);
      const node = messages[maxIdx];
      if (node) params.onVisibleBoundaryChange(node.nodeId);
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
    params.onVisibleBoundaryChange(messages[messages.length - 1].nodeId);

    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // ---- автоскролл: доезжаем до низа, ЕСЛИ пользователь не отлистал вверх ----
  // useLayoutEffect — чтобы прыжок случился до отрисовки и без мигания.
  useLayoutEffect(() => {
    if (!stickToBottom) return;
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading, sendError, composerHeight, stickToBottom]);

  // Признак «прилипания» к низу: у самого низа -> держим автоскролл; отлистал
  // вверх -> отпускаем.
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

  // Позиционирование на ветвлении: к низу области сообщений последнюю строку
  // БАЗОВОГО запроса этой ветки (вопрос сразу за выбранным A-узлом; иначе сам A).
  function scrollBranchBaseIntoView(assistantNodeId: string) {
    const arr = messagesDataRef.current;
    const idx = arr.findIndex(m => m.nodeId === assistantNodeId);
    if (idx < 0) return;
    let targetIdx = idx;
    if (idx + 1 < arr.length && arr[idx + 1].role === "user") targetIdx = idx + 1;
    const el = messageEls.current[targetIdx];
    el?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  // Тянем верхнюю границу поля ввода. Границы 60px..60% высоты окна.
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

  // Намерение фокуса (D-072): доскроллить к узлу в центре. Зовёт и контроллер
  // (для ui.focus от правой панели), и внутренняя логика.
  function focusNode(nodeId: string) {
    const arr = messagesDataRef.current;
    const i = arr.findIndex((m) => m.nodeId === nodeId);
    if (i < 0) return;
    const el = messageEls.current[i];
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function focusComposer() {
    composerRef.current?.focus();
  }

  // Поставить ПЕРВОЕ сообщение ветки к верху окна (после выбора развилки).
  function scrollToNodeTop(nodeId: string) {
    const i = messagesDataRef.current.findIndex(m => m.nodeId === nodeId);
    const el = messageEls.current[i];
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function trimMessageEls(len: number) {
    messageEls.current.length = len;
  }

  // ---- навигация по «точкам остановки» (узлы с маркером или развилки) ----

  interface NavStop {
    nodeId: string;
    type: "marker" | "fork";
    anchor: number; // нижняя кромка узла в координатах КОНТЕНТА (без обрезки)
  }

  // Допуск близости к нижней кромке окна. Узел, чья нижняя кромка ближе к низу
  // окна, чем NAV_TOLERANCE, считается «уже на месте» и целью НЕ берётся:
  //  - у самого низа ленты иначе Ctrl-↑ цепляет последний маркер, дёргает ленту
  //    на величину нижнего паддинга (12px) и автоскролл-прилипание возвращает её
  //    назад;
  //  - сравнение в координатах КОНТЕНТА (anchor), а не обрезанного targetScrollTop,
  //    чтобы короткая целиком видимая развилка (её target обрезается в 0) всё
  //    равно была достижима — иначе Ctrl-↑ её вовсе не открывает.
  // Совпадает с порогом «прилипания» в handleMessagesScroll.
  const NAV_TOLERANCE = 40;

  function collectNavStops(): NavStop[] {
    const container = messagesRef.current;
    if (!container) return [];
    const containerTop = container.getBoundingClientRect().top;
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
      const anchor = relTop + scrollTop + el.offsetHeight; // нижняя кромка узла
      // Развилка приоритетнее маркера, если узел и то и другое.
      stops.push({ nodeId: m.nodeId, type: isFork ? "fork" : "marker", anchor });
    }
    return stops;
  }

  // Доводим низ узла к низу окна по текущей геометрии.
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
      params.onOpenFork(stop.nodeId);
    } else if (forkMode) {
      params.onCloseFork();
    }
    // Раскладка низа меняется при открытии/закрытии плашек — скроллим после
    // коммита, по обновлённой высоте окна.
    setTimeout(() => scrollNodeBottomToView(stop.nodeId), 0);
  }

  function navigateUp() {
    const container = messagesRef.current;
    if (!container) return;
    const viewportBottom = container.scrollTop + container.clientHeight;
    // «Выше» — узлы, чья нижняя кромка ощутимо выше низа окна (не «уже на месте»).
    const above = collectNavStops().filter(s => s.anchor < viewportBottom - NAV_TOLERANCE);
    if (above.length === 0) {
      // Выше точек нет — просто к самому верху.
      if (forkMode) params.onCloseFork();
      setStickToBottom(false);
      container.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const next = above.reduce((a, b) => (b.anchor > a.anchor ? b : a));
    applyNavStop(next);
  }

  function navigateDown() {
    const container = messagesRef.current;
    if (!container) return;
    const viewportBottom = container.scrollTop + container.clientHeight;
    // «Ниже» — узлы, чья нижняя кромка ощутимо ниже низа окна.
    const below = collectNavStops().filter(s => s.anchor > viewportBottom + NAV_TOLERANCE);
    if (below.length === 0) {
      // Ниже точек нет — к самому низу, снова приклеиваемся.
      if (forkMode) params.onCloseFork();
      setStickToBottom(true);
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      return;
    }
    const next = below.reduce((a, b) => (b.anchor < a.anchor ? b : a));
    applyNavStop(next);
  }

  return {
    messagesRef,
    messageEls,
    composerRef,
    cardsRef,
    composerHeight,
    stickToBottom,
    setStickToBottom,
    handleMessagesScroll,
    scrollToBottom,
    startComposerResize,
    focusNode,
    focusComposer,
    scrollBranchBaseIntoView,
    scrollToNodeTop,
    navigateUp,
    navigateDown,
    trimMessageEls,
  };
}
