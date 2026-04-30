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
        atomic::{AtomicBool, AtomicU64, Ordering},
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
use std::os::windows::{ffi::OsStrExt, process::CommandExt};

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "3fr", "ai", "arq", "arw", "avif", "avi", "bmp", "cr2", "cr3", "crw", "dcp", "dng", "eps",
    "erf", "gif", "gpr", "heic", "heif", "iiq", "insp", "jpeg", "jpg", "jxl", "m4a", "m4v", "mef",
    "mie", "mov", "mp3", "mp4", "mrw", "nef", "nrw", "orf", "pdf", "png", "ps", "psd", "raf",
    "raw", "rw2", "sr2", "srw", "tif", "tiff", "wav", "webp", "wmv", "x3f",
];
const IMAGE_EXTENSIONS: &[&str] = &[
    "3fr", "arq", "arw", "avif", "bmp", "cr2", "cr3", "crw", "dcp", "dng", "erf", "gif", "gpr",
    "heic", "heif", "iiq", "insp", "jpeg", "jpg", "jxl", "mef", "mrw", "nef", "nrw", "orf", "png",
    "raf", "raw", "rw2", "sr2", "srw", "tif", "tiff", "webp", "x3f",
];
const TARGET_IMAGE_TITLE_ARGS: &[&str] = &[
    "-XMP-dc:Title=",
    "-IPTC:ObjectName=",
    "-EXIF:ImageDescription=",
    "-EXIF:XPTitle=",
    "-PNG:Title=",
];
const TARGET_IMAGE_SUBJECT_ARGS: &[&str] = &[
    "-XMP-dc:Subject=",
    "-IPTC:Keywords=",
    "-EXIF:XPKeywords=",
    "-EXIF:XPSubject=",
    "-PNG:Subject=",
];
const TARGET_IMAGE_AUTHOR_ARGS: &[&str] = &[
    "-XMP-dc:Creator=",
    "-EXIF:Artist=",
    "-EXIF:XPAuthor=",
    "-IPTC:By-line=",
    "-PNG:Author=",
];
const TARGET_IMAGE_RIGHTS_ARGS: &[&str] = &[
    "-XMP-dc:Rights=",
    "-XMP-xmpRights:WebStatement=",
    "-EXIF:Copyright=",
    "-IPTC:CopyrightNotice=",
    "-PNG:Copyright=",
];
const TARGET_IMAGE_ID_ARGS: &[&str] = &[
    "-EXIF:ImageUniqueID=",
    "-XMP-exif:ImageUniqueID=",
    "-XMP-iptcExt:DigitalImageGUID=",
    "-XMP-xmpMM:DocumentID=",
    "-XMP-xmpMM:InstanceID=",
    "-XMP-xmpMM:OriginalDocumentID=",
    "-XMP-photoshop:DocumentAncestors=",
];
const MAX_QUEUE_PREVIEW_FILES: usize = 12;
const SCAN_BATCH_SIZE: usize = 256;
const SCAN_PROGRESS_INTERVAL_MS: u64 = 350;
const METADATA_GROUPS_TO_SKIP: &[&str] = &["Composite", "ExifTool", "File", "System"];
const QUICKTIME_PREVIEW_FIELDS: &[&str] = &[
    "MajorBrand",
    "MinorVersion",
    "CompatibleBrands",
    "CreateDate",
    "ModifyDate",
    "DateTimeOriginal",
    "Duration",
    "HandlerType",
    "HandlerVendorID",
    "Encoder",
];
const QUICKTIME_TRACK_PREVIEW_FIELDS: &[&str] = &[
    "TrackCreateDate",
    "TrackModifyDate",
    "TrackDuration",
    "TrackVolume",
    "MediaCreateDate",
    "MediaModifyDate",
    "MediaDuration",
    "MediaLanguageCode",
    "HandlerType",
    "HandlerDescription",
    "CompressorID",
    "ImageWidth",
    "ImageHeight",
    "SourceImageWidth",
    "SourceImageHeight",
    "XResolution",
    "YResolution",
    "BitDepth",
    "PixelAspectRatio",
    "VideoFrameRate",
    "AudioFormat",
    "AudioChannels",
    "AudioBitsPerSample",
    "AudioSampleRate",
    "Balance",
];
const QUEUE_PAGE_SIZE_MAX: usize = 512;
const QUEUE_INDEX_STRIDE: usize = 128;
const DEBUG_LOG_MAX_BYTES: u64 = 512 * 1024;
const SHELL_CLEAN_ARG: &str = "--shell-clean";
const SHELL_IMPORT_ARG: &str = "--shell-import";
const WINDOW_STATE_FILENAME: &str = ".window-state.json";
const EXIFTOOL_METADATA_TIMEOUT_SECS: u64 = 30;
const EXIFTOOL_CLEAN_TIMEOUT_SECS: u64 = 90;
const EXIFTOOL_CLOSE_TIMEOUT_SECS: u64 = 5;
const METADATA_WRITE_MAX_CHARS: usize = 240;
const METADATA_KEYWORD_MAX_CHARS: usize = 60;
const METADATA_KEYWORD_MAX_COUNT: usize = 20;
const SAFE_CLEAN_REMOVAL_ARGS: &[&str] = &["-all="];
const STRICT_VIDEO_TIMESTAMP_REMOVAL_ARGS: &[&str] = &[
    "-QuickTime:CreateDate=",
    "-QuickTime:ModifyDate=",
    "-QuickTime:TrackCreateDate=",
    "-QuickTime:TrackModifyDate=",
    "-QuickTime:MediaCreateDate=",
    "-QuickTime:MediaModifyDate=",
];

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
#[cfg(target_os = "windows")]
const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn MoveFileExW(existing_file_name: *const u16, new_file_name: *const u16, flags: u32) -> i32;
}

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum VideoCleanupMode {
    Safe,
    Strict,
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
    video_cleanup_mode: Option<VideoCleanupMode>,
    targeted_image_cleanup: Option<TargetedImageCleanupOptions>,
    metadata_write: Option<MetadataWriteOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetedImageCleanupOptions {
    enabled: bool,
    title: bool,
    subject: bool,
    author: bool,
    rights: bool,
    image_id: bool,
    search: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataWriteOptions {
    enabled: bool,
    title: Option<String>,
    author: Option<String>,
    description: Option<String>,
    keywords: Option<String>,
    rights: Option<String>,
    rating: Option<String>,
    label: Option<String>,
    rights_url: Option<String>,
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
    error: Option<String>,
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
    exiftool_path: PathBuf,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_events: Receiver<StderrEvent>,
    stderr_thread: Option<thread::JoinHandle<()>>,
    next_execute_id: u64,
    needs_restart: bool,
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
    let default_output_dir = default_output_dir(&app)?.to_string_lossy().to_string();
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
    let scan_handle = tauri::async_runtime::spawn_blocking(move || {
        perform_scan_inputs(input_paths, cancel_flag, sender)
    });

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
    let mut last_flush_at = Instant::now();

    for raw_path in input_paths {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }

        let input_path = PathBuf::from(raw_path);

        if !input_path.exists() {
            record_ignored_path(&sender, &mut batch, &mut last_flush_at, &input_path)?;
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
                    record_ignored_path(&sender, &mut batch, &mut last_flush_at, &file_path)?;
                    continue;
                }

                let key = dedupe_key(&file_path);
                if !seen.insert(key) {
                    continue;
                }

                let metadata = match fs::metadata(&file_path) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        record_ignored_path(&sender, &mut batch, &mut last_flush_at, &file_path)?;
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

                flush_scan_batch(&sender, &mut batch, &mut last_flush_at)?;
            }
        } else if input_path.is_file() {
            if !is_supported_file(&input_path) {
                record_ignored_path(&sender, &mut batch, &mut last_flush_at, &input_path)?;
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

                flush_scan_batch(&sender, &mut batch, &mut last_flush_at)?;
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
    last_flush_at: &mut Instant,
) -> Result<(), String> {
    if !should_flush_scan_batch(batch, *last_flush_at) {
        return Ok(());
    }

    flush_remaining_scan_batch(sender, batch)?;
    *last_flush_at = Instant::now();
    Ok(())
}

fn should_flush_scan_batch(batch: &ScanBatch, last_flush_at: Instant) -> bool {
    !batch.is_empty()
        && (batch.files.len() >= SCAN_BATCH_SIZE
            || batch.ignored_count >= SCAN_BATCH_SIZE
            || last_flush_at.elapsed() >= Duration::from_millis(SCAN_PROGRESS_INTERVAL_MS))
}

fn record_ignored_path(
    sender: &mpsc::UnboundedSender<ScanWorkerEvent>,
    batch: &mut ScanBatch,
    last_flush_at: &mut Instant,
    path: &Path,
) -> Result<(), String> {
    batch.ignored_count += 1;
    push_ignored_sample(&mut batch.ignored_samples, path);
    flush_scan_batch(sender, batch, last_flush_at)
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

fn create_queue_spool_path() -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let temp_dir = std::env::temp_dir();

    for _ in 0..128 {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = temp_dir.join(format!(
            "tagsweep-queue-{}-{timestamp}-{counter}.jsonl",
            std::process::id()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建唯一队列暂存文件: {error}")),
        }
    }

    Err("无法创建唯一队列暂存文件。".to_string())
}

fn ensure_queue_spool_path(store: &mut QueueStore) -> Result<PathBuf, String> {
    if let Some(path) = store.queue_file_path.clone() {
        return Ok(path);
    }

    let path = create_queue_spool_path()?;
    store.queue_file_path = Some(path.clone());
    Ok(path)
}

fn append_queued_files(store: &mut QueueStore, files: &[QueuedFile]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }

    let spool_path = ensure_queue_spool_path(store)?;
    let mut spool = fs::OpenOptions::new()
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

    let (snapshot_map, snapshot_errors) = match read_metadata_snapshot_map(
        &exiftool_path,
        &deduped_paths,
    ) {
        Ok(snapshot_map) => (snapshot_map, HashMap::<String, String>::new()),
        Err(error) => {
            append_debug_log(format!(
                    "metadata.batch_error requests={} valid_files={} missing_files={} elapsed_ms={} error={}",
                    request_count,
                    deduped_paths.len(),
                    missing_count,
                    started_at.elapsed().as_millis(),
                    sanitize_debug_message(&error)
                ));

            let mut snapshot_map = HashMap::new();
            let mut snapshot_errors = HashMap::new();
            for path in &deduped_paths {
                let key = dedupe_key(path);
                match read_metadata_snapshot_map(&exiftool_path, std::slice::from_ref(path)) {
                    Ok(single_map) => {
                        let snapshot = single_map
                            .get(&key)
                            .cloned()
                            .unwrap_or_else(empty_metadata_snapshot);
                        snapshot_map.insert(key, snapshot);
                    }
                    Err(error) => {
                        snapshot_errors.insert(key, error);
                    }
                }
            }

            (snapshot_map, snapshot_errors)
        }
    };
    let mut results = Vec::with_capacity(requests.len());

    for request in requests {
        let path = PathBuf::from(&request.file_path);
        let key = dedupe_key(&path);
        let error = snapshot_errors.get(&key).cloned();
        let snapshot = if error.is_some() {
            empty_metadata_snapshot()
        } else {
            snapshot_map
                .get(&key)
                .cloned()
                .unwrap_or_else(empty_metadata_snapshot)
        };

        results.push(MetadataSnapshotResponse {
            request_key: request.request_key,
            snapshot,
            missing: !path.is_file(),
            error,
        });
    }

    if !snapshot_errors.is_empty() {
        append_debug_log(format!(
            "metadata.partial_error requests={} valid_files={} missing_files={} resolved_files={} failed_files={} elapsed_ms={}",
            request_count,
            deduped_paths.len(),
            missing_count,
            snapshot_map.len(),
            snapshot_errors.len(),
            started_at.elapsed().as_millis()
        ));
    } else {
        append_debug_log(format!(
            "metadata.done requests={} valid_files={} missing_files={} resolved_files={} elapsed_ms={}",
            request_count,
            deduped_paths.len(),
            missing_count,
            snapshot_map.len(),
            started_at.elapsed().as_millis()
        ));
    }

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

    let argfile_path = write_utf8_argfile(
        "metadata-preview",
        input_paths
            .iter()
            .map(|path| path.to_string_lossy().to_string()),
    )?;
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

    let output = command_output_with_timeout(
        &mut command,
        Duration::from_secs(EXIFTOOL_METADATA_TIMEOUT_SECS),
        "ExifTool 元数据预览",
    );
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

fn read_raw_metadata_record(
    exiftool_path: &Path,
    input_path: &Path,
) -> Result<HashMap<String, Value>, String> {
    let argfile_path = write_utf8_argfile(
        "metadata-search",
        std::iter::once(input_path.to_string_lossy().to_string()),
    )?;
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

    let output = command_output_with_timeout(
        &mut command,
        Duration::from_secs(EXIFTOOL_METADATA_TIMEOUT_SECS),
        "ExifTool 指定清理搜索",
    );
    let _ = fs::remove_file(&argfile_path);
    let output = output?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "ExifTool 指定清理搜索失败。".to_string()
        } else {
            stderr
        });
    }

    let mut records = serde_json::from_slice::<Vec<HashMap<String, Value>>>(&output.stdout)
        .map_err(|error| format!("无法解析指定清理搜索结果: {error}"))?;

    Ok(records.pop().unwrap_or_default())
}

