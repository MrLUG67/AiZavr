// Метаданные и иконки артефактов в ленте (D-092).

export type MediaKind =
  | "image"
  | "audio"
  | "video"
  | "model_3d"
  | "document"
  | "other";

export interface ArtifactData {
  mediaKind: MediaKind;
  filename: string;
  extension: string;
  mime: string | null;
  sizeBytes: number;
  storagePath: string;
}

const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "heic", "avif", "tiff", "tif",
]);
const AUDIO_EXT = new Set([
  "mp3", "wav", "flac", "ogg", "oga", "aac", "m4a", "wma", "opus",
]);
const VIDEO_EXT = new Set([
  "mp4", "webm", "mkv", "avi", "mov", "m4v", "wmv", "mpeg", "mpg",
]);
const MODEL3D_EXT = new Set([
  "glb", "gltf", "obj", "fbx", "stl", "ply", "dae", "3ds", "blend",
]);
const DOC_EXT = new Set([
  "pdf", "doc", "docx", "txt", "md", "rtf", "odt", "xls", "xlsx", "ppt", "pptx", "csv",
]);

export function inferMediaKind(extension: string): MediaKind {
  const e = extension.replace(/^\./, "").toLowerCase();
  if (IMAGE_EXT.has(e)) return "image";
  if (AUDIO_EXT.has(e)) return "audio";
  if (VIDEO_EXT.has(e)) return "video";
  if (MODEL3D_EXT.has(e)) return "model_3d";
  if (DOC_EXT.has(e)) return "document";
  return "other";
}

export function parseMessageAttachments(extra: string | null | undefined): ArtifactData[] {
  if (!extra) return [];
  try {
    const root = JSON.parse(extra) as { attachments?: Record<string, unknown>[] };
    const list = root.attachments;
    if (!Array.isArray(list)) return [];

    return list
      .map((a) => {
        if (!a || typeof a !== "object") return null;
        const extension = String(a.extension ?? "").toLowerCase();
        const mediaKindRaw = a.media_kind;
        const mediaKind =
          typeof mediaKindRaw === "string" &&
          ["image", "audio", "video", "model_3d", "document", "other"].includes(mediaKindRaw)
            ? (mediaKindRaw as MediaKind)
            : inferMediaKind(extension);

        return {
          mediaKind,
          filename: String(a.filename ?? "file"),
          extension,
          mime: typeof a.mime === "string" ? a.mime : null,
          sizeBytes: typeof a.size_bytes === "number" ? a.size_bytes : 0,
          storagePath: String(a.storage_path ?? ""),
        } satisfies ArtifactData;
      })
      .filter((x): x is ArtifactData => x !== null);
  } catch {
    return [];
  }
}

export function parseArtifactExtra(extra: string | null | undefined): ArtifactData | null {
  if (!extra) return null;
  try {
    const root = JSON.parse(extra) as { artifact?: Record<string, unknown> };
    const a = root.artifact;
    if (!a || typeof a !== "object") return null;

    const extension = String(a.extension ?? "").toLowerCase();
    const mediaKindRaw = a.media_kind;
    const mediaKind =
      typeof mediaKindRaw === "string" &&
      ["image", "audio", "video", "model_3d", "document", "other"].includes(mediaKindRaw)
        ? (mediaKindRaw as MediaKind)
        : inferMediaKind(extension);

    return {
      mediaKind,
      filename: String(a.filename ?? "file"),
      extension,
      mime: typeof a.mime === "string" ? a.mime : null,
      sizeBytes: typeof a.size_bytes === "number" ? a.size_bytes : 0,
      storagePath: String(a.storage_path ?? ""),
    };
  } catch {
    return null;
  }
}

/** Метка расширения для плашки: `.PNG` */
export function extensionBadge(ext: string): string {
  const bare = ext.replace(/^\./, "").trim();
  if (!bare) return ".???";
  return `.${bare.toUpperCase()}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
