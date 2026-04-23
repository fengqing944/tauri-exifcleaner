use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::{BufRead, BufReader, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self as std_mpsc, Receiver},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use walkdir::WalkDir;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "3fr", "ai", "arq", "arw", "avif", "avi", "bmp", "cr2", "cr3", "crw", "dcp", "dng", "eps",
    "erf", "gif", "gpr", "heic", "heif", "iiq", "insp", "jpeg", "jpg", "jxl", "m4a", "m4v",
    "mef", "mie", "mov", "mp3", "mp4", "mrw", "nef", "nrw", "orf", "pdf", "png", "ps", "psd",
    "raf", "raw", "rw2", "sr2", "srw", "tif", "tiff", "wav", "webp", "wmv", "x3f",
];
const MAX_QUEUE_PREVIEW_FILES: usize = 12;
const SCAN_BATCH_SIZE: usize = 256;
const METADATA_GROUPS_TO_SKIP: &[&str] = &["Composite", "ExifTool", "File", "System"];
const QUEUE_PAGE_SIZE_MAX: usize = 512;
const QUEUE_INDEX_STRIDE: usize = 128;
const DEBUG_LOG_MAX_BYTES: u64 = 512 * 1024;
const SHELL_CLEAN_ARG: &str = "--shell-clean";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct CleanupState {
    running: Mutex<bool>,
    cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Default)]
struct ScanState {
    running: Mutex<bool>,
    cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Default)]
struct QueueState {
    inner: Mutex<QueueStore>,
}

#[derive(Default)]
struct PendingShellRequestState {
    inner: Mutex<Option<ShellOpenRequest>>,
}

#[derive(Default)]
struct QueueStore {
    file_count: usize,
    preview_files: Vec<QueuedFile>,
    queue_file_path: Option<PathBuf>,
    queue_page_offsets: Vec<u64>,
    file_hashes: HashSet<u64>,
    roots: HashMap<String, RootSummary>,
    total_bytes: u64,
    ignored_count: usize,
    ignored_samples: Vec<String>,
}

