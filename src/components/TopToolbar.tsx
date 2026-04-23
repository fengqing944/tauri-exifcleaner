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
  onParallelismChange: (value: number) => void;
  onStartCleanup: () => void;
  onCancelCurrent: () => void;
  onToggleDetails: () => void;
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
          <span className="toolbar-label">并发</span>
          <div className="toolbar-slider">
            <input
              type="range"
              min={1}
              max={props.runtimeInfo?.parallelismMax ?? 16}
              value={props.parallelism}
              onChange={(event) => props.onParallelismChange(Number(event.currentTarget.value))}
            />
            <strong className="toolbar-slider-value">{props.parallelism}</strong>
          </div>
        </div>
      </div>
    </header>
  );
}
