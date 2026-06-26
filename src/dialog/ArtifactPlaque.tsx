import { t } from "../i18n";
import type { ArtifactData } from "./artifactMedia";
import { extensionBadge, formatFileSize } from "./artifactMedia";
import { MediaKindIcon } from "./MediaKindIcon";

interface ArtifactPlaqueProps {
  artifact: ArtifactData;
  busy?: boolean;
  onOpen: () => void;
}

export function ArtifactPlaque({ artifact, busy, onOpen }: ArtifactPlaqueProps): React.ReactElement {
  const extLabel = extensionBadge(artifact.extension);

  return (
    <button
      type="button"
      className="artifact-plaque"
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
  );
}
