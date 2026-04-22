import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

type OutputMode = "mirror" | "overwrite";
type CleanupStatus = "running" | "success" | "failed" | "cancelled";
type BadgeTone = "success" | "warning" | "info" | "neutral" | "danger";

type RuntimeInfo = {
  defaultOutputDir: string;
  parallelismDefault: number;
  parallelismMax: number;
  exiftoolReady: boolean;
  exiftoolVersion: string | null;
  exiftoolPath: string | null;
};

type QueuedFile = {
  sourcePath: string;
  relativePath: string;
  rootLabel: string;
  rootSourcePath: string;
  sizeBytes: number;
  fromDirectory: boolean;
};

type QueueView = {
  supportedCount: number;
  totalBytes: number;
  ignoredCount: number;
  ignoredSamples: string[];
  previewFiles: QueuedFile[];
  rootCount: number;
};

type ScanProgressEvent = {
  view: QueueView;
  done: boolean;
  cancelled: boolean;
};

type ScanSummary = {
  view: QueueView;
  cancelled: boolean;
};

type CleanupProgressEvent = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentPath: string;
  outputPath: string | null;
  status: CleanupStatus;
  error: string | null;
};

type CleanupSummary = {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: boolean;
  outputDir: string | null;
  failures: Array<{
    sourcePath: string;
    error: string;
  }>;
};

type ProgressState = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentPath: string;
  currentStatus: string;
};

type MetadataFieldPreview = {
  group: string;
  name: string;
  valuePreview: string;
};

type MetadataPreviewSnapshot = {
  count: number;
  fields: MetadataFieldPreview[];
  truncated: boolean;
};

type MetadataSnapshotRequest = {
  requestKey: string;
  filePath: string;
};

type MetadataSnapshotResponse = {
  requestKey: string;
  snapshot: MetadataPreviewSnapshot;
  missing: boolean;
};

type FileRunState = {
  status: CleanupStatus;
  outputPath: string | null;
  error: string | null;
};

type FlyoutPosition = {
  left: number;
  top: number;
};

const EMPTY_PROGRESS: ProgressState = {
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  currentPath: "",
  currentStatus: "idle",
};

