// src/widgets/host/types.ts
// Контракт виджет-хоста. Граница ядро<->плагин (D-072): плагин видит ТОЛЬКО
// эти типы и ничего из ядра напрямую не импортирует.
// Форма TEA (state + view + update): обработчики — ДАННЫЕ, не функции, чтобы
// контракт пережил переезд в окно-за-мостом (D-075) без переписывания.

// ---------------------------------------------------------------------------
// Манифест (D-070, D-073)
// ---------------------------------------------------------------------------

export type DockPosition = 'left' | 'right' | 'top' | 'bottom';
export type SurfaceKind = 'panel' | 'window'; // MVP: только 'panel' (D-071)

export type CapabilityName =
  | 'markers.read'
  | 'compression.attach'
  | 'model.call'
  | 'ui.focus';

export interface WidgetManifest {
  // идентичность
  id: string;       // 'context-meter', 'compression'
  title: string;    // подпись в шапке виджета
  icon: string;     // имя иконки lucide-react СТРОКОЙ, не ReactNode —
                    // манифест должен оставаться сериализуемым (мост, D-075)

  // подсказки раскладки. MVP-хром читает только то, что умеет (right/panel),
  // остальное держим на вырост и пишем сейчас, чтобы не ломать формат потом.
  defaultOpen?: boolean;
  order?: number;
  minWidth?: number;
  preferredPosition?: DockPosition;
  surface?: SurfaceKind;

  // РАСКРЫТИЕ, не принуждение (D-073). В MVP не проверяется. Поля есть, чтобы
  // позже завести курирование/provenance без смены формата.
  capabilities?: CapabilityName[];
  author?: string;
  sourceUrl?: string;
  version?: string;
  // integrity?: string; // зарезервировано (подпись/чек-сумма), в MVP не сверяется
}

// ---------------------------------------------------------------------------
// Сообщения (TEA). Обработчик контрола несёт ТЕГ; ядро на событии обогащает
// его динамическим значением (в поле value) и доставляет в update:
//   button    -> доставляется как есть
//   list      -> ядро добавляет value = id выбранного элемента
//   segmented -> ядро добавляет value = выбранный option
//   preview   -> ядро добавляет value = новый текст
// Зарезервировано: { type: '@@mount' } — ядро шлёт ОДИН раз после монтирования,
// точка для асинхронной инициализации (напр. compression грузит startable-маркеры).
// ---------------------------------------------------------------------------

export interface WidgetMsg {
  type: string;
  value?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Факты — read-only проекция состояния ядра (D-072). Доступны в view.
// Ядро само перерисовывает виджет при изменении относящегося факта.
// ---------------------------------------------------------------------------

export interface NodeView {
  id: string;
  parentId: string | null;
  nodeType:
    | 'user_message'
    | 'assistant_message'
    | 'artifact'
    | 'compressed_summary'
    | 'compression_placeholder'
    | 'unanswered_placeholder'
    | 'system'
    | 'context_migration';
  text: string;     // уже БЕЗ приватных диапазонов — вырезает ядро при проекции (D-078)
  hasMarker: boolean;
}

export interface WidgetFacts {
  activeDialogId: string | null;
  cursorNodeId: string | null;            // рабочая позиция (lastNodeId)
  visibleBoundaryNodeId: string | null;   // граница ПРОСМОТРА (эфемерна, ползёт скроллом)
  activeBranch: NodeView[];               // выпрямленный путь, проекция (не DbNode)
  context: { window: number };            // окно модели; ТОКЕНЫ считает ПЛАГИН, не ядро
}

// ---------------------------------------------------------------------------
// Капабилити — именованные возможности (D-072). Доступны ТОЛЬКО в update.
// Это и есть полный список разрешений плагина. Нет: generic invoke, fetch,
// ключей, хэндла к БД.
// ---------------------------------------------------------------------------

export interface Marker {
  id: string;
  nodeId: string;
  label: string;
  comment: string | null;
}

export interface ReachableEnd {
  nodeId: string;
  kind: 'marker' | 'leaf';
  label: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompressionProvenance {
  pluginId: string;
  pluginVersion: string;
  algorithm: string;
  params: unknown;
}

export interface WidgetCapabilities {
  // топология маркеров (D-066). Тонкие обёртки над существующими cmd_*
  // (сессия 7), НЕ generic invoke.
  markers: {
    listStartable(): Promise<Marker[]>;
    listReachableEnds(startNodeId: string): Promise<ReachableEnd[]>;
    resolveLinearRange(start: string, end: string): Promise<NodeView[]>;
  };
  // крепление сжатого: ядро создаёт S (compressed_summary) + заглушку
  // (compression_placeholder) + пишет extra.compression (D-060/D-061/D-065).
  compression: {
    attach(args: {
      startNodeId: string;
      endNodeId: string;
      summaryText: string;
      placeholderText: string | null;
      provenance: CompressionProvenance;
    }): Promise<void>;
  };
  // опосредованный ядром вызов модели — КЛЮЧ НЕ покидает ядро (D-073).
  // Маршрутизация по роли — слой ролей v0.2; в MVP-заглушке не используется.
  model: {
    call(role: string, messages: ChatMessage[]): Promise<string>;
  };
  // намерение в центральный поток — координация панель<->центр (D-072).
  ui: {
    focus(nodeId: string): void;
  };
}

// ---------------------------------------------------------------------------
// Каталог контролов (кирпичи, D-074). Плагин декларирует СОСТАВ; геометрией
// и отрисовкой владеет ядро. 'stack' — ЕДИНСТВЕННЫЙ примитив раскладки, и он
// про состав ("эти, по порядку"), не про геометрию. Новый kind добавляется
// только под реальный виджет.
// ---------------------------------------------------------------------------

export interface ListItem {
  id: string;
  label: string;
  secondary?: string;
  selected?: boolean;
}

export interface SegOption {
  value: string;
  label: string;
}

export type ControlNode =
  | { kind: 'stack'; children: ControlNode[] }
  | { kind: 'text'; value: string; tone?: 'normal' | 'muted' }
  | { kind: 'indicator'; value: number; max: number; color: string; label?: string }
  | { kind: 'list'; items: ListItem[]; onSelect: WidgetMsg }
  | { kind: 'button'; label: string; disabled?: boolean; onClick: WidgetMsg }
  | { kind: 'segmented'; options: SegOption[]; value: string; onChange: WidgetMsg }
  | { kind: 'preview'; text: string; editable?: boolean; onChange?: WidgetMsg };

// ---------------------------------------------------------------------------
// Определение виджета (TEA). Регистрируется в реестре (хардкод-мапа, D-070).
// view  — ЧИСТАЯ: только состав, без side-effects, без капабилити.
// update — вся логика; капабилити доступны ТОЛЬКО здесь.
// ---------------------------------------------------------------------------

export interface WidgetDef<State = unknown, Msg extends WidgetMsg = WidgetMsg> {
  manifest: WidgetManifest;
  initialState(facts: WidgetFacts): State;
  view(state: State, facts: WidgetFacts): ControlNode;
  update(msg: Msg, state: State, cap: WidgetCapabilities): State | Promise<State>;
}

