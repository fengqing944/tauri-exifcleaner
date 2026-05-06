import { openUrl } from "@tauri-apps/plugin-opener";
import { UtilityDrawer } from "./UtilityDrawer";

const OPEN_SOURCE_URL = "https://github.com/fengqing944/tauri-exifcleaner";
const CONTACT_EMAIL_URL = "mailto:kinacni@gmail.com";

function openExternalUrl(url: string) {
  void openUrl(url).catch((error) => {
    console.error("打开外部链接失败", error);
  });
}

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
        <button
          className="utility-link-card"
          type="button"
          onClick={() => openExternalUrl(OPEN_SOURCE_URL)}
        >
          <strong>{OPEN_SOURCE_URL}</strong>
          <span>查看源码、提交问题或跟进更新。</span>
        </button>
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
            <button
              className="about-identity-link"
              type="button"
              onClick={() => openExternalUrl(CONTACT_EMAIL_URL)}
            >
              kinacni@gmail.com
            </button>
          </div>
        </div>
      </section>
    </UtilityDrawer>
  );
}