impl Drop for QueueStore {
    fn drop(&mut self) {
        if let Some(path) = self.queue_file_path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum OutputMode {
    Mirror,
    Overwrite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedFile {
    source_path: String,
    relative_path: String,
    root_label: String,
    root_source_path: String,
    size_bytes: u64,
    from_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootSummary {
    label: String,
    source_path: String,
    total_files: usize,
    total_bytes: u64,
    from_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueView {
    supported_count: usize,
    total_bytes: u64,
    ignored_count: usize,
    ignored_samples: Vec<String>,
    preview_files: Vec<QueuedFile>,
    root_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupOptions {
    output_mode: OutputMode,
    output_dir: Option<String>,
    parallelism: usize,
    preserve_structure: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    default_output_dir: String,
    parallelism_default: usize,
    parallelism_max: usize,
    exiftool_ready: bool,
    exiftool_version: Option<String>,
    exiftool_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupProgressEvent {
    total: usize,
    completed: usize,
    succeeded: usize,
    failed: usize,
    current_path: String,
    output_path: Option<String>,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupFailure {
    source_path: String,
    error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupPreviewState {
    source_path: String,
    output_path: Option<String>,
    status: String,
    error: Option<String>,
    snapshot: Option<MetadataPreviewSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupSummary {
    total: usize,
    succeeded: usize,
    failed: usize,
    cancelled: bool,
    output_dir: Option<String>,
    failures: Vec<CleanupFailure>,
    preview_states: Vec<CleanupPreviewState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressEvent {
    view: QueueView,
    done: bool,
    cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSummary {
    view: QueueView,
    cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellOpenRequest {
    paths: Vec<String>,
    auto_start_cleanup: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataSnapshotRequest {
    request_key: String,
    file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataFieldPreview {
    group: String,
    name: String,
    value_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataPreviewSnapshot {
    count: usize,
    fields: Vec<MetadataFieldPreview>,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataSnapshotResponse {
    request_key: String,
    snapshot: MetadataPreviewSnapshot,
    missing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugLogInfo {
    path: String,
}

#[derive(Debug, Clone)]
struct PlannedCleanupFile {
    source_path: PathBuf,
    output_path: Option<PathBuf>,
}

#[derive(Debug)]
struct ScanBatch {
    files: Vec<QueuedFile>,
    ignored_count: usize,
    ignored_samples: Vec<String>,
}

impl ScanBatch {
    fn is_empty(&self) -> bool {
        self.files.is_empty() && self.ignored_count == 0 && self.ignored_samples.is_empty()
    }
}

enum ScanWorkerEvent {
    Batch(ScanBatch),
}

struct ScanOutcome {
    cancelled: bool,
}

#[derive(Debug)]
struct FileCleanupOutcome {
    source_path: String,
    output_path: Option<String>,
    status: &'static str,
    error: Option<String>,
}

#[derive(Debug)]
struct FileCleanupStart {
    source_path: String,
    output_path: Option<String>,
}

enum WorkerEvent {
    Started(FileCleanupStart),
    Outcome(FileCleanupOutcome),
    Fatal(String),
}

struct ExifToolSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_events: Receiver<StderrEvent>,
    stderr_thread: Option<thread::JoinHandle<()>>,
    next_execute_id: u64,
}

enum StderrEvent {
    Line(String),
    Closed,
    Error(String),
}

struct ExifToolCommandResult {
    status: i32,
    stderr_output: String,
}

#[tauri::command]
async fn get_runtime_info(app: AppHandle) -> Result<RuntimeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || build_runtime_info(app))
        .await
        .map_err(|error| format!("运行时信息探测任务异常: {error}"))?
}

fn build_runtime_info(app: AppHandle) -> Result<RuntimeInfo, String> {
    let default_output_dir = default_output_dir(&app)?
        .to_string_lossy()
        .to_string();
    let exiftool_path = resolve_exiftool(&app).ok();
    let exiftool_version = exiftool_path
        .as_ref()
        .and_then(|path| read_exiftool_version(path).ok());

    Ok(RuntimeInfo {
        default_output_dir,
        parallelism_default: default_parallelism(),
        parallelism_max: max_parallelism(),
        exiftool_ready: exiftool_path.is_some(),
        exiftool_version,
        exiftool_path: exiftool_path.map(|path| path.to_string_lossy().to_string()),
    })
}

#[tauri::command]
async fn scan_inputs(
    app: AppHandle,
    cleanup_state: State<'_, CleanupState>,
    scan_state: State<'_, ScanState>,
    queue_state: State<'_, QueueState>,
    input_paths: Vec<String>,
) -> Result<ScanSummary, String> {
    if *cleanup_state.running.lock().unwrap() {
        return Err("请等待当前清理任务结束后再追加导入。".to_string());
    }

    {
        let mut running = scan_state.running.lock().unwrap();
        if *running {
            return Err("已有扫描任务正在进行，请等待当前导入完成或先取消扫描。".to_string());
        }
        *running = true;
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut stored_flag = scan_state.cancel_flag.lock().unwrap();
        *stored_flag = Some(cancel_flag.clone());
    }

    let (sender, mut receiver) = mpsc::unbounded_channel::<ScanWorkerEvent>();
    let scan_handle =
        tauri::async_runtime::spawn_blocking(move || perform_scan_inputs(input_paths, cancel_flag, sender));

    let scan_result = async {
        while let Some(event) = receiver.recv().await {
            match event {
                ScanWorkerEvent::Batch(batch) => {
                    let view = {
                        let mut store = queue_state.inner.lock().unwrap();
                        merge_scan_batch(&mut store, batch)?;
                        build_queue_view(&store)
                    };

                    app.emit(
                        "scan-progress",
                        ScanProgressEvent {
                            view,
                            done: false,
                            cancelled: false,
                        },
                    )
                    .map_err(|error| format!("无法发送扫描进度事件: {error}"))?;
                }
            }
        }

        let outcome = scan_handle
            .await
            .map_err(|error| format!("扫描任务异常: {error}"))??;
        let view = {
            let store = queue_state.inner.lock().unwrap();
            build_queue_view(&store)
        };

        app.emit(
            "scan-progress",
            ScanProgressEvent {
                view: view.clone(),
                done: true,
                cancelled: outcome.cancelled,
            },
        )
        .map_err(|error| format!("无法发送扫描完成事件: {error}"))?;

        Ok(ScanSummary {
            view,
            cancelled: outcome.cancelled,
        })
    }
    .await;

    {
        let mut running = scan_state.running.lock().unwrap();
        *running = false;
    }
    {
        let mut stored_flag = scan_state.cancel_flag.lock().unwrap();
        *stored_flag = None;
    }

    scan_result
}

#[tauri::command]
fn cancel_scan(state: State<'_, ScanState>) -> bool {
    if let Some(cancel_flag) = state.cancel_flag.lock().unwrap().as_ref() {
        cancel_flag.store(true, Ordering::Relaxed);
        return true;
    }

    false
}

#[tauri::command]
fn clear_queue(
    cleanup_state: State<'_, CleanupState>,
    scan_state: State<'_, ScanState>,
    queue_state: State<'_, QueueState>,
) -> Result<(), String> {
    if *cleanup_state.running.lock().unwrap() {
        return Err("请等待当前清理任务结束后再清空队列。".to_string());
    }
    if *scan_state.running.lock().unwrap() {
        return Err("扫描尚未结束，请先等待扫描完成或取消扫描。".to_string());
    }

    *queue_state.inner.lock().unwrap() = QueueStore::default();
    Ok(())
}

#[tauri::command]
fn get_queue_files_page(
    queue_state: State<'_, QueueState>,
    offset: usize,
    limit: usize,
) -> Result<Vec<QueuedFile>, String> {
    let store = queue_state.inner.lock().unwrap();
    let page_size = limit.clamp(1, QUEUE_PAGE_SIZE_MAX);
    read_queue_files_page(&store, offset, page_size)
}

#[tauri::command]
fn get_debug_log_info() -> DebugLogInfo {
    DebugLogInfo {
        path: if debug_logging_enabled() {
            debug_log_path().to_string_lossy().to_string()
        } else {
            String::new()
        },
    }
}

#[tauri::command]
fn take_pending_shell_request(
    shell_request_state: State<'_, PendingShellRequestState>,
) -> Option<ShellOpenRequest> {
    shell_request_state.inner.lock().unwrap().take()
}

#[tauri::command]
async fn load_metadata_snapshots(
    app: AppHandle,
    requests: Vec<MetadataSnapshotRequest>,
) -> Result<Vec<MetadataSnapshotResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || build_metadata_snapshots(app, requests))
        .await
        .map_err(|error| format!("元数据预览任务异常: {error}"))?
}

fn perform_scan_inputs(
    input_paths: Vec<String>,
    cancel_flag: Arc<AtomicBool>,
    sender: mpsc::UnboundedSender<ScanWorkerEvent>,
) -> Result<ScanOutcome, String> {
    let mut seen = HashSet::new();
    let mut batch = ScanBatch {
        files: Vec::with_capacity(SCAN_BATCH_SIZE),
        ignored_count: 0,
        ignored_samples: Vec::new(),
    };

    for raw_path in input_paths {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }

        let input_path = PathBuf::from(raw_path);

        if !input_path.exists() {
            batch.ignored_count += 1;
            push_ignored_sample(&mut batch.ignored_samples, &input_path);
            continue;
        }

        let from_directory = input_path.is_dir();
        let root_source_path = input_path.to_string_lossy().to_string();
        let root_label = root_label_for(&input_path, from_directory);

        if from_directory {
            for entry in WalkDir::new(&input_path)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
            {
                if cancel_flag.load(Ordering::Relaxed) {
                    break;
                }

                let file_path = entry.into_path();
                if !is_supported_file(&file_path) {
                    batch.ignored_count += 1;
                    push_ignored_sample(&mut batch.ignored_samples, &file_path);
                    continue;
                }

                let key = dedupe_key(&file_path);
                if !seen.insert(key) {
                    continue;
                }

                let metadata = match fs::metadata(&file_path) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        batch.ignored_count += 1;
                        push_ignored_sample(&mut batch.ignored_samples, &file_path);
                        continue;
                    }
                };

                let relative_path = file_path
                    .strip_prefix(&input_path)
                    .unwrap_or(file_path.as_path())
                    .to_string_lossy()
                    .to_string();

                batch.files.push(QueuedFile {
                    source_path: file_path.to_string_lossy().to_string(),
                    relative_path,
                    root_label: root_label.clone(),
                    root_source_path: root_source_path.clone(),
                    size_bytes: metadata.len(),
                    from_directory: true,
                });

                flush_scan_batch(&sender, &mut batch)?;
            }
        } else if input_path.is_file() {
            if !is_supported_file(&input_path) {
                batch.ignored_count += 1;
                push_ignored_sample(&mut batch.ignored_samples, &input_path);
                continue;
            }

            let key = dedupe_key(&input_path);
            if seen.insert(key) {
                let metadata = fs::metadata(&input_path)
                    .map_err(|error| format!("无法读取文件元信息: {error}"))?;
                let relative_path = input_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("unnamed")
                    .to_string();

                batch.files.push(QueuedFile {
                    source_path: input_path.to_string_lossy().to_string(),
                    relative_path,
                    root_label: root_label.clone(),
                    root_source_path: root_source_path.clone(),
                    size_bytes: metadata.len(),
                    from_directory: false,
                });

                flush_scan_batch(&sender, &mut batch)?;
            }
        }
    }

    flush_remaining_scan_batch(&sender, &mut batch)?;

    Ok(ScanOutcome {
        cancelled: cancel_flag.load(Ordering::Relaxed),
    })
}

fn flush_scan_batch(
    sender: &mpsc::UnboundedSender<ScanWorkerEvent>,
    batch: &mut ScanBatch,
) -> Result<(), String> {
    if batch.files.len() < SCAN_BATCH_SIZE {
        return Ok(());
    }

    flush_remaining_scan_batch(sender, batch)
}

fn flush_remaining_scan_batch(
    sender: &mpsc::UnboundedSender<ScanWorkerEvent>,
    batch: &mut ScanBatch,
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }

    let outgoing = ScanBatch {
        files: std::mem::take(&mut batch.files),
        ignored_count: batch.ignored_count,
        ignored_samples: std::mem::take(&mut batch.ignored_samples),
    };
    batch.ignored_count = 0;

    sender
        .send(ScanWorkerEvent::Batch(outgoing))
        .map_err(|_| "扫描进度通道已关闭。".to_string())
}

fn queue_spool_path() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "tagsweep-queue-{}-{timestamp}.jsonl",
        std::process::id()
    ))
}

fn ensure_queue_spool_path(store: &mut QueueStore) -> PathBuf {
    if let Some(path) = store.queue_file_path.clone() {
        return path;
    }

    let path = queue_spool_path();
    store.queue_file_path = Some(path.clone());
    path
}

fn append_queued_files(store: &mut QueueStore, files: &[QueuedFile]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }

    let spool_path = ensure_queue_spool_path(store);
    let mut spool = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(&spool_path)
        .map_err(|error| format!("无法打开队列暂存文件: {error}"))?;
    let mut next_offset = spool
        .seek(SeekFrom::End(0))
        .map_err(|error| format!("无法定位队列暂存文件: {error}"))?;

    for file in files {
        if store.file_count % QUEUE_INDEX_STRIDE == 0 {
            store.queue_page_offsets.push(next_offset);
        }

        let serialized = serde_json::to_string(file)
            .map_err(|error| format!("无法写入队列文件信息: {error}"))?;
        spool
            .write_all(serialized.as_bytes())
            .and_then(|_| spool.write_all(b"\n"))
            .map_err(|error| format!("无法写入队列暂存文件: {error}"))?;

        next_offset += serialized.len() as u64 + 1;
        store.file_count += 1;
        if store.preview_files.len() < MAX_QUEUE_PREVIEW_FILES {
            store.preview_files.push(file.clone());
        }
    }

    Ok(())
}

fn read_queue_file_line<R>(reader: &mut R) -> Result<Option<QueuedFile>, String>
where
    R: BufRead,
{
    let mut line = String::new();
    let bytes = reader
        .read_line(&mut line)
        .map_err(|error| format!("无法读取队列暂存条目: {error}"))?;
    if bytes == 0 {
        return Ok(None);
    }
    serde_json::from_str::<QueuedFile>(line.trim_end())
        .map(Some)
        .map_err(|error| format!("无法解析队列暂存条目: {error}"))
}

fn read_queue_files_page(
    store: &QueueStore,
    offset: usize,
    limit: usize,
) -> Result<Vec<QueuedFile>, String> {
    let Some(path) = store.queue_file_path.as_deref() else {
        return Ok(Vec::new());
    };

    if offset >= store.file_count {
        return Ok(Vec::new());
    }

    let block_index = offset / QUEUE_INDEX_STRIDE;
    let Some(block_offset) = store.queue_page_offsets.get(block_index).copied() else {
        return Ok(Vec::new());
    };
    let skip_within_block = offset % QUEUE_INDEX_STRIDE;
    let file = fs::File::open(path).map_err(|error| format!("无法读取队列暂存文件: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut page = Vec::with_capacity(limit);
    reader
        .seek(SeekFrom::Start(block_offset))
        .map_err(|error| format!("无法定位队列暂存文件: {error}"))?;

    for _ in 0..skip_within_block {
        let mut discarded = String::new();
        let bytes = reader
            .read_line(&mut discarded)
            .map_err(|error| format!("无法跳过队列暂存条目: {error}"))?;
        if bytes == 0 {
            return Ok(page);
        }
    }

    for _ in 0..limit {
        match read_queue_file_line(&mut reader)? {
            Some(file) => page.push(file),
            None => break,
        }
    }

    Ok(page)
}

fn merge_scan_batch(store: &mut QueueStore, batch: ScanBatch) -> Result<(), String> {
    let mut appended_files = Vec::with_capacity(batch.files.len());

    for file in batch.files {
        let file_hash = dedupe_hash(Path::new(&file.source_path));
        if !store.file_hashes.insert(file_hash) {
            continue;
        }

        store.total_bytes += file.size_bytes;

        let root_key = dedupe_key(Path::new(&file.root_source_path));
        if let Some(existing_root) = store.roots.get_mut(&root_key) {
            existing_root.total_files += 1;
            existing_root.total_bytes += file.size_bytes;
        } else {
            store.roots.insert(
                root_key,
                RootSummary {
                    label: file.root_label.clone(),
                    source_path: file.root_source_path.clone(),
                    total_files: 1,
                    total_bytes: file.size_bytes,
                    from_directory: file.from_directory,
                },
            );
        }

        appended_files.push(file);
    }

    append_queued_files(store, &appended_files)?;
    store.ignored_count += batch.ignored_count;
    merge_ignored_samples(&mut store.ignored_samples, batch.ignored_samples);
    Ok(())
}

fn build_queue_view(store: &QueueStore) -> QueueView {
    QueueView {
        supported_count: store.file_count,
        total_bytes: store.total_bytes,
        ignored_count: store.ignored_count,
        ignored_samples: store.ignored_samples.clone(),
        preview_files: store.preview_files.clone(),
        root_count: store.roots.len(),
    }
}

fn build_cleanup_preview_states(
    tracked_preview_files: &[QueuedFile],
    tracked_preview_states: &HashMap<String, CleanupPreviewState>,
    preview_snapshots: &HashMap<String, MetadataPreviewSnapshot>,
    failure_map: &HashMap<String, String>,
    cancelled: bool,
) -> Vec<CleanupPreviewState> {
    tracked_preview_files
        .iter()
        .map(|file| {
            let key = dedupe_key(Path::new(&file.source_path));
            tracked_preview_states
                .get(&key)
                .cloned()
                .map(|mut state| {
                    if state.status == "success" {
                        state.snapshot = preview_snapshots.get(&key).cloned();
                    }
                    state
                })
                .unwrap_or_else(|| CleanupPreviewState {
                    source_path: file.source_path.clone(),
                    output_path: None,
                    status: if let Some(_) = failure_map.get(&key) {
                        "failed".to_string()
                    } else if cancelled {
                        "cancelled".to_string()
                    } else {
                        "success".to_string()
                    },
                    error: failure_map.get(&key).cloned(),
                    snapshot: preview_snapshots.get(&key).cloned(),
                })
        })
        .collect()
}

fn build_cleanup_preview_snapshot_map(
    exiftool_path: &Path,
    tracked_preview_files: &[QueuedFile],
    tracked_preview_states: &HashMap<String, CleanupPreviewState>,
) -> HashMap<String, MetadataPreviewSnapshot> {
    let mut snapshot_path_keys = HashSet::new();
    let mut snapshot_paths = Vec::new();
    let mut source_to_snapshot_key = HashMap::new();

    for file in tracked_preview_files {
        let source_key = dedupe_key(Path::new(&file.source_path));
        if let Some(state) = tracked_preview_states.get(&source_key) {
            if state.status != "success" {
                continue;
            }
        }

        let target_path = tracked_preview_states
            .get(&source_key)
            .and_then(|state| state.output_path.as_deref())
            .unwrap_or(&file.source_path);
        let target_path = PathBuf::from(target_path);
        if !target_path.is_file() {
            continue;
        }

        let snapshot_key = dedupe_key(&target_path);
        source_to_snapshot_key.insert(source_key, snapshot_key.clone());
        if snapshot_path_keys.insert(snapshot_key) {
            snapshot_paths.push(target_path);
        }
    }

    let snapshot_map = match read_metadata_snapshot_map(exiftool_path, &snapshot_paths) {
        Ok(snapshot_map) => snapshot_map,
        Err(error) => {
            eprintln!("metadata preview snapshot read failed after cleanup: {error}");
            return HashMap::new();
        }
    };

    source_to_snapshot_key
        .into_iter()
        .filter_map(|(source_key, snapshot_key)| {
            snapshot_map
                .get(&snapshot_key)
                .cloned()
                .map(|snapshot| (source_key, snapshot))
        })
        .collect()
}

fn build_metadata_snapshots(
    app: AppHandle,
    requests: Vec<MetadataSnapshotRequest>,
) -> Result<Vec<MetadataSnapshotResponse>, String> {
    let exiftool_path = resolve_exiftool(&app)?;
    let request_count = requests.len();
    if requests.is_empty() {
        return Ok(Vec::new());
    }

    let started_at = Instant::now();
    append_debug_log(format!("metadata.start requests={request_count}"));

    let mut deduped_paths = Vec::new();
    let mut seen = HashSet::new();
    let mut missing_count = 0_usize;

    for request in &requests {
        let file_path = PathBuf::from(&request.file_path);
        if !file_path.is_file() {
            missing_count += 1;
            continue;
        }

        let key = dedupe_key(&file_path);
        if seen.insert(key) {
            deduped_paths.push(file_path);
        }
    }

    let snapshot_map = match read_metadata_snapshot_map(&exiftool_path, &deduped_paths) {
        Ok(snapshot_map) => snapshot_map,
        Err(error) => {
            append_debug_log(format!(
                "metadata.error requests={} valid_files={} missing_files={} elapsed_ms={} error={}",
                request_count,
                deduped_paths.len(),
                missing_count,
                started_at.elapsed().as_millis(),
                sanitize_debug_message(&error)
            ));
            return Err(error);
        }
    };
    let mut results = Vec::with_capacity(requests.len());

    for request in requests {
        let path = PathBuf::from(&request.file_path);
        let key = dedupe_key(&path);
        let snapshot = snapshot_map
            .get(&key)
            .cloned()
            .unwrap_or_else(empty_metadata_snapshot);

        results.push(MetadataSnapshotResponse {
            request_key: request.request_key,
            snapshot,
            missing: !path.is_file(),
        });
    }

    append_debug_log(format!(
        "metadata.done requests={} valid_files={} missing_files={} resolved_files={} elapsed_ms={}",
        request_count,
        deduped_paths.len(),
        missing_count,
        snapshot_map.len(),
        started_at.elapsed().as_millis()
    ));

    Ok(results)
}

fn debug_log_path() -> PathBuf {
    std::env::temp_dir().join("tagsweep-debug.log")
}

fn debug_logging_enabled() -> bool {
    matches!(
        std::env::var("TAGSWEEP_DEBUG_LOG").ok().as_deref(),
        Some("1" | "true" | "TRUE" | "True")
    )
}

fn sanitize_debug_message(message: &str) -> String {
    let flattened = message.replace('\r', " ").replace('\n', " ");
    let scrubbed = flattened
        .split_whitespace()
        .map(|token| {
            if token.contains(":\\")
                || token.contains(":/")
                || token.starts_with("\\\\")
                || token.starts_with('/')
            {
                "<path>"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    truncate_text(&scrubbed, 180)
}

fn append_debug_log(message: String) {
    if !debug_logging_enabled() {
        return;
    }

    let path = debug_log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(metadata) = fs::metadata(&path) {
        if metadata.len() > DEBUG_LOG_MAX_BYTES {
            let _ = fs::remove_file(&path);
        }
    }

    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        let _ = writeln!(file, "[{timestamp}] {message}");
    }
}

fn read_metadata_snapshot_map(
    exiftool_path: &Path,
    input_paths: &[PathBuf],
) -> Result<HashMap<String, MetadataPreviewSnapshot>, String> {
    if input_paths.is_empty() {
        return Ok(HashMap::new());
    }

    let argfile_path = write_utf8_argfile("metadata-preview", input_paths.iter().map(|path| {
        path.to_string_lossy().to_string()
    }))?;
    let mut command = Command::new(exiftool_path);
    command
        .arg("-charset")
        .arg("filename=UTF8")
        .arg("-j")
        .arg("-G1")
        .arg("-s")
        .arg("-a")
        .arg("-u")
        .arg("-m")
        .arg("-ignoreMinorErrors")
        .arg("-@")
        .arg(&argfile_path);
    configure_hidden_process(&mut command);

    if let Some(parent) = exiftool_path.parent() {
        command.current_dir(parent);
    }

    let output = command
        .output()
        .map_err(|error| format!("无法读取元数据预览: {error}"));
    let _ = fs::remove_file(&argfile_path);
    let output = output?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "ExifTool 元数据预览失败。".to_string()
        } else {
            stderr
        });
    }

    let records = serde_json::from_slice::<Vec<HashMap<String, Value>>>(&output.stdout)
        .map_err(|error| format!("无法解析元数据预览结果: {error}"))?;
    let mut snapshots = HashMap::new();

    for record in records {
        let Some(source_file) = record
            .get("SourceFile")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };

        let mut fields = record
            .into_iter()
            .filter_map(|(key, value)| map_metadata_field(&key, &value))
            .collect::<Vec<_>>();
        fields.sort_by(|left, right| {
            left.group
                .cmp(&right.group)
                .then(left.name.cmp(&right.name))
        });

        snapshots.insert(
            dedupe_key(Path::new(&source_file)),
            build_metadata_snapshot(&fields),
        );
    }

    Ok(snapshots)
}

fn map_metadata_field(key: &str, value: &Value) -> Option<MetadataFieldPreview> {
    if key == "SourceFile" {
        return None;
    }

    let (group, name) = split_metadata_key(key);
    if should_skip_metadata_group(group) {
        return None;
    }

    Some(MetadataFieldPreview {
        group: group.to_string(),
        name: name.to_string(),
        value_preview: summarize_metadata_value(value),
    })
}

fn split_metadata_key(key: &str) -> (&str, &str) {
    key.split_once(':').unwrap_or(("General", key))
}

fn should_skip_metadata_group(group: &str) -> bool {
    METADATA_GROUPS_TO_SKIP
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(group))
}

fn summarize_metadata_value(value: &Value) -> String {
    let summary = match value {
        Value::Null => "空值".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.trim().to_string(),
        Value::Array(items) => items
            .iter()
            .take(3)
            .map(summarize_metadata_value)
            .collect::<Vec<_>>()
            .join(" / "),
        Value::Object(map) => format!("{} 个字段", map.len()),
    };

    truncate_text(&summary, 96)
}

fn build_metadata_snapshot(fields: &[MetadataFieldPreview]) -> MetadataPreviewSnapshot {
    MetadataPreviewSnapshot {
        count: fields.len(),
        fields: fields.to_vec(),
        truncated: false,
    }
}

fn empty_metadata_snapshot() -> MetadataPreviewSnapshot {
    MetadataPreviewSnapshot {
        count: 0,
        fields: Vec::new(),
        truncated: false,
    }
}

fn truncate_text(value: &str, max_len: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "空值".to_string();
    }

    if trimmed.chars().count() <= max_len {
        return trimmed.to_string();
    }

    let shortened = trimmed
        .chars()
        .take(max_len.saturating_sub(1))
        .collect::<String>();
    format!("{shortened}...")
}

fn write_utf8_argfile<I>(prefix: &str, lines: I) -> Result<PathBuf, String>
where
    I: IntoIterator<Item = String>,
{
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!(
            "tagsweep-{prefix}-{}-{timestamp}.args",
        std::process::id()
    ));
    let mut content = String::new();

    for line in lines {
        content.push_str(&line);
        content.push('\n');
    }

    fs::write(&path, content).map_err(|error| format!("无法创建 ExifTool 参数文件: {error}"))?;
    Ok(path)
}

#[tauri::command]
fn cancel_cleanup(state: State<'_, CleanupState>) -> bool {
    if let Some(cancel_flag) = state.cancel_flag.lock().unwrap().as_ref() {
        cancel_flag.store(true, Ordering::Relaxed);
        return true;
    }

    false
}

#[tauri::command]
async fn run_cleanup(
    app: AppHandle,
    cleanup_state: State<'_, CleanupState>,
    scan_state: State<'_, ScanState>,
    queue_state: State<'_, QueueState>,
    options: CleanupOptions,
) -> Result<CleanupSummary, String> {
    if *scan_state.running.lock().unwrap() {
        return Err("扫描尚未结束，请等待扫描完成或先取消扫描。".to_string());
    }

    {
        let mut running = cleanup_state.running.lock().unwrap();
        if *running {
            return Err("已有清理任务正在运行，请稍后再试。".to_string());
        }
        *running = true;
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut stored_flag = cleanup_state.cancel_flag.lock().unwrap();
        *stored_flag = Some(cancel_flag.clone());
    }

    let run_result = async {
        let (total, tracked_preview_files, tracked_paths, queue_file_path) = {
            let store = queue_state.inner.lock().unwrap();
            let tracked_preview_files = store.preview_files.clone();
            let tracked_paths = store
                .preview_files
                .iter()
                .take(MAX_QUEUE_PREVIEW_FILES)
                .map(|file| dedupe_key(Path::new(&file.source_path)))
                .collect::<HashSet<_>>();
            (
                store.file_count,
                tracked_preview_files,
                tracked_paths,
                store.queue_file_path.clone(),
            )
        };

        if total == 0 {
            return Ok(CleanupSummary {
                total: 0,
                succeeded: 0,
                failed: 0,
                cancelled: false,
                output_dir: options.output_dir.clone(),
                failures: Vec::new(),
                preview_states: Vec::new(),
            });
        }

        let exiftool_path = resolve_exiftool(&app)?;
        let concurrency = options
            .parallelism
            .clamp(1, max_parallelism())
            .min(total.max(1));

        let (planned_sender, planned_receiver) =
            std_mpsc::sync_channel::<PlannedCleanupFile>((concurrency * 4).max(16));
        let producer_options = options.clone();
        let producer_cancel_flag = cancel_flag.clone();
        let producer_handle = thread::spawn(move || {
            produce_planned_cleanup_files(
                queue_file_path,
                producer_options,
                planned_sender,
                producer_cancel_flag,
            )
        });

        let queue = Arc::new(Mutex::new(planned_receiver));
        let (sender, mut receiver) = mpsc::unbounded_channel::<WorkerEvent>();
        let mut worker_handles = Vec::with_capacity(concurrency);

        for worker_index in 0..concurrency {
            let queue = queue.clone();
            let sender = sender.clone();
            let options = options.clone();
            let exiftool_path = exiftool_path.clone();
            let cancel_flag = cancel_flag.clone();

            worker_handles.push(tauri::async_runtime::spawn_blocking(move || {
                run_cleanup_worker(
                    worker_index,
                    queue,
                    sender,
                    options,
                    exiftool_path,
                    cancel_flag,
                )
            }));
        }
        drop(sender);

        let mut completed = 0_usize;
        let mut succeeded = 0_usize;
        let mut failed = 0_usize;
        let mut failures = Vec::new();
        let mut tracked_preview_states = HashMap::<String, CleanupPreviewState>::new();
        let mut fatal_error = None::<String>;
        let emit_step = if total > 4_000 {
            48
        } else if total > 1_200 {
            24
        } else if total > 300 {
            8
        } else {
            2
        };
        let mut last_emitted_completed = 0_usize;
        let mut last_emit_at = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);

        while let Some(event) = receiver.recv().await {
            match event {
                WorkerEvent::Started(started) => {
                    if tracked_paths.contains(&dedupe_key(Path::new(&started.source_path))) {
                        app.emit(
                            "cleanup-file",
                            CleanupProgressEvent {
                                total,
                                completed,
                                succeeded,
                                failed,
                                current_path: started.source_path,
                                output_path: started.output_path,
                                status: "running".to_string(),
                                error: None,
                            },
                        )
                        .map_err(|error| format!("无法发送行状态事件: {error}"))?;
                    }
                }
                WorkerEvent::Outcome(outcome) => {
                    let outcome_key = dedupe_key(Path::new(&outcome.source_path));
                    if tracked_paths.contains(&outcome_key) {
                        tracked_preview_states.insert(
                            outcome_key,
                            CleanupPreviewState {
                                source_path: outcome.source_path.clone(),
                                output_path: outcome.output_path.clone(),
                                status: outcome.status.to_string(),
                                error: outcome.error.clone(),
                                snapshot: None,
                            },
                        );
                        app.emit(
                            "cleanup-file",
                            CleanupProgressEvent {
                                total,
                                completed: completed + 1,
                                succeeded: succeeded + usize::from(outcome.status == "success"),
                                failed: failed + usize::from(outcome.status == "failed"),
                                current_path: outcome.source_path.clone(),
                                output_path: outcome.output_path.clone(),
                                status: outcome.status.to_string(),
                                error: outcome.error.clone(),
                            },
                        )
                        .map_err(|error| format!("无法发送行状态事件: {error}"))?;
                    }

                    completed += 1;
                    match outcome.status {
                        "success" => succeeded += 1,
                        "failed" => {
                            failed += 1;
                            failures.push(CleanupFailure {
                                source_path: outcome.source_path.clone(),
                                error: outcome
                                    .error
                                    .clone()
                                    .unwrap_or_else(|| "未知错误".to_string()),
                            });
                        }
                        _ => {}
                    }

                    let should_emit = outcome.status == "failed"
                        || completed == total
                        || completed == 1
                        || completed.saturating_sub(last_emitted_completed) >= emit_step
                        || last_emit_at.elapsed() >= Duration::from_millis(320);

                    if should_emit {
                        app.emit(
                            "cleanup-progress",
                            CleanupProgressEvent {
                                total,
                                completed,
                                succeeded,
                                failed,
                                current_path: outcome.source_path.clone(),
                                output_path: outcome.output_path.clone(),
                                status: outcome.status.to_string(),
                                error: outcome.error.clone(),
                            },
                        )
                        .map_err(|error| format!("无法发送进度事件: {error}"))?;
                        last_emitted_completed = completed;
                        last_emit_at = Instant::now();
                    }
                }
                WorkerEvent::Fatal(error) => {
                    fatal_error = Some(error);
                    cancel_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }

        for handle in worker_handles {
            if let Err(error) = handle.await {
                fatal_error.get_or_insert_with(|| format!("后台 worker 异常: {error}"));
            }
        }

        match producer_handle.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                fatal_error.get_or_insert(error);
            }
            Err(_) => {
                fatal_error.get_or_insert_with(|| "清理规划线程异常退出。".to_string());
            }
        }

        if let Some(error) = fatal_error {
            return Err(error);
        }

        let cancelled = cancel_flag.load(Ordering::Relaxed);
        let preview_snapshots =
            build_cleanup_preview_snapshot_map(&exiftool_path, &tracked_preview_files, &tracked_preview_states);
        let failure_map = failures
            .iter()
            .map(|failure| (dedupe_key(Path::new(&failure.source_path)), failure.error.clone()))
            .collect::<HashMap<_, _>>();

        Ok(CleanupSummary {
            total,
            succeeded,
            failed,
            cancelled,
            output_dir: options.output_dir.clone(),
            failures,
            preview_states: build_cleanup_preview_states(
                &tracked_preview_files,
                &tracked_preview_states,
                &preview_snapshots,
                &failure_map,
                cancelled,
            ),
        })
    }
    .await;

    {
        let mut running = cleanup_state.running.lock().unwrap();
        *running = false;
    }
    {
        let mut stored_flag = cleanup_state.cancel_flag.lock().unwrap();
        *stored_flag = None;
    }

    run_result
}

fn run_cleanup_worker(
    worker_index: usize,
    queue: Arc<Mutex<std_mpsc::Receiver<PlannedCleanupFile>>>,
    sender: mpsc::UnboundedSender<WorkerEvent>,
    options: CleanupOptions,
    exiftool_path: PathBuf,
    cancel_flag: Arc<AtomicBool>,
) {
    let mut session = match ExifToolSession::new(&exiftool_path) {
        Ok(session) => session,
        Err(error) => {
            cancel_flag.store(true, Ordering::Relaxed);
            let _ = sender.send(WorkerEvent::Fatal(format!(
                "清理引擎 worker {} 初始化失败: {error}",
                worker_index + 1
            )));
            return;
        }
    };

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }

