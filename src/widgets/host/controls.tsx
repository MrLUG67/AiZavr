// src/widgets/host/controls.tsx
// Рендерер каталога контролов (D-074). Чистая трансляция ControlNode -> React.
// Геометрию/раскладку владеет ЯДРО (className -> твой CSS); инлайн-стиль только
// для значений, пришедших от плагина как ДАННЫЕ (заливка/цвет индикатора).
// На событии тег-обработчик из ControlNode обогащается динамическим value и
// поднимается через dispatch (TEA: см. types.ts).

import { createContext, useContext, useState, type ChangeEvent } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { ControlNode, WidgetMsg, ModalityFlags, ModelTableModalityFilterUi } from './types';
import {
  emptyModalityFilter,
  matchesModalityFilter,
  modalityFilterActive,
  MODALITY_KINDS,
  MODALITY_LABELS,
  type ModalityFilterState,
} from '../llm/capabilities';

export type Dispatch = (msg: WidgetMsg) => void;

// ---------------------------------------------------------------------------
// Буфер значений формы (D-096). Контролы field/select/radioGroup/textInput,
// будучи ВНУТРИ формы, читают/пишут значение через этот контекст (состояние
// держит ХОСТ-модалка, не плагин). ВНЕ формы (в обычной панели) контекст = null:
// контрол показывает своё node.value и сразу диспатчит onChange как раньше.
// ---------------------------------------------------------------------------

export interface FormFieldController {
  getValue: (name: string, fallback: string) => string;
  setValue: (name: string, value: string) => void;
  /** Реактивный onChange контрола: хост доставит плагину снимок всех значений. */
  notifyChange: (msg: WidgetMsg, name: string, value: string) => void;
}

export const FormFieldContext = createContext<FormFieldController | null>(null);

// Обогащение тега значением события. База — тег из ControlNode (напр.
// { type: 'PICK_START' }); ядро добавляет value согласно контракту в types.ts.
function enrich(base: WidgetMsg, value: unknown): WidgetMsg {
  return { ...base, value };
}

// Страховка исчерпываемости: если в каталог добавили kind и забыли его здесь —
// TypeScript подсветит это на этапе сборки, а не молча отрендерит пусто.
function assertNever(node: never): never {
  throw new Error(`Unknown control kind: ${JSON.stringify(node)}`);
}

