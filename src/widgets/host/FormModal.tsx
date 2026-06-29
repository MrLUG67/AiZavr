// src/widgets/host/FormModal.tsx
// Модальная поверхность декларативной формы плагина (D-096). ХОСТ владеет
// геометрией (оверлей-бэкдроп, заголовок, футер) и ЭФЕМЕРНЫМ состоянием полей
// (буфер значений + активная вкладка живёт в TabsControl). Плагин присылает
// только СОСТАВ (doc.body) и получает значения ОДНИМ сообщением submitMsg по
// «Применить»; реактивные поля (onChange) шлют плагину снимок и ждут refreshForm.
//
// Все сообщения из формы несут поле values (снимок) — плагин всегда может
// перестроить форму из актуальных значений, не теряя несохранённых правок.

import { useEffect, useRef, useState } from 'react';
import { renderControl, FormFieldContext, type FormFieldController } from './controls';
import { dispatchWidgetMsg } from './widgetDispatch';
import type { ControlNode, FormDoc } from './types';

// Собрать задекларированные значения именованных полей из дерева формы.
function collectFieldValues(node: ControlNode, acc: Record<string, string>): void {
  switch (node.kind) {
    case 'select':
    case 'radioGroup':
    case 'favoriteModelList':
    case 'textInput':
      acc[node.name] = node.value;
      break;
    case 'modelTable':
      acc[node.name] = node.value;
      break;
    case 'field':
      collectFieldValues(node.child, acc);
      break;
    case 'tabs':
      node.tabs.forEach((t) => collectFieldValues(t.child, acc));
      break;
    case 'stack':
    case 'row':
    case 'overlay':
      node.children.forEach((c) => collectFieldValues(c, acc));
      break;
    default:
      break;
  }
}

export function FormModal(props: { doc: FormDoc }): React.ReactElement {
  const { doc } = props;

  // Буфер правок пользователя (имя поля -> значение). Незатронутые поля берут
  // значение из node.value (declared). baseline — последний виденный declared:
  // если плагин ИЗМЕНИЛ declared (refreshForm после смены провайдера) — его
  // правка побеждает (сбрасываем buffer-override этого поля).
  const [buffer, setBuffer] = useState<Record<string, string>>({});
  const baselineRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const declared: Record<string, string> = {};
    collectFieldValues(doc.body, declared);
    setBuffer((prev) => {
      const next = { ...prev };
      for (const name of Object.keys(declared)) {
        if (declared[name] !== baselineRef.current[name]) {
          delete next[name];
        }
      }
      return next;
    });
    baselineRef.current = declared;
  }, [doc]);

  const snapshot = (): Record<string, string> => {
    const declared: Record<string, string> = {};
    collectFieldValues(doc.body, declared);
    return { ...declared, ...buffer };
  };

  const controller: FormFieldController = {
    getValue: (name, fallback) => (name in buffer ? buffer[name] : fallback),
    setValue: (name, value) => setBuffer((p) => ({ ...p, [name]: value })),
    notifyChange: (msg, name, value) => {
      const values = { ...snapshot(), [name]: value };
      dispatchWidgetMsg(doc.widgetId, { ...msg, value, name, values });
    },
  };

  // Кнопки/ссылки внутри body диспатчатся плагину со СНИМКОМ значений — плагин
  // всегда перестраивает форму из актуальных полей (напр. сброс промпта).
  const dispatchBody = (msg: { type: string; [k: string]: unknown }) =>
    dispatchWidgetMsg(doc.widgetId, { ...msg, values: snapshot() });

  const submit = () => {
    dispatchWidgetMsg(doc.widgetId, {
      ...doc.submitMsg,
      value: { values: snapshot() },
    });
  };
  const cancel = () => {
    if (doc.cancelMsg) dispatchWidgetMsg(doc.widgetId, doc.cancelMsg);
  };

  return (
    <div className="form-modal-backdrop" role="presentation" onClick={cancel}>
      <div
        className="form-modal"
        role="dialog"
        aria-modal="true"
        aria-label={doc.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="form-modal-head">
          <h2 className="form-modal-title">{doc.title}</h2>
        </header>
        <div className="form-modal-body">
          <FormFieldContext.Provider value={controller}>
            {renderControl(doc.body, dispatchBody)}
          </FormFieldContext.Provider>
          {doc.error && <p className="form-modal-error">{doc.error}</p>}
        </div>
        <footer className="form-modal-actions">
          <button
            type="button"
            className="form-modal-btn form-modal-btn-primary"
            disabled={doc.busy}
            onClick={submit}
          >
            {doc.submitLabel ?? 'OK'}
          </button>
          <button type="button" className="form-modal-btn" onClick={cancel}>
            {doc.cancelLabel ?? 'Cancel'}
          </button>
        </footer>
      </div>
    </div>
  );
}