fn map_metadata_field(key: &str, value: &Value) -> Option<MetadataFieldPreview> {
    if key == "SourceFile" {
        return None;
    }

    let (group, name) = split_metadata_key(key);
    if should_skip_metadata_field(group, name, value) {
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

fn should_skip_metadata_field(group: &str, name: &str, value: &Value) -> bool {
    if should_skip_metadata_group(group) {
        return true;
    }

    if is_quicktime_structural_group(group) {
        return !is_quicktime_preview_field(group, name, value);
    }

    false
}

fn is_quicktime_structural_group(group: &str) -> bool {
    group.eq_ignore_ascii_case("QuickTime") || is_quicktime_track_group(group)
}

fn is_quicktime_track_group(group: &str) -> bool {
    group
        .strip_prefix("Track")
        .is_some_and(|suffix| suffix.chars().all(|ch| ch.is_ascii_digit()))
}

fn is_quicktime_preview_field(group: &str, name: &str, value: &Value) -> bool {
    if is_zero_quicktime_timestamp(value) {
        return false;
    }

    if group.eq_ignore_ascii_case("QuickTime") {
        is_metadata_name_in_list(name, QUICKTIME_PREVIEW_FIELDS)
    } else if is_quicktime_track_group(group) {
        is_metadata_name_in_list(name, QUICKTIME_TRACK_PREVIEW_FIELDS)
    } else {
        false
    }
}

fn is_metadata_name_in_list(name: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(name))
}

fn is_zero_quicktime_timestamp(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.trim().starts_with("0000:00:00"))
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
    let mut content = String::new();

    for line in lines {
        content.push_str(&line);
        content.push('\n');
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let temp_dir = std::env::temp_dir();

    for _ in 0..128 {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = temp_dir.join(format!(
            "tagsweep-{prefix}-{}-{timestamp}-{counter}.args",
            std::process::id()
        ));

        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建 ExifTool 参数文件: {error}")),
        };

        if let Err(error) = file.write_all(content.as_bytes()) {
            let _ = fs::remove_file(&path);
            return Err(format!("无法写入 ExifTool 参数文件: {error}"));
        }

        return Ok(path);
    }

    Err("无法创建唯一的 ExifTool 参数文件。".to_string())
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
        let preview_snapshots = build_cleanup_preview_snapshot_map(
            &exiftool_path,
            &tracked_preview_files,
            &tracked_preview_states,
        );
        let failure_map = failures
            .iter()
            .map(|failure| {
                (
                    dedupe_key(Path::new(&failure.source_path)),
                    failure.error.clone(),
                )
            })
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
            Err(error) => {
                if session.should_restart() {
                    if let Err(restart_error) = session.restart() {
                        cancel_flag.store(true, Ordering::Relaxed);
                        let _ = sender.send(WorkerEvent::Fatal(format!(
                            "清理引擎 worker {} 重启失败: {restart_error}",
                            worker_index + 1
                        )));
                        break;
                    }
                }

                FileCleanupOutcome {
                    source_path: planned_file.source_path.to_string_lossy().to_string(),
                    output_path: planned_file
                        .output_path
                        .as_ref()
                        .map(|path| path.to_string_lossy().to_string()),
                    status: "failed",
                    error: Some(error),
                }
            }
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
        let mut planned_file = build_planned_cleanup_file(
            &queued_file,
            &options,
            output_root.as_deref(),
            &mut reserved_paths,
        )?;

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

fn build_clean_command_args(
    planned_file: &PlannedCleanupFile,
    options: &CleanupOptions,
    removal_args: Vec<String>,
    write_args: Vec<String>,
    stderr_marker: Option<&str>,
    end_options_before_source: bool,
    overwrite_output_path: Option<&Path>,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "-charset".to_string(),
        "filename=UTF8".to_string(),
        "-q".to_string(),
        "-q".to_string(),
        "-m".to_string(),
        "-ignoreMinorErrors".to_string(),
        "-P".to_string(),
    ];
    args.extend(removal_args);
    args.extend(write_args);

    match options.output_mode {
        OutputMode::Overwrite => {
            if let Some(output_path) = overwrite_output_path {
                args.push("-o".to_string());
                args.push(output_path.to_string_lossy().to_string());
            } else {
                args.push("-overwrite_original".to_string());
            }
        }
        OutputMode::Mirror => {
            let output_path = planned_file
                .output_path
                .as_ref()
                .ok_or_else(|| "镜像输出模式缺少目标路径。".to_string())?;
            args.push("-o".to_string());
            args.push(output_path.to_string_lossy().to_string());
        }
    }

    if let Some(marker) = stderr_marker {
        args.push("-echo4".to_string());
        args.push(format!("{marker}${{status}}"));
    }

    if end_options_before_source {
        args.push("--".to_string());
    }
    args.push(planned_file.source_path.to_string_lossy().to_string());
    Ok(args)
}

