use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
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
const MAX_METADATA_PREVIEW_FILES: usize = 8;
const MAX_METADATA_FIELD_PREVIEW: usize = 10;
const MAX_MEASURED_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;
const MEASURED_PREVIEW_EXTENSIONS: &[&str] = &[
    "avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp",
];
const METADATA_GROUPS_TO_SKIP: &[&str] = &["Composite", "ExifTool", "File", "System"];

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct CleanupState {
    running: Mutex<bool>,
    cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Default)]
struct QueueState {
    inner: Mutex<QueueStore>,
}

#[derive(Default)]
struct QueueStore {
    files: Vec<QueuedFile>,
    file_keys: HashSet<String>,
    roots: HashMap<String, RootSummary>,
    total_bytes: u64,
    ignored_count: usize,
    ignored_samples: Vec<String>,
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
struct CleanupSummary {
    total: usize,
    succeeded: usize,
    failed: usize,
    cancelled: bool,
    output_dir: Option<String>,
    failures: Vec<CleanupFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataFieldPreview {
    group: String,
    name: String,
    value_preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataPreviewSnapshot {
    count: usize,
    fields: Vec<MetadataFieldPreview>,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMetadataPreview {
    source_path: String,
    before: MetadataPreviewSnapshot,
    after: MetadataPreviewSnapshot,
    after_estimated: bool,
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

#[derive(Debug)]
struct FileCleanupOutcome {
    source_path: String,
    output_path: Option<String>,
    status: &'static str,
    error: Option<String>,
}

enum WorkerEvent {
    Outcome(FileCleanupOutcome),
    Fatal(String),
}

struct ExifToolSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: BufReader<ChildStderr>,
    next_execute_id: u64,
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
    queue_state: State<'_, QueueState>,
    input_paths: Vec<String>,
) -> Result<QueueView, String> {
    let batch = tauri::async_runtime::spawn_blocking(move || perform_scan_inputs(input_paths))
        .await
        .map_err(|error| format!("扫描任务异常: {error}"))??;

    let mut store = queue_state.inner.lock().unwrap();
    merge_scan_batch(&mut store, batch);
    Ok(build_queue_view(&store))
}

#[tauri::command]
async fn load_metadata_previews(
    app: AppHandle,
    input_paths: Vec<String>,
    focused_path: Option<String>,
) -> Result<Vec<FileMetadataPreview>, String> {
    tauri::async_runtime::spawn_blocking(move || build_metadata_previews(app, input_paths, focused_path))
        .await
        .map_err(|error| format!("元数据预览任务异常: {error}"))?
}

#[tauri::command]
fn clear_queue(queue_state: State<'_, QueueState>) {
    *queue_state.inner.lock().unwrap() = QueueStore::default();
}

fn perform_scan_inputs(input_paths: Vec<String>) -> Result<ScanBatch, String> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    let mut ignored_count = 0_usize;
    let mut ignored_samples = Vec::new();

    for raw_path in input_paths {
        let input_path = PathBuf::from(raw_path);

        if !input_path.exists() {
            ignored_count += 1;
            push_ignored_sample(&mut ignored_samples, &input_path);
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
                let file_path = entry.into_path();
                if !is_supported_file(&file_path) {
                    ignored_count += 1;
                    push_ignored_sample(&mut ignored_samples, &file_path);
                    continue;
                }

                let key = dedupe_key(&file_path);
                if !seen.insert(key) {
                    continue;
                }

                let metadata = match fs::metadata(&file_path) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        ignored_count += 1;
                        push_ignored_sample(&mut ignored_samples, &file_path);
                        continue;
                    }
                };

                let relative_path = file_path
                    .strip_prefix(&input_path)
                    .unwrap_or(file_path.as_path())
                    .to_string_lossy()
                    .to_string();

                files.push(QueuedFile {
                    source_path: file_path.to_string_lossy().to_string(),
                    relative_path,
                    root_label: root_label.clone(),
                    root_source_path: root_source_path.clone(),
                    size_bytes: metadata.len(),
                    from_directory: true,
                });
            }
        } else if input_path.is_file() {
            if !is_supported_file(&input_path) {
                ignored_count += 1;
                push_ignored_sample(&mut ignored_samples, &input_path);
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

                files.push(QueuedFile {
                    source_path: input_path.to_string_lossy().to_string(),
                    relative_path,
                    root_label: root_label.clone(),
                    root_source_path: root_source_path.clone(),
                    size_bytes: metadata.len(),
                    from_directory: false,
                });
            }
        }
    }

    Ok(ScanBatch {
        files,
        ignored_count,
        ignored_samples,
    })
}

