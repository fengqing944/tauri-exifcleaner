import { useEffect, useMemo, useState } from "react";
import type {
  BadgeTone,
  MetadataDebugEntry,
  MetadataDebugState,
} from "../app-shared";
import { trimMiddle } from "../app-shared";
import { EmptyBox, StatusBadge } from "./AppPrimitives";
import { UtilityDrawer } from "./UtilityDrawer";

const FAILURE_DISPLAY_LIMIT = 200;

type RunFailure = { sourcePath: string; error: string };

function metadataDebugTone(status: MetadataDebugState["status"]): BadgeTone {
  if (status === "error") {
    return "danger";
  }
  if (status === "running") {
    return "info";
  }
  if (status === "success") {
    return "success";
  }
  return "neutral";
}

function metadataDebugLabel(status: MetadataDebugState["status"]) {
  if (status === "error") {
    return "异常";
  }
  if (status === "running") {
    return "读取中";
  }
  if (status === "success") {
    return "最近成功";
  }
  return "空闲";
}

function buildFailureReport(failures: RunFailure[]) {
  return failures
    .map((failure, index) => {
      const number = String(index + 1).padStart(4, "0");
      return `${number}. ${failure.sourcePath}\n${failure.error}`;
    })
    .join("\n\n");
}

export function RunDetailsDrawer(props: {
  isOpen: boolean;
  isRunning: boolean;
  metadataDebug: MetadataDebugState;
  metadataDebugEntries: MetadataDebugEntry[];
  debugLogPath: string;
  runFailures: RunFailure[];
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const subtitle = props.isRunning
    ? "任务进行中，可查看字段调试和失败项。"
    : props.runFailures.length
      ? `${props.runFailures.length} 条失败项可查看`
      : "字段调试、日志位置和失败列表。";
  const durationLabel = props.metadataDebug.lastDurationMs
    ? `${props.metadataDebug.lastDurationMs} ms`
    : "等待中";

  useEffect(() => {
    setCopyState("idle");
  }, [props.runFailures]);

  const visibleFailures = useMemo(
    () => props.runFailures.slice(0, FAILURE_DISPLAY_LIMIT),
    [props.runFailures],
  );
  const hiddenFailureCount = Math.max(
    0,
    props.runFailures.length - visibleFailures.length,
  );
  const copyFailureLabel =
    copyState === "copied"
      ? "已复制"
      : copyState === "failed"
        ? "复制失败"
        : "复制全部";

  const handleCopyFailures = async () => {
    if (!props.runFailures.length) {
      return;
    }
    try {
      await navigator.clipboard.writeText(buildFailureReport(props.runFailures));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <UtilityDrawer
      isOpen={props.isOpen}
      title="运行详情"
      subtitle={subtitle}
      bodyClassName="run-details-body"
      onClose={props.onClose}
    >
      <section className="utility-section run-details-section">
        <div className="task-block-head">
          <strong>字段调试</strong>
          <span>{props.metadataDebug.lastOrigin || "尚未读取"}</span>
        </div>

        <div className="debug-strip">
          <StatusBadge
            tone={metadataDebugTone(props.metadataDebug.status)}
            label={metadataDebugLabel(props.metadataDebug.status)}
          />
          <span className="topbar-meta-chip">
            批次 {props.metadataDebug.pendingBatches}
          </span>
          <span className="topbar-meta-chip">
            文件 {props.metadataDebug.pendingFiles}
          </span>
          <span className="topbar-meta-chip">{durationLabel}</span>
        </div>

        <div className="utility-note debug-message-card">
          <strong>{props.metadataDebug.lastMessage || "暂无调试信息"}</strong>
          <span>
            最近返回 {props.metadataDebug.lastResolved} 项，缺失{" "}
            {props.metadataDebug.lastMissing} 项，失败{" "}
            {props.metadataDebug.lastErrors} 项
          </span>
          <span title={props.debugLogPath || "未启用"}>
            日志:{" "}
            {props.debugLogPath ? trimMiddle(props.debugLogPath, 52) : "未启用"}
          </span>
          {!props.debugLogPath ? (
            <span>
              需要写入调试日志时，可在启动前设置 TAGSWEEP_DEBUG_LOG=1。
            </span>
          ) : null}
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
        ) : (
          <EmptyBox
            title="暂无调试事件"
            description="字段读取完成后，这里会保留最近的诊断记录。"
          />
        )}
      </section>

      <section className="utility-section run-details-section">
        <div className="task-block-head">
          <strong>失败列表</strong>
          <div className="failure-head-actions">
            <span>
              {props.runFailures.length
                ? `${props.runFailures.length} 条`
                : "无错误"}
            </span>
            {props.runFailures.length ? (
              <button
                className="button toolbar-button-compact"
                type="button"
                onClick={handleCopyFailures}
              >
                {copyFailureLabel}
              </button>
            ) : null}
          </div>
        </div>
        {props.runFailures.length ? (
          <>
            {hiddenFailureCount ? (
              <div className="failure-list-note" aria-live="polite">
                已收集全部 {props.runFailures.length} 条失败项，界面仅显示前{" "}
                {FAILURE_DISPLAY_LIMIT} 条，复制可获取完整清单。
              </div>
            ) : null}
            <div className="failure-list task-failure-list">
              {visibleFailures.map((failure, index) => (
                <div
                  key={`${failure.sourcePath}-${index}`}
                  className="failure-row compact-failure-row"
                >
                  <strong title={failure.sourcePath}>
                    {trimMiddle(failure.sourcePath, 42)}
                  </strong>
                  <span>{failure.error}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <EmptyBox
            title="没有错误项"
            description="最近一次任务里没有记录失败项。"
          />
        )}
      </section>
    </UtilityDrawer>
  );
}
