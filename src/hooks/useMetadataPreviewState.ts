import { invoke } from "@tauri-apps/api/core";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
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
  buildAfterSnapshotMap,
  normalizePath,
  toMessage,
} from "../app-shared";

type UseMetadataPreviewStateInput = {
  metadataSeedFiles: QueuedFile[];
  previewFile: QueuedFile | null;
  previewPathKey: string | null;
  fileStates: Record<string, FileRunState>;
  summary: CleanupSummary | null;
  onError: (message: string) => void;
};

export function useMetadataPreviewState(input: UseMetadataPreviewStateInput) {
  const [beforeSnapshots, setBeforeSnapshots] = useState<Record<string, MetadataPreviewSnapshot>>(
    {},
  );
  const [afterSnapshots, setAfterSnapshots] = useState<Record<string, MetadataPreviewSnapshot>>(
    {},
  );
  const [loadingSnapshots, setLoadingSnapshots] = useState<Record<string, boolean>>({});
  const [debugLogPath, setDebugLogPath] = useState("");
  const [metadataDebug, setMetadataDebug] = useState<MetadataDebugState>(EMPTY_METADATA_DEBUG);
  const [metadataDebugEntries, setMetadataDebugEntries] = useState<MetadataDebugEntry[]>([]);

  const metadataSeedKey = useMemo(
    () => input.metadataSeedFiles.map((file) => normalizePath(file.sourcePath)).join("|"),
    [input.metadataSeedFiles],
  );

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
    error?: string;
  }) => {
    startTransition(() => {
      setMetadataDebug((current) => ({
        status: result.error ? "error" : "success",
        lastOrigin: result.origin,
        pendingBatches: Math.max(0, current.pendingBatches - 1),
        pendingFiles: Math.max(0, current.pendingFiles - result.requestCount),
        lastDurationMs: result.durationMs,
        lastResolved: Math.max(0, result.responseCount - result.missingCount),
        lastMissing: result.missingCount,
        lastMessage: result.error
          ? `${result.origin} 失败: ${result.error}`
          : `${result.origin} 完成，返回 ${result.responseCount} 项`,
      }));
    });

    pushMetadataDebugEntry(
      result.error ? "danger" : result.missingCount ? "warning" : "success",
      result.origin,
      result.error
        ? result.error
        : `耗时 ${result.durationMs} ms，返回 ${result.responseCount} 项，缺失 ${result.missingCount} 项`,
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

      const loadingKeys = options.requests.map(
        (request) => `${options.phase}:${request.requestKey}`,
      );
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
      beginMetadataDebug(options.origin, options.requests.length);

      try {
        const responses = await invoke<MetadataSnapshotResponse[]>("load_metadata_snapshots", {
          requests: options.requests,
        });

        startTransition(() => {
          const applyResponses =
            options.phase === "before" ? setBeforeSnapshots : setAfterSnapshots;
          applyResponses((current) => {
            const next = { ...current };
            for (const response of responses) {
              next[response.requestKey] = response.snapshot;
            }
            return next;
          });
        });

        finishMetadataDebug({
          origin: options.origin,
          requestCount: options.requests.length,
          durationMs: Math.round(performance.now() - startedAt),
          responseCount: responses.length,
          missingCount: responses.filter((response) => response.missing).length,
        });
      } catch (error) {
        const message = toMessage(error);
        input.onError(message);
        finishMetadataDebug({
          origin: options.origin,
          requestCount: options.requests.length,
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
      }
    },
  );

  const resetMetadataState = useEffectEvent(() => {
    setBeforeSnapshots({});
    setAfterSnapshots({});
    setLoadingSnapshots({});
    setMetadataDebug(EMPTY_METADATA_DEBUG);
    setMetadataDebugEntries([]);
  });

  const clearAfterSnapshots = useEffectEvent(() => {
    setAfterSnapshots({});
  });

  const applyCleanupPreviewStates = useEffectEvent((previewStates: CleanupPreviewState[]) => {
    setAfterSnapshots(buildAfterSnapshotMap(previewStates));
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
        return !beforeSnapshots[pathKey] && !loadingSnapshots[`before:${pathKey}`];
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
  }, [beforeSnapshots, input.metadataSeedFiles, loadingSnapshots, metadataSeedKey, requestSnapshots]);

  useEffect(() => {
    if (!input.previewFile || !input.previewPathKey) {
      return;
    }

    const loadingKey = `before:${input.previewPathKey}`;
    if (beforeSnapshots[input.previewPathKey] || loadingSnapshots[loadingKey]) {
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
  }, [
    beforeSnapshots,
    input.previewFile,
    input.previewPathKey,
    loadingSnapshots,
    requestSnapshots,
  ]);

  useEffect(() => {
    if (!input.previewFile || !input.previewPathKey) {
      return;
    }

    const rowState = input.fileStates[input.previewPathKey];
    const loadingKey = `after:${input.previewPathKey}`;
    if (rowState?.status !== "success" || afterSnapshots[input.previewPathKey] || loadingSnapshots[loadingKey]) {
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
  }, [
    afterSnapshots,
    input.fileStates,
    input.previewFile,
    input.previewPathKey,
    loadingSnapshots,
    requestSnapshots,
  ]);

  useEffect(() => {
    if (!input.summary || input.summary.cancelled || !input.metadataSeedFiles.length) {
      return;
    }

    const requests = input.metadataSeedFiles
      .map((file) => {
        const pathKey = normalizePath(file.sourcePath);
        const rowState = input.fileStates[pathKey];
        if (rowState?.status !== "success" || afterSnapshots[pathKey] || loadingSnapshots[`after:${pathKey}`]) {
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
  }, [
    afterSnapshots,
    input.fileStates,
    input.metadataSeedFiles,
    input.summary,
    loadingSnapshots,
    metadataSeedKey,
    requestSnapshots,
  ]);

  return {
    beforeSnapshots,
    afterSnapshots,
    loadingSnapshots,
    debugLogPath,
    metadataDebug,
    metadataDebugEntries,
    resetMetadataState,
    clearAfterSnapshots,
    applyCleanupPreviewStates,
  };
}
