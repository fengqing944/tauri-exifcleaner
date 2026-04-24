import { UtilityDrawer } from "./UtilityDrawer";

export function HelpDrawer(props: { isOpen: boolean; onClose: () => void }) {
  return (
    <UtilityDrawer
      isOpen={props.isOpen}
      title="帮助"
      subtitle="流程、快捷操作和当前工作模式说明。"
      onClose={props.onClose}
    >
      <section className="utility-section">
        <div className="task-block-head">
          <strong>使用流程</strong>
          <span>桌面工具的默认主流程</span>
        </div>
        <ol className="utility-list ordered-list">
          <li>拖入文件或文件夹，程序会自动扫描支持的项目并生成队列。</li>
          <li>在工作台里查看处理前字段、处理后字段和当前状态。</li>
          <li>确认无误后点击顶部的“开始清理”，按当前并发执行原地覆盖。</li>
          <li>任务结束后查看工作台状态和“运行详情”里的错误项。</li>
        </ol>
      </section>

      <section className="utility-section">
        <div className="task-block-head">
          <strong>支持范围</strong>
          <span>和当前后端能力保持一致</span>
        </div>
        <div className="utility-chip-row">
          <span className="topbar-meta-chip">
            图片: JPG PNG WEBP HEIC GIF TIFF
          </span>
          <span className="topbar-meta-chip">
            视频/音频: MP4 MOV M4V AVI MP3 WAV
          </span>
          <span className="topbar-meta-chip">文档: PDF AI PSD EPS</span>
          <span className="topbar-meta-chip">
            相机 RAW: CR2 CR3 ARW DNG NEF RAF
          </span>
        </div>
      </section>

      <section className="utility-section">
        <div className="task-block-head">
          <strong>快捷操作</strong>
          <span>当前工作台支持这些交互</span>
        </div>
        <ul className="utility-list">
          <li>
            <kbd>悬停</kbd> 查看字段摘要，<kbd>点击</kbd> 固定预览。
          </li>
          <li>
            <kbd>↑</kbd> / <kbd>↓</kbd> 切换队列行，<kbd>Enter</kbd> 或{" "}
            <kbd>Space</kbd> 固定当前预览。
          </li>
          <li>
            <kbd>Esc</kbd> 关闭字段浮层、运行详情、帮助、设置或关于抽屉。
          </li>
          <li>资源管理器右键菜单可以直接把当前选择送进 TagSweep 队列。</li>
        </ul>
      </section>

      <section className="utility-section">
        <div className="task-block-head">
          <strong>当前工作模式</strong>
          <span>这版程序的处理方式</span>
        </div>
        <div className="utility-note">
          <strong>原地覆盖</strong>
          <span>
            当前版本固定为原地覆盖清理。程序会保留文件时间信息，并在工作台里反馈成功、失败和字段结果。
          </span>
        </div>
      </section>
    </UtilityDrawer>
  );
}