export function renderControl(
  node: ControlNode,
  dispatch: Dispatch,
  key?: React.Key,
): React.ReactNode {
  switch (node.kind) {
    // -- единственный примитив раскладки: состав по порядку, не геометрия --
    case 'stack':
      return (
        <div className="widget-stack widget-plugin-root" key={key}>
          {node.children.map((child, i) => renderControl(child, dispatch, i))}
        </div>
      );

    case 'row':
      return (
        <div className="widget-row" key={key}>
          {node.children.map((child, i) => renderControl(child, dispatch, i))}
        </div>
      );

    case 'spacer':
      return <div className="widget-row-spacer" key={key} />;

    case 'text':
      return (
        <div
          className={`widget-text ${node.tone === 'muted' ? 'is-muted' : ''}`}
          key={key}
        >
          {node.value}
        </div>
      );

    // value/max/color/label приходят от плагина; заливка и цвет — данные, не дизайн
    case 'indicator': {
      const frac = node.max > 0 ? Math.min(node.value / node.max, 1) : 0;
      return (
        <div className="widget-indicator" key={key}>
          <div className="widget-indicator-track">
            <div
              className="widget-indicator-fill"
              style={{ width: `${frac * 100}%`, backgroundColor: node.color }}
            />
          </div>
          {node.label !== undefined && (
            <span className="widget-indicator-label">{node.label}</span>
          )}
        </div>
      );
    }

    case 'list':
      return (
        <ul className="widget-list" key={key}>
          {node.items.map((item) => (
            <li
              key={item.id}
              className={`widget-list-item ${item.selected ? 'is-selected' : ''}`}
              // value = id выбранного; заодно несём его подпись/вторичный текст,
              // чтобы update не делал повторный lookup (фактов в update нет).
              onClick={() =>
                dispatch({
                  ...node.onSelect,
                  value: item.id,
                  label: item.label,
                  secondary: item.secondary,
                })
              }
            >
              <span className="widget-list-item-label">{item.label}</span>
              {item.secondary !== undefined && (
                <span className="widget-list-item-secondary">{item.secondary}</span>
              )}
            </li>
          ))}
        </ul>
      );

    case 'button':
      return (
        <button
          className={`widget-button ${node.primary ? 'is-primary' : ''}`}
          key={key}
          disabled={node.disabled}
          onClick={() => dispatch(node.onClick)}
        >
          {node.label}
        </button>
      );

    case 'iconButton':
      return (
        <button
          className="widget-icon-button"
          key={key}
          type="button"
          title={node.title}
          onClick={() => dispatch(node.onClick)}
        >
          {node.icon}
        </button>
      );

    // Внешняя ссылка: открываем в системном браузере через opener-плагин Tauri
    // (плагин не дёргает invoke напрямую — это делает хост).
    case 'link':
      return (
        <button
          className="widget-link"
          key={key}
          type="button"
          onClick={() => {
            void openUrl(node.href).catch((e) =>
              console.error('openUrl failed:', e),
            );
          }}
        >
          {node.label}
        </button>
      );

    case 'checkbox':
      return (
        <label className="widget-checkbox" key={key}>
          <input
            type="checkbox"
            checked={node.checked}
            disabled={node.disabled}
            onChange={(e) => dispatch(enrich(node.onChange, e.target.checked))}
          />
          <span>{node.label}</span>
        </label>
      );

    case 'segmented':
      return (
        <div className="widget-segmented" key={key} role="group">
          {node.options.map((opt) => (
            <button
              key={opt.value}
              className={`widget-segmented-option ${
                opt.value === node.value ? 'is-active' : ''
              }`}
              onClick={() => dispatch(enrich(node.onChange, opt.value))}
            >
              {opt.label}
            </button>
          ))}
        </div>
      );

    // editable preview — управляемый из state через view; на ввод поднимаем
    // value = новый текст. Каждое нажатие = round-trip через update (см. caveat).
    case 'preview':
      return (
        <div className="widget-preview" key={key}>
          {node.editable && node.onChange ? (
            node.inputType ? (
              <input
                className="widget-preview-input"
                type={node.inputType}
                value={node.text}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  dispatch(enrich(node.onChange!, e.target.value))
                }
              />
            ) : (
              <textarea
                className="widget-preview-edit"
                value={node.text}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  dispatch(enrich(node.onChange!, e.target.value))
                }
              />
            )
          ) : (
            <div className="widget-preview-text">{node.text}</div>
          )}
        </div>
      );

    // --- кирпичи формы (D-096) ---
    case 'field':
      return (
        <div className="widget-field" key={key}>
          <div className="widget-field-label">{node.label}</div>
          {renderControl(node.child, dispatch)}
          {node.hint !== undefined && (
            <div className="widget-field-hint">{node.hint}</div>
          )}
        </div>
      );

    case 'select':
      return <SelectControl key={key} node={node} dispatch={dispatch} />;

    case 'radioGroup':
      return <RadioGroupControl key={key} node={node} dispatch={dispatch} />;

    case 'favoriteModelList':
      return <FavoriteModelListControl key={key} node={node} dispatch={dispatch} />;

    case 'tabs':
      return <TabsControl key={key} node={node} dispatch={dispatch} />;

    case 'textInput':
      return <TextInputControl key={key} node={node} dispatch={dispatch} />;

    case 'modelTable':
      return <ModelTableControl key={key} node={node} dispatch={dispatch} />;

    case 'overlay':
      return (
        <div className="widget-overlay" key={key}>
          {node.children.map((child, i) => renderControl(child, dispatch, i))}
        </div>
      );

    default:
      return assertNever(node);
  }
}

// ---------------------------------------------------------------------------
// Компоненты контролов формы. Вынесены из renderControl, т.к. используют хуки
// (локальная вкладка / контекст буфера). Function-declaration → хойстятся,
// поэтому ссылка из switch выше легальна.
// ---------------------------------------------------------------------------

// Общий помощник: применить изменение значения поля. В форме — в буфер хоста
// (+ снимок плагину при onChange); вне формы — прямой dispatch onChange.
function applyFieldChange(
  form: FormFieldController | null,
  dispatch: Dispatch,
  node: { name: string; onChange?: WidgetMsg },
  value: string,
): void {
  if (form) form.setValue(node.name, value);
  if (node.onChange) {
    if (form) form.notifyChange(node.onChange, node.name, value);
    else dispatch(enrich(node.onChange, value));
  }
}

