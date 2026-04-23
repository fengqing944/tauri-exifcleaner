import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type FlyoutPosition,
  EAGER_METADATA_PREFETCH_LIMIT,
  SMALL_QUEUE_EAGER_LOAD_THRESHOLD,
  buildActivityState,
  clampNumber,
  normalizePath,
} from "./app-shared";
import { TopToolbar } from "./components/TopToolbar";
import { RunDetailsDrawer } from "./components/RunDetailsDrawer";
import { WorkbenchPanel } from "./components/WorkbenchPanel";
import { useMetadataPreviewState } from "./hooks/useMetadataPreviewState";
import { useWorkbenchController } from "./hooks/useWorkbenchController";

function App() {
  const [hoveredPathKey, setHoveredPathKey] = useState<string | null>(null);
  const [flyoutPosition, setFlyoutPosition] = useState<FlyoutPosition>({ left: 16, top: 52 });
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  const hoverTimeoutRef = useRef<number | null>(null);
  const flyoutActiveRef = useRef(false);
  const tableShellRef = useRef<HTMLDivElement | null>(null);
  const queueBodyRef = useRef<HTMLDivElement | null>(null);
  const wasScanningRef = useRef(false);
  const wasRunningRef = useRef(false);
  const hadFilesRef = useRef(false);
  const cancelHoverTimer = useEffectEvent(() => {
    if (hoverTimeoutRef.current) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  });

  const hidePreview = useEffectEvent(() => {
    cancelHoverTimer();
    flyoutActiveRef.current = false;
    setHoveredPathKey(null);
  });

  const {
    runtimeInfo,
    queueView,
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
  } = useWorkbenchController();

  const progressPercent = progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;
  const allQueueFilesLoaded = fileCount > 0 && !hasMoreQueueFiles;
  const metadataSeedFiles = useMemo(() => {
    if (allQueueFilesLoaded && fileCount <= SMALL_QUEUE_EAGER_LOAD_THRESHOLD) {
      return previewFiles;
    }

    return previewFiles.slice(0, Math.min(previewFiles.length, EAGER_METADATA_PREFETCH_LIMIT));
  }, [allQueueFilesLoaded, fileCount, previewFiles]);

  const runningPreviewPathKey =
    previewFiles
      .map((file) => normalizePath(file.sourcePath))
      .find((pathKey) => fileStates[pathKey]?.status === "running") ?? "";

  const highlightedPathKey = runningPreviewPathKey || activePathKey;
  const deferredHoveredPathKey = useDeferredValue(hoveredPathKey);
  const previewPathKey = hoveredPathKey ? deferredHoveredPathKey : null;
  const previewFile =
    previewFiles.find((file) => normalizePath(file.sourcePath) === previewPathKey) ?? null;

  const {
    beforeSnapshots,
    afterSnapshots,
    loadingSnapshots,
    debugLogPath,
    metadataDebug,
    metadataDebugEntries,
    resetMetadataState,
    clearAfterSnapshots,
    applyCleanupPreviewStates,
  } = useMetadataPreviewState({
    metadataSeedFiles,
    previewFile,
    previewPathKey,
    fileStates,
    summary,
    onError: setErrorMessage,
  });

  useEffect(() => {
    if (isScanning && !wasScanningRef.current) {
      resetMetadataState();
      hidePreview();
    }
    wasScanningRef.current = isScanning;
  }, [isScanning]);

  useEffect(() => {
    if (isRunning && !wasRunningRef.current) {
      clearAfterSnapshots();
      hidePreview();
    }
    wasRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    if (summary?.previewStates.length) {
      applyCleanupPreviewStates(summary.previewStates);
    }
  }, [summary]);

  useEffect(() => {
    if (!fileCount && hadFilesRef.current) {
      resetMetadataState();
      hidePreview();
    }
    hadFilesRef.current = fileCount > 0;
  }, [fileCount]);

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
  }, [hasMoreQueueFiles, isLoadingQueuePage, previewFiles.length]);

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
  const detailsLabel =
    metadataDebug.status === "running"
      ? "读取中"
      : runFailures.length
        ? `${runFailures.length} 条错误`
        : "调试";

  return (
    <main className="app-shell">
      <TopToolbar
        runtimeInfo={runtimeInfo}
        canStart={canStart}
        isRunning={isRunning}
        isScanning={isScanning}
        parallelism={parallelism}
        detailsLabel={detailsLabel}
        isDetailsOpen={isDetailsOpen}
        onParallelismChange={setParallelism}
        onStartCleanup={startCleanup}
        onCancelCurrent={isRunning ? cancelCleanup : cancelScan}
        onToggleDetails={() => setIsDetailsOpen((current) => !current)}
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

      <RunDetailsDrawer
        isOpen={isDetailsOpen}
        isRunning={isRunning}
        metadataDebug={metadataDebug}
        metadataDebugEntries={metadataDebugEntries}
        debugLogPath={debugLogPath}
        runFailures={runFailures}
        onClose={() => setIsDetailsOpen(false)}
      />

      {errorMessage ? <div className="error-strip">{errorMessage}</div> : null}
    </main>
  );
}

export default App;
