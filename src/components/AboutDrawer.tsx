import { UtilityDrawer } from "./UtilityDrawer";

const OPEN_SOURCE_URL = "https://github.com/fengqing944/tauri-exifcleaner";

export function AboutDrawer(props: { isOpen: boolean; onClose: () => void }) {
  return (
    <UtilityDrawer
      isOpen={props.isOpen}
      title="关于"
      subtitle="TagSweep 项目信息和联系方式。"
      onClose={props.onClose}
    >
      <section className="utility-section">
        <div className="task-block-head">
          <strong>关于开源</strong>
          <span>GitHub</span>
        </div>
        <a
          className="utility-link-card"
          href={OPEN_SOURCE_URL}
          target="_blank"
          rel="noreferrer"
        >
          <strong>{OPEN_SOURCE_URL}</strong>
          <span>查看源码、提交问题或跟进更新。</span>
        </a>
      </section>

      <section className="utility-section">
        <div className="task-block-head">
          <strong>作者</strong>
          <span>联系信息</span>
        </div>
        <div className="about-identity">
          <div>
            <span>作者</span>
            <strong>Yo</strong>
          </div>
          <div>
            <span>邮箱</span>
            <a href="mailto:kinacni@gmail.com">kinacni@gmail.com</a>
          </div>
        </div>
      </section>
    </UtilityDrawer>
  );
}
