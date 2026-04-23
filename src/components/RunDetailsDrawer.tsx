import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { MetadataDebugEntry, MetadataDebugState } from "../app-shared";
import { trimMiddle } from "../app-shared";
import { EmptyBox, StatusBadge } from "./AppPrimitives";

export function RunDetailsDrawer(props: {
  isOpen: boolean;
  isRunning: boolean;
  metadataDebug: MetadataDebugState;
  metadataDebugEntries: MetadataDebugEntry[];
  debugLogPath: string;
  runFailures: Array<{ sourcePath: string; error: string }>;
  onClose: () => void;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const drawer = drawerRef.current;
    if (!drawer) {
      return;
    }

    const focusableElements = Array.from(
      drawer.querySelectorAll<HTMLElement>(
        'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute("disabled"));

    if (!focusableElements.length) {
      event.preventDefault();
      drawer.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      if (!activeElement || activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      }
      return;
    }

    if (activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  if (!props.isOpen) {
    return null;
  }

  return (
    <div className="details-drawer-backdrop" onClick={props.onClose}>
      <aside
        ref={drawerRef}
        className="details-drawer"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="details-drawer-head">
          <div>
            <strong>运行详情</strong>
            <span>
              {props.metadataDebug.status === "running"
                ? "字段读取中"
                : props.runFailures.length
                  ? `${props.runFailures.length} 条错误`
                  : "调试与错误信息"}
            </span>
          </div>
          <button ref={closeButtonRef} className="button" type="button" onClick={props.onClose}>
            关闭
          </button>
        </div>

        <div className="details-drawer-body">
          <div className="debug-block compact-debug-block">
            <div className="task-block-head">
              <strong>字段调试</strong>
              <span>{props.metadataDebug.lastOrigin}</span>
            </div>
            <div className="debug-strip">
              <StatusBadge
                tone={
                  props.metadataDebug.status === "error"
                    ? "danger"
                    : props.metadataDebug.status === "running"
                      ? "info"
                      : props.metadataDebug.status === "success"
                        ? "success"
                        : "neutral"
                }
                label={
                  props.metadataDebug.status === "error"
                    ? "异常"
                    : props.metadataDebug.status === "running"
                      ? "读取中"
                      : props.metadataDebug.status === "success"
                        ? "最近成功"
                        : "空闲"
                }
              />
              <span>批次 {props.metadataDebug.pendingBatches}</span>
              <span>文件 {props.metadataDebug.pendingFiles}</span>
              <span>{props.metadataDebug.lastDurationMs ? `${props.metadataDebug.lastDurationMs} ms` : "等待中"}</span>
            </div>
            <div className="debug-copy">
              <span>{props.metadataDebug.lastMessage}</span>
              <span>
                最近返回 {props.metadataDebug.lastResolved} 项，缺失 {props.metadataDebug.lastMissing} 项
              </span>
              <span title={props.debugLogPath}>日志: {props.debugLogPath ? trimMiddle(props.debugLogPath, 52) : "未就绪"}</span>
            </div>
            {props.metadataDebugEntries.length ? (
              <div className="debug-entry-list">
                {props.metadataDebugEntries.map((entry) => (
                  <div key={entry.id} className={`debug-entry ${entry.tone}`}>
                    <strong>{entry.title}</strong>
                    <span>{entry.detail}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="task-errors-block compact-error-block">
            <div className="task-block-head">
              <strong>最近错误</strong>
              <span>{props.runFailures.length ? `${props.runFailures.length} 条` : "无错误"}</span>
            </div>
            {props.runFailures.length ? (
              <div className="failure-list task-failure-list">
                {props.runFailures.map((failure) => (
                  <div key={failure.sourcePath} className="failure-row compact-failure-row">
                    <strong title={failure.sourcePath}>{trimMiddle(failure.sourcePath, 42)}</strong>
                    <span>{failure.error}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyBox title="没有错误项" description="最近一次任务里没有记录失败项。" />
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
