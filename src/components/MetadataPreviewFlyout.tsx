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
          <strong>{props.beforeSnapshot ? props.beforeSnapshot.count : props.beforeLoading ? "读取中" : "—"}</strong>
        </div>
        <div className="preview-summary-card">
          <span>处理后</span>
          <strong>{resolveAfterCountLabel(props.afterSnapshot, props.rowState, props.afterLoading)}</strong>
        </div>
      </div>

      <div className="preview-card-grid compare-grid">
        <MetadataColumn
          title="处理前"
          snapshot={props.beforeSnapshot}
          loading={props.beforeLoading}
          emptyText="正在读取字段摘要..."
        />

        <MetadataColumn
          title="处理后"
          snapshot={props.afterSnapshot}
          loading={props.afterLoading}
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
  emptyText: string;
}) {
  const visibleFields = props.snapshot ? props.snapshot.fields : [];

  return (
    <section className="preview-column">
      <header>
        <strong>{props.title}</strong>
        <span>{props.snapshot ? `${props.snapshot.count} 条` : props.loading ? "读取中" : "暂无"}</span>
      </header>

      {props.snapshot ? (
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
