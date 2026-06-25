// src/widgets/host/types.ts
// Контракт виджет-хоста. Граница ядро<->плагин (D-072): плагин видит ТОЛЬКО
// эти типы и ничего из ядра напрямую не импортирует.
// Форма TEA (state + view + update): обработчики — ДАННЫЕ, не функции, чтобы
// контракт пережил переезд в окно-за-мостом (D-075) без переписывания.
//
// Сессия 9 (D-081..D-083): факт модели (ModelFacts) вместо голого окна;
// применимость (manifest.supportedModels); неактивное состояние (ViewResult).

// ---------------------------------------------------------------------------
// Манифест (D-070, D-073, D-082)
// ---------------------------------------------------------------------------

export type DockPosition = 'left' | 'right' | 'top' | 'bottom';
export type SurfaceKind = 'panel' | 'window'; // MVP: только 'panel' (D-071)

export type CapabilityName =
  | 'markers.read'
  | 'compression.attach'
  | 'model.call'
  | 'secrets'
  | 'ui.focus'
  | 'tags.read'
  | 'tags.write';

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

  // ПРИМЕНИМОСТЬ к модели (D-082): какие модели плагин умеет обслуживать —
  // массив id/паттернов или '*' (любая). Отсутствует => '*'. Это ДЕКЛАРАЦИЯ
  // автора (disclosure, как capabilities), НЕ enforcement; сверяет ХОСТ по
  // facts.model.id, плагин строк в теле не хардкодит. ПРИМЕНИМОСТЬ ('подходит ли
  // плагин под модель') ОТЛИЧНА от ДОВЕРИЯ ('безопасен ли' — даётся узостью
  // WidgetContext, D-072, а не манифестом).
  supportedModels?: string[] | '*';

  // Плагин-источник LLM (выбор модели для обработки диалога). Хедер панели
  // показывает для таких виджетов радио «активен/нет»; выбрать можно только
  // ГОТОВЫЙ (с валидным ключом). Обычные виджеты этого не имеют.
  providesLlm?: boolean;

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
//   list      -> ядро добавляет value = id выбранного элемента, а также его
//                label и secondary (подпись/вторичный текст) — чтобы update не
//                делал повторный lookup (фактов в update нет)
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
// Факт об активной модели (D-081). Ядро РЕЛЕИТ свойства модели плагину; размер
// окна — свойство МОДЕЛИ (реестр моделей, v0.2), не ядра и не тела плагина.
// До реестра — временная константа в App. Смена модели меняет факт -> плагин
// пересчитывает (динамика по построению). id служит И применимости (D-082),
// И провенансу/показу модели.
// ---------------------------------------------------------------------------

export interface ModelFacts {
  id: string;            // строка модели у провайдера ('anthropic/claude-haiku-4-5')
  contextWindow: number; // размер окна в токенах; ТОКЕНЫ по-прежнему считает ПЛАГИН
}

// ---------------------------------------------------------------------------
// Факты — read-only проекция состояния ядра (D-072). Доступны в view.
// Ядро само перерисовывает виджет при изменении относящегося факта.
// ---------------------------------------------------------------------------

// Маркер на узле (D-058: только на assistant). Раньше узел нёс голый
// hasMarker; теперь ядро отдаёт сами метки — плагин строит списки прямо из
// факта и обновляется РЕАКТИВНО при постановке/снятии маркера (ядро перерисует
// view при изменении ветки), без отдельного pull/refresh.
export interface NodeMarker {
  id: string;
  label: string;
  comment: string | null;
}

export interface NodeView {
  id: string;
  parentId: string | null;
  nodeType:
    | 'user_message'
    | 'assistant_message'
    | 'root_anchor'
    | 'artifact'
    | 'compressed_summary'
    | 'compression_placeholder'
    | 'unanswered_placeholder'
    | 'system'
    | 'context_migration';
  text: string;     // уже БЕЗ приватных диапазонов — вырезает ядро при проекции (D-078)
  markers: NodeMarker[];  // пусто, если меток нет (hasMarker := markers.length > 0)
}