function App() {
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [queueView, setQueueView] = useState<QueueView | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [parallelism, setParallelism] = useState(2);
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [runFailures, setRunFailures] = useState<Array<{ sourcePath: string; error: string }>>([]);
  const [summary, setSummary] = useState<CleanupSummary | null>(null);
  const [fileStates, setFileStates] = useState<Record<string, FileRunState>>({});
  const [beforeSnapshots, setBeforeSnapshots] = useState<Record<string, MetadataPreviewSnapshot>>(
    {},
  );
  const [afterSnapshots, setAfterSnapshots] = useState<Record<string, MetadataPreviewSnapshot>>({});
  const [loadingSnapshots, setLoadingSnapshots] = useState<Record<string, boolean>>({});
  const [hoveredPathKey, setHoveredPathKey] = useState<string | null>(null);
  const [flyoutPosition, setFlyoutPosition] = useState<FlyoutPosition>({ left: 16, top: 52 });

  const pendingProgressRef = useRef<CleanupProgressEvent | null>(null);
  const dropActiveRef = useRef(false);
  const hoverTimeoutRef = useRef<number | null>(null);
  const flyoutActiveRef = useRef(false);
  const tableShellRef = useRef<HTMLDivElement | null>(null);

  const progressPercent = progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;
  const isBusy = isScanning || isRunning;
  const fileCount = queueView?.supportedCount ?? 0;
  const rootCount = queueView?.rootCount ?? 0;
  const previewFiles = queueView?.previewFiles ?? [];
  const ignoredCount = queueView?.ignoredCount ?? 0;
  const moreFiles = Math.max(0, fileCount - previewFiles.length);
  const activePathKey = progress.currentPath ? normalizePath(progress.currentPath) : "";
  const previewFileKey = previewFiles.map((file) => normalizePath(file.sourcePath)).join("|");
  const outputMode: OutputMode = "overwrite";
  const canStart = fileCount > 0 && !isScanning && !isRunning;

  const runningPreviewPathKey =
    previewFiles
      .map((file) => normalizePath(file.sourcePath))
      .find((pathKey) => fileStates[pathKey]?.status === "running") ?? "";

  const highlightedPathKey = runningPreviewPathKey || activePathKey;
  const deferredHoveredPathKey = useDeferredValue(hoveredPathKey);
  const previewPathKey = hoveredPathKey ? deferredHoveredPathKey : null;
  const previewFile =
    previewFiles.find((file) => normalizePath(file.sourcePath) === previewPathKey) ?? null;

  const handleProgressEvent = useEffectEvent((payload: CleanupProgressEvent) => {
    pendingProgressRef.current = payload;
  });

  const handleCleanupFileEvent = useEffectEvent((payload: CleanupProgressEvent) => {
    const pathKey = normalizePath(payload.currentPath);

    startTransition(() => {
      setFileStates((current) => ({
        ...current,
        [pathKey]: {
          status: payload.status,
          outputPath: payload.outputPath,
          error: payload.error,
        },
      }));
    });
  });

  const handleScanProgressEvent = useEffectEvent((payload: ScanProgressEvent) => {
    startTransition(() => {
      setQueueView(payload.view);
      setProgress(createProgressState(payload.view.supportedCount));
      setSummary(null);
      setRunFailures([]);
    });
  });

  const resetRunState = useEffectEvent(() => {
    pendingProgressRef.current = null;
    setSummary(null);
    setRunFailures([]);
    setAfterSnapshots({});
    setFileStates({});
    setHoveredPathKey(null);
    flyoutActiveRef.current = false;
  });

  const scanInputPaths = useEffectEvent(async (paths: string[]) => {
    if (isRunning) {
      setErrorMessage("请等待当前清理任务结束后再追加导入。");
      return;
    }

    if (isScanning) {
      setErrorMessage("扫描尚未完成，请等待当前导入结束或先取消扫描。");
      return;
    }

    const cleanedPaths = normalizeSelection(paths);
    if (!cleanedPaths.length) {
      return;
    }

    setIsScanning(true);
    setErrorMessage(null);
    resetRunState();

    try {
      const result = await invoke<ScanSummary>("scan_inputs", {
        inputPaths: cleanedPaths,
      });

      startTransition(() => {
        setQueueView(result.view);
        setProgress(createProgressState(result.view.supportedCount));
      });
    } catch (error) {
      setErrorMessage(toMessage(error));
    } finally {
      setIsScanning(false);
    }
  });

  const handleWindowDrop = useEffectEvent((event: { payload: { type: string; paths?: string[] } }) => {
    switch (event.payload.type) {
      case "enter":
        if (!dropActiveRef.current) {
          dropActiveRef.current = true;
          setDropActive(true);
        }
        break;
      case "leave":
        if (dropActiveRef.current) {
          dropActiveRef.current = false;
          setDropActive(false);
        }
        break;
      case "drop":
        if (dropActiveRef.current) {
          dropActiveRef.current = false;
          setDropActive(false);
        }
        void scanInputPaths(event.payload.paths ?? []);
        break;
      default:
        break;
    }
  });

  useEffect(() => {
    let disposed = false;
    let unlistenWindowDrop: (() => void) | undefined;

    void invoke<RuntimeInfo>("get_runtime_info")
      .then((info) => {
        if (disposed) {
          return;
        }

        setRuntimeInfo(info);
        setParallelism(info.parallelismDefault);
      })
      .catch((error) => {
        if (!disposed) {
          setErrorMessage(toMessage(error));
        }
      });

    const cleanupProgressListener = listen<CleanupProgressEvent>("cleanup-progress", (event) =>
      handleProgressEvent(event.payload),
    );
    const cleanupFileListener = listen<CleanupProgressEvent>("cleanup-file", (event) =>
      handleCleanupFileEvent(event.payload),
    );
    const scanProgressListener = listen<ScanProgressEvent>("scan-progress", (event) =>
      handleScanProgressEvent(event.payload),
    );

    void getCurrentWindow()
      .onDragDropEvent((event) => handleWindowDrop(event as never))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenWindowDrop = unlisten;
      });

    return () => {
      disposed = true;
      if (hoverTimeoutRef.current) {
        window.clearTimeout(hoverTimeoutRef.current);
      }
      void cleanupProgressListener.then((unlisten) => unlisten());
      void cleanupFileListener.then((unlisten) => unlisten());
      void scanProgressListener.then((unlisten) => unlisten());
      unlistenWindowDrop?.();
    };
  }, [handleCleanupFileEvent, handleProgressEvent, handleScanProgressEvent, handleWindowDrop]);

  useEffect(() => {
    if (!previewFiles.length) {
      return;
    }

    const requests = previewFiles
      .filter((file) => !beforeSnapshots[normalizePath(file.sourcePath)])
      .map((file) => ({
        requestKey: normalizePath(file.sourcePath),
        filePath: file.sourcePath,
      }));

    if (!requests.length) {
      return;
    }

    let disposed = false;
    const loadingKeys = requests.map((request) => `before:${request.requestKey}`);

    startTransition(() => {
      setLoadingSnapshots((current) => {
        const next = { ...current };
        for (const key of loadingKeys) {
          next[key] = true;
        }
        return next;
      });
    });

    void invoke<MetadataSnapshotResponse[]>("load_metadata_snapshots", { requests })
      .then((responses) => {
        if (disposed) {
          return;
        }

        startTransition(() => {
          setBeforeSnapshots((current) => {
            const next = { ...current };
            for (const response of responses) {
              next[response.requestKey] = response.snapshot;
            }
            return next;
          });
        });
      })
      .catch((error) => {
        if (!disposed) {
          setErrorMessage(toMessage(error));
        }
      })
      .finally(() => {
        if (disposed) {
          return;
        }

        startTransition(() => {
          setLoadingSnapshots((current) => {
            const next = { ...current };
            for (const key of loadingKeys) {
              delete next[key];
            }
            return next;
          });
        });
      });

    return () => {
      disposed = true;
    };
  }, [beforeSnapshots, previewFileKey, previewFiles]);

  useEffect(() => {
    if (!previewFile || !previewPathKey) {
      return;
    }

    const pathKey = previewPathKey;
    const rowState = fileStates[pathKey];
    const afterLoadingKey = `after:${pathKey}`;

    if (
      rowState?.status !== "success" ||
      afterSnapshots[pathKey] ||
      loadingSnapshots[afterLoadingKey]
    ) {
      return;
    }

    let disposed = false;
    const targetPath = rowState.outputPath || previewFile.sourcePath;
    const requests: MetadataSnapshotRequest[] = [
      {
        requestKey: pathKey,
        filePath: targetPath,
      },
    ];

    startTransition(() => {
      setLoadingSnapshots((current) => ({
        ...current,
        [afterLoadingKey]: true,
      }));
    });

    void invoke<MetadataSnapshotResponse[]>("load_metadata_snapshots", { requests })
      .then((responses) => {
        if (disposed) {
          return;
        }

        startTransition(() => {
          setAfterSnapshots((current) => {
            const next = { ...current };
            for (const response of responses) {
              next[response.requestKey] = response.snapshot;
            }
            return next;
          });
        });
      })
      .catch((error) => {
        if (!disposed) {
          setErrorMessage(toMessage(error));
        }
      })
      .finally(() => {
        if (disposed) {
          return;
        }

        startTransition(() => {
          setLoadingSnapshots((current) => {
            const next = { ...current };
            delete next[afterLoadingKey];
            return next;
          });
        });
      });

    return () => {
      disposed = true;
    };
  }, [afterSnapshots, fileStates, loadingSnapshots, previewFile, previewPathKey]);

  useEffect(() => {
    if (!hoveredPathKey) {
      return;
    }

    const stillVisible = previewFiles.some(
      (file) => normalizePath(file.sourcePath) === hoveredPathKey,
    );
    if (!stillVisible) {
      setHoveredPathKey(null);
      flyoutActiveRef.current = false;
    }
  }, [hoveredPathKey, previewFiles]);

  useEffect(() => {
    if (!isRunning) {
      if (summary) {
        return;
      }

      const payload = pendingProgressRef.current;
      if (payload) {
        pendingProgressRef.current = null;
        setProgress({
          total: payload.total,
          completed: payload.completed,
          succeeded: payload.succeeded,
          failed: payload.failed,
          currentPath: payload.currentPath,
          currentStatus: payload.status,
        });
      }
      return;
    }

    const timer = window.setInterval(() => {
      const payload = pendingProgressRef.current;
      if (!payload) {
        return;
      }

      pendingProgressRef.current = null;
      startTransition(() => {
        setProgress({
          total: payload.total,
          completed: payload.completed,
          succeeded: payload.succeeded,
          failed: payload.failed,
          currentPath: payload.currentPath,
          currentStatus: payload.status,
        });

        if (payload.status === "failed" && payload.error) {
          setRunFailures((current) =>
            [
              {
                sourcePath: payload.currentPath,
                error: payload.error ?? "处理失败",
              },
              ...current,
            ].slice(0, 6),
          );
        }
      });
    }, 220);

    return () => window.clearInterval(timer);
  }, [isRunning, summary]);

  const addFiles = async () => {
    const selection = await open({
      title: "选择一个或多个文件",
      multiple: true,
      directory: false,
    });

    await scanInputPaths(selectionToArray(selection));
  };

  const addFolders = async () => {
    const selection = await open({
      title: "选择一个或多个文件夹",
      multiple: true,
      directory: true,
    });

    await scanInputPaths(selectionToArray(selection));
  };

  const startCleanup = async () => {
    if (!fileCount || !canStart) {
      return;
    }

    setIsRunning(true);
    setErrorMessage(null);
    setRunFailures([]);
    setSummary(null);
    setFileStates({});
    setAfterSnapshots({});
    setHoveredPathKey(null);
    pendingProgressRef.current = null;
    setProgress(createProgressState(fileCount));

    try {
      const result = await invoke<CleanupSummary>("run_cleanup", {
        options: {
          outputMode,
          outputDir: null,
          parallelism,
          preserveStructure: true,
        },
      });

      pendingProgressRef.current = null;
      setSummary(result);
      setRunFailures(result.failures.slice(0, 6));
      setProgress({
        total: result.total,
        completed: result.succeeded + result.failed,
        succeeded: result.succeeded,
        failed: result.failed,
        currentPath: "",
        currentStatus: result.cancelled ? "cancelled" : "done",
      });
    } catch (error) {
      setErrorMessage(toMessage(error));
    } finally {
      setIsRunning(false);
    }
  };

  const cancelCleanup = async () => {
    try {
      await invoke<boolean>("cancel_cleanup");
    } catch (error) {
      setErrorMessage(toMessage(error));
    }
  };

  const cancelScan = async () => {
    try {
      await invoke<boolean>("cancel_scan");
    } catch (error) {
      setErrorMessage(toMessage(error));
    }
  };

  const clearQueue = async () => {
    try {
      await invoke("clear_queue");
      setQueueView(null);
      setSummary(null);
      setRunFailures([]);
      setProgress(EMPTY_PROGRESS);
      setErrorMessage(null);
      setFileStates({});
      setBeforeSnapshots({});
      setAfterSnapshots({});
      setLoadingSnapshots({});
      setHoveredPathKey(null);
      flyoutActiveRef.current = false;
    } catch (error) {
      setErrorMessage(toMessage(error));
    }
  };

  const cancelHoverTimer = () => {
    if (hoverTimeoutRef.current) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  };

  const hidePreview = () => {
    cancelHoverTimer();
    flyoutActiveRef.current = false;
    setHoveredPathKey(null);
  };

  const positionFlyout = (event: React.MouseEvent<HTMLDivElement>) => {
    const shell = tableShellRef.current;
    if (!shell) {
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const rowRect = event.currentTarget.getBoundingClientRect();
    const estimatedWidth = Math.min(360, Math.max(260, shell.clientWidth - 112));
    const estimatedHeight = 310;
    const nextLeft = clampNumber(
      event.clientX - shellRect.left + 14,
      12,
      Math.max(12, shell.clientWidth - estimatedWidth - 12),
    );
    const nextTop = clampNumber(
      rowRect.top - shellRect.top + rowRect.height + 6,
      48,
      Math.max(48, shell.clientHeight - estimatedHeight - 12),
    );

    setFlyoutPosition({ left: nextLeft, top: nextTop });
  };

  const scheduleHover = (pathKey: string, event: React.MouseEvent<HTMLDivElement>) => {
    cancelHoverTimer();
    positionFlyout(event);
    startTransition(() => {
      setHoveredPathKey(pathKey);
    });
  };

  const clearHover = () => {
    cancelHoverTimer();
    hoverTimeoutRef.current = window.setTimeout(() => {
      if (flyoutActiveRef.current) {
        return;
      }
      setHoveredPathKey(null);
    }, 90);
  };

  const handleFlyoutEnter = () => {
    flyoutActiveRef.current = true;
    cancelHoverTimer();
  };

  const handleFlyoutLeave = () => {
    flyoutActiveRef.current = false;
    clearHover();
  };

  useEffect(() => {
    if (!previewPathKey) {
      return;
    }

    const handleWindowBlur = () => {
      hidePreview();
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const shell = tableShellRef.current;
      if (shell && target && shell.contains(target)) {
        return;
      }
      hidePreview();
    };

    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("pointerdown", handlePointerDown, true);

    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [previewPathKey]);

  const activity = buildActivityState({
    summary,
    isRunning,
    isScanning,
    fileCount,
    progress,
  });
  const previewRowState = previewPathKey ? fileStates[previewPathKey] : undefined;
  const previewBeforeSnapshot = previewPathKey ? beforeSnapshots[previewPathKey] : undefined;
  const previewAfterSnapshot = previewPathKey ? afterSnapshots[previewPathKey] : undefined;
  const previewBeforeLoading = previewPathKey ? Boolean(loadingSnapshots[`before:${previewPathKey}`]) : false;
  const previewAfterLoading = previewPathKey ? Boolean(loadingSnapshots[`after:${previewPathKey}`]) : false;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <strong>MetaSweep</strong>
          <span>元数据清理工具</span>
        </div>
        <div className="topbar-meta">
          <StatusBadge
            tone={runtimeInfo?.exiftoolReady ? "success" : "warning"}
            label={runtimeInfo?.exiftoolReady ? "引擎就绪" : "引擎未就绪"}
          />
          <span>{runtimeInfo?.exiftoolVersion ? `ExifTool ${runtimeInfo.exiftoolVersion}` : "ExifTool"}</span>
          <span>原地覆盖</span>
        </div>
      </header>

      <section className="workspace">
        <section className="content">
          <Panel
            title="工作区"
            subtitle="导入、预览和处理状态都收在一个区域里。悬停文件行可以查看处理前和处理后的字段摘要。"
            aside={
              isScanning ? (
                <StatusBadge tone="info" label="扫描中" />
              ) : isRunning ? (
                <StatusBadge tone="info" label="处理中" />
              ) : summary ? (
                <StatusBadge tone={summary.cancelled ? "warning" : "success"} label={summary.cancelled ? "已取消" : "已完成"} />
              ) : (
                <StatusBadge tone={dropActive ? "info" : "neutral"} label={dropActive ? "释放导入" : "待命"} />
              )
            }
          >
            <div className="import-strip">
              <button
                className={`dropzone compact-dropzone ${dropActive ? "active" : ""}`}
                type="button"
                disabled={isBusy}
                onClick={addFiles}
              >
                <strong>{fileCount ? "继续添加文件或文件夹" : "拖入文件或点击导入"}</strong>
                <span>支持多文件、多文件夹和递归扫描。</span>
              </button>

              <div className="import-actions">
                <button className="button button-primary" type="button" onClick={addFiles} disabled={isBusy}>
                  添加文件
                </button>
                <button className="button" type="button" onClick={addFolders} disabled={isBusy}>
                  添加文件夹
                </button>
                <button className="button button-danger" type="button" onClick={clearQueue} disabled={isBusy}>
                  清空
                </button>
              </div>
            </div>

            <div className="summary-strip">
              <StatChip label="输入根" value={String(rootCount)} />
              <StatChip label="候选文件" value={String(fileCount)} />
              <StatChip label="总大小" value={formatBytes(queueView?.totalBytes ?? 0)} />
              <StatChip label="忽略项" value={String(ignoredCount)} />
            </div>

            <div className="activity-strip">
              <div className="activity-main">
                <span className="activity-label">{activity.label}</span>
                <strong title={activity.title}>{trimMiddle(activity.title, 88)}</strong>
              </div>
              <div className="activity-stats">
                <span>
                  {progress.completed}/{progress.total || fileCount}
                </span>
                <span>{progressPercent}%</span>
                <span>{progress.currentStatus}</span>
              </div>
            </div>

            {ignoredCount > 0 ? (
              <div className="message warning">
                已忽略 {ignoredCount} 个不支持的项目。
                {queueView?.ignoredSamples.length ? ` 示例: ${queueView.ignoredSamples.join(" · ")}` : ""}
              </div>
            ) : null}

            {!fileCount ? (
              <EmptyBox title="未选择文件" description="拖放图像、视频或 PDF 文件以自动删除元数据。" />
            ) : (
              <div
                className={`table-shell ${previewFile ? "is-flyout-open" : ""}`}
                ref={tableShellRef}
                onMouseLeave={() => clearHover()}
              >
                <div className="table-head">
                  <span>选中的文件</span>
                  <span># 处理前</span>
                  <span># 处理后</span>
                  <span>状态</span>
                </div>

                <div className="table-body">
                  {previewFiles.map((file) => {
                    const pathKey = normalizePath(file.sourcePath);
                    const rowState = fileStates[pathKey];
                    const beforeSnapshot = beforeSnapshots[pathKey];
                    const afterSnapshot = afterSnapshots[pathKey];
                    const beforeLoading = Boolean(loadingSnapshots[`before:${pathKey}`]);
                    const afterLoading = Boolean(loadingSnapshots[`after:${pathKey}`]);
                    const isPreviewing = hoveredPathKey === pathKey;
                    const isActive = highlightedPathKey === pathKey && isRunning;
                    const rowStatus = getRowStatusDescriptor(rowState);

                    return (
                      <div
                        key={file.sourcePath}
                        className={`queue-row ${isActive ? "is-active" : ""} ${isPreviewing ? "is-hovered" : ""}`}
                        onMouseEnter={(event) => scheduleHover(pathKey, event)}
                        onMouseLeave={() => clearHover()}
                      >
                        <div className="queue-file">
                          <strong title={file.relativePath}>{trimMiddle(file.relativePath, 44)}</strong>
                          <span title={file.sourcePath}>{trimMiddle(file.sourcePath, 68)}</span>
                        </div>
                        <span className="queue-count">
                          {beforeSnapshot ? beforeSnapshot.count : beforeLoading ? "…" : "…"}
                        </span>
                        <span className="queue-count">
                          {resolveAfterCountLabel(afterSnapshot, rowState, afterLoading)}
                        </span>
                        <span className={`row-pill ${rowStatus.tone}`}>{rowStatus.label}</span>
                      </div>
                    );
                  })}
                </div>

                {previewFile ? (
                  <div
                    className="preview-flyout-shell"
                    style={{ left: `${flyoutPosition.left}px`, top: `${flyoutPosition.top}px` }}
                    onMouseEnter={handleFlyoutEnter}
                    onMouseLeave={handleFlyoutLeave}
                  >
                    <MetadataPreviewFlyout
                      file={previewFile}
                      beforeSnapshot={previewBeforeSnapshot}
                      afterSnapshot={previewAfterSnapshot}
                      rowState={previewRowState}
                      beforeLoading={previewBeforeLoading}
                      afterLoading={previewAfterLoading}
                    />
                  </div>
                ) : null}

                {moreFiles > 0 ? <div className="footnote">还有 {moreFiles} 个文件未展开显示。</div> : null}
              </div>
            )}
          </Panel>
        </section>

        <aside className="sidebar">
          <Panel
            title="任务"
            subtitle="这里显示总进度、最近结果和最近失败项。"
            aside={
              <StatusBadge
                tone={isRunning ? "info" : summary ? (summary.cancelled ? "warning" : "success") : "neutral"}
                label={isRunning ? "处理中" : summary ? (summary.cancelled ? "已取消" : "已完成") : "空闲"}
              />
            }
          >
            <div className="progress-panel">
              <div className="progress-head">
                <strong>{progressPercent}%</strong>
                <span>
                  {progress.completed}/{progress.total || fileCount}
                </span>
              </div>
              <div className="progress-track">
                <div className="progress-value" style={{ width: `${progressPercent}%` }} />
              </div>
              <div className="progress-meta">
                <span>成功 {progress.succeeded}</span>
                <span>失败 {progress.failed}</span>
                <span>{progress.currentStatus}</span>
              </div>
            </div>

            {summary ? (
              <div className={`message ${summary.cancelled ? "warning" : "success"}`}>
                {summary.cancelled
                  ? `任务已取消，已完成 ${summary.succeeded + summary.failed}/${summary.total} 项。`
                  : `任务完成，成功 ${summary.succeeded} 项，失败 ${summary.failed} 项。`}
              </div>
            ) : (
              <div className="message neutral">开始清理后，这里会保留最近一次任务结果。</div>
            )}

            {runFailures.length ? (
              <div className="failure-list">
                {runFailures.map((failure) => (
                  <div key={failure.sourcePath} className="failure-row">
                    <strong title={failure.sourcePath}>{trimMiddle(failure.sourcePath, 42)}</strong>
                    <span>{failure.error}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyBox title="没有错误项" description="最近一次任务里没有记录失败项。" />
            )}
          </Panel>

          <Panel title="操作" subtitle="默认原地覆盖，只保留必要执行项。">
            <div className="message neutral">清理结果会直接写回原文件，不再显示输出模式和目录设置。</div>

            <label className="field">
              <span>并发任务数</span>
              <div className="slider-row">
                <input
                  type="range"
                  min={1}
                  max={runtimeInfo?.parallelismMax ?? 16}
                  value={parallelism}
                  onChange={(event) => setParallelism(Number(event.currentTarget.value))}
                />
                <strong>{parallelism}</strong>
              </div>
            </label>

            <div className="button-row actions-row">
              <button
                className="button button-primary"
                type="button"
                disabled={!canStart}
                onClick={startCleanup}
              >
                开始清理
              </button>
              <button
                className="button"
                type="button"
                disabled={!isRunning && !isScanning}
                onClick={isRunning ? cancelCleanup : cancelScan}
              >
                {isRunning ? "取消清理" : "取消扫描"}
              </button>
            </div>
          </Panel>
        </aside>
      </section>

      {errorMessage ? <div className="error-strip">{errorMessage}</div> : null}
    </main>
  );
}

function Panel(props: {
  title: string;
  subtitle: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h2>{props.title}</h2>
          <p>{props.subtitle}</p>
        </div>
        {props.aside}
      </header>
      {props.children}
    </section>
  );
}

function StatusBadge(props: { tone: BadgeTone; label: string }) {
  return <span className={`badge ${props.tone}`}>{props.label}</span>;
}

function StatChip(props: { label: string; value: string }) {
  return (
    <div className="stat-chip">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function EmptyBox(props: { title: string; description: string }) {
  return (
    <div className="empty-box">
      <strong>{props.title}</strong>
      <span>{props.description}</span>
    </div>
  );
}

function MetadataPreviewFlyout(props: {
  file: QueuedFile;
  beforeSnapshot?: MetadataPreviewSnapshot;
  afterSnapshot?: MetadataPreviewSnapshot;
  rowState?: FileRunState;
  beforeLoading: boolean;
  afterLoading: boolean;
}) {
  const fileTitle = getLeafName(props.file.relativePath || props.file.sourcePath);
  const fileContext = getParentPath(props.file.relativePath || props.file.sourcePath);

  return (
    <div className="preview-detail-panel">
      <div className="preview-panel-head">
        <div className="preview-panel-title">
          <strong title={props.file.sourcePath}>{trimMiddle(fileTitle, 24)}</strong>
          <span title={fileContext}>{trimMiddle(fileContext || props.file.sourcePath, 34)}</span>
        </div>
        <span className={`row-pill ${getRowStatusDescriptor(props.rowState).tone}`}>
          {props.rowState ? getRowStatusDescriptor(props.rowState).label : "字段预览"}
        </span>
      </div>

      <div className="preview-summary-strip">
        <span className="preview-summary-chip">
          前 {props.beforeSnapshot ? props.beforeSnapshot.count : props.beforeLoading ? "…" : "—"}
        </span>
        <span className="preview-summary-chip">
          后 {resolveAfterCountLabel(props.afterSnapshot, props.rowState, props.afterLoading)}
        </span>
      </div>

      <div className="preview-card-grid">
        <MetadataColumn
          title="处理前"
          snapshot={props.beforeSnapshot}
          loading={props.beforeLoading}
          emptyText="正在读取字段摘要..."
        />

        <MetadataColumn
          title="处理后"
          snapshot={props.afterSnapshot}
          loading={props.afterLoading}
          emptyText={resolveAfterEmptyText(props.rowState)}
        />
      </div>
    </div>
  );
}

function MetadataColumn(props: {
  title: string;
  snapshot?: MetadataPreviewSnapshot;
  loading: boolean;
  emptyText: string;
}) {
  const visibleFields = props.snapshot ? props.snapshot.fields : [];

  return (
    <section className="preview-column">
      <header>
        <strong>{props.title}</strong>
        <span>{props.snapshot ? `${props.snapshot.count} 条` : props.loading ? "读取中" : "暂无"}</span>
      </header>

      {props.snapshot ? (
        visibleFields.length ? (
          <div className="preview-fields">
            {visibleFields.map((field) => (
              <div
                key={`${field.group}:${field.name}`}
                className="preview-field"
                title={`${field.group} · ${field.name}\n${field.valuePreview}`}
              >
                <strong title={`${field.group} · ${field.name}`}>{trimMiddle(field.name, 18)}</strong>
                <span>{field.valuePreview}</span>
              </div>
            ))}
            {props.snapshot.truncated ? <div className="preview-note">内容已裁剪</div> : null}
          </div>
        ) : (
          <div className="preview-empty">没有可展示的字段。</div>
        )
      ) : (
        <div className="preview-empty">{props.loading ? "正在读取字段..." : props.emptyText}</div>
      )}
    </section>
  );
}

function selectionToArray(selection: string | string[] | null): string[] {
  if (!selection) {
    return [];
  }

  return Array.isArray(selection) ? selection : [selection];
}

function normalizeSelection(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) {
      continue;
    }

    const key = normalizePath(trimmed);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function createProgressState(total: number): ProgressState {
  return {
    total,
    completed: 0,
    succeeded: 0,
    failed: 0,
    currentPath: "",
    currentStatus: "idle",
  };
}

function normalizePath(path: string): string {
  return path.split("\\").join("/").toLowerCase();
}

function formatBytes(bytes: number): string {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function trimMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const head = Math.max(12, Math.floor(maxLength / 2) - 2);
  const tail = Math.max(10, Math.floor(maxLength / 2) - 4);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function getLeafName(path: string): string {
  const normalized = path.split("\\").join("/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function getParentPath(path: string): string {
  const normalized = path.split("\\").join("/");
  const parts = normalized.split("/");
  if (parts.length <= 1) {
    return "";
  }
  return parts.slice(0, -1).join("/");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "发生了未知错误。";
}

function getRowStatusDescriptor(rowState?: FileRunState): { label: string; tone: BadgeTone } {
  switch (rowState?.status) {
    case "running":
      return { label: "处理中", tone: "info" };
    case "success":
      return { label: "已清理", tone: "success" };
    case "failed":
      return { label: "失败", tone: "danger" };
    case "cancelled":
      return { label: "已取消", tone: "warning" };
    default:
      return { label: "待处理", tone: "neutral" };
  }
}

function resolveAfterCountLabel(
  snapshot: MetadataPreviewSnapshot | undefined,
  rowState: FileRunState | undefined,
  loading: boolean,
): string {
  if (snapshot) {
    return String(snapshot.count);
  }
  if (loading) {
    return "…";
  }
  if (rowState?.status === "success") {
    return "0";
  }
  if (rowState?.status === "running") {
    return "…";
  }
  return "—";
}

function resolveAfterEmptyText(rowState?: FileRunState): string {
  if (!rowState) {
    return "清理完成后可查看处理后的字段。";
  }
  if (rowState.status === "running") {
    return "正在处理当前文件...";
  }
  if (rowState.status === "failed") {
    return rowState.error || "当前文件处理失败，未生成处理后结果。";
  }
  if (rowState.status === "success") {
    return "没有可展示的处理后字段。";
  }
  if (rowState.status === "cancelled") {
    return "任务已取消，处理后结果不可用。";
  }
  return "清理完成后可查看处理后的字段。";
}

function buildActivityState(input: {
  summary: CleanupSummary | null;
  isRunning: boolean;
  isScanning: boolean;
  fileCount: number;
  progress: ProgressState;
}) {
  if (input.summary) {
    return {
      label: input.summary.cancelled ? "任务已取消" : "任务已完成",
      title: input.summary.cancelled
        ? `已完成 ${input.summary.succeeded + input.summary.failed}/${input.summary.total} 项`
        : `成功 ${input.summary.succeeded} 项，失败 ${input.summary.failed} 项`,
    };
  }

  if (input.isRunning) {
    return {
      label: "当前正在清理",
      title: input.progress.currentPath || "正在准备下一项",
    };
  }

  if (input.isScanning) {
    return {
      label: "扫描中",
      title: "正在把文件加入队列",
    };
  }

  if (input.fileCount) {
    return {
      label: "准备就绪",
      title: `队列中共有 ${input.fileCount} 个文件，悬停任意行可看字段摘要`,
    };
  }

  return {
    label: "等待导入",
    title: "拖放文件或文件夹后，这里会直接显示紧凑表格和字段预览。",
  };
}

export default App;