function SelectControl(props: {
  node: Extract<ControlNode, { kind: 'select' }>;
  dispatch: Dispatch;
}): React.ReactElement {
  const { node, dispatch } = props;
  const form = useContext(FormFieldContext);
  const value = form ? form.getValue(node.name, node.value) : node.value;
  return (
    <select
      className="widget-select"
      value={value}
      disabled={node.disabled}
      onChange={(e) => applyFieldChange(form, dispatch, node, e.target.value)}
    >
      {node.placeholder !== undefined && (
        <option value="" disabled>
          {node.placeholder}
        </option>
      )}
      {node.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function RadioGroupControl(props: {
  node: Extract<ControlNode, { kind: 'radioGroup' }>;
  dispatch: Dispatch;
}): React.ReactElement {
  const { node, dispatch } = props;
  const form = useContext(FormFieldContext);
  const value = form ? form.getValue(node.name, node.value) : node.value;
  return (
    <div className="widget-radio-group" role="radiogroup">
      {node.options.map((o) => (
        <label
          key={o.value}
          className={`widget-radio ${o.disabled ? 'is-disabled' : ''}`}
        >
          <input
            type="radio"
            name={node.name}
            value={o.value}
            checked={value === o.value}
            disabled={node.disabled || o.disabled}
            onChange={() => applyFieldChange(form, dispatch, node, o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function FavoriteModelListControl(props: {
  node: Extract<ControlNode, { kind: 'favoriteModelList' }>;
  dispatch: Dispatch;
}): React.ReactElement {
  const { node, dispatch } = props;
  const form = useContext(FormFieldContext);
  const value = form ? form.getValue(node.name, node.value) : node.value;

  return (
    <div className="widget-favorite-model-list" role="radiogroup">
      {node.items.map((item) => (
        <div key={item.id} className="widget-favorite-model-row">
          <label className={`widget-radio widget-favorite-model-radio ${node.disabled ? 'is-disabled' : ''}`}>
            <input
              type="radio"
              name={node.name}
              value={item.id}
              checked={value === item.id}
              disabled={node.disabled}
              onChange={() => applyFieldChange(form, dispatch, node, item.id)}
            />
            <span className="widget-favorite-model-label">{item.label}</span>
            {item.secondary !== undefined && (
              <span className="widget-favorite-model-secondary">{item.secondary}</span>
            )}
          </label>
          <button
            type="button"
            className="widget-favorite-model-remove"
            title="Убрать из избранного"
            disabled={node.disabled}
            aria-label={`Убрать из избранного: ${item.label}`}
            onClick={() =>
              dispatch({ ...node.onRemove, value: item.id, modelId: item.id })
            }
          >
            −
          </button>
        </div>
      ))}
    </div>
  );
}

function TextInputControl(props: {
  node: Extract<ControlNode, { kind: 'textInput' }>;
  dispatch: Dispatch;
}): React.ReactElement {
  const { node, dispatch } = props;
  const form = useContext(FormFieldContext);
  const value = form ? form.getValue(node.name, node.value) : node.value;
  if (node.multiline) {
    return (
      <textarea
        className="widget-text-input widget-text-input-multiline"
        value={value}
        rows={node.rows ?? 4}
        placeholder={node.placeholder}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
          applyFieldChange(form, dispatch, node, e.target.value)
        }
      />
    );
  }
  return (
    <input
      className="widget-text-input"
      type={node.inputType ?? 'text'}
      value={value}
      placeholder={node.placeholder}
      onChange={(e: ChangeEvent<HTMLInputElement>) =>
        applyFieldChange(form, dispatch, node, e.target.value)
      }
    />
  );
}

function parseFavoriteIds(raw: string): Set<string> {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function serializeFavoriteIds(ids: Set<string>): string {
  return JSON.stringify([...ids]);
}

function ModalityFilterPanel(props: {
  ui: ModelTableModalityFilterUi;
  value: ModalityFilterState;
  disabled?: boolean;
  onChange: (next: ModalityFilterState) => void;
}): React.ReactElement {
  const { ui, value, disabled, onChange } = props;

  const toggle = (side: 'input' | 'output', kind: keyof ModalityFlags) => {
    onChange({
      ...value,
      [side]: { ...value[side], [kind]: !value[side][kind] },
    });
  };

  const renderRow = (side: 'input' | 'output', label: string, hint?: string) => (
    <div className="widget-modality-filter-side" key={side}>
      <div className="widget-modality-filter-side-head">
        <span className="widget-modality-filter-label">{label}</span>
        {hint !== undefined && (
          <span className="widget-modality-filter-hint">{hint}</span>
        )}
      </div>
      <div className="widget-modality-filter-checks" role="group">
        {MODALITY_KINDS.map((k) => (
          <label key={k} className="widget-modality-filter-check">
            <input
              type="checkbox"
              checked={value[side][k]}
              disabled={disabled}
              onChange={() => toggle(side, k)}
            />
            <span>{MODALITY_LABELS[k]}</span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="widget-modality-filter">
      {renderRow('input', ui.inputLabel, ui.inputHint)}
      {renderRow('output', ui.outputLabel, ui.outputHint)}
    </div>
  );
}

function rowPassesModalityFilter(
  row: { capabilities?: import('./types').ModelCapabilities },
  filter: ModalityFilterState,
  enabled: boolean,
): boolean {
  if (!enabled || !modalityFilterActive(filter)) return true;
  if (!row.capabilities) return false;
  return matchesModalityFilter(row.capabilities, filter);
}

function ModelTableControl(props: {
  node: Extract<ControlNode, { kind: 'modelTable' }>;
  dispatch: Dispatch;
}): React.ReactElement {
  const { node, dispatch } = props;
  const form = useContext(FormFieldContext);
  const rawFavorites = form ? form.getValue(node.name, node.value) : node.value;
  const favorites = parseFavoriteIds(rawFavorites);
  const [filter, setFilter] = useState('');
  const [modalityFilter, setModalityFilter] = useState<ModalityFilterState>(emptyModalityFilter);

  const modalityEnabled = node.modalityFilter !== undefined;
  const afterModality = node.rows.filter((r) =>
    rowPassesModalityFilter(r, modalityFilter, modalityEnabled),
  );

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? afterModality.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          r.id.toLowerCase().includes(needle) ||
          (r.comment ?? '').toLowerCase().includes(needle),
      )
    : afterModality;

  const setFavorites = (next: Set<string>) => {
    const serialized = serializeFavoriteIds(next);
    if (form) form.setValue(node.name, serialized);
  };

  const toggleOne = (id: string, checked: boolean) => {
    const next = new Set(favorites);
    if (checked) next.add(id);
    else next.delete(id);
    setFavorites(next);
  };

  const selectAllVisible = () => {
    const next = new Set(favorites);
    for (const r of visible) next.add(r.id);
    setFavorites(next);
    if (node.onSelectAll && form) {
      const visibleIds = visible.map((r) => r.id);
      dispatch({
        ...node.onSelectAll,
        value: { visibleIds, values: { [node.name]: serializeFavoriteIds(next) } },
      });
    }
  };

  const deselectAllVisible = () => {
    const next = new Set(favorites);
    for (const r of visible) next.delete(r.id);
    setFavorites(next);
    if (node.onDeselectAll && form) {
      const visibleIds = visible.map((r) => r.id);
      dispatch({
        ...node.onDeselectAll,
        value: { visibleIds, values: { [node.name]: serializeFavoriteIds(next) } },
      });
    }
  };

  return (
    <div className="widget-model-table">
      {node.modalityFilter !== undefined && (
        <ModalityFilterPanel
          ui={node.modalityFilter}
          value={modalityFilter}
          disabled={node.disabled}
          onChange={setModalityFilter}
        />
      )}
      <div className="widget-model-table-toolbar">
        <input
          className="widget-model-table-search"
          type="search"
          value={filter}
          placeholder={node.searchPlaceholder ?? 'Поиск…'}
          disabled={node.disabled}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className="widget-button"
          disabled={node.disabled || visible.length === 0}
          onClick={selectAllVisible}
        >
          Выделить все
        </button>
        <button
          type="button"
          className="widget-button"
          disabled={node.disabled || visible.length === 0}
          onClick={deselectAllVisible}
        >
          Отменить все
        </button>
      </div>
      <div className="widget-model-table-scroll">
        <table className="widget-model-table-grid">
          <thead>
            <tr>
              <th className="widget-model-table-col-check" aria-label="Избранное" />
              <th>Название модели</th>
              <th>Комментарий</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={3} className="widget-model-table-empty">
                  {node.rows.length === 0 ? 'Модели не загружены' : 'Ничего не найдено'}
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row.id}>
                  <td className="widget-model-table-col-check">
                    <input
                      type="checkbox"
                      checked={favorites.has(row.id)}
                      disabled={node.disabled}
                      onChange={(e) => toggleOne(row.id, e.target.checked)}
                      aria-label={`Избранное: ${row.name}`}
                    />
                  </td>
                  <td className="widget-model-table-name">{row.name}</td>
                  <td className="widget-model-table-comment">{row.comment}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TabsControl(props: {
  node: Extract<ControlNode, { kind: 'tabs' }>;
  dispatch: Dispatch;
}): React.ReactElement {
  const { node, dispatch } = props;
  // Активная вкладка — эфемерное состояние ХОСТА (D-096): сохраняется между
  // refreshForm (тот же узел на той же позиции -> React держит state).
  const [active, setActive] = useState<string>(
    node.defaultTab ?? node.tabs[0]?.id ?? '',
  );
  const current = node.tabs.find((t) => t.id === active) ?? node.tabs[0];
  return (
    <div className="widget-tabs">
      <div className="widget-tabs-bar" role="tablist">
        {node.tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === current?.id}
            className={`widget-tab ${t.id === current?.id ? 'is-active' : ''}`}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="widget-tab-panel" role="tabpanel">
        {current ? renderControl(current.child, dispatch) : null}
      </div>
    </div>
  );
}

// Тонкая обёртка-компонент, чтобы хост рендерил дерево одним тегом.
export function ControlTree(props: {
  root: ControlNode;
  dispatch: Dispatch;
}): React.ReactElement {
  return <>{renderControl(props.root, props.dispatch)}</>;
}