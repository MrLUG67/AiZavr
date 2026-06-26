// Редактор тегов в шапке беседы (справочник тегов).
// Политика: теги вводятся ПО ОДНОМУ. По мере ввода ядро подбирает «похожие»
// теги из справочника (нечёткое ранжирование, cmd_suggest_tags). Выбор из
// подсказки добавляет существующий тег; Enter без выбора создаёт новый
// (cmd_get_or_create_tag в контроллере). Чип несёт «×» для отвязки.
//
// LLM-генерация тегов живёт в плагине «Тегизатор» (панель плагинов) — здесь
// только ручной ввод. Состояние ввода/подсказок — ЛОКАЛЬНОЕ здесь; контроллер
// хранит итоговый список тегов беседы (Tag[]) и операции add/remove/suggest.

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { Tag } from "./types";

interface TagsEditorProps {
  tags: Tag[];
  editing: boolean;
  setEditing: (v: boolean) => void;
  onAdd: (arg: { tagId?: string; display?: string }) => Promise<void> | void;
  onRemove: (tagId: string) => Promise<void> | void;
  onSuggest: (query: string) => Promise<Tag[]>;
}

export function TagsEditor({
  tags,
  editing,
  setEditing,
  onAdd,
  onRemove,
  onSuggest,
}: TagsEditorProps): React.ReactElement {
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<Tag[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const reqIdRef = useRef(0);

  // Динамический подбор: на каждое изменение ввода дёргаем ядро (с защитой от
  // гонки — учитываем только ответ на последний запрос).
  useEffect(() => {
    if (!editing) return;
    const q = draft.trim();
    if (!q) {
      setSuggestions([]);
      setActiveIdx(-1);
      return;
    }
    const myId = ++reqIdRef.current;
    let cancelled = false;
    const tagIds = new Set(tags.map((x) => x.id));
    (async () => {
      const hits = await onSuggest(q);
      if (cancelled || myId !== reqIdRef.current) return;
      // не предлагаем уже навешенные теги
      setSuggestions(hits.filter((h) => !tagIds.has(h.id)));
      setActiveIdx(-1);
    })();
    return () => {
      cancelled = true;
    };
  }, [draft, editing, tags, onSuggest]);

  function reset() {
    setDraft("");
    setSuggestions([]);
    setActiveIdx(-1);
  }

  async function pickSuggestion(tag: Tag) {
    await onAdd({ tagId: tag.id });
    reset();
  }

  async function commitDraft() {
    const display = draft.trim();
    if (!display) return;
    // если ввод точно совпал с подсказкой по имени — берём её id, иначе создаём
    const exact = suggestions.find(
      (s) => s.name === display.replace(/^#+/, "").trim().toLowerCase(),
    );
    if (exact) await onAdd({ tagId: exact.id });
    else await onAdd({ display });
    reset();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (suggestions.length)
        setActiveIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (suggestions.length)
        setActiveIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && suggestions[activeIdx]) pickSuggestion(suggestions[activeIdx]);
      else commitDraft();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (draft) reset();
      else setEditing(false);
    }
  }

  if (!editing) {
    return (
      <div
        className="dialog-tags"
        title={t("app.tags.editHint")}
        onDoubleClick={() => setEditing(true)}
      >
        {tags.length > 0 ? (
          tags.map((tag) => (
            <span key={tag.id} className="dialog-tag-chip">#{tag.display_name}</span>
          ))
        ) : (
          <span className="dialog-tags-empty">{t("app.tags.empty")}</span>
        )}
      </div>
    );
  }

  return (
    <div className="dialog-tags-editor">
      <div className="dialog-tags-editing">
        {tags.map((tag) => (
          <span key={tag.id} className="dialog-tag-chip dialog-tag-chip--editable">
            #{tag.display_name}
            <button
              type="button"
              className="dialog-tag-remove"
              title={t("app.tags.remove")}
              // не уводим фокус из поля ввода — редактор остаётся открытым,
              // теги можно удалять подряд (раньше клик закрывал режим правки)
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onRemove(tag.id)}
            >
              ×
            </button>
          </span>
        ))}
        <div className="dialog-tag-input-wrap">
          <input
            className="dialog-tags-edit"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              // даём клику по подсказке отработать раньше закрытия
              window.setTimeout(() => {
                if (!draft.trim()) setEditing(false);
              }, 120);
            }}
            placeholder={t("app.tags.placeholder")}
            title={t("app.tags.editHint")}
          />
          {suggestions.length > 0 && (
            <ul className="dialog-tag-suggest" onMouseDown={(e) => e.preventDefault()}>
              {suggestions.map((s, i) => (
                <li
                  key={s.id}
                  className={`dialog-tag-suggest-item ${
                    i === activeIdx ? "is-active" : ""
                  }`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pickSuggestion(s)}
                >
                  #{s.display_name}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className="dialog-tags-done"
          title={t("common.done")}
          onClick={() => {
            reset();
            setEditing(false);
          }}
        >
          ✓
        </button>
      </div>
    </div>
  );
}