fn clean_command_needs_spawned_process(
    planned_file: &PlannedCleanupFile,
    removal_args: &[String],
    write_args: &[String],
) -> bool {
    !planned_file.source_path.to_string_lossy().is_ascii()
        || planned_file
            .output_path
            .as_ref()
            .is_some_and(|path| !path.to_string_lossy().is_ascii())
        || removal_args.iter().any(|arg| !arg.is_ascii())
        || write_args.iter().any(|arg| !arg.is_ascii())
}

#[derive(Debug)]
struct CleanTempWorkspace {
    dir_path: PathBuf,
    output_path: PathBuf,
}

impl CleanTempWorkspace {
    fn cleanup(&self) {
        let _ = fs::remove_dir_all(&self.dir_path);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum CleanTempOutcome {
    Replaced,
    Unchanged,
}

fn create_clean_temp_workspace(source_path: &Path) -> Result<CleanTempWorkspace, String> {
    let parent = source_path
        .parent()
        .ok_or_else(|| format!("无法为 {} 创建临时清理路径。", source_path.display()))?;
    let extension = source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    for _ in 0..128 {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir_path = parent.join(format!(
            ".tagsweep-work-{}-{timestamp}-{counter}",
            std::process::id()
        ));
        match fs::create_dir(&dir_path) {
            Ok(()) => {
                return Ok(CleanTempWorkspace {
                    output_path: dir_path.join(format!("cleaned{extension}")),
                    dir_path,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "无法为 {} 创建临时清理目录: {error}",
                    source_path.display()
                ));
            }
        }
    }

    Err(format!(
        "无法为 {} 生成唯一临时清理目录。",
        source_path.display()
    ))
}

fn complete_clean_temp_workspace(
    source_path: &Path,
    workspace: &CleanTempWorkspace,
) -> Result<CleanTempOutcome, String> {
    let temp_path = &workspace.output_path;
    let temp_metadata = match fs::metadata(temp_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CleanTempOutcome::Unchanged);
        }
        Err(error) => {
            return Err(format!(
                "无法读取清理后的临时文件，原文件未改变: {} ({error})",
                temp_path.display()
            ));
        }
    };

    if !temp_metadata.is_file() {
        return Err(format!(
            "清理后的临时路径不是文件，原文件未改变: {}",
            temp_path.display()
        ));
    }
    if temp_metadata.len() == 0 {
        return Err(format!(
            "清理后的临时文件为空，原文件未改变: {}",
            temp_path.display()
        ));
    }

    replace_existing_file(temp_path, source_path).map_err(|error| {
        format!(
            "无法用清理后的临时文件替换原文件，原文件未改变。临时输出路径 {}: {error}",
            temp_path.display()
        )
    })?;

    Ok(CleanTempOutcome::Replaced)
}

#[cfg(target_os = "windows")]
fn replace_existing_file(from: &Path, to: &Path) -> Result<(), String> {
    let from_wide = path_to_wide(from);
    let to_wide = path_to_wide(to);
    let result = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn path_to_wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(not(target_os = "windows"))]
fn replace_existing_file(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| error.to_string())
}

fn cleanup_removal_args(options: &CleanupOptions) -> Vec<String> {
    let mut args = SAFE_CLEAN_REMOVAL_ARGS
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    if matches!(options.video_cleanup_mode, Some(VideoCleanupMode::Strict)) {
        args.extend(
            STRICT_VIDEO_TIMESTAMP_REMOVAL_ARGS
                .iter()
                .map(|arg| (*arg).to_string()),
        );
    }
    args
}

fn cleanup_removal_args_for_file(
    options: &CleanupOptions,
    source_path: &Path,
    exiftool_path: &Path,
) -> Result<Vec<String>, String> {
    let Some(targeted) = options.targeted_image_cleanup.as_ref() else {
        return Ok(cleanup_removal_args(options));
    };
    if !targeted.enabled || !is_image_path(source_path) {
        return Ok(cleanup_removal_args(options));
    }

    targeted_image_cleanup_args(targeted, source_path, exiftool_path)
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
        .unwrap_or(false)
}