        let planned_file = {
            let queue = queue.lock().unwrap();
            queue.recv()
        };

        let Ok(planned_file) = planned_file else {
            break;
        };

        if sender
            .send(WorkerEvent::Started(FileCleanupStart {
                source_path: planned_file.source_path.to_string_lossy().to_string(),
                output_path: planned_file
                    .output_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string()),
            }))
            .is_err()
        {
            break;
        }

        let outcome = match execute_cleanup_file(&planned_file, &options, &mut session) {
            Ok(outcome) => outcome,
            Err(error) => FileCleanupOutcome {
                source_path: planned_file.source_path.to_string_lossy().to_string(),
                output_path: planned_file
                    .output_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string()),
                status: "failed",
                error: Some(error),
            },
        };

        if sender.send(WorkerEvent::Outcome(outcome)).is_err() {
            break;
        }
    }

    let _ = session.close();
}

fn produce_planned_cleanup_files(
    queue_file_path: Option<PathBuf>,
    options: CleanupOptions,
    sender: std_mpsc::SyncSender<PlannedCleanupFile>,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let path = queue_file_path.ok_or_else(|| "队列暂存文件不可用。".to_string())?;
    let file = fs::File::open(&path).map_err(|error| format!("无法读取队列暂存文件: {error}"))?;
    let mut reader = BufReader::new(file);
    let output_root = resolve_output_root(&options)?;
    let mut reserved_paths = HashSet::new();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }

        let queued_file = match read_queue_file_line(&mut reader)? {
            Some(file) => file,
            None => break,
        };
        let mut planned_file =
            build_planned_cleanup_file(&queued_file, &options, output_root.as_deref(), &mut reserved_paths)?;

        loop {
            match sender.try_send(planned_file) {
                Ok(()) => break,
                Err(std_mpsc::TrySendError::Disconnected(_)) => return Ok(()),
                Err(std_mpsc::TrySendError::Full(returned_file)) => {
                    if cancel_flag.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    planned_file = returned_file;
                    thread::sleep(Duration::from_millis(8));
                }
            }
        }
    }

    Ok(())
}

