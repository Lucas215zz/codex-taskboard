import { useEffect, useRef, useState } from "react";
import { useTaskboardI18n } from "../i18n";

export function VersionBadge({ version }: { version?: string }) {
  const { text } = useTaskboardI18n();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const trimmed = version?.trim() ?? "";

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  if (!trimmed) return null;

  const label = trimmed === "development" ? "dev" : `v${trimmed}`;

  const copyVersion = () => {
    void navigator.clipboard?.writeText(trimmed).then(() => {
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => undefined);
  };

  return (
    <button
      type="button"
      className={`version-badge${copied ? " version-badge-copied" : ""}`}
      onClick={copyVersion}
      title={text(
        `版本号 ${trimmed}，点击复制以便排查问题`,
        `Version ${trimmed}. Click to copy for troubleshooting.`,
      )}
      aria-label={text(
        `版本号 ${trimmed}，点击复制以便排查问题`,
        `Version ${trimmed}. Click to copy for troubleshooting.`,
      )}
    >
      <span className="version-badge-label">{label}</span>
      {copied ? <span className="version-badge-hint">{text("已复制", "Copied")}</span> : null}
    </button>
  );
}
