import type { RuntimeInfo } from "../app-shared";
import { StatusBadge } from "./AppPrimitives";

export function TopToolbar(props: {
  runtimeInfo: RuntimeInfo | null;
  canStart: boolean;
  isRunning: boolean;
  isScanning: boolean;
  parallelism: number;
  toolbarNote: string;
  detailsLabel: string;
  isDetailsOpen: boolean;
  isHelpOpen: boolean;
  isSettingsOpen: boolean;
  onStartCleanup: () => void;
  onCancelCurrent: () => void;
  onToggleDetails: () => void;
  onToggleHelp: () => void;
  onToggleSettings: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-main">
        <div className="brand-block">
          <strong>TagSweep</strong>
          <span>元数据痕迹清理工具</span>
          <div className="topbar-note">{props.toolbarNote}</div>
        </div>
        <div className="topbar-meta">
          <StatusBadge
            tone={props.runtimeInfo?.exiftoolReady ? "success" : "warning"}
            label={props.runtimeInfo?.exiftoolReady ? "引擎就绪" : "引擎未就绪"}
          />
          <span className="topbar-meta-chip">
            {props.runtimeInfo?.exiftoolVersion
              ? `ExifTool ${props.runtimeInfo.exiftoolVersion}`
              : "ExifTool"}
          </span>
          <span className="topbar-meta-chip">原地覆盖</span>
          <span className="topbar-meta-chip">并发 {props.parallelism}</span>
        </div>
      </div>

      <div className="topbar-toolbar">
        <div className="toolbar-group">
          <button
            className="button button-primary toolbar-button"
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

        <div className="toolbar-group toolbar-meta-group">
          <button
            className={`button toolbar-button ${props.isHelpOpen ? "button-active" : ""}`}
            type="button"
            onClick={props.onToggleHelp}
          >
            {props.isHelpOpen ? "收起帮助" : "帮助"}
          </button>
          <button
            className={`button toolbar-button ${props.isSettingsOpen ? "button-active" : ""}`}
            type="button"
            onClick={props.onToggleSettings}
          >
            {props.isSettingsOpen ? "收起设置" : "设置"}
          </button>
        </div>
      </div>
    </header>
  );
}