fn resolve_output_root(options: &CleanupOptions) -> Result<Option<PathBuf>, String> {
    match options.output_mode {
        OutputMode::Mirror => Ok(Some(PathBuf::from(
            options
                .output_dir
                .as_deref()
                .ok_or_else(|| "镜像输出模式必须选择输出目录。".to_string())?,
        ))),
        OutputMode::Overwrite => Ok(None),
    }
}

fn build_planned_cleanup_file(
    file: &QueuedFile,
    options: &CleanupOptions,
    output_root: Option<&Path>,
    reserved_paths: &mut HashSet<String>,
) -> Result<PlannedCleanupFile, String> {
    let source_path = PathBuf::from(&file.source_path);
    let output_path = match options.output_mode {
        OutputMode::Overwrite => None,
        OutputMode::Mirror => {
            let base_dir = output_root.ok_or_else(|| "输出目录不可用。".to_string())?;

            let mut candidate = base_dir.to_path_buf();
            if options.preserve_structure {
                candidate.push(sanitize_segment(&file.root_label));
                candidate.push(&file.relative_path);
            } else {
                let file_name = Path::new(&file.relative_path)
                    .file_name()
                    .map(|value| value.to_os_string())
                    .unwrap_or_else(|| "unnamed".into());
                candidate.push(file_name);
            }

            Some(reserve_unique_path(candidate, reserved_paths))
        }
    };

    Ok(PlannedCleanupFile {
        source_path,
        output_path,
    })
}

