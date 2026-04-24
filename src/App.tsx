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
  type CleanupSummary,
  type FlyoutPosition,
  EAGER_METADATA_PREFETCH_LIMIT,
  QUEUE_ROW_HEIGHT,
  SMALL_QUEUE_EAGER_LOAD_THRESHOLD,
  buildActivityState,
  clampNumber,
  normalizePath,
} from "./app-shared";
import { HelpDrawer } from "./components/HelpDrawer";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { TopToolbar } from "./components/TopToolbar";
import { RunDetailsDrawer } from "./components/RunDetailsDrawer";
import { WorkbenchPanel } from "./components/WorkbenchPanel";
import { useDesktopPreferences } from "./hooks/useDesktopPreferences";
import { useMetadataPreviewState } from "./hooks/useMetadataPreviewState";
import { useWorkbenchController } from "./hooks/useWorkbenchController";

function App() {
  const { preferences, setPreference } = useDesktopPreferences();
  const [hoveredPathKey, setHoveredPathKey] = useState<string | null>(null);
  const [pinnedPathKey, setPinnedPathKey] = useState<string | null>(null);
  const [flyoutPosition, setFlyoutPosition] = useState<FlyoutPosition>({ left: 16, top: 52 });
  const [isDetailsOpen, setIsDetailsOpen] = useState(
    () => preferences.reopenRunDetailsOnLaunch && preferences.lastDetailsOpen,
  );
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const hoverTimeoutRef = useRef<number | null>(null);
  const flyoutActiveRef = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const tableShellRef = useRef<HTMLDivElement | null>(null);
  const queueBodyRef = useRef<HTMLDivElement | null>(null);
  const wasScanningRef = useRef(false);
  const wasRunningRef = useRef(false);
  const hadFilesRef = useRef(false);
  const previousSummaryRef = useRef<CleanupSummary | null>(null);
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

  const toggleHelpDrawer = useEffectEvent(() => {
    hidePreview();
    setIsDetailsOpen(false);
    setIsSettingsOpen(false);
    setIsHelpOpen((current) => !current);
  });

  const toggleSettingsDrawer = useEffectEvent(() => {
    hidePreview();
    setIsDetailsOpen(false);
    setIsHelpOpen(false);
    setIsSettingsOpen((current) => !current);
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
  } = useWorkbenchController({
    preferredParallelism: preferences.preferredParallelism,
    metadataWrite: preferences.metadataWrite,
  });

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
    if (!runtimeInfo) {
      return;
    }

    const nextPreferredParallelism =
      parallelism === runtimeInfo.parallelismDefault ? null : parallelism;
    if (preferences.preferredParallelism === nextPreferredParallelism) {
      return;
    }

    setPreference("preferredParallelism", nextPreferredParallelism);
  }, [parallelism, preferences.preferredParallelism, runtimeInfo, setPreference]);

  useEffect(() => {
    if (!preferences.reopenRunDetailsOnLaunch) {
      if (preferences.lastDetailsOpen) {
        setPreference("lastDetailsOpen", false);
      }
      return;
    }

    if (preferences.lastDetailsOpen !== isDetailsOpen) {
      setPreference("lastDetailsOpen", isDetailsOpen);
    }
  }, [
    isDetailsOpen,
    preferences.lastDetailsOpen,
    preferences.reopenRunDetailsOnLaunch,
    setPreference,
  ]);

  useEffect(() => {
    if (
      summary &&
      previousSummaryRef.current !== summary &&
      summary.failed > 0 &&
      preferences.autoOpenDetailsOnFailure
    ) {
      setIsHelpOpen(false);
      setIsSettingsOpen(false);
      setIsDetailsOpen(true);
    }
    previousSummaryRef.current = summary;
  }, [preferences.autoOpenDetailsOnFailure, summary]);

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
        const body = queueBodyRef.current;
        if (!body) {
          return;
        }

        body.scrollTo({
          top: Math.max(0, nextIndex * QUEUE_ROW_HEIGHT - QUEUE_ROW_HEIGHT * 2),
          behavior: "auto",
        });
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            const revealedRow = rowRefs.current.get(nextPathKey);
            if (!revealedRow) {
              return;
            }
            anchorPreview(nextPathKey, revealedRow);
            revealedRow.focus();
          });
        });
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
    if (!previewPathKey && !isDetailsOpen && !isHelpOpen && !isSettingsOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (isSettingsOpen) {
        setIsSettingsOpen(false);
        return;
      }

      if (isHelpOpen) {
        setIsHelpOpen(false);
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
  }, [hidePreview, isDetailsOpen, isHelpOpen, isSettingsOpen, previewPathKey]);

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
  const toolbarNote = summary
    ? summary.cancelled
      ? `最近任务已取消，完成 ${summary.succeeded + summary.failed}/${summary.total} 项`
      : `最近任务成功 ${summary.succeeded} 项，失败 ${summary.failed} 项`
    : isRunning
      ? `正在清理 ${progress.completed}/${progress.total || fileCount} 项，完成度 ${progressPercent}%`
    : isScanning
        ? "正在扫描文件并加入队列"
        : fileCount
          ? `当前队列 ${fileCount} 项，可以直接开始清理`
          : "";

  return (
    <main className="app-shell">
      <TopToolbar
        runtimeInfo={runtimeInfo}
        canStart={canStart}
        isRunning={isRunning}
        isScanning={isScanning}
        parallelism={parallelism}
        toolbarNote={toolbarNote}
        detailsLabel={detailsLabel}
        isDetailsOpen={isDetailsOpen}
        isHelpOpen={isHelpOpen}
        isSettingsOpen={isSettingsOpen}
        onStartCleanup={startCleanup}
        onCancelCurrent={isRunning ? cancelCleanup : cancelScan}
        onToggleDetails={() => {
          setIsHelpOpen(false);
          setIsSettingsOpen(false);
          setIsDetailsOpen((current) => !current);
        }}
        onToggleHelp={toggleHelpDrawer}
        onToggleSettings={toggleSettingsDrawer}
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

      <HelpDrawer isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />

      <SettingsDrawer
        isOpen={isSettingsOpen}
        runtimeInfo={runtimeInfo}
        parallelism={parallelism}
        autoOpenDetailsOnFailure={preferences.autoOpenDetailsOnFailure}
        reopenRunDetailsOnLaunch={preferences.reopenRunDetailsOnLaunch}
        metadataWrite={preferences.metadataWrite}
        onClose={() => setIsSettingsOpen(false)}
        onParallelismChange={setParallelism}
        onResetParallelism={() => {
          if (runtimeInfo) {
            setParallelism(runtimeInfo.parallelismDefault);
          }
        }}
        onAutoOpenDetailsOnFailureChange={(value) =>
          setPreference("autoOpenDetailsOnFailure", value)
        }
        onReopenRunDetailsOnLaunchChange={(value) =>
          setPreference("reopenRunDetailsOnLaunch", value)
        }
        onMetadataWriteChange={(metadataWrite) =>
          setPreference("metadataWrite", metadataWrite)
        }
      />

      {errorMessage ? <div className="error-strip">{errorMessage}</div> : null}
    </main>
  );
}

export default App;
