import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";

import {
  type CleanupProgressEvent,
  type CleanupSummary,
  type FileRunState,
  type MetadataWritePreferences,
  type QueuedFile,
  type QueueView,
  type RuntimeInfo,
  type ScanProgressEvent,
  type ScanSummary,
  type ShellOpenRequest,
  EMPTY_PROGRESS,
  QUEUE_PAGE_SIZE,
  buildFileStateMap,
  createProgressState,
  mergeSummaryFileStates,
  normalizePath,
  normalizeSelection,
  selectionToArray,
  toMessage,
} from "../app-shared";

export function useWorkbenchController(options?: {
  preferredParallelism?: number | null;
  metadataWrite?: MetadataWritePreferences;
}) {
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [queueView, setQueueView] = useState<QueueView | null>(null);
  const [queueFiles, setQueueFiles] = useState<QueuedFile[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [parallelism, setParallelism] = useState(2);
  const [progress, setProgress] = useState(EMPTY_PROGRESS);
  const [runFailures, setRunFailures] = useState<Array<{ sourcePath: string; error: string }>>([]);
  const [summary, setSummary] = useState<CleanupSummary | null>(null);
  const [fileStates, setFileStates] = useState<Record<string, FileRunState>>({});
  const [isLoadingQueuePage, setIsLoadingQueuePage] = useState(false);
  const [pendingShellRequest, setPendingShellRequest] = useState<ShellOpenRequest | null>(null);
  const [autoStartCleanupRequested, setAutoStartCleanupRequested] = useState(false);

  const pendingProgressRef = useRef<CleanupProgressEvent | null>(null);
  const dropActiveRef = useRef(false);

  const fileCount = queueView?.supportedCount ?? 0;
  const rootCount = queueView?.rootCount ?? 0;
  const previewFiles = queueFiles.length ? queueFiles : queueView?.previewFiles ?? [];
  const ignoredCount = queueView?.ignoredCount ?? 0;
  const activePathKey = progress.currentPath ? normalizePath(progress.currentPath) : "";
  const isBusy = isScanning || isRunning;
  const canStart = fileCount > 0 && !isScanning && !isRunning;
  const hasMoreQueueFiles = queueFiles.length < fileCount;

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
    setFileStates({});
  });

  const enqueueShellRequest = useEffectEvent((request: ShellOpenRequest | null) => {
    if (!request) {
      return;
    }

    const paths = normalizeSelection(request.paths);
    if (!paths.length) {
      return;
    }

    startTransition(() => {
      setPendingShellRequest((current) => ({
        paths: normalizeSelection([...(current?.paths ?? []), ...paths]),
        autoStartCleanup:
          Boolean(current?.autoStartCleanup) || Boolean(request.autoStartCleanup),
      }));
    });
  });

  const pullPendingShellRequest = useEffectEvent(async () => {
    try {
      const request = await invoke<ShellOpenRequest | null>("take_pending_shell_request");
      enqueueShellRequest(request);
    } catch (error) {
      setErrorMessage(toMessage(error));
    }
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

  const scanInputPaths = useEffectEvent(
    async (
      paths: string[],
      options?: { autoStartCleanup?: boolean; replaceQueue?: boolean },
    ) => {
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

    if (options?.replaceQueue) {
      try {
        await invoke("clear_queue");
        startTransition(() => {
          setQueueView(null);
          setQueueFiles([]);
          setSummary(null);
          setRunFailures([]);
          setProgress(EMPTY_PROGRESS);
          setErrorMessage(null);
          setFileStates({});
        });
      } catch (error) {
        setErrorMessage(toMessage(error));
        return;
      }
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
      if (options?.autoStartCleanup && result.view.supportedCount > 0) {
        setAutoStartCleanupRequested(true);
      }
    } catch (error) {
      setErrorMessage(toMessage(error));
    } finally {
      setIsScanning(false);
    }
  });

  const addFiles = useEffectEvent(async () => {
    const selection = await open({
      title: "选择一个或多个文件",
      multiple: true,
      directory: false,
    });

    await scanInputPaths(selectionToArray(selection));
  });

  const addFolders = useEffectEvent(async () => {
    const selection = await open({
      title: "选择一个或多个文件夹",
      multiple: true,
      directory: true,
    });

    await scanInputPaths(selectionToArray(selection));
  });

  const startCleanup = useEffectEvent(async () => {
    if (!fileCount || !canStart) {
      return;
    }

    setIsRunning(true);
    setErrorMessage(null);
    setRunFailures([]);
    setSummary(null);
    setFileStates({});
    pendingProgressRef.current = null;
    setProgress(createProgressState(fileCount));

    try {
      const result = await invoke<CleanupSummary>("run_cleanup", {
        options: {
          outputMode: "overwrite",
          outputDir: null,
          parallelism,
          preserveStructure: true,
          metadataWrite: {
            enabled: Boolean(options?.metadataWrite?.enabled),
            title: options?.metadataWrite?.title.trim() || null,
            author: options?.metadataWrite?.author.trim() || null,
            description: options?.metadataWrite?.description.trim() || null,
            keywords: options?.metadataWrite?.keywords.trim() || null,
            rights: options?.metadataWrite?.rights.trim() || null,
            rating: options?.metadataWrite?.rating.trim() || null,
            label: options?.metadataWrite?.label.trim() || null,
            rightsUrl: options?.metadataWrite?.rightsUrl.trim() || null,
          },
        },
      });

      pendingProgressRef.current = null;
      setSummary(result);
      setRunFailures(result.failures.slice(0, 6));
      setFileStates(buildFileStateMap(result.previewStates));
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
  });

  const cancelCleanup = useEffectEvent(async () => {
    try {
      await invoke<boolean>("cancel_cleanup");
    } catch (error) {
      setErrorMessage(toMessage(error));
    }
  });

  const cancelScan = useEffectEvent(async () => {
    try {
      await invoke<boolean>("cancel_scan");
    } catch (error) {
      setErrorMessage(toMessage(error));
    }
  });

  const clearQueue = useEffectEvent(async () => {
    try {
      await invoke("clear_queue");
      setQueueView(null);
      setQueueFiles([]);
      setSummary(null);
      setRunFailures([]);
      setProgress(EMPTY_PROGRESS);
      setErrorMessage(null);
      setFileStates({});
    } catch (error) {
      setErrorMessage(toMessage(error));
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
        const preferredParallelism = options?.preferredParallelism;
        if (
          typeof preferredParallelism === "number" &&
          Number.isFinite(preferredParallelism) &&
          preferredParallelism >= 1
        ) {
          setParallelism(Math.min(info.parallelismMax, Math.round(preferredParallelism)));
          return;
        }

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
    const shellOpenListener = listen("shell-open-paths", () => {
      void pullPendingShellRequest();
    });

    void getCurrentWindow()
      .onDragDropEvent((event) => handleWindowDrop(event as never))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenWindowDrop = unlisten;
      });

    void pullPendingShellRequest();

    return () => {
      disposed = true;
      void cleanupProgressListener.then((unlisten) => unlisten());
      void cleanupFileListener.then((unlisten) => unlisten());
      void scanProgressListener.then((unlisten) => unlisten());
      void shellOpenListener.then((unlisten) => unlisten());
      unlistenWindowDrop?.();
    };
  }, []);

  useEffect(() => {
    if (!pendingShellRequest || isScanning || isRunning) {
      return;
    }

    const request = pendingShellRequest;
    setPendingShellRequest(null);
    void scanInputPaths(request.paths, {
      autoStartCleanup: request.autoStartCleanup,
      replaceQueue: true,
    });
  }, [isRunning, isScanning, pendingShellRequest]);

  useEffect(() => {
    if (!summary || !queueFiles.length) {
      return;
    }

    startTransition(() => {
      setFileStates((current) => mergeSummaryFileStates(current, queueFiles, summary));
    });
  }, [queueFiles, summary]);

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

  useEffect(() => {
    if (!autoStartCleanupRequested || isScanning || isRunning || !fileCount) {
      return;
    }

    setAutoStartCleanupRequested(false);
    void startCleanup();
  }, [autoStartCleanupRequested, fileCount, isRunning, isScanning]);

  return {
    runtimeInfo,
    queueView,
    queueFiles,
    dropActive,
    isScanning,
    isRunning,
    errorMessage,
    setErrorMessage,
    parallelism,
    setParallelism,
    progress,
    runFailures,
    summary,
    fileStates,
    isLoadingQueuePage,
    fileCount,
    rootCount,
    previewFiles,
    ignoredCount,
    activePathKey,
    isBusy,
    canStart,
    hasMoreQueueFiles,
    loadMoreQueueFiles,
    addFiles,
    addFolders,
    startCleanup,
    cancelCleanup,
    cancelScan,
    clearQueue,
  };
}
