import type { FileRunState, MetadataPreviewSnapshot, QueuedFile } from "../app-shared";
import {
  getLeafName,
  getParentPath,
  getRowStatusDescriptor,
  resolveAfterCountLabel,
  resolveAfterEmptyText,
  trimMiddle,
} from "../app-shared";

export function MetadataPreviewFlyout(props: {
  file: QueuedFile;
  beforeSnapshot?: MetadataPreviewSnapshot;
  afterSnapshot?: MetadataPreviewSnapshot;
  rowState?: FileRunState;
  beforeLoading: boolean;
  afterLoading: boolean;
  beforeError?: string;
  afterError?: string;
}) {
  const fileTitle = getLeafName(props.file.relativePath || props.file.sourcePath);
  const fileContext = getParentPath(props.file.relativePath || props.file.sourcePath);
  const rowStatus = getRowStatusDescriptor(props.rowState);

  return (
    <div className="preview-detail-panel">
      <div className="preview-panel-head">
        <div className="preview-panel-title">
          <strong title={props.file.sourcePath}>{trimMiddle(fileTitle, 24)}</strong>
          <span title={fileContext}>{trimMiddle(fileContext || props.file.sourcePath, 34)}</span>
        </div>
        <span className={`row-pill ${rowStatus.tone}`}>{props.rowState ? rowStatus.label : "字段预览"}</span>
      </div>

      <div className="preview-summary-grid">
        <div className="preview-summary-card">
          <span>处理前</span>
          <strong>
            {props.beforeSnapshot
              ? props.beforeSnapshot.count
              : props.beforeLoading
                ? "读取中"
                : props.beforeError
                  ? "读取失败"
                  : "—"}
          </strong>
        </div>
        <div className="preview-summary-card">
          <span>处理后</span>
          <strong>
            {props.afterError
              ? "读取失败"
              : resolveAfterCountLabel(props.afterSnapshot, props.rowState, props.afterLoading)}
          </strong>
        </div>
      </div>

      <div className="preview-card-grid compare-grid">
        <MetadataColumn
          title="处理前"
          snapshot={props.beforeSnapshot}
          loading={props.beforeLoading}
          error={props.beforeError}
          emptyText="正在读取字段摘要..."
        />

        <MetadataColumn
          title="处理后"
          snapshot={props.afterSnapshot}
          loading={props.afterLoading}
          error={props.afterError}
          emptyText={resolveAfterEmptyText(props.rowState)}
        />
      </div>
    </div>
  );
}

function MetadataColumn(props: {
  title: string;
  snapshot?: MetadataPreviewSnapshot;
  loading: boolean;
  error?: string;
  emptyText: string;
}) {
  const visibleFields = props.snapshot ? props.snapshot.fields : [];

  return (
    <section className="preview-column">
      <header>
        <strong>{props.title}</strong>
        <span>
          {props.snapshot
            ? `${props.snapshot.count} 条`
            : props.loading
              ? "读取中"
              : props.error
                ? "读取失败"
                : "暂无"}
        </span>
      </header>

      {props.error ? (
        <div className="preview-empty" title={props.error}>
          读取失败: {props.error}
        </div>
      ) : props.snapshot ? (
        visibleFields.length ? (
          <div className="preview-fields">
            {visibleFields.map((field) => (
              <div
                key={`${field.group}:${field.name}`}
                className="preview-field"
                title={`${field.group} · ${field.name}\n${field.valuePreview}`}
              >
                <div className="preview-field-head">
                  <strong title={`${field.group} · ${field.name}`}>{field.name}</strong>
                  <span className="preview-field-group">{field.group}</span>
                </div>
                <span className="preview-field-value">{field.valuePreview}</span>
              </div>
            ))}
            {props.snapshot.truncated ? <div className="preview-note">内容已裁剪</div> : null}
          </div>
        ) : (
          <div className="preview-empty">没有可展示的字段。</div>
        )
      ) : (
        <div className="preview-empty">{props.loading ? "正在读取字段..." : props.emptyText}</div>
      )}
    </section>
  );
}
