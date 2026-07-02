// src/dialog/DialogView.tsx
// Презентационный слой основного диалога (шаг 4 расщепления). Содержит ТОЛЬКО
// разметку центральной области: заголовок беседы, оверлей справки плагина, ленту
// сообщений, оверлей развилки/удалённых веток, нижний composer. Никакой логики,
// БД или вызовов LLM — всё это в useDialogController; сюда оно приходит одним
// пропсом `c`. Скролл/рефы тоже приходят из контроллера (инфраструктура
// useDialogScroll остаётся за ним).
//
// Менять дизайн/функционал окна диалога нужно ИМЕННО здесь (+ App.css) — ядро и
// контроллер при этом не трогаются.
//
// Реактивность языка обеспечивает App (useLang): при смене языка перерисовывается
// App и, как следствие, этот компонент — t() пересчитывается.

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n";
import type { DialogController } from "./useDialogController";
import { copyToClipboard } from "./clipboard";
import { MessageContent } from "../renderers/MessageContent";
import { autolinkPlain } from "../renderers/base/segments";
import { ArtifactPlaque } from "./ArtifactPlaque";
import { MediaKindIcon } from "./MediaKindIcon";
import { extensionBadge } from "./artifactMedia";
import { TagsEditor } from "./TagsEditor";
import { useMetricsEnabled } from "../settings/metricsSetting";
import { resolveModelName } from "../widgets/llm/registry";
import { FormModal } from "../widgets/host/FormModal";
import { TreeCanvas } from "./TreeCanvas";

