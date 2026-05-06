import type { CleanupOutputMode, RuntimeInfo } from "../app-shared";
import { StatusBadge } from "./AppPrimitives";

export function TopToolbar(props: {
  runtimeInfo: RuntimeInfo | null;
  canStart: boolean;
  isRunning: boolean;
  isScanning: boolean;
  parallelism: number;
  cleanupOutputMode: CleanupOutputMode;
  toolbarNote: string;
  detailsLabel: string;
  isDetailsOpen: boolean;
  isHelpOpen: boolean;
  isSettingsOpen: boolean;
  isAboutOpen: boolean;
  onStartCleanup: () => void;
  onCancelCurrent: () => void;
  onToggleDetails: () => void;
  onToggleHelp: () => void;
  onToggleSettings: () => void;
  onToggleAbout: () => void;
}) {
  const exiftoolTone = props.runtimeInfo
    ? props.runtimeInfo.exiftoolReady
      ? "success"
      : "warning"
    : "info";
  const exiftoolLabel = props.runtimeInfo
    ? props.runtimeInfo.exiftoolReady
      ? props.runtimeInfo.exiftoolVersion
        ? `ExifTool ${props.runtimeInfo.exiftoolVersion}`
        : "ExifTool 就绪"
      : "ExifTool 未就绪"
    : "ExifTool 检查中";

  return (
    <header className="topbar">
      <div className="topbar-main">
        <div className="brand-block">
          <strong>TagSweep</strong>
          <span>元数据痕迹清理工具</span>
          {props.toolbarNote ? (
            <div className="topbar-note">{props.toolbarNote}</div>
          ) : null}
        </div>
        <div className="topbar-meta">
          <StatusBadge tone={exiftoolTone} label={exiftoolLabel} />
          <span className="topbar-meta-chip">
            {props.cleanupOutputMode === "mirror" ? "镜像输出" : "原地覆盖"}
          </span>
          <span className="topbar-meta-chip">并发 {props.parallelism}</span>
        </div>
      </div>

      <div className="topbar-toolbar">
        <div className="toolbar-group toolbar-main-actions">
          <button
            className="button button-primary toolbar-button toolbar-button-main"
            type="button"
            disabled={!props.canStart}
            onClick={props.onStartCleanup}
          >
            开始清理
          </button>
          <button
            className="button toolbar-button"
            type="button"
            disabled={!props.isRunning && !props.isScanning}
            onClick={props.onCancelCurrent}
          >
            {props.isRunning ? "取消清理" : "取消扫描"}
          </button>
          <button
            className={`button toolbar-button ${props.isDetailsOpen ? "button-active" : ""}`}
            type="button"
            onClick={props.onToggleDetails}
          >
            {props.isDetailsOpen ? "收起详情" : "运行详情"}
            {props.detailsLabel ? ` · ${props.detailsLabel}` : ""}
          </button>
        </div>

        <div className="toolbar-group toolbar-utility-group">
          <button
            className={`button toolbar-button toolbar-button-compact ${props.isHelpOpen ? "button-active" : ""}`}
            type="button"
            onClick={props.onToggleHelp}
          >
            {props.isHelpOpen ? "收起帮助" : "帮助"}
          </button>
          <button
            className={`button toolbar-button toolbar-button-compact ${props.isSettingsOpen ? "button-active" : ""}`}
            type="button"
            onClick={props.onToggleSettings}
          >
            {props.isSettingsOpen ? "收起设置" : "设置"}
          </button>
          <button
            className={`button toolbar-button toolbar-button-compact ${props.isAboutOpen ? "button-active" : ""}`}
            type="button"
            onClick={props.onToggleAbout}
          >
            {props.isAboutOpen ? "收起关于" : "关于"}
          </button>
        </div>
      </div>
    </header>
  );
}