fn targeted_image_cleanup_args(
    targeted: &TargetedImageCleanupOptions,
    source_path: &Path,
    exiftool_path: &Path,
) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    if targeted.title {
        args.extend(TARGET_IMAGE_TITLE_ARGS.iter().map(|arg| (*arg).to_string()));
    }
    if targeted.subject {
        args.extend(
            TARGET_IMAGE_SUBJECT_ARGS
                .iter()
                .map(|arg| (*arg).to_string()),
        );
    }
    if targeted.author {
        args.extend(
            TARGET_IMAGE_AUTHOR_ARGS
                .iter()
                .map(|arg| (*arg).to_string()),
        );
    }
    if targeted.rights {
        args.extend(
            TARGET_IMAGE_RIGHTS_ARGS
                .iter()
                .map(|arg| (*arg).to_string()),
        );
    }
    if targeted.image_id {
        args.extend(TARGET_IMAGE_ID_ARGS.iter().map(|arg| (*arg).to_string()));
    }

    let search_terms = sanitize_targeted_search_terms(targeted.search.as_deref());
    if !search_terms.is_empty() {
        let record = read_raw_metadata_record(exiftool_path, source_path)?;
        args.extend(metadata_search_delete_args(&record, &search_terms));
    }

    Ok(dedupe_args(args))
}

fn sanitize_targeted_search_terms(value: Option<&str>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let normalized = value.replace(['\r', '\n', ';', '；', '，', '、'], ",");
    let mut seen = HashSet::new();
    normalized
        .split(',')
        .filter_map(|term| {
            let term = term.split_whitespace().collect::<Vec<_>>().join(" ");
            let term = term.trim();
            if term.is_empty() {
                return None;
            }
            let term = term
                .chars()
                .take(METADATA_KEYWORD_MAX_CHARS)
                .collect::<String>();
            if seen.insert(term.to_lowercase()) {
                Some(term)
            } else {
                None
            }
        })
        .take(METADATA_KEYWORD_MAX_COUNT)
        .collect()
}

fn metadata_search_delete_args(
    record: &HashMap<String, Value>,
    search_terms: &[String],
) -> Vec<String> {
    let args = record
        .iter()
        .filter_map(|(key, value)| {
            if key == "SourceFile" {
                return None;
            }
            let (group, name) = split_metadata_key(key);
            if should_skip_metadata_group(group)
                || !metadata_value_matches_search_terms(value, search_terms)
            {
                return None;
            }
            Some(format!("-{group}:{name}="))
        })
        .collect::<Vec<_>>();

    dedupe_args(args)
}

fn metadata_value_matches_search_terms(value: &Value, search_terms: &[String]) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(_) | Value::Number(_) => false,
        Value::String(text) => text_matches_search_terms(text, search_terms),
        Value::Array(items) => items
            .iter()
            .any(|item| metadata_value_matches_search_terms(item, search_terms)),
        Value::Object(map) => map
            .values()
            .any(|item| metadata_value_matches_search_terms(item, search_terms)),
    }
}

fn text_matches_search_terms(text: &str, search_terms: &[String]) -> bool {
    let lower_text = text.to_lowercase();
    search_terms
        .iter()
        .any(|term| lower_text.contains(&term.to_lowercase()))
}

fn dedupe_args(args: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    args.into_iter()
        .filter(|arg| seen.insert(arg.to_ascii_lowercase()))
        .collect()
}

fn metadata_write_args(options: &CleanupOptions) -> Vec<String> {
    let Some(metadata_write) = options.metadata_write.as_ref() else {
        return Vec::new();
    };
    if !metadata_write.enabled {
        return Vec::new();
    }

    let mut args = Vec::new();
    if let Some(title) = sanitize_metadata_write_value(metadata_write.title.as_deref()) {
        args.push(format!("-XMP-dc:Title={title}"));
    }
    if let Some(author) = sanitize_metadata_write_value(metadata_write.author.as_deref()) {
        args.push(format!("-XMP-dc:Creator={author}"));
    }
    if let Some(description) = sanitize_metadata_write_value(metadata_write.description.as_deref())
    {
        args.push(format!("-XMP-dc:Description={description}"));
    }
    for (index, keyword) in sanitize_metadata_keywords(metadata_write.keywords.as_deref())
        .into_iter()
        .enumerate()
    {
        let operator = if index == 0 { "=" } else { "+=" };
        args.push(format!("-XMP-dc:Subject{operator}{keyword}"));
    }
    if let Some(rights) = sanitize_metadata_write_value(metadata_write.rights.as_deref()) {
        args.push(format!("-XMP-dc:Rights={rights}"));
    }
    if let Some(rating) = sanitize_metadata_rating(metadata_write.rating.as_deref()) {
        args.push(format!("-XMP-xmp:Rating={rating}"));
    }
    if let Some(label) = sanitize_metadata_write_value(metadata_write.label.as_deref()) {
        args.push(format!("-XMP-xmp:Label={label}"));
    }
    if let Some(rights_url) = sanitize_metadata_write_url(metadata_write.rights_url.as_deref()) {
        args.push(format!("-XMP-xmpRights:WebStatement={rights_url}"));
    }
    if !args.is_empty() {
        args.push("-XMP-x:XMPToolkit=".to_string());
    }

    args
}

fn sanitize_metadata_write_value(value: Option<&str>) -> Option<String> {
    let value = value?
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(
        trimmed
            .chars()
            .take(METADATA_WRITE_MAX_CHARS)
            .collect::<String>(),
    )
}

fn sanitize_metadata_keywords(value: Option<&str>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };

    let normalized = value.replace(['\r', '\n', ';', '；', '，', '、'], ",");
    let mut seen = HashSet::new();
    let mut keywords = Vec::new();

    for keyword in normalized.split(',') {
        let keyword = keyword.split_whitespace().collect::<Vec<_>>().join(" ");
        let keyword = keyword.trim();
        if keyword.is_empty() {
            continue;
        }

        let keyword = keyword
            .chars()
            .take(METADATA_KEYWORD_MAX_CHARS)
            .collect::<String>();
        let normalized_key = keyword.to_lowercase();
        if seen.insert(normalized_key) {
            keywords.push(keyword);
        }
        if keywords.len() >= METADATA_KEYWORD_MAX_COUNT {
            break;
        }
    }

    keywords
}

fn sanitize_metadata_rating(value: Option<&str>) -> Option<String> {
    let rating = value?.trim();
    match rating {
        "-1" | "0" | "1" | "2" | "3" | "4" | "5" => Some(rating.to_string()),
        _ => None,
    }
}

