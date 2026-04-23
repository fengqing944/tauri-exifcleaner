export type CleanupStatus = "running" | "success" | "failed" | "cancelled";
export type BadgeTone = "success" | "warning" | "info" | "neutral" | "danger";

export type RuntimeInfo = {
  defaultOutputDir: string;
  parallelismDefault: number;
  parallelismMax: number;
  exiftoolReady: boolean;
  exiftoolVersion: string | null;
  exiftoolPath: string | null;
};

export type QueuedFile = {
  sourcePath: string;
  relativePath: string;
  rootLabel: string;
  rootSourcePath: string;
  sizeBytes: number;
  fromDirectory: boolean;
};

export type QueueView = {
  supportedCount: number;
  totalBytes: number;
  ignoredCount: number;
  ignoredSamples: string[];
  previewFiles: QueuedFile[];
  rootCount: number;
};

export type ScanProgressEvent = {
  view: QueueView;
  done: boolean;
  cancelled: boolean;
};

export type ScanSummary = {
  view: QueueView;
  cancelled: boolean;
};

export type ShellOpenRequest = {
  paths: string[];
  autoStartCleanup: boolean;
};

export type CleanupProgressEvent = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentPath: string;
  outputPath: string | null;
  status: CleanupStatus;
  error: string | null;
};

export type MetadataFieldPreview = {
  group: string;
  name: string;
  valuePreview: string;
};

export type MetadataPreviewSnapshot = {
  count: number;
  fields: MetadataFieldPreview[];
  truncated: boolean;
};

export type CleanupPreviewState = {
  sourcePath: string;
  outputPath: string | null;
  status: CleanupStatus;
  error: string | null;
  snapshot: MetadataPreviewSnapshot | null;
};

export type CleanupSummary = {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: boolean;
  outputDir: string | null;
  failures: Array<{
    sourcePath: string;
    error: string;
  }>;
  previewStates: CleanupPreviewState[];
};

export type ProgressState = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentPath: string;
  currentStatus: string;
};

export type MetadataSnapshotRequest = {
  requestKey: string;
  filePath: string;
};

export type MetadataSnapshotResponse = {
  requestKey: string;
  snapshot: MetadataPreviewSnapshot;
  missing: boolean;
};

export type DebugLogInfo = {
  path: string;
};

export type MetadataDebugState = {
  status: "idle" | "running" | "success" | "error";
  lastOrigin: string;
  pendingBatches: number;
  pendingFiles: number;
  lastDurationMs: number;
  lastResolved: number;
  lastMissing: number;
  lastMessage: string;
};

export type MetadataDebugEntry = {
  id: string;
  tone: BadgeTone;
  title: string;
  detail: string;
};

export type FileRunState = {
  status: CleanupStatus;
  outputPath: string | null;
  error: string | null;
};

export type FlyoutPosition = {
  left: number;
  top: number;
};

export type ActivityState = {
  label: string;
  title: string;
};

export const EMPTY_PROGRESS: ProgressState = {
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  currentPath: "",
  currentStatus: "idle",
};

export const QUEUE_PAGE_SIZE = 240;
export const EAGER_METADATA_PREFETCH_LIMIT = 48;
export const SMALL_QUEUE_EAGER_LOAD_THRESHOLD = 96;
export const QUEUE_ROW_HEIGHT = 58;
export const QUEUE_VIRTUALIZE_THRESHOLD = 180;
export const QUEUE_VIRTUAL_OVERSCAN = 8;

export const EMPTY_METADATA_DEBUG: MetadataDebugState = {
  status: "idle",
  lastOrigin: "未开始",
  pendingBatches: 0,
  pendingFiles: 0,
  lastDurationMs: 0,
  lastResolved: 0,
  lastMissing: 0,
  lastMessage: "字段读取尚未开始。",
};

export function selectionToArray(selection: string | string[] | null): string[] {
  if (!selection) {
    return [];
  }

  return Array.isArray(selection) ? selection : [selection];
}

export function normalizeSelection(paths: string[]): string[] {
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

export function createProgressState(total: number): ProgressState {
  return {
    total,
    completed: 0,
    succeeded: 0,
    failed: 0,
    currentPath: "",
    currentStatus: "idle",
  };
}

export function normalizePath(path: string): string {
  return path.split("\\").join("/").toLowerCase();
}

export function formatBytes(bytes: number): string {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function trimMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const head = Math.max(12, Math.floor(maxLength / 2) - 2);
  const tail = Math.max(10, Math.floor(maxLength / 2) - 4);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function getLeafName(path: string): string {
  const normalized = path.split("\\").join("/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

export function getParentPath(path: string): string {
  const normalized = path.split("\\").join("/");
  const parts = normalized.split("/");
  if (parts.length <= 1) {
    return "";
  }
  return parts.slice(0, -1).join("/");
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function buildFileStateMap(
  previewStates: CleanupPreviewState[],
): Record<string, FileRunState> {
  return previewStates.reduce<Record<string, FileRunState>>((result, item) => {
    result[normalizePath(item.sourcePath)] = {
      status: item.status,
      outputPath: item.outputPath,
      error: item.error,
    };
    return result;
  }, {});
}

export function buildAfterSnapshotMap(
  previewStates: CleanupPreviewState[],
): Record<string, MetadataPreviewSnapshot> {
  return previewStates.reduce<Record<string, MetadataPreviewSnapshot>>((result, item) => {
    if (item.snapshot) {
      result[normalizePath(item.sourcePath)] = item.snapshot;
    }
    return result;
  }, {});
}

export function mergeSummaryFileStates(
  current: Record<string, FileRunState>,
  queueFiles: QueuedFile[],
  summary: CleanupSummary,
): Record<string, FileRunState> {
  const next = { ...current };
  const previewStateMap = buildFileStateMap(summary.previewStates);
  const failureMap = new Map(summary.failures.map((failure) => [normalizePath(failure.sourcePath), failure.error]));

  for (const [pathKey, state] of Object.entries(previewStateMap)) {
    next[pathKey] = state;
  }

  for (const file of queueFiles) {
    const pathKey = normalizePath(file.sourcePath);
    if (previewStateMap[pathKey]) {
      continue;
    }

    const failure = failureMap.get(pathKey);
    if (failure) {
      next[pathKey] = {
        status: "failed",
        outputPath: null,
        error: failure,
      };
      continue;
    }

    if (!summary.cancelled) {
      next[pathKey] = {
        status: "success",
        outputPath: next[pathKey]?.outputPath ?? null,
        error: null,
      };
    }
  }

  return next;
}

export function toMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "发生了未知错误。";
}

export function getRowStatusDescriptor(rowState?: FileRunState): { label: string; tone: BadgeTone } {
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

export function resolveAfterCountLabel(
  snapshot: MetadataPreviewSnapshot | undefined,
  rowState: FileRunState | undefined,
  loading: boolean,
): string {
  if (snapshot) {
    return String(snapshot.count);
  }
  if (loading) {
    return "读取中";
  }
  if (rowState?.status === "success") {
    return "待读取";
  }
  if (rowState?.status === "running") {
    return "处理中";
  }
  return "—";
}

export function resolveAfterEmptyText(rowState?: FileRunState): string {
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

export function buildActivityState(input: {
  summary: CleanupSummary | null;
  isRunning: boolean;
  isScanning: boolean;
  fileCount: number;
  progress: ProgressState;
}): ActivityState {
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