fn merge_scan_batch(store: &mut QueueStore, batch: ScanBatch) {
    for file in batch.files {
        let file_key = dedupe_key(Path::new(&file.source_path));
        if !store.file_keys.insert(file_key) {
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

        store.files.push(file);
    }

    store.ignored_count += batch.ignored_count;
    merge_ignored_samples(&mut store.ignored_samples, batch.ignored_samples);
}

fn build_queue_view(store: &QueueStore) -> QueueView {
    QueueView {
        supported_count: store.files.len(),
        total_bytes: store.total_bytes,
        ignored_count: store.ignored_count,
        ignored_samples: store.ignored_samples.clone(),
        preview_files: store
            .files
            .iter()
            .take(MAX_METADATA_PREVIEW_FILES)
            .cloned()
            .collect(),
        root_count: store.roots.len(),
    }
}

fn build_metadata_previews(
    app: AppHandle,
    input_paths: Vec<String>,
    focused_path: Option<String>,
) -> Result<Vec<FileMetadataPreview>, String> {
    let exiftool_path = resolve_exiftool(&app)?;
    let preview_paths = normalize_preview_paths(input_paths);
    if preview_paths.is_empty() {
        return Ok(Vec::new());
    }

    let before_map = read_metadata_snapshot_map(&exiftool_path, &preview_paths)?;
    let focused_key = focused_path
        .as_deref()
        .map(PathBuf::from)
        .map(|path| dedupe_key(&path));
    let after_map = build_focused_after_map(&exiftool_path, &preview_paths, focused_key.as_deref())?;

    let mut results = Vec::with_capacity(preview_paths.len());

    for path in &preview_paths {
        let source_key = dedupe_key(path);
        let before_fields = before_map
            .get(&source_key)
            .cloned()
            .unwrap_or_default();

        let after_fields = after_map.get(&source_key).cloned().unwrap_or_default();

        results.push(FileMetadataPreview {
            source_path: path.to_string_lossy().to_string(),
            before: build_metadata_snapshot(&before_fields),
            after: build_metadata_snapshot(&after_fields),
            after_estimated: !after_map.contains_key(&source_key),
        });
    }

    Ok(results)
}

fn build_focused_after_map(
    exiftool_path: &Path,
    preview_paths: &[PathBuf],
    focused_key: Option<&str>,
) -> Result<HashMap<String, Vec<MetadataFieldPreview>>, String> {
    let Some(focused_key) = focused_key else {
        return Ok(HashMap::new());
    };

    let Some(focused_path) = preview_paths
        .iter()
        .find(|path| dedupe_key(path) == focused_key)
    else {
        return Ok(HashMap::new());
    };

    if !can_measure_metadata_preview(focused_path) {
        return Ok(HashMap::new());
    }

    let temp_dir = create_preview_temp_dir()?;
    let temp_path = create_preview_copy(&temp_dir, focused_path, 0)?;
    let result = clean_preview_copy(exiftool_path, &temp_path)
        .and_then(|_| read_metadata_snapshot_map(exiftool_path, &[temp_path.clone()]));
    let _ = fs::remove_dir_all(&temp_dir);

    let temp_map = result?;
    let after_fields = temp_map
        .get(&dedupe_key(&temp_path))
        .cloned()
        .unwrap_or_default();

    Ok(HashMap::from([(focused_key.to_string(), after_fields)]))
}

fn normalize_preview_paths(input_paths: Vec<String>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for raw_path in input_paths {
        let path = PathBuf::from(raw_path);
        if !path.is_file() {
            continue;
        }

        let key = dedupe_key(&path);
        if !seen.insert(key) {
            continue;
        }

        normalized.push(path);
        if normalized.len() >= MAX_METADATA_PREVIEW_FILES {
            break;
        }
    }

    normalized
}

fn read_metadata_snapshot_map(
    exiftool_path: &Path,
    input_paths: &[PathBuf],
) -> Result<HashMap<String, Vec<MetadataFieldPreview>>, String> {
    if input_paths.is_empty() {
        return Ok(HashMap::new());
    }

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
        .arg("-ignoreMinorErrors");
    configure_hidden_process(&mut command);

    if let Some(parent) = exiftool_path.parent() {
        command.current_dir(parent);
    }

    for path in input_paths {
        command.arg(path);
    }

    let output = command
        .output()
        .map_err(|error| format!("无法读取元数据预览: {error}"))?;

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

        snapshots.insert(dedupe_key(Path::new(&source_file)), fields);
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
        fields: fields
            .iter()
            .take(MAX_METADATA_FIELD_PREVIEW)
            .cloned()
            .collect(),
        truncated: fields.len() > MAX_METADATA_FIELD_PREVIEW,
    }
}

fn can_measure_metadata_preview(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !MEASURED_PREVIEW_EXTENSIONS.contains(&extension.as_str()) {
        return false;
    }

    fs::metadata(path)
        .map(|metadata| metadata.len() <= MAX_MEASURED_PREVIEW_BYTES)
        .unwrap_or(false)
}

fn create_preview_temp_dir() -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let temp_dir = std::env::temp_dir().join(format!(
        "metasweep-preview-{}-{}",
        std::process::id(),
        timestamp
    ));
    fs::create_dir_all(&temp_dir)
        .map_err(|error| format!("无法创建元数据预览临时目录: {error}"))?;
    Ok(temp_dir)
}