fn sanitize_metadata_write_url(value: Option<&str>) -> Option<String> {
    let value = sanitize_metadata_write_value(value)?;
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        Some(value)
    } else {
        None
    }
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
            exiftool_path: exiftool_path.to_path_buf(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr_events,
            stderr_thread: Some(stderr_thread),
            next_execute_id: 1,
            needs_restart: false,
        })
    }

    fn clean_file(
        &mut self,
        planned_file: &PlannedCleanupFile,
        options: &CleanupOptions,
    ) -> Result<(), String> {
        if !planned_file.source_path.is_file() {
            return Err(format!(
                "源文件不存在或已移动: {}",
                planned_file.source_path.display()
            ));
        }
        let source_metadata = fs::metadata(&planned_file.source_path).map_err(|error| {
            format!(
                "无法读取源文件属性: {} ({error})",
                planned_file.source_path.display()
            )
        })?;
        if matches!(options.output_mode, OutputMode::Overwrite)
            && source_metadata.permissions().readonly()
        {
            return Err(format!(
                "源文件是只读文件，无法原地替换: {}",
                planned_file.source_path.display()
            ));
        }

        let removal_args =
            cleanup_removal_args_for_file(options, &planned_file.source_path, &self.exiftool_path)?;
        let write_args = metadata_write_args(options);

        if removal_args.is_empty() && write_args.is_empty() {
            if let (OutputMode::Mirror, Some(output_path)) =
                (&options.output_mode, planned_file.output_path.as_ref())
            {
                fs::copy(&planned_file.source_path, output_path).map_err(|error| {
                    format!("无法复制未修改文件到 {}: {error}", output_path.display())
                })?;
            }
            return Ok(());
        }

        let overwrite_workspace = match options.output_mode {
            OutputMode::Overwrite => Some(create_clean_temp_workspace(&planned_file.source_path)?),
            OutputMode::Mirror => None,
        };
        let overwrite_temp_path = overwrite_workspace
            .as_ref()
            .map(|workspace| workspace.output_path.as_path());

        let clean_result =
            if clean_command_needs_spawned_process(planned_file, &removal_args, &write_args) {
                self.clean_file_with_spawned_process(
                    planned_file,
                    options,
                    removal_args,
                    write_args,
                    overwrite_temp_path,
                )
            } else {
                self.clean_file_with_stay_open(
                    planned_file,
                    options,
                    removal_args,
                    write_args,
                    overwrite_temp_path,
                )
            };

        if let Err(error) = clean_result {
            if let Some(workspace) = overwrite_workspace.as_ref() {
                workspace.cleanup();
            }
            return Err(format!(
                "ExifTool 清理失败（源文件: {}）: {error}",
                planned_file.source_path.display()
            ));
        }

        if let Some(workspace) = overwrite_workspace.as_ref() {
            let complete_result =
                complete_clean_temp_workspace(&planned_file.source_path, workspace);
            workspace.cleanup();
            complete_result?;
        }

        Ok(())
    }

    fn clean_file_with_stay_open(
        &mut self,
        planned_file: &PlannedCleanupFile,
        options: &CleanupOptions,
        removal_args: Vec<String>,
        write_args: Vec<String>,
        overwrite_output_path: Option<&Path>,
    ) -> Result<(), String> {
        let execute_id = self.next_execute_id;
        self.next_execute_id += 1;

        let stderr_marker = format!("__META_SWEEP_DONE__:{execute_id}:");
        let command_args = build_clean_command_args(
            planned_file,
            options,
            removal_args,
            write_args,
            Some(&stderr_marker),
            false,
            overwrite_output_path,
        )?;
        for arg in command_args {
            self.write_arg(&arg)?;
        }
        self.write_arg(&format!("-execute{execute_id}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("无法刷新 ExifTool 指令: {error}"))?;

        let finished = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        let watchdog = spawn_process_watchdog(
            self.child.id(),
            Duration::from_secs(EXIFTOOL_CLEAN_TIMEOUT_SECS),
            finished.clone(),
            timed_out.clone(),
        );

        let command_result = (|| {
            self.consume_stdout_until_ready(execute_id)?;
            self.consume_stderr_until_marker(&stderr_marker)
        })();
        finished.store(true, Ordering::Relaxed);
        let _ = watchdog.join();

        if timed_out.load(Ordering::Relaxed) {
            self.needs_restart = true;
            return Err(format!(
                "ExifTool 处理超时，已终止当前 worker（超过 {} 秒）。",
                EXIFTOOL_CLEAN_TIMEOUT_SECS
            ));
        }

        let result = match command_result {
            Ok(result) => result,
            Err(error) => {
                self.mark_restart_if_exited();
                return Err(error);
            }
        };

        if !result.stderr_output.is_empty() {
            return Err(result.stderr_output);
        }
        if result.status != 0 {
            return Err(format!("ExifTool 返回了非零状态码 {}", result.status));
        }

        Ok(())
    }

    fn clean_file_with_spawned_process(
        &self,
        planned_file: &PlannedCleanupFile,
        options: &CleanupOptions,
        removal_args: Vec<String>,
        write_args: Vec<String>,
        overwrite_output_path: Option<&Path>,
    ) -> Result<(), String> {
        let command_args = build_clean_command_args(
            planned_file,
            options,
            removal_args,
            write_args,
            None,
            true,
            overwrite_output_path,
        )?;
        let argfile_path = write_utf8_argfile("clean", command_args)?;
        let mut command = Command::new(&self.exiftool_path);
        command
            .arg("-charset")
            .arg("filename=UTF8")
            .arg("-@")
            .arg(&argfile_path);
        configure_hidden_process(&mut command);

        if let Some(parent) = self.exiftool_path.parent() {
            command.current_dir(parent);
        }

        let output = command_output_with_timeout(
            &mut command,
            Duration::from_secs(EXIFTOOL_CLEAN_TIMEOUT_SECS),
            "ExifTool 清理",
        );
        let _ = fs::remove_file(&argfile_path);
        let output = output?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("ExifTool 返回了非零状态码 {}", output.status)
            } else {
                stderr
            });
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(stderr);
        }

        Ok(())
    }

    fn close(&mut self) -> Result<(), String> {
        let _ = self.write_arg("-stay_open");
        let _ = self.write_arg("False");
        let _ = self.stdin.flush();
        let finished = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        let watchdog = spawn_process_watchdog(
            self.child.id(),
            Duration::from_secs(EXIFTOOL_CLOSE_TIMEOUT_SECS),
            finished.clone(),
            timed_out.clone(),
        );
        let wait_result = self
            .child
            .wait()
            .map_err(|error| format!("关闭 ExifTool worker 失败: {error}"));
        finished.store(true, Ordering::Relaxed);
        let _ = watchdog.join();
        if let Some(handle) = self.stderr_thread.take() {
            let _ = handle.join();
        }
        if timed_out.load(Ordering::Relaxed) {
            return Err(format!(
                "关闭 ExifTool worker 超时，已强制终止（超过 {} 秒）。",
                EXIFTOOL_CLOSE_TIMEOUT_SECS
            ));
        }
        wait_result.map(|_| ())
    }

    fn restart(&mut self) -> Result<(), String> {
        let exiftool_path = self.exiftool_path.clone();
        let _ = self.close();
        *self = Self::new(&exiftool_path)?;
        Ok(())
    }

    fn should_restart(&self) -> bool {
        self.needs_restart
    }

    fn mark_restart_if_exited(&mut self) {
        match self.child.try_wait() {
            Ok(Some(_)) | Err(_) => {
                self.needs_restart = true;
            }
            Ok(None) => {}
        }
    }

    fn write_arg(&mut self, value: &str) -> Result<(), String> {
        writeln!(self.stdin, "{value}").map_err(|error| format!("写入 ExifTool 参数失败: {error}"))
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

fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    description: &str,
) -> Result<std::process::Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|error| format!("{description} 启动失败: {error}"))?;
    let process_id = child.id();
    let finished = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    let watchdog = spawn_process_watchdog(process_id, timeout, finished.clone(), timed_out.clone());
    let output = child
        .wait_with_output()
        .map_err(|error| format!("{description} 执行失败: {error}"));

    finished.store(true, Ordering::Relaxed);
    let _ = watchdog.join();

    if timed_out.load(Ordering::Relaxed) {
        return Err(format!(
            "{description} 超时，已强制终止（超过 {} 秒）。",
            timeout.as_secs()
        ));
    }

    output
}

