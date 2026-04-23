import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  type BadgeTone,
  type CleanupProgressEvent,
  type CleanupSummary,
  type DebugLogInfo,
  type FileRunState,
  type FlyoutPosition,
  type MetadataDebugEntry,
  type MetadataDebugState,
  type MetadataPreviewSnapshot,
  type MetadataSnapshotRequest,
  type MetadataSnapshotResponse,
  type ProgressState,
  type QueuedFile,
  type QueueView,
  type RuntimeInfo,
  type ScanProgressEvent,
  type ScanSummary,
  EAGER_METADATA_PREFETCH_LIMIT,
  EMPTY_METADATA_DEBUG,
  EMPTY_PROGRESS,
  QUEUE_PAGE_SIZE,
  SMALL_QUEUE_EAGER_LOAD_THRESHOLD,
  buildActivityState,
  buildAfterSnapshotMap,
  buildFileStateMap,
  clampNumber,
  createProgressState,
  mergeSummaryFileStates,
  normalizePath,
  normalizeSelection,
  selectionToArray,
  toMessage,
} from "./app-shared";
import { TopToolbar } from "./components/TopToolbar";
import { WorkbenchPanel } from "./components/WorkbenchPanel";

function App() {
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [queueView, setQueueView] = useState<QueueView | null>(null);
  const [queueFiles, setQueueFiles] = useState<QueuedFile[]>([]);
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
  const [isLoadingQueuePage, setIsLoadingQueuePage] = useState(false);
  const [debugLogPath, setDebugLogPath] = useState<string>("");
  const [metadataDebug, setMetadataDebug] = useState<MetadataDebugState>(EMPTY_METADATA_DEBUG);
  const [metadataDebugEntries, setMetadataDebugEntries] = useState<MetadataDebugEntry[]>([]);

  const pendingProgressRef = useRef<CleanupProgressEvent | null>(null);
  const dropActiveRef = useRef(false);
  const hoverTimeoutRef = useRef<number | null>(null);
  const flyoutActiveRef = useRef(false);
  const tableShellRef = useRef<HTMLDivElement | null>(null);
  const queueBodyRef = useRef<HTMLDivElement | null>(null);

  const progressPercent = progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;
  const isBusy = isScanning || isRunning;
  const fileCount = queueView?.supportedCount ?? 0;
  const rootCount = queueView?.rootCount ?? 0;
  const previewFiles = queueFiles.length ? queueFiles : queueView?.previewFiles ?? [];
  const ignoredCount = queueView?.ignoredCount ?? 0;
  const activePathKey = progress.currentPath ? normalizePath(progress.currentPath) : "";
  const outputMode = "overwrite" as const;
  const canStart = fileCount > 0 && !isScanning && !isRunning;
  const hasMoreQueueFiles = queueFiles.length < fileCount;
  const allQueueFilesLoaded = fileCount > 0 && !hasMoreQueueFiles;
  const metadataSeedFiles = useMemo(() => {
    if (allQueueFilesLoaded && fileCount <= SMALL_QUEUE_EAGER_LOAD_THRESHOLD) {
      return previewFiles;
    }

    return previewFiles.slice(0, Math.min(previewFiles.length, EAGER_METADATA_PREFETCH_LIMIT));
  }, [allQueueFilesLoaded, fileCount, previewFiles]);
  const previewFileKey = metadataSeedFiles.map((file) => normalizePath(file.sourcePath)).join("|");

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
    setBeforeSnapshots({});
    setAfterSnapshots({});
    setLoadingSnapshots({});
    setFileStates({});
    setHoveredPathKey(null);
    flyoutActiveRef.current = false;
    setMetadataDebug(EMPTY_METADATA_DEBUG);
    setMetadataDebugEntries([]);
  });

  const pushMetadataDebugEntry = useEffectEvent(
    (tone: BadgeTone, title: string, detail: string) => {
      const entry: MetadataDebugEntry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        tone,
        title,
        detail,
      };

      startTransition(() => {
        setMetadataDebugEntries((current) => [entry, ...current].slice(0, 6));
      });
    },
  );

  const beginMetadataDebug = useEffectEvent((origin: string, requestCount: number) => {
    startTransition(() => {
      setMetadataDebug((current) => ({
        ...current,
        status: "running",
        lastOrigin: origin,
        pendingBatches: current.pendingBatches + 1,
        pendingFiles: current.pendingFiles + requestCount,
        lastMessage: `${origin} 发起 ${requestCount} 个字段请求`,
      }));
    });
  });

  const finishMetadataDebug = useEffectEvent((input: {
    origin: string;
    requestCount: number;
    durationMs: number;
    responseCount: number;
    missingCount: number;
    error?: string;
  }) => {
    startTransition(() => {
      setMetadataDebug((current) => ({
        status: input.error ? "error" : "success",
        lastOrigin: input.origin,
        pendingBatches: Math.max(0, current.pendingBatches - 1),
        pendingFiles: Math.max(0, current.pendingFiles - input.requestCount),
        lastDurationMs: input.durationMs,
        lastResolved: Math.max(0, input.responseCount - input.missingCount),
        lastMissing: input.missingCount,
        lastMessage: input.error
          ? `${input.origin} 失败: ${input.error}`
          : `${input.origin} 完成，返回 ${input.responseCount} 项`,
      }));
    });

    pushMetadataDebugEntry(
      input.error ? "danger" : input.missingCount ? "warning" : "success",
      input.origin,
      input.error
        ? input.error
        : `耗时 ${input.durationMs} ms，返回 ${input.responseCount} 项，缺失 ${input.missingCount} 项`,
    );
  });

  const refreshQueueFiles = useEffectEvent(async () => {
    try {
      setIsLoadingQueuePage(true);
      const files = await invoke<QueuedFile[]>("get_queue_files_page", {
        offset: 0,
        limit: QUEUE_PAGE_SIZE,
      });
      startTransition(() => {
        setQueueFiles(files);
      });
    } catch (error) {
      setErrorMessage(toMessage(error));
    } finally {
      setIsLoadingQueuePage(false);
    }
  });

  const loadMoreQueueFiles = useEffectEvent(async () => {
    if (isLoadingQueuePage || queueFiles.length >= fileCount || !fileCount) {
      return;
    }

    try {
      setIsLoadingQueuePage(true);
      const files = await invoke<QueuedFile[]>("get_queue_files_page", {
        offset: queueFiles.length,
        limit: QUEUE_PAGE_SIZE,
      });
      if (!files.length) {
        return;
      }

      startTransition(() => {
        setQueueFiles((current) => [...current, ...files]);
      });
    } catch (error) {
      setErrorMessage(toMessage(error));
    } finally {
      setIsLoadingQueuePage(false);
    }
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
    setQueueFiles([]);

    try {
      const result = await invoke<ScanSummary>("scan_inputs", {
        inputPaths: cleanedPaths,
      });

      startTransition(() => {
        setQueueView(result.view);
        setProgress(createProgressState(result.view.supportedCount));
      });
      await refreshQueueFiles();
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

    void invoke<DebugLogInfo>("get_debug_log_info")
      .then((info) => {
        if (!disposed) {
          setDebugLogPath(info.path);
        }
      })
      .catch(() => {
        if (!disposed) {
          setDebugLogPath("");
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
    if (!metadataSeedFiles.length) {
      return;
    }

    const requests = metadataSeedFiles
      .filter((file) => {
        const pathKey = normalizePath(file.sourcePath);
        return !beforeSnapshots[pathKey] && !loadingSnapshots[`before:${pathKey}`];
      })
      .map((file) => ({
        requestKey: normalizePath(file.sourcePath),
        filePath: file.sourcePath,
      }));

    if (!requests.length) {
      return;
    }

    const loadingKeys = requests.map((request) => `before:${request.requestKey}`);
    const startedAt = performance.now();

    startTransition(() => {
      setLoadingSnapshots((current) => {
        const next = { ...current };
        for (const key of loadingKeys) {
          next[key] = true;
        }
        return next;
      });
    });
    beginMetadataDebug("列表预读", requests.length);

    void invoke<MetadataSnapshotResponse[]>("load_metadata_snapshots", { requests })
      .then((responses) => {
        startTransition(() => {
          setBeforeSnapshots((current) => {
            const next = { ...current };
            for (const response of responses) {
              next[response.requestKey] = response.snapshot;
            }
            return next;
          });
        });
        finishMetadataDebug({
          origin: "列表预读",
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: responses.length,
          missingCount: responses.filter((response) => response.missing).length,
        });
      })
      .catch((error) => {
        setErrorMessage(toMessage(error));
        finishMetadataDebug({
          origin: "列表预读",
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: 0,
          missingCount: 0,
          error: toMessage(error),
        });
      })
      .finally(() => {
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
  }, [beforeSnapshots, previewFileKey]);

  useEffect(() => {
    if (!previewFile || !previewPathKey) {
      return;
    }

    const beforeLoadingKey = `before:${previewPathKey}`;
    if (beforeSnapshots[previewPathKey] || loadingSnapshots[beforeLoadingKey]) {
      return;
    }

    const startedAt = performance.now();
    const requests: MetadataSnapshotRequest[] = [
      {
        requestKey: previewPathKey,
        filePath: previewFile.sourcePath,
      },
    ];

    startTransition(() => {
      setLoadingSnapshots((current) => ({
        ...current,
        [beforeLoadingKey]: true,
      }));
    });
    beginMetadataDebug("悬停预读", requests.length);

    void invoke<MetadataSnapshotResponse[]>("load_metadata_snapshots", { requests })
      .then((responses) => {
        startTransition(() => {
          setBeforeSnapshots((current) => {
            const next = { ...current };
            for (const response of responses) {
              next[response.requestKey] = response.snapshot;
            }
            return next;
          });
        });
        finishMetadataDebug({
          origin: "悬停预读",
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: responses.length,
          missingCount: responses.filter((response) => response.missing).length,
        });
      })
      .catch((error) => {
        setErrorMessage(toMessage(error));
        finishMetadataDebug({
          origin: "悬停预读",
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: 0,
          missingCount: 0,
          error: toMessage(error),
        });
      })
      .finally(() => {
        startTransition(() => {
          setLoadingSnapshots((current) => {
            const next = { ...current };
            delete next[beforeLoadingKey];
            return next;
          });
        });
      });
  }, [beforeSnapshots, previewFile, previewPathKey]);

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

    const startedAt = performance.now();
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
    beginMetadataDebug("悬停后览", requests.length);

    void invoke<MetadataSnapshotResponse[]>("load_metadata_snapshots", { requests })
      .then((responses) => {
        startTransition(() => {
          setAfterSnapshots((current) => {
            const next = { ...current };
            for (const response of responses) {
              next[response.requestKey] = response.snapshot;
            }
            return next;
          });
        });
        finishMetadataDebug({
          origin: "悬停后览",
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: responses.length,
          missingCount: responses.filter((response) => response.missing).length,
        });
      })
      .catch((error) => {
        setErrorMessage(toMessage(error));
        finishMetadataDebug({
          origin: "悬停后览",
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: 0,
          missingCount: 0,
          error: toMessage(error),
        });
      })
      .finally(() => {
        startTransition(() => {
          setLoadingSnapshots((current) => {
            const next = { ...current };
            delete next[afterLoadingKey];
            return next;
          });
        });
      });
  }, [afterSnapshots, fileStates, previewFile, previewPathKey]);

  useEffect(() => {
    if (!summary || summary.cancelled || !metadataSeedFiles.length) {
      return;
    }

    const requests = metadataSeedFiles
      .map((file) => {
        const pathKey = normalizePath(file.sourcePath);
        const rowState = fileStates[pathKey];
        if (
          rowState?.status !== "success" ||
          afterSnapshots[pathKey] ||
          loadingSnapshots[`after:${pathKey}`]
        ) {
          return null;
        }

        return {
          requestKey: pathKey,
          filePath: rowState.outputPath || file.sourcePath,
        };
      })
      .filter((request): request is MetadataSnapshotRequest => Boolean(request));

    if (!requests.length) {
      return;
    }

    const startedAt = performance.now();

    startTransition(() => {
      setLoadingSnapshots((current) => {
        const next = { ...current };
        for (const request of requests) {
          next[`after:${request.requestKey}`] = true;
        }
        return next;
      });
    });
    beginMetadataDebug("任务回填", requests.length);

    void invoke<MetadataSnapshotResponse[]>("load_metadata_snapshots", { requests })
      .then((responses) => {
        startTransition(() => {
          setAfterSnapshots((current) => {
            const next = { ...current };
            for (const response of responses) {
              next[response.requestKey] = response.snapshot;
            }
            return next;
          });
        });
        finishMetadataDebug({
          origin: "任务回填",
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: responses.length,
          missingCount: responses.filter((response) => response.missing).length,
        });
      })
      .catch((error) => {
        setErrorMessage(toMessage(error));
        finishMetadataDebug({
          origin: "任务回填",
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: 0,
          missingCount: 0,
          error: toMessage(error),
        });
      })
      .finally(() => {
        startTransition(() => {
          setLoadingSnapshots((current) => {
            const next = { ...current };
            for (const request of requests) {
              delete next[`after:${request.requestKey}`];
            }
            return next;
          });
        });
      });
  }, [afterSnapshots, fileStates, metadataSeedFiles, previewFileKey, summary]);

  useEffect(() => {
    if (!summary || !queueFiles.length) {
      return;
    }

    startTransition(() => {
      setFileStates((current) => mergeSummaryFileStates(current, queueFiles, summary));
    });
  }, [queueFiles, summary]);

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
    const body = queueBodyRef.current;
    if (!body) {
      return;
    }

    const handleScroll = () => {
      if (
        body.scrollTop + body.clientHeight >= body.scrollHeight - 160 &&
        hasMoreQueueFiles &&
        !isLoadingQueuePage
      ) {
        void loadMoreQueueFiles();
      }
    };

    body.addEventListener("scroll", handleScroll);
    return () => body.removeEventListener("scroll", handleScroll);
  }, [hasMoreQueueFiles, isLoadingQueuePage, loadMoreQueueFiles, previewFiles.length]);

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
      setFileStates(buildFileStateMap(result.previewStates));
      setAfterSnapshots(buildAfterSnapshotMap(result.previewStates));
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
      setQueueFiles([]);
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
    const estimatedWidth = Math.min(480, Math.max(340, shell.clientWidth - 24));
    const estimatedHeight = 360;
    const preferredLeft = event.clientX - shellRect.left - estimatedWidth - 14;
    const fallbackLeft = event.clientX - shellRect.left + 16;
    const nextLeft = clampNumber(
      preferredLeft >= 12 ? preferredLeft : fallbackLeft,
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
      <TopToolbar
        runtimeInfo={runtimeInfo}
        canStart={canStart}
        isRunning={isRunning}
        isScanning={isScanning}
        parallelism={parallelism}
        onParallelismChange={setParallelism}
        onStartCleanup={startCleanup}
        onCancelCurrent={isRunning ? cancelCleanup : cancelScan}
      />

      <section className="workspace single-workspace">
        <section className="content">
          <WorkbenchPanel
            dropActive={dropActive}
            isScanning={isScanning}
            isRunning={isRunning}
            isBusy={isBusy}
            summary={summary}
            fileCount={fileCount}
            rootCount={rootCount}
            ignoredCount={ignoredCount}
            queueView={queueView}
            progress={progress}
            progressPercent={progressPercent}
            activity={activity}
            previewFiles={previewFiles}
            fileStates={fileStates}
            beforeSnapshots={beforeSnapshots}
            afterSnapshots={afterSnapshots}
            loadingSnapshots={loadingSnapshots}
            hoveredPathKey={hoveredPathKey}
            highlightedPathKey={highlightedPathKey}
            hasMoreQueueFiles={hasMoreQueueFiles}
            isLoadingQueuePage={isLoadingQueuePage}
            previewFile={previewFile}
            previewRowState={previewRowState}
            previewBeforeSnapshot={previewBeforeSnapshot}
            previewAfterSnapshot={previewAfterSnapshot}
            previewBeforeLoading={previewBeforeLoading}
            previewAfterLoading={previewAfterLoading}
            flyoutPosition={flyoutPosition}
            metadataDebug={metadataDebug}
            metadataDebugEntries={metadataDebugEntries}
            debugLogPath={debugLogPath}
            runFailures={runFailures}
            tableShellRef={tableShellRef}
            queueBodyRef={queueBodyRef}
            onAddFiles={addFiles}
            onAddFolders={addFolders}
            onClearQueue={clearQueue}
            onScheduleHover={scheduleHover}
            onClearHover={clearHover}
            onFlyoutEnter={handleFlyoutEnter}
            onFlyoutLeave={handleFlyoutLeave}
          />
        </section>
      </section>

      {errorMessage ? <div className="error-strip">{errorMessage}</div> : null}
    </main>
  );
}

export default App;