fn execute_cleanup_file(
    planned_file: &PlannedCleanupFile,
    options: &CleanupOptions,
    session: &mut ExifToolSession,
) -> Result<FileCleanupOutcome, String> {
    if let Some(output_path) = planned_file.output_path.as_ref() {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建输出目录 {}: {error}", parent.display()))?;
        }
    }

    session.clean_file(planned_file, options)?;

    Ok(FileCleanupOutcome {
        source_path: planned_file.source_path.to_string_lossy().to_string(),
        output_path: planned_file
            .output_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        status: "success",
        error: None,
    })
}

impl ExifToolSession {
    fn new(exiftool_path: &Path) -> Result<Self, String> {
        let mut command = Command::new(exiftool_path);
        command
            .arg("-charset")
            .arg("filename=UTF8")
            .arg("-stay_open")
            .arg("True")
            .arg("-@")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_hidden_process(&mut command);

        if let Some(parent) = exiftool_path.parent() {
            command.current_dir(parent);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 ExifTool worker: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法获取 ExifTool stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法获取 ExifTool stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法获取 ExifTool stderr".to_string())?;
        let (stderr_sender, stderr_events) = std_mpsc::channel();
        let stderr_thread = thread::spawn(move || drain_stderr(stderr, stderr_sender));

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr_events,
            stderr_thread: Some(stderr_thread),
            next_execute_id: 1,
        })
    }

    fn clean_file(
        &mut self,
        planned_file: &PlannedCleanupFile,
        options: &CleanupOptions,
    ) -> Result<(), String> {
        let execute_id = self.next_execute_id;
        self.next_execute_id += 1;

        let stderr_marker = format!("__META_SWEEP_DONE__:{execute_id}:");

        self.write_arg("-charset")?;
        self.write_arg("filename=UTF8")?;
        self.write_arg("-q")?;
        self.write_arg("-q")?;
        self.write_arg("-m")?;
        self.write_arg("-ignoreMinorErrors")?;
        self.write_arg("-P")?;
        self.write_arg("-all=")?;

        match options.output_mode {
            OutputMode::Overwrite => {
                self.write_arg("-overwrite_original")?;
            }
            OutputMode::Mirror => {
                let output_path = planned_file
                    .output_path
                    .as_ref()
                    .ok_or_else(|| "镜像输出模式缺少目标路径。".to_string())?;
                self.write_arg("-o")?;
                self.write_arg(&output_path.to_string_lossy())?;
            }
        }

        self.write_arg("-echo4")?;
        self.write_arg(&format!("{stderr_marker}${{status}}"))?;
        self.write_arg(&planned_file.source_path.to_string_lossy())?;
        self.write_arg(&format!("-execute{execute_id}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("无法刷新 ExifTool 指令: {error}"))?;

        self.consume_stdout_until_ready(execute_id)?;
        let result = self.consume_stderr_until_marker(&stderr_marker)?;

        if !result.stderr_output.is_empty() {
            return Err(result.stderr_output);
        }
        if result.status != 0 {
            return Err(format!("ExifTool 返回了非零状态码 {}", result.status));
        }

        Ok(())
    }

    fn close(&mut self) -> Result<(), String> {
        let _ = self.write_arg("-stay_open");
        let _ = self.write_arg("False");
        let _ = self.stdin.flush();
        self.child
            .wait()
            .map_err(|error| format!("关闭 ExifTool worker 失败: {error}"))?;
        if let Some(handle) = self.stderr_thread.take() {
            let _ = handle.join();
        }
        Ok(())
    }

    fn write_arg(&mut self, value: &str) -> Result<(), String> {
        writeln!(self.stdin, "{value}")
            .map_err(|error| format!("写入 ExifTool 参数失败: {error}"))
    }

    fn consume_stdout_until_ready(&mut self, execute_id: u64) -> Result<(), String> {
        let ready_marker = format!("{{ready{execute_id}}}");

        loop {
            let line = read_line(&mut self.stdout, "stdout")?;
            if line == ready_marker {
                return Ok(());
            }
        }
    }

    fn consume_stderr_until_marker(
        &mut self,
        marker_prefix: &str,
    ) -> Result<ExifToolCommandResult, String> {
        let mut stderr_lines = Vec::new();

        loop {
            match self
                .stderr_events
                .recv()
                .map_err(|_| "ExifTool stderr 通道已关闭。".to_string())?
            {
                StderrEvent::Line(line) => {
                    if let Some(status) = line.strip_prefix(marker_prefix) {
                        let status = status
                            .trim()
                            .parse::<i32>()
                            .map_err(|error| format!("无法解析 ExifTool 状态码: {error}"))?;

                        return Ok(ExifToolCommandResult {
                            status,
                            stderr_output: stderr_lines.join("\n"),
                        });
                    }

                    if !line.is_empty() {
                        stderr_lines.push(line);
                    }
                }
                StderrEvent::Closed => {
                    return Err("ExifTool stderr 意外关闭。".to_string());
                }
                StderrEvent::Error(error) => return Err(error),
            }
        }
    }
}

fn drain_stderr(stderr: impl std::io::Read, sender: std_mpsc::Sender<StderrEvent>) {
    let mut reader = BufReader::new(stderr);

    loop {
        let mut buffer = String::new();
        match reader.read_line(&mut buffer) {
            Ok(0) => {
                let _ = sender.send(StderrEvent::Closed);
                break;
            }
            Ok(_) => {
                let line = buffer.trim_end_matches(['\r', '\n']).to_string();
                if sender.send(StderrEvent::Line(line)).is_err() {
                    break;
                }
            }
            Err(error) => {
                let _ = sender.send(StderrEvent::Error(format!(
                    "读取 ExifTool stderr 失败: {error}"
                )));
                break;
            }
        }
    }
}

fn read_line<R: BufRead>(reader: &mut R, stream_name: &str) -> Result<String, String> {
    let mut buffer = String::new();
    let bytes = reader
        .read_line(&mut buffer)
        .map_err(|error| format!("读取 ExifTool {stream_name} 失败: {error}"))?;

    if bytes == 0 {
        return Err(format!("ExifTool {stream_name} 意外关闭。"));
    }

    Ok(buffer.trim_end_matches(['\r', '\n']).to_string())
}

fn resolve_exiftool(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(custom_path) = std::env::var("EXIFTOOL_PATH") {
        let candidate = PathBuf::from(custom_path);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    let executable_name = if cfg!(target_os = "windows") {
        "exiftool.exe"
    } else {
        "exiftool"
    };

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("exiftool").join(executable_name));
    }
    candidates.push(
        PathBuf::from("src-tauri")
            .join("resources")
            .join("exiftool")
            .join(executable_name),
    );
    candidates.push(PathBuf::from("resources").join("exiftool").join(executable_name));
    candidates.push(PathBuf::from(executable_name));

    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err("没有找到 ExifTool 可执行文件。请确认打包资源存在，或设置 EXIFTOOL_PATH。".to_string())
}

