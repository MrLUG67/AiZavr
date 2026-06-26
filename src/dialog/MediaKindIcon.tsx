import type { MediaKind } from "./artifactMedia";
import type { ReactElement } from "react";

interface MediaKindIconProps {
  kind: MediaKind;
  className?: string;
}

/** Иконки смысла медиа (D-092) — inline SVG, без внешних зависимостей. */
export function MediaKindIcon({ kind, className = "" }: MediaKindIconProps): ReactElement {
  const common = {
    className: `artifact-kind-icon ${className}`.trim(),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (kind) {
    case "image":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="8.5" cy="10" r="1.5" fill="currentColor" stroke="none" />
          <path d="M21 16l-5.5-5.5L5 19" />
        </svg>
      );
    case "audio":
      return (
        <svg {...common}>
          <path d="M9 18V6l10-2v14" />
          <circle cx="7" cy="18" r="3" />
          <circle cx="17" cy="16" r="3" />
        </svg>
      );
    case "video":
      return (
        <svg {...common}>
          <rect x="3" y="6" width="14" height="12" rx="2" />
          <path d="M17 10l4-2v8l-4-2" />
        </svg>
      );
    case "model_3d":
      return (
        <svg {...common}>
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
          <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
        </svg>
      );
    case "document":
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
          <path d="M14 3v5h5" />
          <path d="M9 13h6M9 17h4" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
          <path d="M14 3v5h5" />
        </svg>
      );
  }
}
