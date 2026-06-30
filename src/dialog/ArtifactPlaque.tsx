import { t } from "../i18n";
import type { ArtifactData } from "./artifactMedia";
import { extensionBadge, formatFileSize } from "./artifactMedia";
import { MediaKindIcon } from "./MediaKindIcon";

interface ArtifactPlaqueProps {
  artifact: ArtifactData;
  busy?: boolean;
  onOpen: () => void;
  /** «Цитирование»: добавить этот файл в запрос. Если не задан — стрелки нет. */
  onQuote?: () => void;
}

export function ArtifactPlaque({ artifact, busy, onOpen, onQuote }: ArtifactPlaqueProps): React.ReactElement {
  const extLabel = extensionBadge(artifact.extension);

  // Контейнер, а не <button>: внутри живут две независимые кнопки (открыть и
  // цитировать) — вложенные интерактивные элементы в <button> недопустимы.
  return (
    <div className="artifact-plaque">
      <button
        type="button"
        className="artifact-plaque-open"
        onClick={() => { if (!busy) onOpen(); }}
        disabled={busy}
        title={t("app.artifact.openHint")}
      >
        <span className="artifact-plaque-icon" aria-hidden>
          <MediaKindIcon kind={artifact.mediaKind} />
        </span>
        <span className="artifact-plaque-body">
          <span className="artifact-plaque-ext">{extLabel}</span>
          <span className="artifact-plaque-name" title={artifact.filename}>
            {artifact.filename}
          </span>
          {artifact.sizeBytes > 0 && (
            <span className="artifact-plaque-size">{formatFileSize(artifact.sizeBytes)}</span>
          )}
        </span>
        <span className="artifact-plaque-action">
          {busy ? t("app.artifact.opening") : t("app.artifact.open")}
        </span>
      </button>
      {onQuote && (
        <button
          type="button"
          className="artifact-plaque-quote"
          onClick={(e) => { e.stopPropagation(); onQuote(); }}
          title={t("app.attachment.quote")}
          aria-label={t("app.attachment.quote")}
        >
          ⌄
        </button>
      )}
    </div>
  );
}