fn read_exiftool_version(exiftool_path: &Path) -> Result<String, String> {
    let mut command = Command::new(exiftool_path);
    command.arg("-ver").stdout(Stdio::piped()).stderr(Stdio::piped());
    configure_hidden_process(&mut command);
    if let Some(parent) = exiftool_path.parent() {
        command.current_dir(parent);
    }

    let output = command
        .output()
        .map_err(|error| format!("无法读取 ExifTool 版本: {error}"))?;

    if !output.status.success() {
        return Err("ExifTool 版本检查失败。".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn default_output_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .desktop_dir()
        .or_else(|_| app.path().download_dir())
        .map(|path| path.join("TagSweep Output"))
        .map_err(|error| format!("无法解析默认输出目录: {error}"))
}

fn default_parallelism() -> usize {
    num_cpus::get().clamp(1, 2)
}

fn max_parallelism() -> usize {
    num_cpus::get().clamp(2, 16)
}

fn is_supported_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            let extension = extension.to_lowercase();
            SUPPORTED_EXTENSIONS.contains(&extension.as_str())
        })
        .unwrap_or(false)
}

fn root_label_for(path: &Path, from_directory: bool) -> String {
    if from_directory {
        return path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("Imported Folder")
            .to_string();
    }

    path.parent()
        .and_then(|value| value.file_name())
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Loose Files")
        .to_string()
}