fn create_preview_copy(temp_dir: &Path, source_path: &Path, index: usize) -> Result<PathBuf, String> {
    let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("preview.bin");
    let temp_path = temp_dir.join(format!("{index:02}-{file_name}"));
    fs::copy(source_path, &temp_path).map_err(|error| {
        format!(
            "无法创建元数据预览副本 {}: {error}",
            source_path.display()
        )
    })?;
    Ok(temp_path)
}

fn clean_preview_copy(exiftool_path: &Path, preview_path: &Path) -> Result<(), String> {
    let mut command = Command::new(exiftool_path);
    command
        .arg("-charset")
        .arg("filename=UTF8")
        .arg("-q")
        .arg("-q")
        .arg("-m")
        .arg("-ignoreMinorErrors")
        .arg("-P")
        .arg("-overwrite_original")
        .arg("-all=")
        .arg(preview_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_process(&mut command);

    if let Some(parent) = exiftool_path.parent() {
        command.current_dir(parent);
    }

    let output = command
        .output()
        .map_err(|error| format!("无法创建元数据预览结果: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !stderr.is_empty() || !output.status.success() {
        return Err(if stderr.is_empty() {
            "ExifTool 无法生成元数据预览结果。".to_string()
        } else {
            stderr
        });
    }

    Ok(())
}

fn truncate_text(value: &str, max_len: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "空值".to_string();
    }

    if trimmed.chars().count() <= max_len {
        return trimmed.to_string();
    }

    let shortened = trimmed.chars().take(max_len.saturating_sub(1)).collect::<String>();
    format!("{shortened}...")
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
    queue_state: State<'_, QueueState>,
    options: CleanupOptions,
) -> Result<CleanupSummary, String> {
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
        let planned_files = {
            let store = queue_state.inner.lock().unwrap();
            plan_output_paths(&store.files, &options)?
        };

        if planned_files.is_empty() {
            return Ok(CleanupSummary {
                total: 0,
                succeeded: 0,
                failed: 0,
                cancelled: false,
                output_dir: options.output_dir.clone(),
                failures: Vec::new(),
            });
        }

        let exiftool_path = resolve_exiftool(&app)?;
        let total = planned_files.len();
        let concurrency = options
            .parallelism
            .clamp(1, max_parallelism())
            .min(total.max(1));

        let queue = Arc::new(Mutex::new(VecDeque::from(planned_files)));
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
                WorkerEvent::Outcome(outcome) => {
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

        if let Some(error) = fatal_error {
            return Err(error);
        }

        Ok(CleanupSummary {
            total,
            succeeded,
            failed,
            cancelled: cancel_flag.load(Ordering::Relaxed),
            output_dir: options.output_dir.clone(),
            failures,
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
    queue: Arc<Mutex<VecDeque<PlannedCleanupFile>>>,
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
            let mut queue = queue.lock().unwrap();
            queue.pop_front()
        };

        let Some(planned_file) = planned_file else {
            break;
        };

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

fn plan_output_paths(
    files: &[QueuedFile],
    options: &CleanupOptions,
) -> Result<Vec<PlannedCleanupFile>, String> {
    let mut planned = Vec::with_capacity(files.len());
    let mut reserved_paths = HashSet::new();

    let output_root = match options.output_mode {
        OutputMode::Mirror => Some(PathBuf::from(
            options
                .output_dir
                .as_deref()
                .ok_or_else(|| "镜像输出模式必须选择输出目录。".to_string())?,
        )),
        OutputMode::Overwrite => None,
    };

    for file in files {
        let source_path = PathBuf::from(&file.source_path);
        let output_path = match options.output_mode {
            OutputMode::Overwrite => None,
            OutputMode::Mirror => {
                let base_dir = output_root
                    .as_ref()
                    .ok_or_else(|| "输出目录不可用。".to_string())?;

                let mut candidate = base_dir.clone();
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

                Some(reserve_unique_path(candidate, &mut reserved_paths))
            }
        };

        planned.push(PlannedCleanupFile {
            source_path,
            output_path,
        });
    }

    Ok(planned)
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

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr: BufReader::new(stderr),
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
            let line = read_line(&mut self.stderr, "stderr")?;
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
        .map(|path| path.join("MetaSweep Output"))
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

fn dedupe_key(path: &Path) -> String {
    let key = path.to_string_lossy().to_string();
    if cfg!(target_os = "windows") {
        key.to_lowercase()
    } else {
        key
    }
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
    tauri::Builder::default()
        .manage(CleanupState::default())
        .manage(QueueState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            scan_inputs,
            clear_queue,
            load_metadata_previews,
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
        );
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
        );

        let view = build_queue_view(&store);

        assert_eq!(view.supported_count, 11);
        assert_eq!(view.preview_files.len(), MAX_METADATA_PREVIEW_FILES);
        assert_eq!(view.root_count, 1);
        assert_eq!(view.ignored_count, 2);
        assert_eq!(view.ignored_samples, vec!["C:/ignored/a.txt", "C:/ignored/b.txt"]);
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
