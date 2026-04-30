import { invoke } from "@tauri-apps/api/core";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type CleanupPreviewState,
  type CleanupSummary,
  type DebugLogInfo,
  type FileRunState,
  type MetadataDebugEntry,
  type MetadataDebugState,
  type MetadataPreviewSnapshot,
  type MetadataSnapshotRequest,
  type MetadataSnapshotResponse,
  type QueuedFile,
  EMPTY_METADATA_DEBUG,
  VISIBLE_METADATA_AFTER_BATCH_LIMIT,
  VISIBLE_METADATA_BEFORE_BATCH_LIMIT,
  VISIBLE_METADATA_PREFETCH_DELAY_MS,
  buildAfterSnapshotErrorMap,
  buildAfterSnapshotMap,
  normalizePath,
  toMessage,
} from "../app-shared";

type UseMetadataPreviewStateInput = {
  metadataSeedFiles: QueuedFile[];
  visibleFiles: QueuedFile[];
  previewFile: QueuedFile | null;
  previewPathKey: string | null;
  fileStates: Record<string, FileRunState>;
  summary: CleanupSummary | null;
  onError: (message: string) => void;
};

type SnapshotPhase = "before" | "after";

export function useMetadataPreviewState(input: UseMetadataPreviewStateInput) {
  const [beforeSnapshots, setBeforeSnapshots] = useState<Record<string, MetadataPreviewSnapshot>>(
    {},
  );
  const [afterSnapshots, setAfterSnapshots] = useState<Record<string, MetadataPreviewSnapshot>>(
    {},
  );
  const [loadingSnapshots, setLoadingSnapshots] = useState<Record<string, boolean>>({});
  const [snapshotErrors, setSnapshotErrors] = useState<Record<string, string>>({});
  const [debugLogPath, setDebugLogPath] = useState("");
  const [metadataDebug, setMetadataDebug] = useState<MetadataDebugState>(EMPTY_METADATA_DEBUG);
  const [metadataDebugEntries, setMetadataDebugEntries] = useState<MetadataDebugEntry[]>([]);
  const activeSnapshotRequestKeysRef = useRef(new Set<string>());
  const completedSnapshotRequestKeysRef = useRef(new Set<string>());

  const metadataSeedKey = useMemo(
    () => input.metadataSeedFiles.map((file) => normalizePath(file.sourcePath)).join("|"),
    [input.metadataSeedFiles],
  );
  const visibleMetadataKey = useMemo(
    () => input.visibleFiles.map((file) => normalizePath(file.sourcePath)).join("|"),
    [input.visibleFiles],
  );

  const snapshotRequestKey = (phase: SnapshotPhase, requestKey: string) =>
    `${phase}:${requestKey}`;

  const hasSnapshotResult = (
    phase: SnapshotPhase,
    requestKey: string,
    snapshots: Record<string, MetadataPreviewSnapshot>,
  ) => Boolean(snapshots[requestKey]) || completedSnapshotRequestKeysRef.current.has(
    snapshotRequestKey(phase, requestKey),
  );

  const hasSnapshotInFlight = (phase: SnapshotPhase, requestKey: string) =>
    Boolean(loadingSnapshots[snapshotRequestKey(phase, requestKey)]) ||
    activeSnapshotRequestKeysRef.current.has(snapshotRequestKey(phase, requestKey));

  const clearCompletedSnapshotKeys = (phase?: SnapshotPhase) => {
    if (!phase) {
      completedSnapshotRequestKeysRef.current.clear();
      return;
    }

    const prefix = `${phase}:`;
    for (const key of Array.from(completedSnapshotRequestKeysRef.current)) {
      if (key.startsWith(prefix)) {
        completedSnapshotRequestKeysRef.current.delete(key);
      }
    }
  };

  const pushMetadataDebugEntry = useEffectEvent(
    (tone: MetadataDebugEntry["tone"], title: string, detail: string) => {
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

  const finishMetadataDebug = useEffectEvent((result: {
    origin: string;
    requestCount: number;
    durationMs: number;
    responseCount: number;
    missingCount: number;
    errorCount?: number;
    error?: string;
  }) => {
    const errorCount = result.errorCount ?? 0;
    const successCount = Math.max(0, result.responseCount - result.missingCount - errorCount);
    startTransition(() => {
      setMetadataDebug((current) => ({
        status: result.error || errorCount ? "error" : "success",
        lastOrigin: result.origin,
        pendingBatches: Math.max(0, current.pendingBatches - 1),
        pendingFiles: Math.max(0, current.pendingFiles - result.requestCount),
        lastDurationMs: result.durationMs,
        lastResolved: successCount,
        lastMissing: result.missingCount,
        lastErrors: errorCount,
        lastMessage: result.error
          ? `${result.origin} 失败: ${result.error}`
          : errorCount
            ? `${result.origin} 完成，${errorCount} 项读取失败`
            : `${result.origin} 完成，返回 ${result.responseCount} 项`,
      }));
    });

    pushMetadataDebugEntry(
      result.error || errorCount ? "danger" : result.missingCount ? "warning" : "success",
      result.origin,
      result.error
        ? result.error
        : `耗时 ${result.durationMs} ms，成功 ${successCount} 项，缺失 ${result.missingCount} 项，失败 ${errorCount} 项`,
    );
  });

  const requestSnapshots = useEffectEvent(
    async (options: {
      origin: string;
      phase: "before" | "after";
      requests: MetadataSnapshotRequest[];
    }) => {
      if (!options.requests.length) {
        return;
      }

      const requests: MetadataSnapshotRequest[] = [];
      const loadingKeys: string[] = [];
      for (const request of options.requests) {
        const loadingKey = snapshotRequestKey(options.phase, request.requestKey);
        if (
          activeSnapshotRequestKeysRef.current.has(loadingKey) ||
          completedSnapshotRequestKeysRef.current.has(loadingKey)
        ) {
          continue;
        }

        activeSnapshotRequestKeysRef.current.add(loadingKey);
        loadingKeys.push(loadingKey);
        requests.push(request);
      }
      if (!requests.length) {
        return;
      }

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
      beginMetadataDebug(options.origin, requests.length);

      try {
        const responses = await invoke<MetadataSnapshotResponse[]>("load_metadata_snapshots", {
          requests,
        });

        for (const response of responses) {
          completedSnapshotRequestKeysRef.current.add(
            snapshotRequestKey(options.phase, response.requestKey),
          );
        }

        startTransition(() => {
          const applyResponses =
            options.phase === "before" ? setBeforeSnapshots : setAfterSnapshots;
          applyResponses((current) => {
            const next = { ...current };
            for (const response of responses) {
              if (response.error) {
                delete next[response.requestKey];
              } else {
                next[response.requestKey] = response.snapshot;
              }
            }
            return next;
          });
          setSnapshotErrors((current) => {
            const next = { ...current };
            for (const response of responses) {
              const errorKey = snapshotRequestKey(options.phase, response.requestKey);
              if (response.error) {
                next[errorKey] = response.error;
              } else {
                delete next[errorKey];
              }
            }
            return next;
          });
        });

        finishMetadataDebug({
          origin: options.origin,
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: responses.length,
          missingCount: responses.filter((response) => response.missing).length,
          errorCount: responses.filter((response) => Boolean(response.error)).length,
        });
      } catch (error) {
        const message = toMessage(error);
        for (const request of requests) {
          completedSnapshotRequestKeysRef.current.add(
            snapshotRequestKey(options.phase, request.requestKey),
          );
        }
        input.onError(message);
        startTransition(() => {
          setSnapshotErrors((current) => {
            const next = { ...current };
            for (const request of requests) {
              next[snapshotRequestKey(options.phase, request.requestKey)] = message;
            }
            return next;
          });
        });
        finishMetadataDebug({
          origin: options.origin,
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: 0,
          missingCount: 0,
          error: message,
        });
      } finally {
        startTransition(() => {
          setLoadingSnapshots((current) => {
            const next = { ...current };
            for (const key of loadingKeys) {
              delete next[key];
            }
            return next;
          });
        });
        for (const key of loadingKeys) {
          activeSnapshotRequestKeysRef.current.delete(key);
        }
      }
    },
  );

  const resetMetadataState = useEffectEvent(() => {
    activeSnapshotRequestKeysRef.current.clear();
    clearCompletedSnapshotKeys();
    setBeforeSnapshots((current) => (Object.keys(current).length ? {} : current));
    setAfterSnapshots((current) => (Object.keys(current).length ? {} : current));
    setLoadingSnapshots((current) => (Object.keys(current).length ? {} : current));
    setSnapshotErrors((current) => (Object.keys(current).length ? {} : current));
    setMetadataDebug((current) => {
      if (
        current.status === EMPTY_METADATA_DEBUG.status &&
        current.lastOrigin === EMPTY_METADATA_DEBUG.lastOrigin &&
        current.pendingBatches === EMPTY_METADATA_DEBUG.pendingBatches &&
        current.pendingFiles === EMPTY_METADATA_DEBUG.pendingFiles &&
        current.lastDurationMs === EMPTY_METADATA_DEBUG.lastDurationMs &&
        current.lastResolved === EMPTY_METADATA_DEBUG.lastResolved &&
        current.lastMissing === EMPTY_METADATA_DEBUG.lastMissing &&
        current.lastErrors === EMPTY_METADATA_DEBUG.lastErrors &&
        current.lastMessage === EMPTY_METADATA_DEBUG.lastMessage
      ) {
        return current;
      }
      return EMPTY_METADATA_DEBUG;
    });
    setMetadataDebugEntries((current) => (current.length ? [] : current));
  });

  const clearAfterSnapshots = useEffectEvent(() => {
    clearCompletedSnapshotKeys("after");
    setAfterSnapshots((current) => (Object.keys(current).length ? {} : current));
    setSnapshotErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (key.startsWith("after:")) {
          delete next[key];
        }
      }
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  });

  const applyCleanupPreviewStates = useEffectEvent((previewStates: CleanupPreviewState[]) => {
    const next = buildAfterSnapshotMap(previewStates);
    const nextErrors = buildAfterSnapshotErrorMap(previewStates);
    for (const pathKey of Object.keys(next)) {
      completedSnapshotRequestKeysRef.current.add(snapshotRequestKey("after", pathKey));
    }
    for (const pathKey of Object.keys(nextErrors)) {
      completedSnapshotRequestKeysRef.current.add(snapshotRequestKey("after", pathKey));
    }

    setAfterSnapshots((current) => {
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      if (
        currentKeys.length === nextKeys.length &&
        currentKeys.every((key) => current[key] === next[key])
      ) {
        return current;
      }
      return next;
    });
    setSnapshotErrors((current) => {
      const updated = { ...current };
      for (const pathKey of Object.keys(next)) {
        delete updated[snapshotRequestKey("after", pathKey)];
      }
      for (const [pathKey, error] of Object.entries(nextErrors)) {
        updated[snapshotRequestKey("after", pathKey)] = error;
      }
      const updatedKeys = Object.keys(updated);
      const currentKeys = Object.keys(current);
      return updatedKeys.length === currentKeys.length &&
        updatedKeys.every((key) => current[key] === updated[key])
        ? current
        : updated;
    });

    const errorCount = Object.keys(nextErrors).length;
    if (errorCount) {
      startTransition(() => {
        setMetadataDebug((current) => ({
          ...current,
          status: "error",
          lastOrigin: "任务回填",
          lastDurationMs: 0,
          lastResolved: Object.keys(next).length,
          lastMissing: 0,
          lastErrors: errorCount,
          lastMessage: `任务回填完成，${errorCount} 项处理后字段读取失败`,
        }));
      });
      pushMetadataDebugEntry(
        "danger",
        "任务回填",
        `${errorCount} 个处理后字段读取失败；清理结果已保留，可在行内或悬浮预览查看原因。`,
      );
    }
  });

  useEffect(() => {
    let disposed = false;

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

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!input.metadataSeedFiles.length) {
      return;
    }

    const requests = input.metadataSeedFiles
      .filter((file) => {
        const pathKey = normalizePath(file.sourcePath);
        return (
          !hasSnapshotResult("before", pathKey, beforeSnapshots) &&
          !hasSnapshotInFlight("before", pathKey)
        );
      })
      .map((file) => ({
        requestKey: normalizePath(file.sourcePath),
        filePath: file.sourcePath,
      }));

    void requestSnapshots({
      origin: "列表预读",
      phase: "before",
      requests,
    });
  }, [beforeSnapshots, input.metadataSeedFiles, loadingSnapshots, metadataSeedKey]);

  useEffect(() => {
    if (!input.visibleFiles.length) {
      return;
    }

    const hasVisibleBeforeLoading = input.visibleFiles.some((file) => {
      const pathKey = normalizePath(file.sourcePath);
      return hasSnapshotInFlight("before", pathKey);
    });
    if (hasVisibleBeforeLoading) {
      return;
    }

    const requests = input.visibleFiles
      .filter((file) => {
        const pathKey = normalizePath(file.sourcePath);
        return (
          !hasSnapshotResult("before", pathKey, beforeSnapshots) &&
          !hasSnapshotInFlight("before", pathKey)
        );
      })
      .slice(0, VISIBLE_METADATA_BEFORE_BATCH_LIMIT)
      .map((file) => ({
        requestKey: normalizePath(file.sourcePath),
        filePath: file.sourcePath,
      }));
    if (!requests.length) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void requestSnapshots({
        origin: "可见预读",
        phase: "before",
        requests,
      });
    }, VISIBLE_METADATA_PREFETCH_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [beforeSnapshots, input.visibleFiles, loadingSnapshots, visibleMetadataKey]);

  useEffect(() => {
    if (!input.previewFile || !input.previewPathKey) {
      return;
    }

    if (
      hasSnapshotResult("before", input.previewPathKey, beforeSnapshots) ||
      hasSnapshotInFlight("before", input.previewPathKey)
    ) {
      return;
    }

    void requestSnapshots({
      origin: "悬停预读",
      phase: "before",
      requests: [
        {
          requestKey: input.previewPathKey,
          filePath: input.previewFile.sourcePath,
        },
      ],
    });
  }, [beforeSnapshots, input.previewFile, input.previewPathKey, loadingSnapshots]);

  useEffect(() => {
    if (!input.previewFile || !input.previewPathKey) {
      return;
    }

    const rowState = input.fileStates[input.previewPathKey];
    if (
      rowState?.status !== "success" ||
      hasSnapshotResult("after", input.previewPathKey, afterSnapshots) ||
      hasSnapshotInFlight("after", input.previewPathKey)
    ) {
      return;
    }

    void requestSnapshots({
      origin: "悬停后览",
      phase: "after",
      requests: [
        {
          requestKey: input.previewPathKey,
          filePath: rowState.outputPath || input.previewFile.sourcePath,
        },
      ],
    });
  }, [afterSnapshots, input.fileStates, input.previewFile, input.previewPathKey, loadingSnapshots]);

  useEffect(() => {
    if (!input.visibleFiles.length) {
      return;
    }

    const hasVisibleAfterLoading = input.visibleFiles.some((file) => {
      const pathKey = normalizePath(file.sourcePath);
      return hasSnapshotInFlight("after", pathKey);
    });
    if (hasVisibleAfterLoading) {
      return;
    }

    const requests = input.visibleFiles
      .map((file) => {
        const pathKey = normalizePath(file.sourcePath);
        const rowState = input.fileStates[pathKey];
        if (
          rowState?.status !== "success" ||
          hasSnapshotResult("after", pathKey, afterSnapshots) ||
          hasSnapshotInFlight("after", pathKey)
        ) {
          return null;
        }

        return {
          requestKey: pathKey,
          filePath: rowState.outputPath || file.sourcePath,
        };
      })
      .filter((request): request is MetadataSnapshotRequest => Boolean(request));
    const limitedRequests = requests.slice(0, VISIBLE_METADATA_AFTER_BATCH_LIMIT);
    if (!limitedRequests.length) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void requestSnapshots({
        origin: "可见后览",
        phase: "after",
        requests: limitedRequests,
      });
    }, VISIBLE_METADATA_PREFETCH_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [afterSnapshots, input.fileStates, input.visibleFiles, loadingSnapshots, visibleMetadataKey]);

  useEffect(() => {
    if (!input.summary || input.summary.cancelled || !input.metadataSeedFiles.length) {
      return;
    }

    const requests = input.metadataSeedFiles
      .map((file) => {
        const pathKey = normalizePath(file.sourcePath);
        const rowState = input.fileStates[pathKey];
        if (
          rowState?.status !== "success" ||
          hasSnapshotResult("after", pathKey, afterSnapshots) ||
          hasSnapshotInFlight("after", pathKey)
        ) {
          return null;
        }

        return {
          requestKey: pathKey,
          filePath: rowState.outputPath || file.sourcePath,
        };
      })
      .filter((request): request is MetadataSnapshotRequest => Boolean(request));

    void requestSnapshots({
      origin: "任务回填",
      phase: "after",
      requests,
    });
  }, [afterSnapshots, input.fileStates, input.metadataSeedFiles, input.summary, loadingSnapshots, metadataSeedKey]);

  return {
    beforeSnapshots,
    afterSnapshots,
    loadingSnapshots,
    snapshotErrors,
    debugLogPath,
    metadataDebug,
    metadataDebugEntries,
    resetMetadataState,
    clearAfterSnapshots,
    applyCleanupPreviewStates,
  };
}