export interface WidgetFacts {
  activeDialogId: string | null;
  cursorNodeId: string | null;            // рабочая позиция (lastNodeId)
  visibleBoundaryNodeId: string | null;   // граница ПРОСМОТРА (эфемерна, ползёт скроллом)
  activeBranch: NodeView[];               // выпрямленный путь, проекция (не DbNode)
  model: ModelFacts;                      // активная модель (D-081); всегда есть —
                                          // без выбранной модели чат невозможен
  activeLlmProviderId: string | null;     // какой LLM-плагин обрабатывает диалог
  dialogTags: string[];                   // теги активного диалога (без '#')
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
      // D-088: модель-уплотнитель. null для детерминированного компрессора без
      // вызова модели; реальный плагин передаёт id модели, которой сжал.
      modelId: string | null;
      provenance: CompressionProvenance;
    }): Promise<void>;
  };
  // опосредованный ядром вызов модели — КЛЮЧ НЕ покидает ядро (D-073).
  // Маршрутизация по роли — слой ролей v0.2; в MVP-заглушке не используется.
  model: {
    call(role: string, messages: ChatMessage[]): Promise<string>;
  };
  // хранение секретов плагина (API-ключи) в системном keychain ядра.
  // providerId — пространство имён плагина ('openrouter', 'anthropic', …).
  secrets: {
    set(providerId: string, apiKey: string): Promise<void>;
    get(providerId: string): Promise<string | null>;
    delete(providerId: string): Promise<void>;
  };
  // намерение в центральный поток — координация панель<->центр (D-072).
  ui: {
    focus(nodeId: string): void;
    // показать справку плагина в ЦЕНТРАЛЬНОЙ области (вместо текущего диалога),
    // с кнопкой закрытия. Рендерит App; в тесном боксе плагина место не на это.
    openHelp(doc: HelpDoc): void;
    openPreview(doc: PreviewDoc, handlers: PreviewHandlers): void;
    closePreview(): void;
  };
  // теги диалога: чтение/запись для автоматизации плагинами.
  tags: {
    getForActiveDialog(): Promise<string[]>;
    setForActiveDialog(tags: string[]): Promise<string[]>;
  };
}

// Справка плагина, показываемая в центре (D-072). Структурные данные, не вёрстка:
// заголовок, абзацы и опциональная внешняя ссылка. Рисует App единообразно.
export interface HelpDoc {
  title: string;
  paragraphs: string[];
  link?: { label: string; href: string };
}

/** Превью в центре (тот же хром, что help-doc): один блок текста + действия. */
export interface PreviewDoc {
  title: string;
  text: string;
}

export interface PreviewHandlers {
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** После onConfirm/onCancel — сообщение виджету-источнику (TEA). */
  widgetId?: string;
  confirmMsg?: WidgetMsg;
  cancelMsg?: WidgetMsg;
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
  | { kind: 'row'; children: ControlNode[] }
  | { kind: 'spacer' }
  | { kind: 'text'; value: string; tone?: 'normal' | 'muted' }
  | { kind: 'indicator'; value: number; max: number; color: string; label?: string }
  | { kind: 'list'; items: ListItem[]; onSelect: WidgetMsg }
  | { kind: 'button'; label: string; disabled?: boolean; primary?: boolean; onClick: WidgetMsg }
  | { kind: 'iconButton'; icon: string; title?: string; onClick: WidgetMsg }
  // Внешняя ссылка: открывается в системном браузере (хост через opener-плагин).
  | { kind: 'link'; label: string; href: string }
  | { kind: 'checkbox'; label: string; checked: boolean; disabled?: boolean; onChange: WidgetMsg }
  | { kind: 'segmented'; options: SegOption[]; value: string; onChange: WidgetMsg }
  | { kind: 'preview'; text: string; editable?: boolean; inputType?: 'text' | 'password'; onChange?: WidgetMsg }
  | { kind: 'overlay'; children: ControlNode[] };

// ---------------------------------------------------------------------------
// Результат view (D-083). view возвращает ЛИБО состав (ControlNode), ЛИБО
// штатное «нечего делать, но не сломан» (InactiveResult). Серую плашку с reason
// рисует ХОСТ единообразно — не каждый плагин по-своему. «Неактивен» — НЕ ошибка
// и НЕ падение (падение ловит изоляция WidgetHost отдельно). Два рубежа:
// ГРУБЫЙ — хост по manifest.supportedModels (не та модель -> view не зовётся);
// ТОНКИЙ — плагин по факту (модель подходит, но вход негоден -> вернул inactive).
// Дискриминант объединения: поле `inactive` против `kind` у ControlNode — не
// пересекаются, TS сужает по `'inactive' in result`.
// ---------------------------------------------------------------------------

export interface InactiveResult {
  inactive: true;
  reason: string;   // человекочитаемая причина для серой плашки (рисует ХОСТ)
}

export type ViewResult = ControlNode | InactiveResult;

// ---------------------------------------------------------------------------
// Определение виджета (TEA). Регистрируется в реестре (хардкод-мапа, D-070).
// view  — ЧИСТАЯ: только состав/inactive, без side-effects, без капабилити.
// update — вся логика; капабилити доступны ТОЛЬКО здесь.
// ---------------------------------------------------------------------------

export interface WidgetDef<State = unknown, Msg extends WidgetMsg = WidgetMsg> {
  manifest: WidgetManifest;
  initialState(facts: WidgetFacts): State;
  view(state: State, facts: WidgetFacts): ViewResult;
  update(msg: Msg, state: State, cap: WidgetCapabilities): State | Promise<State>;
}