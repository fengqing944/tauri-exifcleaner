import { useEffect, useState } from "react";
import type { KeyboardEvent, MouseEvent, RefObject } from "react";

import type {
  ActivityState,
  CleanupSummary,
  FileRunState,
  FlyoutPosition,
  MetadataPreviewSnapshot,
  ProgressState,
  QueuedFile,
  QueueView,
} from "../app-shared";
import {
  formatBytes,
  getRowStatusDescriptor,
  normalizePath,
  QUEUE_ROW_HEIGHT,
  QUEUE_VIRTUAL_OVERSCAN,
  QUEUE_VIRTUALIZE_THRESHOLD,
  resolveAfterCountLabel,
  trimMiddle,
} from "../app-shared";
import { Panel, StatChip, StatusBadge } from "./AppPrimitives";
import { MetadataPreviewFlyout } from "./MetadataPreviewFlyout";

export function WorkbenchPanel(props: {
  dropActive: boolean;
  isScanning: boolean;
  isRunning: boolean;
  isBusy: boolean;
  summary: CleanupSummary | null;
  fileCount: number;
  rootCount: number;
  ignoredCount: number;
  queueView: QueueView | null;
  progress: ProgressState;
  progressPercent: number;
  activity: ActivityState;
  previewFiles: QueuedFile[];
  fileStates: Record<string, FileRunState>;
  beforeSnapshots: Record<string, MetadataPreviewSnapshot>;
  afterSnapshots: Record<string, MetadataPreviewSnapshot>;
  loadingSnapshots: Record<string, boolean>;
  hoveredPathKey: string | null;
  selectedPreviewPathKey: string | null;
  highlightedPathKey: string;
  hasMoreQueueFiles: boolean;
  isLoadingQueuePage: boolean;
  previewFile: QueuedFile | null;
  previewRowState?: FileRunState;
  previewBeforeSnapshot?: MetadataPreviewSnapshot;
  previewAfterSnapshot?: MetadataPreviewSnapshot;
  previewBeforeLoading: boolean;
  previewAfterLoading: boolean;
  flyoutPosition: FlyoutPosition;
  tableShellRef: RefObject<HTMLDivElement | null>;
  queueBodyRef: RefObject<HTMLDivElement | null>;
  onAddFiles: () => void;
  onAddFolders: () => void;
  onClearQueue: () => void;
  onScheduleHover: (pathKey: string, event: MouseEvent<HTMLDivElement>) => void;
  onAnchorPreview: (pathKey: string, row: HTMLDivElement) => void;
  onPreviewKeyDown: (
    pathKey: string,
    row: HTMLDivElement,
    event: KeyboardEvent<HTMLDivElement>,
  ) => void;
  onClearHover: () => void;
  onFlyoutEnter: () => void;
  onFlyoutLeave: () => void;
  onRegisterRowRef: (pathKey: string, row: HTMLDivElement | null) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const body = props.queueBodyRef.current;
    if (!body) {
      return;
    }

    const syncViewport = () => {
      setScrollTop(body.scrollTop);
      setViewportHeight(body.clientHeight);
    };

    syncViewport();
    body.addEventListener("scroll", syncViewport, { passive: true });
    const observer = new ResizeObserver(syncViewport);
    observer.observe(body);

    return () => {
      body.removeEventListener("scroll", syncViewport);
      observer.disconnect();
    };
  }, [props.fileCount, props.queueBodyRef]);

  const aside = props.isScanning ? (
    <StatusBadge tone="info" label="扫描中" />
  ) : props.isRunning ? (
    <StatusBadge tone="info" label="处理中" />
  ) : props.summary ? (
    <StatusBadge tone={props.summary.cancelled ? "warning" : "success"} label={props.summary.cancelled ? "已取消" : "已完成"} />
  ) : (
    <StatusBadge tone={props.dropActive ? "info" : "neutral"} label={props.dropActive ? "释放导入" : "待命"} />
  );

  const shouldVirtualize = props.previewFiles.length > QUEUE_VIRTUALIZE_THRESHOLD;
  const visibleStart = shouldVirtualize
    ? Math.max(0, Math.floor(scrollTop / QUEUE_ROW_HEIGHT) - QUEUE_VIRTUAL_OVERSCAN)
    : 0;
  const visibleCount = shouldVirtualize
    ? Math.ceil((viewportHeight || QUEUE_ROW_HEIGHT) / QUEUE_ROW_HEIGHT) +
      QUEUE_VIRTUAL_OVERSCAN * 2
    : props.previewFiles.length;
  const visibleEnd = shouldVirtualize
    ? Math.min(props.previewFiles.length, visibleStart + visibleCount)
    : props.previewFiles.length;
  const visibleFiles = shouldVirtualize
    ? props.previewFiles.slice(visibleStart, visibleEnd)
    : props.previewFiles;
  const topSpacerHeight = shouldVirtualize ? visibleStart * QUEUE_ROW_HEIGHT : 0;
  const bottomSpacerHeight = shouldVirtualize
    ? Math.max(0, (props.previewFiles.length - visibleEnd) * QUEUE_ROW_HEIGHT)
    : 0;

  return (
    <Panel title="工作台" subtitle="导入、列表、任务状态和调试都集中在这里，整体更紧凑。" aside={aside}>
      <div className={`queue-workspace compact-workbench ${props.dropActive ? "is-drop-active" : ""}`}>
        <div className="queue-workspace-toolbar compact-workbench-toolbar">
          <div className="queue-workspace-copy">
            <strong>{props.fileCount ? "拖到这里可继续追加文件" : "拖放区域与文件列表已合并"}</strong>
            <span>
              {props.fileCount
                ? "列表、进度和调试都已收进同一个工作台。"
                : "拖放图像、视频或 PDF 到这里，或直接点击按钮导入。"}
            </span>
          </div>

          <div className="import-actions compact-actions">
            <button className="button button-primary" type="button" onClick={props.onAddFiles} disabled={props.isBusy}>
              添加文件
            </button>
            <button className="button" type="button" onClick={props.onAddFolders} disabled={props.isBusy}>
              添加文件夹
            </button>
            <button className="button button-danger" type="button" onClick={props.onClearQueue} disabled={props.isBusy}>
              清空
            </button>
          </div>
        </div>

        <div className="workbench-meta-row">
          <div className="summary-strip compact-summary-strip">
            <StatChip label="输入根" value={String(props.rootCount)} />
            <StatChip label="候选" value={String(props.fileCount)} />
            <StatChip label="大小" value={formatBytes(props.queueView?.totalBytes ?? 0)} />
            <StatChip label="成功" value={String(props.progress.succeeded)} />
            <StatChip label="失败" value={String(props.progress.failed)} />
            <StatChip label="忽略" value={String(props.ignoredCount)} />
          </div>

          <div className="activity-strip compact-activity-strip">
            <div className="activity-main">
              <span className="activity-label">{props.activity.label}</span>
              <strong title={props.activity.title}>{trimMiddle(props.activity.title, 72)}</strong>
            </div>
            <div className="activity-stats">
              <span>
                {props.progress.completed}/{props.progress.total || props.fileCount}
              </span>
              <span>{props.progressPercent}%</span>
              <span>{props.progress.currentStatus}</span>
            </div>
          </div>
        </div>

        {props.ignoredCount > 0 ? (
          <div className="message warning compact-message">
            已忽略 {props.ignoredCount} 个不支持的项目。
            {props.queueView?.ignoredSamples.length ? ` 示例: ${props.queueView.ignoredSamples.join(" · ")}` : ""}
          </div>
        ) : null}

        {!props.fileCount ? (
          <button
            className={`dropzone queue-dropstage compact-dropstage ${props.dropActive ? "active" : ""}`}
            type="button"
            disabled={props.isBusy}
            onClick={props.onAddFiles}
          >
            <strong>拖入文件或点击导入</strong>
            <span>支持多文件、多文件夹和递归扫描。这里就是你的主工作区。</span>
          </button>
        ) : (
          <div
            className={`table-shell queue-list-shell compact-list-shell ${props.previewFile ? "is-flyout-open" : ""}`}
            ref={props.tableShellRef}
            onMouseLeave={props.onClearHover}
          >
            <div className="table-head compact-table-head">
              <span>选中的文件</span>
              <span># 处理前</span>
              <span># 处理后</span>
              <span>状态</span>
            </div>

            <div className="table-body queue-scroll-body compact-scroll-body" ref={props.queueBodyRef}>
              {topSpacerHeight ? (
                <div
                  aria-hidden="true"
                  className="queue-virtual-spacer"
                  style={{ height: `${topSpacerHeight}px` }}
                />
              ) : null}

              {visibleFiles.map((file) => {
                const pathKey = normalizePath(file.sourcePath);
                const rowState = props.fileStates[pathKey];
                const beforeSnapshot = props.beforeSnapshots[pathKey];
                const afterSnapshot = props.afterSnapshots[pathKey];
                const beforeLoading = Boolean(props.loadingSnapshots[`before:${pathKey}`]);
                const afterLoading = Boolean(props.loadingSnapshots[`after:${pathKey}`]);
                const isPreviewing = props.hoveredPathKey === pathKey;
                const isSelected = props.selectedPreviewPathKey === pathKey;
                const isActive = props.highlightedPathKey === pathKey && props.isRunning;
                const rowStatus = getRowStatusDescriptor(rowState);

                return (
                  <div
                    key={file.sourcePath}
                    ref={(row) => props.onRegisterRowRef(pathKey, row)}
                    className={`queue-row compact-row ${isActive ? "is-active" : ""} ${isPreviewing ? "is-hovered" : ""} ${isSelected ? "is-selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    onMouseEnter={(event) => props.onScheduleHover(pathKey, event)}
                    onMouseLeave={props.onClearHover}
                    onFocus={(event) => props.onAnchorPreview(pathKey, event.currentTarget)}
                    onClick={(event) => props.onAnchorPreview(pathKey, event.currentTarget)}
                    onKeyDown={(event) =>
                      props.onPreviewKeyDown(pathKey, event.currentTarget, event)
                    }
                  >
                    <div className="queue-file">
                      <strong title={file.relativePath}>{trimMiddle(file.relativePath, 44)}</strong>
                      <span title={file.sourcePath}>{trimMiddle(file.sourcePath, 68)}</span>
                    </div>
                    <span className="queue-count">{beforeSnapshot ? beforeSnapshot.count : beforeLoading ? "读取中" : "—"}</span>
                    <span className="queue-count">{resolveAfterCountLabel(afterSnapshot, rowState, afterLoading)}</span>
                    <span className={`row-pill ${rowStatus.tone}`}>{rowStatus.label}</span>
                  </div>
                );
              })}

              {bottomSpacerHeight ? (
                <div
                  aria-hidden="true"
                  className="queue-virtual-spacer"
                  style={{ height: `${bottomSpacerHeight}px` }}
                />
              ) : null}
            </div>

            {props.hasMoreQueueFiles ? (
              <div className="queue-scroll-hint">
                {props.isLoadingQueuePage ? "正在继续载入列表..." : "继续向下滚动以载入更多文件"}
              </div>
            ) : null}

            {props.previewFile ? (
              <div
                className="preview-flyout-shell"
                style={{ left: `${props.flyoutPosition.left}px`, top: `${props.flyoutPosition.top}px` }}
                onMouseEnter={props.onFlyoutEnter}
                onMouseLeave={props.onFlyoutLeave}
              >
                <MetadataPreviewFlyout
                  file={props.previewFile}
                  beforeSnapshot={props.previewBeforeSnapshot}
                  afterSnapshot={props.previewAfterSnapshot}
                  rowState={props.previewRowState}
                  beforeLoading={props.previewBeforeLoading}
                  afterLoading={props.previewAfterLoading}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="workbench-bottom">
        <div className={`task-callout compact-callout ${props.summary?.cancelled ? "warning" : props.summary ? "success" : "neutral"}`}>
          {props.summary ? (
            props.summary.cancelled ? (
              <span>
                任务已取消，已完成 {props.summary.succeeded + props.summary.failed}/{props.summary.total} 项。
              </span>
            ) : (
              <span>任务完成，成功 {props.summary.succeeded} 项，失败 {props.summary.failed} 项。</span>
            )
          ) : (
            <span>清理开始后，这里会持续显示当前任务状态。</span>
          )}
        </div>
      </div>
    </Panel>
  );
}
