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
  const [pinnedPathKey, setPinnedPathKey] = useState<string | null>(null);
  const [flyoutPosition, setFlyoutPosition] = useState<FlyoutPosition>({ left: 16, top: 52 });
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  const hoverTimeoutRef = useRef<number | null>(null);
  const flyoutActiveRef = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
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
    setPinnedPathKey(null);
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
  const previewPathKey = pinnedPathKey ?? (hoveredPathKey ? deferredHoveredPathKey : null);
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
    if (!previewPathKey) {
      return;
    }

    const stillVisible = previewFiles.some(
      (file) => normalizePath(file.sourcePath) === previewPathKey,
    );
    if (!stillVisible) {
      setHoveredPathKey(null);
      setPinnedPathKey(null);
      flyoutActiveRef.current = false;
    }
  }, [previewFiles, previewPathKey]);

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

  const positionFlyout = (rowElement: HTMLDivElement, pointerClientX?: number) => {
    const shell = tableShellRef.current;
    if (!shell) {
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const rowRect = rowElement.getBoundingClientRect();
    const estimatedWidth = Math.min(480, Math.max(340, shell.clientWidth - 24));
    const estimatedHeight = 360;
    const anchorX = pointerClientX ?? rowRect.left + rowRect.width * 0.72;
    const preferredLeft = anchorX - shellRect.left - estimatedWidth - 14;
    const fallbackLeft = anchorX - shellRect.left + 16;
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

  const registerRowRef = useEffectEvent((pathKey: string, element: HTMLDivElement | null) => {
    if (element) {
      rowRefs.current.set(pathKey, element);
    } else {
      rowRefs.current.delete(pathKey);
    }
  });

  const scheduleHover = (pathKey: string, event: React.MouseEvent<HTMLDivElement>) => {
    if (pinnedPathKey && pinnedPathKey !== pathKey) {
      return;
    }
    cancelHoverTimer();
    positionFlyout(event.currentTarget, event.clientX);
    startTransition(() => {
      setHoveredPathKey(pathKey);
    });
  };

  const anchorPreview = useEffectEvent((pathKey: string, rowElement: HTMLDivElement) => {
    cancelHoverTimer();
    flyoutActiveRef.current = true;
    positionFlyout(rowElement);
    startTransition(() => {
      setPinnedPathKey(pathKey);
      setHoveredPathKey(null);
    });
  });

  const handlePreviewKeyDown = useEffectEvent(
    (pathKey: string, rowElement: HTMLDivElement, event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        anchorPreview(pathKey, rowElement);
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      const currentIndex = previewFiles.findIndex(
        (file) => normalizePath(file.sourcePath) === pathKey,
      );
      if (currentIndex < 0) {
        return;
      }

      event.preventDefault();
      const nextIndex =
        event.key === "ArrowDown"
          ? Math.min(previewFiles.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
      const nextFile = previewFiles[nextIndex];
      if (!nextFile) {
        return;
      }

      const nextPathKey = normalizePath(nextFile.sourcePath);
      const nextRow = rowRefs.current.get(nextPathKey);
      if (!nextRow) {
        return;
      }

      anchorPreview(nextPathKey, nextRow);
      nextRow.focus();
    },
  );

  const clearHover = () => {
    if (pinnedPathKey) {
      return;
    }
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
    if (pinnedPathKey) {
      return;
    }
    flyoutActiveRef.current = false;
    clearHover();
  };

  useEffect(() => {
    if (!previewPathKey && !isDetailsOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (isDetailsOpen) {
        setIsDetailsOpen(false);
        return;
      }

      if (previewPathKey) {
        hidePreview();
      }
    };

    const handleWindowBlur = () => {
      if (previewPathKey) {
        hidePreview();
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const shell = tableShellRef.current;
      if (shell && target && shell.contains(target)) {
        return;
      }
      hidePreview();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("pointerdown", handlePointerDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [hidePreview, isDetailsOpen, previewPathKey]);

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
            selectedPreviewPathKey={pinnedPathKey}
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
            onAnchorPreview={anchorPreview}
            onPreviewKeyDown={handlePreviewKeyDown}
            onClearHover={clearHover}
            onFlyoutEnter={handleFlyoutEnter}
            onFlyoutLeave={handleFlyoutLeave}
            onRegisterRowRef={registerRowRef}
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