fn spawn_process_watchdog(
    process_id: u32,
    timeout: Duration,
    finished: Arc<AtomicBool>,
    timed_out: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let started_at = Instant::now();
        let poll_interval = Duration::from_millis(100);

        while started_at.elapsed() < timeout {
            if finished.load(Ordering::Relaxed) {
                return;
            }

            let remaining = timeout
                .checked_sub(started_at.elapsed())
                .unwrap_or_default();
            thread::sleep(if remaining < poll_interval {
                remaining
            } else {
                poll_interval
            });
        }

        if !finished.load(Ordering::Relaxed) {
            timed_out.store(true, Ordering::Relaxed);
            terminate_process_by_id(process_id);
        }
    })
}

fn terminate_process_by_id(process_id: u32) {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("taskkill");
        command
            .arg("/PID")
            .arg(process_id.to_string())
            .arg("/T")
            .arg("/F");
        configure_hidden_process(&mut command);
        let _ = command.output();
    }

    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(process_id.to_string())
            .output();
        thread::sleep(Duration::from_millis(500));
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(process_id.to_string())
            .output();
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
    candidates.push(
        PathBuf::from("resources")
            .join("exiftool")
            .join(executable_name),
    );
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
    command
        .arg("-ver")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
            if value == SHELL_CLEAN_ARG || value == SHELL_IMPORT_ARG {
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
            auto_start_cleanup: false,
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

fn state_file_has_main_window(path: &Path) -> bool {
    let Ok(contents) = fs::read_to_string(path) else {
        return false;
    };

    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return false;
    };

    value
        .as_object()
        .and_then(|state_map| state_map.get("main"))
        .is_some()
}

fn should_center_main_window_on_first_launch(app: &AppHandle) -> bool {
    let Ok(app_dir) = app.path().app_config_dir() else {
        return false;
    };

    !state_file_has_main_window(&app_dir.join(WINDOW_STATE_FILENAME))
}

