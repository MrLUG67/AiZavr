// src/widgets/host/controls.tsx
// Рендерер каталога контролов (D-074). Чистая трансляция ControlNode -> React.
// Геометрию/раскладку владеет ЯДРО (className -> твой CSS); инлайн-стиль только
// для значений, пришедших от плагина как ДАННЫЕ (заливка/цвет индикатора).
// На событии тег-обработчик из ControlNode обогащается динамическим value и
// поднимается через dispatch (TEA: см. types.ts).

import type { ChangeEvent } from 'react';
import type { ControlNode, WidgetMsg } from './types';

export type Dispatch = (msg: WidgetMsg) => void;

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

// Тонкая обёртка-компонент, чтобы хост рендерил дерево одним тегом.
export function ControlTree(props: {
  root: ControlNode;
  dispatch: Dispatch;
}): React.ReactElement {
  return <>{renderControl(props.root, props.dispatch)}</>;
}