fn reserve_unique_path(mut candidate: PathBuf, reserved_paths: &mut HashSet<String>) -> PathBuf {
    let mut suffix = 1_usize;

    while candidate.exists() || reserved_paths.contains(&dedupe_key(&candidate)) {
        let parent = candidate
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(PathBuf::new);
        let stem = candidate
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("cleaned");
        let extension = candidate
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"))
            .unwrap_or_default();
        candidate = parent.join(format!("{stem} ({suffix}){extension}"));
        suffix += 1;
    }

    reserved_paths.insert(dedupe_key(&candidate));
    candidate
}

fn sanitize_segment(input: &str) -> String {
    let cleaned = input
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => character,
        })
        .collect::<String>()
        .trim()
        .to_string();

    if cleaned.is_empty() {
        "Imported".to_string()
    } else {
        cleaned
    }
}

fn collect_shell_open_request_from_strings<I, S>(args: I) -> Option<ShellOpenRequest>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen_marker = false;
    let mut paths = Vec::new();

    for (index, value) in args.into_iter().enumerate() {
        if index == 0 {
            continue;
        }

        let value = value.as_ref();
        if !seen_marker {
            if value == SHELL_CLEAN_ARG {
                seen_marker = true;
            }
            continue;
        }

        let trimmed = value.trim();
        if !trimmed.is_empty() {
            paths.push(trimmed.to_string());
        }
    }

    let paths = normalize_shell_paths(paths);
    if paths.is_empty() {
        None
    } else {
        Some(ShellOpenRequest {
            paths,
            auto_start_cleanup: true,
        })
    }
}

fn collect_shell_open_request_from_os_args<I, S>(args: I) -> Option<ShellOpenRequest>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    let values = args
        .into_iter()
        .map(|value| value.into().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    collect_shell_open_request_from_strings(values)
}

fn normalize_shell_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }

        let path_buf = PathBuf::from(trimmed);
        if !path_buf.exists() {
            continue;
        }

        let key = dedupe_key(&path_buf);
        if !seen.insert(key) {
            continue;
        }

        result.push(path_buf.to_string_lossy().to_string());
    }

    result
}

fn merge_shell_open_request(
    slot: &mut Option<ShellOpenRequest>,
    incoming: ShellOpenRequest,
) -> ShellOpenRequest {
    let mut paths = slot
        .as_ref()
        .map(|request| request.paths.clone())
        .unwrap_or_default();
    paths.extend(incoming.paths);

    let merged = ShellOpenRequest {
        paths: normalize_shell_paths(paths),
        auto_start_cleanup: slot
            .as_ref()
            .map(|request| request.auto_start_cleanup)
            .unwrap_or(false)
            || incoming.auto_start_cleanup,
    };

    *slot = Some(merged.clone());
    merged
}