export function DialogView({ c }: { c: DialogController }): React.ReactElement {
  const {
    dialogId,
    messages,
    input,
    setInput,
    loading,
    sendError,
    setSendError,
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
    helpDoc,
    setHelpDoc,
    previewDoc,
    previewBusy,
    confirmPreview,
    cancelPreview,
    formDoc,
    treeDoc,
    rootActions,
    branchingFromId,
    composerHeight,
    composerRef,
    startComposerResize,
    stickToBottom,
    scrollToBottom,
    messagesRef,
    messageEls,
    handleMessagesScroll,
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
    forkMode,
    forkCards,
    forkActiveIdx,
    setForkActiveIdx,
    cardsRef,
    openForkMode,
    closeForkMode,
    handleCardClick,
    handleCardDoubleClick,
    deleteCardBranch,
    deletedMode,
    deletedForkCards,
    openDeletedMode,
    closeDeletedMode,
    restoreBranch,
    editingNodeId,
    editingText,
    setEditingText,
    startEditing,
    saveEditing,
    cancelEditing,
    menuNodeId,
    setMenuNodeId,
    dialogs,
    commitTitle,
    submitComposer,
    cancelBranching,
    toggleBranching,
    attachArtifactFromDisk,
    attachBusy,
    pendingAttachments,
    addPendingFiles,
    addPendingFromExisting,
    removePendingAttachment,
    openArtifact,
    openingArtifactId,
    openMessageAttachment,
    openingAttachmentKey,
    isBlocked,
    facts,
  } = c;

  // Контекстное меню копирования (ПКМ по элементу диалога). Чисто визуальное
  // состояние — живёт в презентационном слое, контроллер про него не знает.
  // Храним координаты курсора, текст всего элемента (Q/A/S) и текст выделения
  // НА МОМЕНТ клика — выделение нужно зафиксировать, иначе клик по пункту меню
  // его сбросит, и «Копировать выделенное»/«Цитировать» получат пусто.
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; text: string; selection: string } | null
  >(null);

  // Закрытие меню: левый клик, скролл, Esc, либо ПКМ вне элемента диалога
  // (обработчик элемента делает stopPropagation, поэтому до window не доходит).
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const openCtxMenu = (e: React.MouseEvent, text: string) => {
    e.preventDefault();
    e.stopPropagation();
    const selection = window.getSelection()?.toString() ?? "";
    setCtxMenu({ x: e.clientX, y: e.clientY, text, selection });
  };

  // «Цитировать»: дописать выделенный фрагмент в КОНЕЦ поля запроса (с переносом
  // строки, если в поле уже что-то есть) и поставить курсор в конец. setInput —
  // обычный сеттер контроллера; данные ядра тут не нужны, поэтому остаёмся во вью.
  const quoteSelection = (selection: string) => {
    const quote = selection.trim();
    if (!quote) return;
    setInput((prev) => (prev ? `${prev}\n${quote}` : quote));
    setTimeout(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    }, 0);
  };

  // --- Метрика запросов (опция меню «Настройки») ---
  const metricsEnabled = useMetricsEnabled();
  // Редактируемые теги-кандидаты в превью тегизатора: пользователь может убрать
  // лишние перед подтверждением (каждый чип со своим ×). Сидируем из previewDoc.
  const [previewTags, setPreviewTags] = useState<string[]>([]);
  useEffect(() => {
    setPreviewTags(previewDoc?.tags ?? []);
  }, [previewDoc]);
  // Ответ LLM, выбранный кликом — показываем модель ИМЕННО его. null => текущая
  // рабочая модель (продолжение диалога).
  const [metricNodeId, setMetricNodeId] = useState<string | null>(null);
  // Пошла отправка (продолжаем диалог) — возвращаемся к «текущая модель».
  useEffect(() => { if (loading) setMetricNodeId(null); }, [loading]);
  // Сменили беседу — сбрасываем выбор.
  useEffect(() => { setMetricNodeId(null); }, [dialogId]);

  const metricSelected = metricNodeId
    ? messages.find((m) => m.nodeId === metricNodeId) ?? null
    : null;
  // Выбран ответ — плагин/модель ИМЕННО его (из пары «запрос-ответ», поля БД).
  // Нет выбора (продолжаем диалог) — текущий активный плагин/модель.
  const metricPluginRaw = metricSelected
    ? metricSelected.pluginId
    : facts.activeLlmProviderId;
  const metricPlugin = metricPluginRaw ? metricPluginRaw.toUpperCase() : t("app.metrics.none");
  const metricModelRaw = metricSelected ? metricSelected.modelId : facts.model.id;
  const metricModel = metricModelRaw ? resolveModelName(metricModelRaw) : t("app.metrics.none");

  // Пиктограмма копирования (вариант 2): неброская, проявляется при наведении.
  const renderCopyBtn = (text: string) => (
    <button
      className="message-copy-btn"
      title={t("app.copy")}
      aria-label={t("app.copy")}
      onClick={(e) => { e.stopPropagation(); void copyToClipboard(text); }}
    >
      ⧉
    </button>
  );

  const compressorPreviewTitle = t("widgets.compressor.preview.title");
  const taggerPreviewTitle = t("widgets.tagger.preview.title");
  const previewTitle = previewDoc
    ? previewDoc.widgetId === "compressor"
      ? compressorPreviewTitle
      : previewDoc.widgetId === "tagger"
        ? taggerPreviewTitle
        : previewDoc.title
    : "";

  return (
    <main className="container">
      {formDoc && <FormModal doc={formDoc} />}
      {treeDoc ? (
        // Дерево ЗАМЕЩАЕТ область диалога целиком: пока оно открыто, ни ленты, ни
        // композера, ни шапки — только полотно. Диалог не нужен, пока ищем узел.
        <TreeCanvas doc={treeDoc} c={c} />
      ) : (
      <>
      {previewDoc && (
        <div
          className={`help-doc preview-doc ${
            previewDoc.widgetId === "tagger" ? "preview-doc--compact" : ""
          }`}
          role="dialog"
          aria-label={previewTitle}
        >
          <div className="help-doc-head">
            <h2 className="help-doc-title">
              {previewTitle}
            </h2>
          </div>
          <div className="help-doc-body preview-doc-body">
            {previewDoc.tags ? (
              previewTags.length > 0 ? (
                <div className="preview-tags">
                  {previewTags.map((tag, i) => (
                    <span key={`${tag}-${i}`} className="preview-tag-chip">
                      #{tag}
                      <button
                        type="button"
                        className="preview-tag-remove"
                        title={t("app.tags.remove")}
                        disabled={previewBusy}
                        onClick={() =>
                          setPreviewTags((prev) => prev.filter((_, j) => j !== i))
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <span className="dialog-tags-empty">{t("app.tags.empty")}</span>
              )
            ) : (
              <pre className="preview-doc-text">{previewDoc.text}</pre>
            )}
          </div>
          <div className="preview-doc-actions">
            <button
              type="button"
              className="preview-doc-btn preview-doc-btn-primary"
              disabled={previewBusy || (!!previewDoc.tags && previewTags.length === 0)}
              onClick={() => {
                void confirmPreview(
                  previewDoc.tags ? { tags: previewTags } : undefined,
                );
              }}
            >
              {previewBusy ? t("app.preview.applying") : t("app.preview.confirm")}
            </button>
            <button
              type="button"
              className="preview-doc-btn"
              disabled={previewBusy}
              onClick={cancelPreview}
            >
              {t("app.preview.cancel")}
            </button>
          </div>
        </div>
      )}
      {!previewDoc && helpDoc && (
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
        <>
        <div className="dialog-head">
          {editingTitle ? (
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
          )}

          <TagsEditor
            tags={dialogTags}
            editing={editingTags}
            setEditing={setEditingTags}
            onAdd={addTag}
            onRemove={removeTag}
            onSuggest={suggestTags}
          />

          <button
            type="button"
            className="dialog-attach-btn"
            title={t("app.artifact.attachHint")}
            disabled={!dialogId || loading || attachBusy || isBlocked}
            onClick={() => { void attachArtifactFromDisk(); }}
          >
            {attachBusy ? "…" : "📎"}
          </button>
        </div>
        {metricsEnabled && (
          <div className="metrics-line" role="status">
            {t("app.metrics.line", { plugin: metricPlugin, model: metricModel })}
          </div>
        )}
        </>
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
        {/* Хедер действий корня (D-090): A0-анкор скрыт из ленты, но его маркер
            #0, «+» (альтернативный первый вопрос) и развилка ⑂ живут здесь —
            «перед первым вопросом». Маркер #0 неудаляем: правка только. */}
        {rootActions && (() => {
          const rootVisible = rootActions.childrenCount - rootActions.deletedChildrenCount;
          const rm = rootActions.markers[0];
          return (
            <div className="root-actions">
              <span className="root-actions-label">{t("app.root.label")}</span>
              <div className="message-actions">
                {rootVisible > 1 && (
                  <button
                    className="fork-btn"
                    title={t("app.fork.title", { count: rootVisible })}
                    onClick={() => openForkMode(rootActions.nodeId)}
                  >
                    ⑂
                  </button>
                )}

                {rootActions.deletedChildrenCount > 0 && (
                  <button
                    className="fork-btn--deleted"
                    title={t("app.deleted.countTitle", { count: rootActions.deletedChildrenCount })}
                    onClick={() => openDeletedMode(rootActions.nodeId)}
                  >
                    ⑂{rootActions.deletedChildrenCount > 1 ? ` ×${rootActions.deletedChildrenCount}` : ""}
                  </button>
                )}

                {rootActions.childrenCount > 0 && (
                  <button
                    className={`branch-btn ${branchingFromId === rootActions.nodeId ? "branch-btn--active" : ""}`}
                    title={t("app.branch.create")}
                    onClick={() => toggleBranching(rootActions.nodeId)}
                  >
                    +
                  </button>
                )}

                {rm && (
                  <>
                    <span
                      className="marker-btn marker-btn--active marker-btn--root"
                      title={t("app.marker.editHint")}
                      onDoubleClick={() => startEditingMarker(rm.id, rm.comment)}
                    >
                      ⚑ {rm.label}
                    </span>

                    {editingMarkerId === rm.id ? (
                      <textarea
                        className="marker-comment-edit"
                        autoFocus
                        value={editingMarkerText}
                        onChange={e => setEditingMarkerText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            saveMarkerComment(rm.id, rm.label);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEditingMarker();
                          }
                        }}
                        rows={1}
                      />
                    ) : (
                      rm.comment && (
                        <span
                          className="marker-comment"
                          title={t("app.marker.editHint")}
                          onDoubleClick={() => startEditingMarker(rm.id, rm.comment)}
                        >
                          {rm.comment}
                        </span>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })()}
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
                onContextMenu={(e) => openCtxMenu(e, m.content)}
              >
                <div className="message-content message-content--compressed">
                  <div className="compressed-badge">⊟ {t("app.compressed.badge")}</div>
                  <MessageContent content={m.content} facts={facts} />
                </div>
                <div className="message-foot">{renderCopyBtn(m.content)}</div>
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

          if (m.nodeType === "artifact" && m.artifact) {
            return (
              <div
                key={i}
                className="message message--artifact"
                ref={el => { messageEls.current[i] = el; }}
                data-msg-idx={i}
              >
                <ArtifactPlaque
                  artifact={m.artifact}
                  busy={openingArtifactId === m.nodeId}
                  onOpen={() => { void openArtifact(m.nodeId); }}
                  onQuote={() => addPendingFromExisting(m.artifact!)}
                />
              </div>
            );
          }

          if (m.nodeType === "artifact") {
            return (
              <div
                key={i}
                className="message message--artifact message--artifact-broken"
                ref={el => { messageEls.current[i] = el; }}
                data-msg-idx={i}
              >
                <p>{t("app.artifact.broken")}</p>
              </div>
            );
          }

          return (
            <div
              key={i}
              className={`message ${m.role}`}
              ref={el => { messageEls.current[i] = el; }}
              data-msg-idx={i}
              onContextMenu={(e) => openCtxMenu(e, m.content)}
              onClick={m.role === "assistant" ? () => setMetricNodeId(m.nodeId) : undefined}
            >
              <div className="message-content">
                {m.role === "assistant"
                  ? <MessageContent content={m.content} facts={facts} />
                  : <p>{autolinkPlain(m.content)}</p>}
              </div>

              {m.attachments.length > 0 && (
                <div className="message-attachments">
                  {m.attachments.map((att, attIdx) => (
                    <ArtifactPlaque
                      key={`${m.nodeId}-att-${attIdx}`}
                      artifact={att}
                      busy={openingAttachmentKey === `${m.nodeId}:${attIdx}`}
                      onOpen={() => { void openMessageAttachment(m.nodeId, attIdx); }}
                      onQuote={() => addPendingFromExisting(att)}
                    />
                  ))}
                </div>
              )}

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

                  {renderCopyBtn(m.content)}
                </div>
              )}

              {m.role === "user" && (
                <div className="message-foot">{renderCopyBtn(m.content)}</div>
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
        {pendingAttachments.length > 0 && (
          <div className="composer-attachments">
            {pendingAttachments.map((att) => (
              <span key={att.id} className="pending-chip" title={att.filename}>
                <span className="pending-chip-icon" aria-hidden>
                  <MediaKindIcon kind={att.mediaKind} />
                </span>
                <span className="pending-chip-ext">{extensionBadge(att.extension)}</span>
                <span className="pending-chip-name">{att.filename}</span>
                <button
                  type="button"
                  className="pending-chip-remove"
                  title={t("app.attachment.remove")}
                  aria-label={t("app.attachment.remove")}
                  onClick={() => removePendingAttachment(att.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
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
              /* Не дизейблим во время loading: поле держит фокус и позволяет
                 печатать следующий запрос, пока идёт текущий. Повторную отправку
                 не даст гард loading в sendMessage/sendBranch. */
              disabled={!dialogId || isBlocked}
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
              type="button"
              className="composer-attach"
              onClick={() => { void addPendingFiles(); }}
              disabled={loading || !dialogId || isBlocked}
              title={t("app.composer.attach")}
              aria-label={t("app.composer.attach")}
            >
              <span className="composer-attach-icon" aria-hidden>📎</span>
            </button>
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

      {/* Контекстное меню копирования (вариант 1): появляется у курсора по ПКМ. */}
      {ctxMenu && (
        <div
          className="msg-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <button
            className="msg-context-menu-item"
            disabled={!ctxMenu.selection.trim()}
            onClick={() => { void copyToClipboard(ctxMenu.selection); setCtxMenu(null); }}
          >
            {t("app.copySelection")}
          </button>
          <button
            className="msg-context-menu-item"
            disabled={!ctxMenu.selection.trim()}
            onClick={() => { quoteSelection(ctxMenu.selection); setCtxMenu(null); }}
          >
            {t("app.quoteSelection")}
          </button>
          <button
            className="msg-context-menu-item"
            onClick={() => { void copyToClipboard(ctxMenu.text); setCtxMenu(null); }}
          >
            {t("app.copyMessage")}
          </button>
        </div>
      )}
      </>
      )}
    </main>
  );
}
