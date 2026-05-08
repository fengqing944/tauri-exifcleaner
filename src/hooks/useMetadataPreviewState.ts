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

type SnapshotQueueItem = {
  queueKey: string;
  phase: SnapshotPhase;
  request: MetadataSnapshotRequest;
  origin: string;
  priority: number;
  staleKey: string;
  generation: number;
  sequence: number;
};

const SNAPSHOT_HIGH_PRIORITY = 100;
const SNAPSHOT_VISIBLE_PRIORITY = 35;
const SNAPSHOT_STALE_RETRY_COOLDOWN_MS = 800;

function snapshotBatchSizeForPriority(priority: number) {
  if (priority >= SNAPSHOT_HIGH_PRIORITY) {
    return 1;
  }
  if (priority >= SNAPSHOT_VISIBLE_PRIORITY) {
    return 6;
  }
  return 4;
}

export function useMetadataPreviewState(input: UseMetadataPreviewStateInput) {
  const [beforeSnapshots, setBeforeSnapshots] = useState<Record<string, MetadataPreviewSnapshot>>(
    {},
  );
  const [afterSnapshots, setAfterSnapshots] = useState<Record<string, MetadataPreviewSnapshot>>(
    {},
  );
  const [queuedSnapshots, setQueuedSnapshots] = useState<Record<string, boolean>>({});
  const [loadingSnapshots, setLoadingSnapshots] = useState<Record<string, boolean>>({});
  const [snapshotErrors, setSnapshotErrors] = useState<Record<string, string>>({});
  const [debugLogPath, setDebugLogPath] = useState("");
  const [metadataDebug, setMetadataDebug] = useState<MetadataDebugState>(EMPTY_METADATA_DEBUG);
  const [metadataDebugEntries, setMetadataDebugEntries] = useState<MetadataDebugEntry[]>([]);
  const activeSnapshotRequestKeysRef = useRef(new Map<string, number>());
  const activeMetadataDebugRequestsRef = useRef(
    new Map<number, { phase: SnapshotPhase; requestCount: number }>(),
  );
  const completedSnapshotRequestKeysRef = useRef(new Set<string>());
  const queuedSnapshotRequestsRef = useRef(new Map<string, SnapshotQueueItem>());
  const snapshotRetryAfterRef = useRef(new Map<string, number>());
  const snapshotSchedulerRunningRef = useRef(false);
  const snapshotSchedulerEpochRef = useRef(0);
  const snapshotQueueSequenceRef = useRef(0);
  const snapshotGenerationRef = useRef(0);
  const snapshotRequestTokenRef = useRef(0);
  const snapshotEpochRef = useRef(0);

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

  const nextSnapshotGeneration = () => {
    snapshotGenerationRef.current += 1;
    return snapshotGenerationRef.current;
  };

  const snapshotStaleKey = (key: string) => `${snapshotEpochRef.current}:${key}`;

  const nextSnapshotRequestToken = () => {
    snapshotRequestTokenRef.current += 1;
    return snapshotRequestTokenRef.current;
  };

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

  const hasSnapshotQueued = (phase: SnapshotPhase, requestKey: string) =>
    queuedSnapshotRequestsRef.current.has(snapshotRequestKey(phase, requestKey));

  const hasSnapshotPending = (phase: SnapshotPhase, requestKey: string) =>
    hasSnapshotInFlight(phase, requestKey) || hasSnapshotQueued(phase, requestKey);

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

  const publishQueuedSnapshots = useEffectEvent(() => {
    const next: Record<string, boolean> = {};
    for (const key of queuedSnapshotRequestsRef.current.keys()) {
      next[key] = true;
    }

    startTransition(() => {
      setQueuedSnapshots(next);
    });
  });

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
    staleCount?: number;
    error?: string;
  }) => {
    const errorCount = result.errorCount ?? 0;
    const staleCount = result.staleCount ?? 0;
    const successCount = Math.max(
      0,
      result.responseCount - result.missingCount - errorCount - staleCount,
    );
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
            : staleCount
              ? `${result.origin} 跳过 ${staleCount} 项过期请求`
            : `${result.origin} 完成，返回 ${result.responseCount} 项`,
      }));
    });

    pushMetadataDebugEntry(
      result.error || errorCount ? "danger" : result.missingCount ? "warning" : "success",
      result.origin,
      result.error
        ? result.error
        : `耗时 ${result.durationMs} ms，成功 ${successCount} 项，缺失 ${result.missingCount} 项，失败 ${errorCount} 项，跳过 ${staleCount} 项`,
    );
  });

  const finishAbortedMetadataDebug = useEffectEvent((
    requestCount: number,
    batchCount = 1,
  ) => {
    startTransition(() => {
      setMetadataDebug((current) => {
        if (!current.pendingBatches && !current.pendingFiles) {
          return current;
        }

        const pendingBatches = Math.max(0, current.pendingBatches - batchCount);
        const pendingFiles = Math.max(0, current.pendingFiles - requestCount);
        const hasPending = Boolean(pendingBatches || pendingFiles);
        const keepSettledStatus = current.status === "error";
        return {
          ...current,
          status: hasPending || keepSettledStatus ? current.status : "success",
          pendingBatches,
          pendingFiles,
          lastMessage:
            hasPending || keepSettledStatus
              ? current.lastMessage
              : "已跳过过期字段请求。",
        };
      });
    });
  });

  const beginTrackedMetadataDebug = useEffectEvent((
    requestToken: number,
    phase: SnapshotPhase,
    origin: string,
    requestCount: number,
  ) => {
    activeMetadataDebugRequestsRef.current.set(requestToken, {
      phase,
      requestCount,
    });
    beginMetadataDebug(origin, requestCount);
  });

  const finishTrackedMetadataDebug = useEffectEvent((
    requestToken: number,
    result: {
      origin: string;
      requestCount: number;
      durationMs: number;
      responseCount: number;
      missingCount: number;
      errorCount?: number;
      staleCount?: number;
      error?: string;
    },
  ) => {
    if (!activeMetadataDebugRequestsRef.current.has(requestToken)) {
      return;
    }

    activeMetadataDebugRequestsRef.current.delete(requestToken);
    finishMetadataDebug(result);
  });

  const abortTrackedMetadataDebug = useEffectEvent((requestToken: number) => {
    const entry = activeMetadataDebugRequestsRef.current.get(requestToken);
    if (!entry) {
      return;
    }

    activeMetadataDebugRequestsRef.current.delete(requestToken);
    finishAbortedMetadataDebug(entry.requestCount);
  });

  const requestSnapshots = useEffectEvent(
    async (options: {
      origin: string;
      phase: "before" | "after";
      requests: MetadataSnapshotRequest[];
      priority: number;
      staleKey: string;
      generation: number;
    }) => {
      if (!options.requests.length) {
        return;
      }

      const requestToken = nextSnapshotRequestToken();
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

        activeSnapshotRequestKeysRef.current.set(loadingKey, requestToken);
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
      beginTrackedMetadataDebug(requestToken, options.phase, options.origin, requests.length);

      try {
        const requestPayload = requests.map((request) => ({
          ...request,
          bypassCache: options.phase === "after",
          priority: options.priority,
          staleKey: options.staleKey,
          generation: options.generation,
        }));
        const responses = await invoke<MetadataSnapshotResponse[]>("load_metadata_snapshots", {
          requests: requestPayload,
        });
        const retryAfter = performance.now() + SNAPSHOT_STALE_RETRY_COOLDOWN_MS;
        for (const response of responses) {
          if (response.stale) {
            snapshotRetryAfterRef.current.set(
              snapshotRequestKey(options.phase, response.requestKey),
              retryAfter,
            );
          }
        }
        const requestStillCurrent = loadingKeys.some(
          (key) => activeSnapshotRequestKeysRef.current.get(key) === requestToken,
        );
        if (!requestStillCurrent) {
          abortTrackedMetadataDebug(requestToken);
          return;
        }

        const activeResponses = responses.filter((response) => {
          const loadingKey = snapshotRequestKey(options.phase, response.requestKey);
          return (
            !response.stale &&
            activeSnapshotRequestKeysRef.current.get(loadingKey) === requestToken
          );
        });

        for (const response of activeResponses) {
          completedSnapshotRequestKeysRef.current.add(
            snapshotRequestKey(options.phase, response.requestKey),
          );
        }

        startTransition(() => {
          const applyResponses =
            options.phase === "before" ? setBeforeSnapshots : setAfterSnapshots;
          applyResponses((current) => {
            const next = { ...current };
            for (const response of activeResponses) {
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
            for (const response of activeResponses) {
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

        finishTrackedMetadataDebug(requestToken, {
          origin: options.origin,
          requestCount: requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: responses.length,
          missingCount: activeResponses.filter((response) => response.missing).length,
          errorCount: activeResponses.filter((response) => Boolean(response.error)).length,
          staleCount: responses.filter((response) => response.stale).length,
        });
      } catch (error) {
        const message = toMessage(error);
        const activeRequests = requests.filter(
          (request) =>
            activeSnapshotRequestKeysRef.current.get(
              snapshotRequestKey(options.phase, request.requestKey),
            ) === requestToken,
        );
        for (const request of activeRequests) {
          completedSnapshotRequestKeysRef.current.add(
            snapshotRequestKey(options.phase, request.requestKey),
          );
        }
        if (activeRequests.length) {
          input.onError(message);
          startTransition(() => {
            setSnapshotErrors((current) => {
              const next = { ...current };
              for (const request of activeRequests) {
                next[snapshotRequestKey(options.phase, request.requestKey)] = message;
              }
              return next;
            });
          });
          finishTrackedMetadataDebug(requestToken, {
            origin: options.origin,
            requestCount: activeRequests.length,
            durationMs: Math.round(performance.now() - startedAt),
            responseCount: 0,
            missingCount: 0,
            error: message,
          });
        } else {
          abortTrackedMetadataDebug(requestToken);
        }
      } finally {
        startTransition(() => {
          setLoadingSnapshots((current) => {
            const next = { ...current };
            for (const key of loadingKeys) {
              if (activeSnapshotRequestKeysRef.current.get(key) === requestToken) {
                delete next[key];
              }
            }
            return next;
          });
        });
        for (const key of loadingKeys) {
          if (activeSnapshotRequestKeysRef.current.get(key) === requestToken) {
            activeSnapshotRequestKeysRef.current.delete(key);
          }
        }
      }
    },
  );

  const drainSnapshotQueue = useEffectEvent(async () => {
    if (snapshotSchedulerRunningRef.current) {
      return;
    }

    const schedulerEpoch = snapshotSchedulerEpochRef.current;
    snapshotSchedulerRunningRef.current = true;
    try {
      while (queuedSnapshotRequestsRef.current.size) {
        if (schedulerEpoch !== snapshotSchedulerEpochRef.current) {
          return;
        }

        const candidates = Array.from(queuedSnapshotRequestsRef.current.values()).filter(
          (item) => {
            const snapshots = item.phase === "before" ? beforeSnapshots : afterSnapshots;
            return (
              !hasSnapshotResult(item.phase, item.request.requestKey, snapshots) &&
              !hasSnapshotInFlight(item.phase, item.request.requestKey)
            );
          },
        );

        if (!candidates.length) {
          queuedSnapshotRequestsRef.current.clear();
          publishQueuedSnapshots();
          return;
        }

        candidates.sort(
          (left, right) => right.priority - left.priority || left.sequence - right.sequence,
        );
        const first = candidates[0];
        const batchLimit = snapshotBatchSizeForPriority(first.priority);
        const batch = candidates
          .filter(
            (item) =>
              item.phase === first.phase &&
              item.origin === first.origin &&
              item.priority === first.priority &&
              item.staleKey === first.staleKey,
          )
          .slice(0, batchLimit);

        for (const item of batch) {
          queuedSnapshotRequestsRef.current.delete(item.queueKey);
        }
        publishQueuedSnapshots();

        await requestSnapshots({
          origin: first.origin,
          phase: first.phase,
          requests: batch.map((item) => item.request),
          priority: first.priority,
          staleKey: first.staleKey,
          generation: Math.max(...batch.map((item) => item.generation)),
        });
        if (schedulerEpoch !== snapshotSchedulerEpochRef.current) {
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    } finally {
      if (schedulerEpoch !== snapshotSchedulerEpochRef.current) {
        return;
      }

      snapshotSchedulerRunningRef.current = false;
      if (queuedSnapshotRequestsRef.current.size) {
        void drainSnapshotQueue();
      }
    }
  });

  const scheduleSnapshotRequests = useEffectEvent(
    (options: {
      origin: string;
      phase: SnapshotPhase;
      requests: MetadataSnapshotRequest[];
      priority: number;
      staleKey: string;
      generation: number;
      snapshots: Record<string, MetadataPreviewSnapshot>;
    }) => {
      if (!options.requests.length) {
        return;
      }

      let changed = false;
      const now = performance.now();
      for (const request of options.requests) {
        const queueKey = snapshotRequestKey(options.phase, request.requestKey);
        const retryAfter = snapshotRetryAfterRef.current.get(queueKey);
        if (
          retryAfter &&
          retryAfter > now &&
          options.priority < SNAPSHOT_HIGH_PRIORITY
        ) {
          continue;
        }
        if (retryAfter && retryAfter <= now) {
          snapshotRetryAfterRef.current.delete(queueKey);
        }
        if (
          hasSnapshotResult(options.phase, request.requestKey, options.snapshots) ||
          hasSnapshotInFlight(options.phase, request.requestKey)
        ) {
          continue;
        }

        const existing = queuedSnapshotRequestsRef.current.get(queueKey);
        if (existing && existing.priority >= options.priority) {
          continue;
        }

        queuedSnapshotRequestsRef.current.set(queueKey, {
          queueKey,
          phase: options.phase,
          request,
          origin: options.origin,
          priority: options.priority,
          staleKey: options.staleKey,
          generation: options.generation,
          sequence: existing?.sequence ?? ++snapshotQueueSequenceRef.current,
        });
        snapshotRetryAfterRef.current.delete(queueKey);
        changed = true;
      }

      if (!changed) {
        return;
      }

      publishQueuedSnapshots();
      void drainSnapshotQueue();
    },
  );

  const resetMetadataState = useEffectEvent(() => {
    activeSnapshotRequestKeysRef.current.clear();
    activeMetadataDebugRequestsRef.current.clear();
    queuedSnapshotRequestsRef.current.clear();
    snapshotRetryAfterRef.current.clear();
    snapshotSchedulerEpochRef.current += 1;
    snapshotSchedulerRunningRef.current = false;
    clearCompletedSnapshotKeys();
    snapshotEpochRef.current += 1;
    snapshotGenerationRef.current = 0;
    setBeforeSnapshots((current) => (Object.keys(current).length ? {} : current));
    setAfterSnapshots((current) => (Object.keys(current).length ? {} : current));
    setQueuedSnapshots((current) => (Object.keys(current).length ? {} : current));
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
    snapshotEpochRef.current += 1;
    clearCompletedSnapshotKeys("after");
    for (const key of Array.from(queuedSnapshotRequestsRef.current.keys())) {
      if (key.startsWith("after:")) {
        queuedSnapshotRequestsRef.current.delete(key);
      }
    }
    for (const key of Array.from(snapshotRetryAfterRef.current.keys())) {
      if (key.startsWith("after:")) {
        snapshotRetryAfterRef.current.delete(key);
      }
    }
    publishQueuedSnapshots();
    let abortedAfterFiles = 0;
    let abortedAfterBatches = 0;
    for (const [requestToken, entry] of Array.from(
      activeMetadataDebugRequestsRef.current.entries(),
    )) {
      if (entry.phase === "after") {
        abortedAfterFiles += entry.requestCount;
        abortedAfterBatches += 1;
        activeMetadataDebugRequestsRef.current.delete(requestToken);
      }
    }
    if (abortedAfterFiles || abortedAfterBatches) {
      finishAbortedMetadataDebug(abortedAfterFiles, abortedAfterBatches);
    }
    for (const key of Array.from(activeSnapshotRequestKeysRef.current.keys())) {
      if (key.startsWith("after:")) {
        activeSnapshotRequestKeysRef.current.delete(key);
      }
    }
    setAfterSnapshots((current) => (Object.keys(current).length ? {} : current));
    setLoadingSnapshots((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (key.startsWith("after:")) {
          delete next[key];
        }
      }
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
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
          !hasSnapshotPending("before", pathKey)
        );
      })
      .map((file) => ({
        requestKey: normalizePath(file.sourcePath),
        filePath: file.sourcePath,
      }));

    scheduleSnapshotRequests({
      origin: "列表预读",
      phase: "before",
      requests,
      priority: 10,
      staleKey: snapshotStaleKey("before:auto"),
      generation: nextSnapshotGeneration(),
      snapshots: beforeSnapshots,
    });
  }, [beforeSnapshots, input.metadataSeedFiles, metadataSeedKey]);

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
          !hasSnapshotPending("before", pathKey)
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
      scheduleSnapshotRequests({
        origin: "可见预读",
        phase: "before",
        requests,
        priority: 40,
        staleKey: snapshotStaleKey("before:auto"),
        generation: nextSnapshotGeneration(),
        snapshots: beforeSnapshots,
      });
    }, VISIBLE_METADATA_PREFETCH_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [beforeSnapshots, input.visibleFiles, visibleMetadataKey]);

  useEffect(() => {
    if (!input.previewFile || !input.previewPathKey) {
      return;
    }

    if (
      hasSnapshotResult("before", input.previewPathKey, beforeSnapshots) ||
      hasSnapshotPending("before", input.previewPathKey)
    ) {
      return;
    }

    scheduleSnapshotRequests({
      origin: "悬停预读",
      phase: "before",
      requests: [
        {
          requestKey: input.previewPathKey,
          filePath: input.previewFile.sourcePath,
        },
      ],
      priority: 100,
      staleKey: snapshotStaleKey("before:hover"),
      generation: nextSnapshotGeneration(),
      snapshots: beforeSnapshots,
    });
  }, [beforeSnapshots, input.previewFile, input.previewPathKey]);

  useEffect(() => {
    if (!input.previewFile || !input.previewPathKey) {
      return;
    }

    const rowState = input.fileStates[input.previewPathKey];
    if (
      rowState?.status !== "success" ||
      hasSnapshotResult("after", input.previewPathKey, afterSnapshots) ||
      hasSnapshotPending("after", input.previewPathKey)
    ) {
      return;
    }

    scheduleSnapshotRequests({
      origin: "悬停后览",
      phase: "after",
      requests: [
        {
          requestKey: input.previewPathKey,
          filePath: rowState.outputPath || input.previewFile.sourcePath,
        },
      ],
      priority: 110,
      staleKey: snapshotStaleKey("after:hover"),
      generation: nextSnapshotGeneration(),
      snapshots: afterSnapshots,
    });
  }, [afterSnapshots, input.fileStates, input.previewFile, input.previewPathKey]);

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
          hasSnapshotPending("after", pathKey)
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
      scheduleSnapshotRequests({
        origin: "可见后览",
        phase: "after",
        requests: limitedRequests,
        priority: 35,
        staleKey: snapshotStaleKey("after:auto"),
        generation: nextSnapshotGeneration(),
        snapshots: afterSnapshots,
      });
    }, VISIBLE_METADATA_PREFETCH_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [afterSnapshots, input.fileStates, input.visibleFiles, visibleMetadataKey]);

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
          hasSnapshotPending("after", pathKey)
        ) {
          return null;
        }

        return {
          requestKey: pathKey,
          filePath: rowState.outputPath || file.sourcePath,
        };
      })
      .filter((request): request is MetadataSnapshotRequest => Boolean(request));

    scheduleSnapshotRequests({
      origin: "任务回填",
      phase: "after",
      requests,
      priority: 25,
      staleKey: snapshotStaleKey("after:task"),
      generation: nextSnapshotGeneration(),
      snapshots: afterSnapshots,
    });
  }, [afterSnapshots, input.fileStates, input.metadataSeedFiles, input.summary, metadataSeedKey]);

  return {
    beforeSnapshots,
    afterSnapshots,
    queuedSnapshots,
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