fn enqueue_shell_open_request(app: &AppHandle, request: ShellOpenRequest) {
    let merged_request = {
        let state = app.state::<PendingShellRequestState>();
        let mut pending = state.inner.lock().unwrap();
        merge_shell_open_request(&mut pending, request)
    };

    if merged_request.paths.is_empty() {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    let _ = app.emit("shell-open-paths", &merged_request);
}

fn dedupe_key(path: &Path) -> String {
    let key = path.to_string_lossy().replace('\\', "/");
    if cfg!(target_os = "windows") {
        key.to_lowercase()
    } else {
        key
    }
}

fn dedupe_hash(path: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    dedupe_key(path).hash(&mut hasher);
    hasher.finish()
}

fn push_ignored_sample(samples: &mut Vec<String>, path: &Path) {
    push_ignored_sample_text(samples, path.to_string_lossy().to_string());
}

fn push_ignored_sample_text(samples: &mut Vec<String>, sample: String) {
    if samples.len() >= 6 || samples.iter().any(|existing| existing == &sample) {
        return;
    }

    samples.push(sample);
}

fn merge_ignored_samples(samples: &mut Vec<String>, additions: Vec<String>) {
    for sample in additions {
        push_ignored_sample_text(samples, sample);
    }
}

fn configure_hidden_process(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_shell_request = collect_shell_open_request_from_os_args(std::env::args_os());
    let mut builder = tauri::Builder::default();
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        if let Some(request) = collect_shell_open_request_from_strings(argv) {
            enqueue_shell_open_request(app, request);
        }
    }));

    builder
        .manage(CleanupState::default())
        .manage(ScanState::default())
        .manage(QueueState::default())
        .manage(PendingShellRequestState {
            inner: Mutex::new(startup_shell_request),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            scan_inputs,
            cancel_scan,
            clear_queue,
            get_queue_files_page,
            get_debug_log_info,
            take_pending_shell_request,
            load_metadata_snapshots,
            run_cleanup,
            cancel_cleanup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queued_file(source_path: &str, relative_path: &str, root_label: &str, root_source_path: &str) -> QueuedFile {
        QueuedFile {
            source_path: source_path.to_string(),
            relative_path: relative_path.to_string(),
            root_label: root_label.to_string(),
            root_source_path: root_source_path.to_string(),
            size_bytes: 128,
            from_directory: true,
        }
    }

    fn bundled_exiftool() -> PathBuf {
        let executable_name = if cfg!(target_os = "windows") {
            "exiftool.exe"
        } else {
            "exiftool"
        };

        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("exiftool")
            .join(executable_name)
    }

    #[test]
    fn queue_store_dedupes_files_and_limits_preview_rows() {
        let mut store = QueueStore::default();

        merge_scan_batch(
            &mut store,
            ScanBatch {
                files: (0..10)
                    .map(|index| {
                        queued_file(
                            &format!("C:/input/{index}.jpg"),
                            &format!("{index}.jpg"),
                            "input",
                            "C:/input",
                        )
                    })
                    .collect(),
                ignored_count: 1,
                ignored_samples: vec!["C:/ignored/a.txt".to_string()],
            },
        )
        .expect("merge first scan batch");
        merge_scan_batch(
            &mut store,
            ScanBatch {
                files: vec![
                    queued_file("C:/input/2.jpg", "2.jpg", "input", "C:/input"),
                    queued_file("C:/input/10.jpg", "10.jpg", "input", "C:/input"),
                ],
                ignored_count: 1,
                ignored_samples: vec!["C:/ignored/a.txt".to_string(), "C:/ignored/b.txt".to_string()],
            },
        )
        .expect("merge second scan batch");

        let view = build_queue_view(&store);
        let page = read_queue_files_page(&store, 8, 4).expect("read paged queue files");

        assert_eq!(view.supported_count, 11);
        assert_eq!(
            view.preview_files.len(),
            view.supported_count.min(MAX_QUEUE_PREVIEW_FILES)
        );
        assert_eq!(view.root_count, 1);
        assert_eq!(view.ignored_count, 2);
        assert_eq!(view.ignored_samples, vec!["C:/ignored/a.txt", "C:/ignored/b.txt"]);
        assert_eq!(page.len(), 3);
        assert_eq!(page[0].relative_path, "8.jpg");
        assert_eq!(page[2].relative_path, "10.jpg");
    }

    #[test]
    fn scan_inputs_emits_multiple_batches_and_honors_cancel_flag() {
        let temp_dir = std::env::temp_dir().join("metasweep-scan-batches");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        for index in 0..(SCAN_BATCH_SIZE + 4) {
            let path = temp_dir.join(format!("batch-{index}.jpg"));
            fs::write(path, b"test").expect("write sample file");
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (sender, mut receiver) = mpsc::unbounded_channel::<ScanWorkerEvent>();
        let outcome = perform_scan_inputs(
            vec![temp_dir.to_string_lossy().to_string()],
            cancel_flag,
            sender,
        )
        .expect("scan directory");

        let mut batches = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            batches.push(event);
        }
        assert!(!outcome.cancelled, "scan should finish without cancellation");
        assert!(
            batches.len() >= 2,
            "expected more than one batch when file count exceeds SCAN_BATCH_SIZE"
        );
    }

    #[test]
    fn scan_inputs_can_stop_early_after_cancel() {
        let temp_dir = std::env::temp_dir().join("metasweep-scan-cancel");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        for index in 0..(SCAN_BATCH_SIZE * 2) {
            let path = temp_dir.join(format!("cancel-{index}.jpg"));
            fs::write(path, b"test").expect("write sample file");
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        cancel_flag.store(true, Ordering::Relaxed);
        let (sender, mut receiver) = mpsc::unbounded_channel::<ScanWorkerEvent>();
        let outcome = perform_scan_inputs(
            vec![temp_dir.to_string_lossy().to_string()],
            cancel_flag,
            sender,
        )
        .expect("scan cancellation");

        assert!(outcome.cancelled, "scan should report cancellation");
        assert!(receiver.try_recv().is_err(), "cancelled scan should not emit queued files");
    }

    #[test]
    fn shell_open_request_parser_extracts_unique_existing_paths() {
        let temp_dir = std::env::temp_dir().join("tagsweep-shell-open");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let first = temp_dir.join("first.jpg");
        let second = temp_dir.join("second.jpg");
        fs::write(&first, b"one").expect("write first sample");
        fs::write(&second, b"two").expect("write second sample");

        let request = collect_shell_open_request_from_strings(vec![
            "tagsweep.exe".to_string(),
            SHELL_CLEAN_ARG.to_string(),
            first.to_string_lossy().to_string(),
            second.to_string_lossy().to_string(),
            first.to_string_lossy().to_string(),
            temp_dir.join("missing.jpg").to_string_lossy().to_string(),
        ])
        .expect("parse shell open request");

        assert!(request.auto_start_cleanup, "shell clean should auto-start cleanup");
        assert_eq!(request.paths.len(), 2, "only unique existing paths should remain");
    }

    #[test]
    fn merge_shell_open_request_preserves_auto_cleanup_and_dedupes_paths() {
        let temp_dir = std::env::temp_dir().join("tagsweep-shell-merge");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let first = temp_dir.join("first.jpg");
        let second = temp_dir.join("second.jpg");
        fs::write(&first, b"one").expect("write first sample");
        fs::write(&second, b"two").expect("write second sample");

        let mut slot = Some(ShellOpenRequest {
            paths: vec![first.to_string_lossy().to_string()],
            auto_start_cleanup: false,
        });
        let merged = merge_shell_open_request(
            &mut slot,
            ShellOpenRequest {
                paths: vec![
                    first.to_string_lossy().to_string(),
                    second.to_string_lossy().to_string(),
                ],
                auto_start_cleanup: true,
            },
        );

        assert_eq!(merged.paths.len(), 2, "duplicate shell paths should collapse");
        assert!(merged.auto_start_cleanup, "cleanup intent should be sticky");
        assert_eq!(
            slot.as_ref().map(|request| request.paths.len()),
            Some(2),
            "merged request should be stored back in the slot"
        );
    }

    #[test]
    fn cleanup_preview_states_fill_missing_rows_from_final_summary() {
        let tracked_preview_files = vec![
            queued_file("C:/input/1.jpg", "1.jpg", "input", "C:/input"),
            queued_file("C:/input/2.jpg", "2.jpg", "input", "C:/input"),
        ];
        let mut tracked_preview_states = HashMap::new();
        tracked_preview_states.insert(
            dedupe_key(Path::new("C:/input/1.jpg")),
            CleanupPreviewState {
                source_path: "C:/input/1.jpg".to_string(),
                output_path: None,
                status: "success".to_string(),
                error: None,
                snapshot: None,
            },
        );
        let preview_snapshots = HashMap::from([(
            dedupe_key(Path::new("C:/input/1.jpg")),
            MetadataPreviewSnapshot {
                count: 2,
                fields: Vec::new(),
                truncated: false,
            },
        )]);

        let completed_states = build_cleanup_preview_states(
            &tracked_preview_files,
            &tracked_preview_states,
            &preview_snapshots,
            &HashMap::new(),
            false,
        );
        assert_eq!(completed_states.len(), 2);
        assert_eq!(completed_states[0].status, "success");
        assert_eq!(completed_states[1].status, "success");
        assert_eq!(
            completed_states[0]
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.count),
            Some(2)
        );

        let cancelled_states = build_cleanup_preview_states(
            &tracked_preview_files,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            true,
        );
        assert_eq!(cancelled_states[0].status, "cancelled");
        assert_eq!(cancelled_states[1].status, "cancelled");
    }

    #[test]
    fn persistent_session_can_clean_png_in_place() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("32x32.png");
        let temp_dir = std::env::temp_dir().join("metasweep-tests");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let working_copy = temp_dir.join("persistent-session.png");
        fs::copy(&source, &working_copy).expect("copy sample png");

        let planned = PlannedCleanupFile {
            source_path: working_copy.clone(),
            output_path: None,
        };
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
        };

        let mut session = ExifToolSession::new(&bundled_exiftool()).expect("start exiftool");
        let result = execute_cleanup_file(&planned, &options, &mut session);
        let _ = session.close();

        assert!(result.is_ok(), "expected png clean to succeed, got {result:?}");
        assert!(working_copy.exists(), "cleaned file should still exist");
    }

    #[test]
    fn persistent_session_supports_unicode_file_paths() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("32x32.png");
        let temp_dir = std::env::temp_dir().join("metasweep-tests").join("中文 路径");
        fs::create_dir_all(&temp_dir).expect("create unicode temp dir");

        let working_copy = temp_dir.join("示例 图像.png");
        fs::copy(&source, &working_copy).expect("copy unicode sample png");

        let planned = PlannedCleanupFile {
            source_path: working_copy.clone(),
            output_path: None,
        };
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
        };

        let mut session = ExifToolSession::new(&bundled_exiftool()).expect("start exiftool");
        let result = execute_cleanup_file(&planned, &options, &mut session);
        let _ = session.close();

        assert!(
            result.is_ok(),
            "expected unicode path clean to succeed, got {result:?}"
        );
        assert!(working_copy.exists(), "cleaned unicode file should still exist");
    }

    #[test]
    fn metadata_snapshot_reader_supports_unicode_file_paths() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("32x32.png");
        let temp_dir = std::env::temp_dir().join("metasweep-tests").join("元数据 预览");
        fs::create_dir_all(&temp_dir).expect("create unicode preview dir");

        let working_copy = temp_dir.join("预览 文件.png");
        fs::copy(&source, &working_copy).expect("copy preview png");

        let snapshot_map =
            read_metadata_snapshot_map(&bundled_exiftool(), &[working_copy.clone()]).expect("read metadata");

        assert!(
            snapshot_map.contains_key(&dedupe_key(&working_copy)),
            "expected snapshot map to contain unicode path key"
        );
    }

    #[test]
    fn persistent_session_reports_unsupported_file_errors() {
        let temp_dir = std::env::temp_dir().join("metasweep-tests");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let unsupported_file = temp_dir.join("unsupported.txt");
        fs::write(&unsupported_file, "hello metasweep").expect("write sample txt");

        let planned = PlannedCleanupFile {
            source_path: unsupported_file,
            output_path: None,
        };
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
        };

        let mut session = ExifToolSession::new(&bundled_exiftool()).expect("start exiftool");
        let result = execute_cleanup_file(&planned, &options, &mut session);
        let _ = session.close();

        assert!(result.is_err(), "expected txt clean to fail");
    }
}
