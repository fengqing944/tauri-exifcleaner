import {
  startTransition,
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

type CleanupProgressEvent = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentPath: string;
  outputPath: string | null;
  status: "success" | "failed" | "cancelled";
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
  const [outputMode, setOutputMode] = useState<OutputMode>("mirror");
  const [outputDir, setOutputDir] = useState("");
  const [parallelism, setParallelism] = useState(2);
  const [preserveStructure, setPreserveStructure] = useState(true);
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [runFailures, setRunFailures] = useState<Array<{ sourcePath: string; error: string }>>([]);
  const [summary, setSummary] = useState<CleanupSummary | null>(null);

  const pendingProgressRef = useRef<CleanupProgressEvent | null>(null);
  const dropActiveRef = useRef(false);

  const progressPercent = progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;
  const fileCount = queueView?.supportedCount ?? 0;
  const rootCount = queueView?.rootCount ?? 0;
  const previewFiles = queueView?.previewFiles ?? [];
  const ignoredCount = queueView?.ignoredCount ?? 0;
  const moreFiles = Math.max(0, fileCount - previewFiles.length);
  const activePathKey = progress.currentPath ? normalizePath(progress.currentPath) : "";
  const canStart =
    fileCount > 0 &&
    !isScanning &&
    !isRunning &&
    (outputMode === "overwrite" || outputDir.trim().length > 0);

  const handleProgressEvent = useEffectEvent((payload: CleanupProgressEvent) => {
    pendingProgressRef.current = payload;
  });

  const scanInputPaths = useEffectEvent(async (paths: string[]) => {
    if (isRunning) {
      setErrorMessage("请等待当前清理任务结束后再追加导入。");
      return;
    }

    const cleanedPaths = normalizeSelection(paths);
    if (!cleanedPaths.length) {
      return;
    }

    setIsScanning(true);
    setErrorMessage(null);

    try {
      const result = await invoke<QueueView>("scan_inputs", {
        inputPaths: cleanedPaths,
      });

      startTransition(() => {
        setQueueView(result);
        setProgress(createProgressState(result.supportedCount));
        setSummary(null);
        setRunFailures([]);
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
        setOutputDir((current) => current || info.defaultOutputDir);
      })
      .catch((error) => {
        if (!disposed) {
          setErrorMessage(toMessage(error));
        }
      });

    const cleanupProgressListener = listen<CleanupProgressEvent>("cleanup-progress", (event) =>
      handleProgressEvent(event.payload),
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
      void cleanupProgressListener.then((unlisten) => unlisten());
      unlistenWindowDrop?.();
    };
  }, [handleProgressEvent, handleWindowDrop]);

  useEffect(() => {
    if (!isRunning) {
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
  }, [isRunning]);

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

  const pickOutputDirectory = async () => {
    const selection = await open({
      title: "选择清理后的输出目录",
      multiple: false,
      directory: true,
      defaultPath: outputDir || runtimeInfo?.defaultOutputDir,
    });

    const [selected] = selectionToArray(selection);
    if (selected) {
      setOutputDir(selected);
    }
  };

  const startCleanup = async () => {
    if (!fileCount || !canStart) {
      return;
    }

    setIsRunning(true);
    setErrorMessage(null);
    setSummary(null);
    setRunFailures([]);
    pendingProgressRef.current = null;
    setProgress(createProgressState(fileCount));

    try {
      const result = await invoke<CleanupSummary>("run_cleanup", {
        options: {
          outputMode,
          outputDir: outputMode === "mirror" ? outputDir : null,
          parallelism,
          preserveStructure,
        },
      });

      setSummary(result);
      setRunFailures(result.failures.slice(0, 6));
      setProgress((current) => ({
        ...current,
        total: result.total,
        completed: result.succeeded + result.failed,
        succeeded: result.succeeded,
        failed: result.failed,
        currentStatus: result.cancelled ? "cancelled" : "done",
      }));
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

  const clearQueue = async () => {
    try {
      await invoke("clear_queue");
      setQueueView(null);
      setSummary(null);
      setRunFailures([]);
      setProgress(EMPTY_PROGRESS);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toMessage(error));
    }
  };

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
          <span>{outputMode === "overwrite" ? "原地覆盖" : "镜像输出"}</span>
        </div>
      </header>

      <section className="workspace">
        <section className="content">
          <Panel
            title="导入与预览"
            subtitle="拖拽区和预览区合并在一起。导入后会在这里直接显示当前队列和当前清理位置。"
            aside={
              isScanning ? (
                <StatusBadge tone="info" label="扫描中" />
              ) : isRunning ? (
                <StatusBadge tone="info" label="处理中" />
              ) : (
                <StatusBadge tone={dropActive ? "info" : "neutral"} label={dropActive ? "释放导入" : "待命"} />
              )
            }
          >
            <button
              className={`dropzone workbench-dropzone ${dropActive ? "active" : ""}`}
              type="button"
              disabled={isRunning}
              onClick={addFiles}
            >
              <strong>拖放图像、视频或 PDF 文件</strong>
              <span>支持多文件和多文件夹。导入后会在这个区域直接显示预览列表，并标出当前清理到哪里。</span>
            </button>

            <div className="button-row">
              <button className="button button-primary" type="button" onClick={addFiles} disabled={isRunning}>
                添加文件
              </button>
              <button className="button" type="button" onClick={addFolders} disabled={isRunning}>
                添加文件夹
              </button>
              <button className="button button-danger" type="button" onClick={clearQueue} disabled={isRunning}>
                清空
              </button>
            </div>

            <div className="metrics-grid">
              <MetricCard label="输入根" value={String(rootCount)} />
              <MetricCard label="候选文件" value={String(fileCount)} />
              <MetricCard label="总大小" value={formatBytes(queueView?.totalBytes ?? 0)} />
              <MetricCard label="忽略项" value={String(ignoredCount)} />
            </div>

            {ignoredCount > 0 ? (
              <div className="message warning">
                已忽略 {ignoredCount} 个不支持的项目。
                {queueView?.ignoredSamples.length ? ` 示例: ${queueView.ignoredSamples.join(" · ")}` : ""}
              </div>
            ) : null}

            <div className="activity-banner">
              <span className="activity-label">
                {isRunning ? "当前正在清理" : fileCount ? "当前队列" : "等待导入"}
              </span>
              <strong title={progress.currentPath}>
                {isRunning
                  ? trimMiddle(progress.currentPath || "准备处理下一项", 88)
                  : fileCount
                    ? `已加入 ${fileCount} 个文件，等待执行清理`
                    : "把文件或文件夹拖进来，这里会直接显示预览列表和当前处理位置"}
              </strong>
              <div className="activity-meta">
                <span>
                  {progress.completed}/{progress.total || fileCount}
                </span>
                <span>{progressPercent}%</span>
                <span>{progress.currentStatus}</span>
              </div>
            </div>

            {!fileCount ? (
              <EmptyBox title="未选择文件" description="拖放图像、视频或 PDF 文件以自动删除元数据。" />
            ) : (
              <>
                <div className="preview-list">
                  {previewFiles.map((file) => {
                    const isActive = activePathKey === normalizePath(file.sourcePath);

                    return (
                      <div key={file.sourcePath} className={`preview-row ${isActive ? "is-active" : ""}`}>
                        <div className="preview-file">
                          <strong title={file.relativePath}>{trimMiddle(file.relativePath, 46)}</strong>
                          <span title={file.sourcePath}>{trimMiddle(file.sourcePath, 72)}</span>
                        </div>
                        <span className="preview-meta">{trimMiddle(file.rootLabel, 24)}</span>
                        <span className="preview-meta">{formatBytes(file.sizeBytes)}</span>
                        <span className={`preview-status ${isActive ? "is-active" : ""}`}>
                          {isActive ? "正在处理" : isRunning ? "队列中" : "待处理"}
                        </span>
                      </div>
                    );
                  })}

                  {moreFiles > 0 ? <div className="footnote">还有 {moreFiles} 个文件未展开显示。</div> : null}
                </div>
              </>
            )}
          </Panel>
        </section>

        <aside className="sidebar">
          <Panel
            title="进度"
            subtitle="清理过程中会持续显示当前处理到的文件。"
            aside={<StatusBadge tone={isRunning ? "info" : "neutral"} label={isRunning ? "处理中" : "空闲"} />}
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
              <div className="current-path" title={progress.currentPath}>
                {progress.currentPath ? trimMiddle(progress.currentPath, 68) : "尚未开始处理"}
              </div>
            </div>

            {summary ? (
              <div className={`message ${summary.cancelled ? "warning" : "success"}`}>
                {summary.cancelled
                  ? `任务已取消，已完成 ${summary.succeeded + summary.failed}/${summary.total} 项。`
                  : `任务完成，成功 ${summary.succeeded} 项，失败 ${summary.failed} 项。`}
              </div>
            ) : null}

            {runFailures.length ? (
              <div className="failure-list">
                {runFailures.map((failure) => (
                  <div key={failure.sourcePath} className="failure-row">
                    <strong title={failure.sourcePath}>{trimMiddle(failure.sourcePath, 48)}</strong>
                    <span>{failure.error}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyBox title="没有错误项" description="这里只保留最近失败项，不再维护整块活动流。" />
            )}
          </Panel>

          <Panel title="设置" subtitle="默认并发降到更稳的级别，优先保证程序响应。">
            <div className="mode-row">
              <button
                type="button"
                className={`button button-mode ${outputMode === "mirror" ? "is-selected" : ""}`}
                onClick={() => setOutputMode("mirror")}
              >
                镜像输出
              </button>
              <button
                type="button"
                className={`button button-mode ${outputMode === "overwrite" ? "is-selected is-danger" : ""}`}
                onClick={() => setOutputMode("overwrite")}
              >
                原地覆盖
              </button>
            </div>

            <label className="field">
              <span>输出目录</span>
              <div className="field-row">
                <input
                  value={outputMode === "overwrite" ? "原地覆盖模式下不需要输出目录" : outputDir}
                  readOnly
                  disabled={outputMode === "overwrite"}
                />
                <button
                  type="button"
                  className="button"
                  disabled={outputMode === "overwrite"}
                  onClick={pickOutputDirectory}
                >
                  浏览
                </button>
              </div>
            </label>

            <label className="field">
              <span>目录结构</span>
              <button
                type="button"
                className={`button ${preserveStructure ? "is-soft-selected" : ""}`}
                onClick={() => setPreserveStructure((value) => !value)}
                disabled={outputMode === "overwrite"}
              >
                {preserveStructure ? "保留原目录结构" : "平铺输出"}
              </button>
            </label>

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

            <div className="button-row button-row-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={!canStart}
                onClick={startCleanup}
              >
                开始清理
              </button>
              <button className="button" type="button" disabled={!isRunning} onClick={cancelCleanup}>
                取消
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

function StatusBadge(props: { tone: "success" | "warning" | "info" | "neutral"; label: string }) {
  return <span className={`badge ${props.tone}`}>{props.label}</span>;
}

function MetricCard(props: { label: string; value: string }) {
  return (
    <div className="metric-card">
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
  return path.toLowerCase();
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

function toMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "发生了未知错误。";
}

export default App;