fn restore_main_window_state_before_show(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if should_center_main_window_on_first_launch(app) {
        let _ = window.center();
    } else {
        let restore_flags = tauri_plugin_window_state::StateFlags::all()
            & !tauri_plugin_window_state::StateFlags::VISIBLE;
        let _ = tauri_plugin_window_state::WindowExt::restore_state(&window, restore_flags);
    }

    let _ = window.show();
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
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state("main")
                .build(),
        )
        .setup(|app| {
            restore_main_window_state_before_show(app.handle());
            Ok(())
        })
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

    fn queued_file(
        source_path: &str,
        relative_path: &str,
        root_label: &str,
        root_source_path: &str,
    ) -> QueuedFile {
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
                ignored_samples: vec![
                    "C:/ignored/a.txt".to_string(),
                    "C:/ignored/b.txt".to_string(),
                ],
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
        assert_eq!(
            view.ignored_samples,
            vec!["C:/ignored/a.txt", "C:/ignored/b.txt"]
        );
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
        assert!(
            !outcome.cancelled,
            "scan should finish without cancellation"
        );
        assert!(
            batches.len() >= 2,
            "expected more than one batch when file count exceeds SCAN_BATCH_SIZE"
        );
    }

    #[test]
    fn scan_inputs_emits_batches_for_ignored_files() {
        let temp_dir = std::env::temp_dir().join("metasweep-scan-ignored-batches");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        for index in 0..(SCAN_BATCH_SIZE + 4) {
            let path = temp_dir.join(format!("ignored-{index}.txt"));
            fs::write(path, b"test").expect("write unsupported sample file");
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let (sender, mut receiver) = mpsc::unbounded_channel::<ScanWorkerEvent>();
        let outcome = perform_scan_inputs(
            vec![temp_dir.to_string_lossy().to_string()],
            cancel_flag,
            sender,
        )
        .expect("scan unsupported directory");

        let mut batches = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            batches.push(event);
        }

        let ignored_total = batches
            .iter()
            .map(|event| match event {
                ScanWorkerEvent::Batch(batch) => batch.ignored_count,
            })
            .sum::<usize>();

        assert!(
            !outcome.cancelled,
            "scan should finish without cancellation"
        );
        assert!(
            batches.len() >= 2,
            "expected ignored-only scans to emit intermediate batches"
        );
        assert_eq!(ignored_total, SCAN_BATCH_SIZE + 4);
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
        assert!(
            receiver.try_recv().is_err(),
            "cancelled scan should not emit queued files"
        );
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

        assert!(
            !request.auto_start_cleanup,
            "shell import should wait for an explicit cleanup confirmation"
        );
        assert_eq!(
            request.paths.len(),
            2,
            "only unique existing paths should remain"
        );
    }

    #[test]
    fn shell_import_request_parser_accepts_new_marker_without_auto_cleanup() {
        let temp_dir = std::env::temp_dir().join("tagsweep-shell-import");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let first = temp_dir.join("first.jpg");
        fs::write(&first, b"one").expect("write sample");

        let request = collect_shell_open_request_from_strings(vec![
            "tagsweep.exe".to_string(),
            SHELL_IMPORT_ARG.to_string(),
            first.to_string_lossy().to_string(),
        ])
        .expect("parse shell import request");

        assert_eq!(request.paths.len(), 1);
        assert!(
            !request.auto_start_cleanup,
            "new shell import marker should only enqueue files"
        );
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

        assert_eq!(
            merged.paths.len(),
            2,
            "duplicate shell paths should collapse"
        );
        assert!(merged.auto_start_cleanup, "cleanup intent should be sticky");
        assert_eq!(
            slot.as_ref().map(|request| request.paths.len()),
            Some(2),
            "merged request should be stored back in the slot"
        );
    }

    #[test]
    fn state_file_parser_only_treats_main_entry_as_restorable_state() {
        let temp_dir = std::env::temp_dir().join("tagsweep-window-state-tests");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let with_main = temp_dir.join("with-main.json");
        fs::write(
            &with_main,
            r#"{"main":{"width":1160,"height":760,"x":120,"y":120}}"#,
        )
        .expect("write main state");
        assert!(
            state_file_has_main_window(&with_main),
            "state file with main entry should be recognized"
        );

        let without_main = temp_dir.join("without-main.json");
        fs::write(&without_main, r#"{"other":{"x":0,"y":0}}"#).expect("write other state");
        assert!(
            !state_file_has_main_window(&without_main),
            "state file without main entry should not skip first-launch centering"
        );

        let invalid = temp_dir.join("invalid.json");
        fs::write(&invalid, "not-json").expect("write invalid state");
        assert!(
            !state_file_has_main_window(&invalid),
            "invalid state content should fall back to first-launch centering"
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
    fn utf8_argfiles_are_created_with_unique_paths() {
        let first =
            write_utf8_argfile("unit", vec!["one".to_string()]).expect("create first argfile");
        let second =
            write_utf8_argfile("unit", vec!["two".to_string()]).expect("create second argfile");

        assert_ne!(first, second);
        assert_eq!(
            fs::read_to_string(&first).expect("read first argfile"),
            "one\n"
        );
        assert_eq!(
            fs::read_to_string(&second).expect("read second argfile"),
            "two\n"
        );

        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
    }

    #[test]
    fn queue_spool_paths_are_created_atomically_and_uniquely() {
        let first = create_queue_spool_path().expect("create first queue spool");
        let second = create_queue_spool_path().expect("create second queue spool");

        assert_ne!(first, second);
        assert!(first.is_file());
        assert!(second.is_file());
        assert_eq!(fs::metadata(&first).expect("first metadata").len(), 0);
        assert_eq!(fs::metadata(&second).expect("second metadata").len(), 0);

        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
    }

    #[test]
    fn clean_temp_workspace_treats_missing_output_as_unchanged() {
        let temp_dir = std::env::temp_dir().join(format!(
            "tagsweep-clean-temp-missing-{}",
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&temp_dir).expect("create test temp dir");
        let source_path = temp_dir.join("sample.jpg");
        fs::write(&source_path, b"original").expect("write source file");

        let workspace =
            create_clean_temp_workspace(&source_path).expect("create clean temp workspace");
        let outcome = complete_clean_temp_workspace(&source_path, &workspace)
            .expect("complete missing output");

        assert_eq!(outcome, CleanTempOutcome::Unchanged);
        assert_eq!(
            fs::read(&source_path).expect("read unchanged source"),
            b"original"
        );

        workspace.cleanup();
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn clean_temp_workspace_replaces_source_from_output_file() {
        let temp_dir = std::env::temp_dir().join(format!(
            "tagsweep-clean-temp-replace-{}",
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&temp_dir).expect("create test temp dir");
        let source_path = temp_dir.join("sample.jpg");
        fs::write(&source_path, b"original").expect("write source file");

        let workspace =
            create_clean_temp_workspace(&source_path).expect("create clean temp workspace");
        fs::write(&workspace.output_path, b"cleaned").expect("write cleaned output");
        let outcome =
            complete_clean_temp_workspace(&source_path, &workspace).expect("replace source file");

        assert_eq!(outcome, CleanTempOutcome::Replaced);
        assert_eq!(
            fs::read(&source_path).expect("read replaced source"),
            b"cleaned"
        );

        workspace.cleanup();
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn metadata_write_args_are_disabled_by_default_and_sanitize_values() {
        let disabled_options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: None,
        };
        assert!(metadata_write_args(&disabled_options).is_empty());

        let empty_options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: Some(MetadataWriteOptions {
                enabled: true,
                title: None,
                author: None,
                description: None,
                keywords: None,
                rights: None,
                rating: None,
                label: None,
                rights_url: None,
            }),
        };
        assert!(metadata_write_args(&empty_options).is_empty());

        let enabled_options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: Some(MetadataWriteOptions {
                enabled: true,
                title: Some("  moeuu\n-title=bad  ".to_string()),
                author: Some("  zero\r\nartist  ".to_string()),
                description: Some("  public\ncaption  ".to_string()),
                keywords: Some("  anime, moeuu；moeuu，clean  ".to_string()),
                rights: Some("  © moeuu  ".to_string()),
                rating: Some("5".to_string()),
                label: Some("  public  ".to_string()),
                rights_url: Some("https://example.com/rights".to_string()),
            }),
        };

        assert_eq!(
            metadata_write_args(&enabled_options),
            vec![
                "-XMP-dc:Title=moeuu -title=bad".to_string(),
                "-XMP-dc:Creator=zero artist".to_string(),
                "-XMP-dc:Description=public caption".to_string(),
                "-XMP-dc:Subject=anime".to_string(),
                "-XMP-dc:Subject+=moeuu".to_string(),
                "-XMP-dc:Subject+=clean".to_string(),
                "-XMP-dc:Rights=© moeuu".to_string(),
                "-XMP-xmp:Rating=5".to_string(),
                "-XMP-xmp:Label=public".to_string(),
                "-XMP-xmpRights:WebStatement=https://example.com/rights".to_string(),
                "-XMP-x:XMPToolkit=".to_string(),
            ]
        );
    }

    #[test]
    fn cleanup_removal_args_use_safe_video_mode_by_default() {
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: None,
        };

        assert_eq!(cleanup_removal_args(&options), vec!["-all=".to_string()]);
    }

    #[test]
    fn cleanup_removal_args_include_quicktime_timestamps_in_strict_mode() {
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: Some(VideoCleanupMode::Strict),
            targeted_image_cleanup: None,
            metadata_write: None,
        };
        let args = cleanup_removal_args(&options);

        assert!(args.contains(&"-all=".to_string()));
        assert!(args.contains(&"-QuickTime:CreateDate=".to_string()));
        assert!(args.contains(&"-QuickTime:TrackCreateDate=".to_string()));
        assert!(args.contains(&"-QuickTime:MediaCreateDate=".to_string()));
    }

    #[test]
    fn targeted_image_cleanup_removes_only_selected_image_tags() {
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: None,
            targeted_image_cleanup: Some(TargetedImageCleanupOptions {
                enabled: true,
                title: true,
                subject: false,
                author: true,
                rights: true,
                image_id: true,
                search: None,
            }),
            metadata_write: None,
        };

        let args =
            cleanup_removal_args_for_file(&options, Path::new("sample.jpg"), Path::new("unused"))
                .expect("build targeted args");

        assert!(!args.contains(&"-all=".to_string()));
        assert!(args.contains(&"-XMP-dc:Title=".to_string()));
        assert!(!args.contains(&"-XMP-dc:Subject=".to_string()));
        assert!(args.contains(&"-XMP-dc:Creator=".to_string()));
        assert!(args.contains(&"-EXIF:Copyright=".to_string()));
        assert!(args.contains(&"-EXIF:ImageUniqueID=".to_string()));
    }

    #[test]
    fn targeted_image_cleanup_keeps_full_cleanup_for_videos() {
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: Some(VideoCleanupMode::Strict),
            targeted_image_cleanup: Some(TargetedImageCleanupOptions {
                enabled: true,
                title: true,
                subject: true,
                author: true,
                rights: true,
                image_id: true,
                search: None,
            }),
            metadata_write: None,
        };

        let args =
            cleanup_removal_args_for_file(&options, Path::new("sample.mp4"), Path::new("unused"))
                .expect("build video args");

        assert!(args.contains(&"-all=".to_string()));
        assert!(args.contains(&"-QuickTime:CreateDate=".to_string()));
        assert!(!args.contains(&"-XMP-dc:Title=".to_string()));
    }

    #[test]
    fn targeted_image_cleanup_search_deletes_matching_metadata_values() {
        let record = HashMap::from([
            ("XMP-dc:Title".to_string(), serde_json::json!("abc 23333")),
            ("XMP-dc:Creator".to_string(), serde_json::json!("moeuu")),
            (
                "IPTC:Keywords".to_string(),
                serde_json::json!(["clean", "23333"]),
            ),
            (
                "System:FileName".to_string(),
                serde_json::json!("23333.jpg"),
            ),
            (
                "SourceFile".to_string(),
                serde_json::json!("C:/demo/23333.jpg"),
            ),
        ]);
        let search_terms = vec!["23333".to_string()];

        let args = metadata_search_delete_args(&record, &search_terms);

        assert!(args.contains(&"-XMP-dc:Title=".to_string()));
        assert!(args.contains(&"-IPTC:Keywords=".to_string()));
        assert!(!args.contains(&"-XMP-dc:Creator=".to_string()));
        assert!(!args.contains(&"-System:FileName=".to_string()));
    }

    #[test]
    fn metadata_preview_includes_important_quicktime_video_fields() {
        let duration = map_metadata_field("QuickTime:Duration", &serde_json::json!("1.00 s"))
            .expect("QuickTime duration should be shown");
        assert_eq!(duration.group, "QuickTime");
        assert_eq!(duration.name, "Duration");

        let major_brand = map_metadata_field(
            "QuickTime:MajorBrand",
            &serde_json::json!("MP4 Base Media v1"),
        )
        .expect("QuickTime major brand should be shown");
        assert_eq!(major_brand.group, "QuickTime");
        assert_eq!(major_brand.name, "MajorBrand");

        let image_width = map_metadata_field("Track1:ImageWidth", &serde_json::json!(1920))
            .expect("Track image width should be shown");
        assert_eq!(image_width.group, "Track1");
        assert_eq!(image_width.name, "ImageWidth");

        let frame_rate = map_metadata_field("Track1:VideoFrameRate", &serde_json::json!(29.97))
            .expect("Track frame rate should be shown");
        assert_eq!(frame_rate.group, "Track1");
        assert_eq!(frame_rate.name, "VideoFrameRate");

        let audio_format = map_metadata_field("Track2:AudioFormat", &serde_json::json!("mp4a"))
            .expect("Track audio format should be shown");
        assert_eq!(audio_format.group, "Track2");
        assert_eq!(audio_format.name, "AudioFormat");
    }

    #[test]
    fn metadata_preview_skips_quicktime_internal_noise() {
        assert!(map_metadata_field("QuickTime:MediaDataOffset", &serde_json::json!(48),).is_none());
        assert!(
            map_metadata_field("QuickTime:MovieHeaderVersion", &serde_json::json!(0),).is_none()
        );
        assert!(map_metadata_field("Track1:TrackID", &serde_json::json!(1)).is_none());
        assert!(map_metadata_field(
            "Track1:MatrixStructure",
            &serde_json::json!("1 0 0 0 1 0 0 0 1"),
        )
        .is_none());
        assert!(map_metadata_field(
            "QuickTime:CreateDate",
            &serde_json::json!("0000:00:00 00:00:00"),
        )
        .is_none());

        let quicktime_date = map_metadata_field(
            "QuickTime:CreateDate",
            &serde_json::json!("2026:04:24 12:00:00"),
        )
        .expect("QuickTime create date should be shown before cleanup");
        assert_eq!(quicktime_date.group, "QuickTime");
        assert_eq!(quicktime_date.name, "CreateDate");

        let item_list_title = map_metadata_field("ItemList:Title", &serde_json::json!("moeuu"))
            .expect("ItemList user metadata should be shown");
        assert_eq!(item_list_title.group, "ItemList");
        assert_eq!(item_list_title.name, "Title");
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
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: None,
        };

        let mut session = ExifToolSession::new(&bundled_exiftool()).expect("start exiftool");
        let result = execute_cleanup_file(&planned, &options, &mut session);
        let _ = session.close();

        assert!(
            result.is_ok(),
            "expected png clean to succeed, got {result:?}"
        );
        assert!(working_copy.exists(), "cleaned file should still exist");
    }

    #[test]
    fn persistent_session_supports_unicode_file_paths() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("32x32.png");
        let temp_dir = std::env::temp_dir()
            .join("metasweep-tests")
            .join("中文 路径");
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
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: None,
        };

        let mut session = ExifToolSession::new(&bundled_exiftool()).expect("start exiftool");
        let result = execute_cleanup_file(&planned, &options, &mut session);
        let _ = session.close();

        assert!(
            result.is_ok(),
            "expected unicode path clean to succeed, got {result:?}"
        );
        assert!(
            working_copy.exists(),
            "cleaned unicode file should still exist"
        );
    }

    #[test]
    fn persistent_session_supports_nested_unicode_file_paths() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("32x32.png");
        let temp_dir = std::env::temp_dir()
            .join("metasweep-tests")
            .join("纯免费")
            .join("AAAA")
            .join("会员")
            .join("纸悦Etsu_ko - 杏山和纱");
        fs::create_dir_all(&temp_dir).expect("create nested unicode temp dir");

        let working_copy = temp_dir.join("DSC05244-已增强-降噪 拷贝.png");
        fs::copy(&source, &working_copy).expect("copy nested unicode sample");

        let planned = PlannedCleanupFile {
            source_path: working_copy.clone(),
            output_path: None,
        };
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: None,
        };

        let mut session = ExifToolSession::new(&bundled_exiftool()).expect("start exiftool");
        let result = execute_cleanup_file(&planned, &options, &mut session);
        let _ = session.close();

        assert!(
            result.is_ok(),
            "expected nested unicode path clean to succeed, got {result:?}"
        );
        assert!(
            working_copy.exists(),
            "cleaned nested unicode file should still exist"
        );
    }

    #[test]
    fn persistent_session_ignores_stale_exiftool_temp_files() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("32x32.png");
        let temp_dir = std::env::temp_dir()
            .join("metasweep-tests")
            .join("stale-exiftool-temp");
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let working_copy = temp_dir.join("stale-temp-sample.png");
        fs::copy(&source, &working_copy).expect("copy sample png");
        let stale_exiftool_tmp = working_copy.with_file_name("stale-temp-sample.png_exiftool_tmp");
        fs::write(&stale_exiftool_tmp, b"leftover").expect("write stale exiftool temp");

        let planned = PlannedCleanupFile {
            source_path: working_copy.clone(),
            output_path: None,
        };
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: None,
        };

        let mut session = ExifToolSession::new(&bundled_exiftool()).expect("start exiftool");
        let result = execute_cleanup_file(&planned, &options, &mut session);
        let _ = session.close();

        assert!(
            result.is_ok(),
            "expected stale ExifTool temp file not to block cleanup, got {result:?}"
        );
        assert!(working_copy.exists(), "cleaned file should still exist");
        assert!(
            stale_exiftool_tmp.exists(),
            "TagSweep should not delete unrelated ExifTool temp leftovers"
        );
        let leftovers = fs::read_dir(&temp_dir)
            .expect("read temp dir")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".tagsweep-")
            })
            .collect::<Vec<_>>();
        assert!(
            leftovers.is_empty(),
            "TagSweep cleanup temp files should be moved away after success"
        );
        let _ = fs::remove_file(stale_exiftool_tmp);
    }

    #[test]
    fn persistent_session_reports_missing_source_before_exiftool() {
        let planned = PlannedCleanupFile {
            source_path: std::env::temp_dir()
                .join("metasweep-tests")
                .join("missing-source.png"),
            output_path: None,
        };
        let options = CleanupOptions {
            output_mode: OutputMode::Overwrite,
            output_dir: None,
            parallelism: 1,
            preserve_structure: true,
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: None,
        };

        let mut session = ExifToolSession::new(&bundled_exiftool()).expect("start exiftool");
        let result = execute_cleanup_file(&planned, &options, &mut session);
        let _ = session.close();

        assert!(
            result
                .expect_err("missing source should fail before ExifTool")
                .contains("源文件不存在或已移动"),
            "expected missing source error"
        );
    }

    #[test]
    fn metadata_snapshot_reader_supports_unicode_file_paths() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("32x32.png");
        let temp_dir = std::env::temp_dir()
            .join("metasweep-tests")
            .join("元数据 预览");
        fs::create_dir_all(&temp_dir).expect("create unicode preview dir");

        let working_copy = temp_dir.join("预览 文件.png");
        fs::copy(&source, &working_copy).expect("copy preview png");

        let snapshot_map = read_metadata_snapshot_map(&bundled_exiftool(), &[working_copy.clone()])
            .expect("read metadata");

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
            video_cleanup_mode: None,
            targeted_image_cleanup: None,
            metadata_write: None,
        };

        let mut session = ExifToolSession::new(&bundled_exiftool()).expect("start exiftool");
        let result = execute_cleanup_file(&planned, &options, &mut session);
        let _ = session.close();

        assert!(result.is_err(), "expected txt clean to fail");
    }
}
