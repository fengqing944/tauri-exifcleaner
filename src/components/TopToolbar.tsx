import type { RuntimeInfo } from "../app-shared";
import { StatusBadge } from "./AppPrimitives";

export function TopToolbar(props: {
  runtimeInfo: RuntimeInfo | null;
  canStart: boolean;
  isRunning: boolean;
  isScanning: boolean;
  parallelism: number;
  onParallelismChange: (value: number) => void;
  onStartCleanup: () => void;
  onCancelCurrent: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-main">
        <div className="brand-block">
          <strong>MetaSweep</strong>
          <span>元数据清理工具</span>
        </div>
        <div className="topbar-meta">
          <StatusBadge
            tone={props.runtimeInfo?.exiftoolReady ? "success" : "warning"}
            label={props.runtimeInfo?.exiftoolReady ? "引擎就绪" : "引擎未就绪"}
          />
          <span>{props.runtimeInfo?.exiftoolVersion ? `ExifTool ${props.runtimeInfo.exiftoolVersion}` : "ExifTool"}</span>
          <span>原地覆盖</span>
        </div>
      </div>

      <div className="topbar-toolbar">
        <div className="toolbar-group">
          <button className="button button-primary" type="button" disabled={!props.canStart} onClick={props.onStartCleanup}>
            开始清理
          </button>
          <button className="button" type="button" disabled={!props.isRunning && !props.isScanning} onClick={props.onCancelCurrent}>
            {props.isRunning ? "取消清理" : "取消扫描"}
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
            <strong>{props.parallelism}</strong>
          </div>
        </div>
      </div>
    </header>
  );
}
