import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type {
  MetadataWritePreferences,
  RuntimeInfo,
  VideoCleanupMode,
} from "../app-shared";
import { StatusBadge } from "./AppPrimitives";
import { UtilityDrawer } from "./UtilityDrawer";

type SettingsTabId =
  | "execution"
  | "cleanup"
  | "metadata"
  | "behavior"
  | "environment";

const SETTINGS_TABS: Array<{
  id: SettingsTabId;
  label: string;
  caption: string;
}> = [
  { id: "execution", label: "执行", caption: "速度" },
  { id: "cleanup", label: "清理", caption: "视频安全" },
  { id: "metadata", label: "标记", caption: "公开字段" },
  { id: "behavior", label: "界面", caption: "详情" },
  { id: "environment", label: "环境", caption: "只读" },
];

export function SettingsDrawer(props: {
  isOpen: boolean;
  runtimeInfo: RuntimeInfo | null;
  parallelism: number;
  autoOpenDetailsOnFailure: boolean;
  reopenRunDetailsOnLaunch: boolean;
  videoCleanupMode: VideoCleanupMode;
  metadataWrite: MetadataWritePreferences;
  onClose: () => void;
  onParallelismChange: (value: number) => void;
  onResetParallelism: () => void;
  onAutoOpenDetailsOnFailureChange: (value: boolean) => void;
  onReopenRunDetailsOnLaunchChange: (value: boolean) => void;
  onVideoCleanupModeChange: (value: VideoCleanupMode) => void;
  onMetadataWriteChange: (value: MetadataWritePreferences) => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("execution");

  const activeTabMeta =
    SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];

  const updateMetadataWrite = (patch: Partial<MetadataWritePreferences>) => {
    props.onMetadataWriteChange({
      ...props.metadataWrite,
      ...patch,
    });
  };

  const handleTabButtonKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tabId: SettingsTabId,
  ) => {
    const currentIndex = SETTINGS_TABS.findIndex((tab) => tab.id === tabId);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SETTINGS_TABS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = SETTINGS_TABS[nextIndex];
    setActiveTab(nextTab.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`settings-tab-${nextTab.id}`)?.focus();
    });
  };

  return (
    <UtilityDrawer
      isOpen={props.isOpen}
      title="设置"
      subtitle="这里的偏好会自动保存在本机，下次启动继续生效。"
      onClose={props.onClose}
    >
      <div className="settings-tablist" role="tablist" aria-label="设置分类">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`settings-tab-${tab.id}`}
            className="settings-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => handleTabButtonKeyDown(event, tab.id)}
          >
            <strong>{tab.label}</strong>
            <span>{tab.caption}</span>
          </button>
        ))}
      </div>

      <section
        id={`settings-panel-${activeTab}`}
        className="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
      >
        <div className="settings-panel-head">
          <strong>{activeTabMeta.label}</strong>
          <span>
            {activeTab === "execution" && "调度和性能偏好会自动保存在本机。"}
            {activeTab === "cleanup" &&
              "安全模式优先保证视频兼容性；严格模式会额外清理视频内部日期。"}
            {activeTab === "metadata" &&
              "清理完成后，可选择写入你自己的公开 XMP 标记。"}
            {activeTab === "behavior" && "控制任务详情和失败提示的显示方式。"}
            {activeTab === "environment" &&
              "当前运行环境信息，仅用于确认状态。"}
          </span>
        </div>

        {activeTab === "execution" ? (
          <div className="setting-stack">
            <div className="setting-card">
              <div className="setting-head">
                <div>
                  <strong>默认并发</strong>
                  <span>
                    调高会更快，调低会更稳。当前设置会在下次启动继续使用。
                  </span>
                </div>
                <strong className="setting-value">{props.parallelism}</strong>
              </div>

              <div className="setting-slider-row">
                <input
                  type="range"
                  min={1}
                  max={props.runtimeInfo?.parallelismMax ?? 16}
                  value={props.parallelism}
                  onChange={(event) =>
                    props.onParallelismChange(Number(event.currentTarget.value))
                  }
                />
                <button
                  className="button"
                  type="button"
                  onClick={props.onResetParallelism}
                >
                  跟随默认值
                </button>
              </div>
              <span className="setting-footnote">
                默认值 {props.runtimeInfo?.parallelismDefault ?? "—"}，最大值{" "}
                {props.runtimeInfo?.parallelismMax ?? "—"}。
              </span>
            </div>
          </div>
        ) : null}

        {activeTab === "cleanup" ? (
          <div className="setting-stack">
            <div className="setting-card">
              <div className="setting-head">
                <div>
                  <strong>视频清理模式</strong>
                  <span>
                    默认使用安全模式。严格模式会额外清理 MP4/MOV
                    容器、轨道和媒体层的创建/修改日期。
                  </span>
                </div>
              </div>

              <div
                className="setting-segmented"
                role="radiogroup"
                aria-label="视频清理模式"
              >
                <label
                  className={`setting-segment ${
                    props.videoCleanupMode === "safe" ? "is-selected" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="video-cleanup-mode"
                    value="safe"
                    checked={props.videoCleanupMode === "safe"}
                    onChange={() => props.onVideoCleanupModeChange("safe")}
                  />
                  <span>
                    <strong>安全</strong>
                    <small>优先兼容</small>
                  </span>
                </label>

                <label
                  className={`setting-segment ${
                    props.videoCleanupMode === "strict" ? "is-selected" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="video-cleanup-mode"
                    value="strict"
                    checked={props.videoCleanupMode === "strict"}
                    onChange={() => props.onVideoCleanupModeChange("strict")}
                  />
                  <span>
                    <strong>严格</strong>
                    <small>更彻底</small>
                  </span>
                </label>
              </div>

              <span className="setting-footnote">
                安全模式只执行通用元数据清理。严格模式通常不会影响播放，但可能改变部分软件按视频内部时间排序的结果。
              </span>
            </div>
          </div>
        ) : null}

        {activeTab === "metadata" ? (
          <div className="setting-stack">
            <label className="setting-check">
              <input
                type="checkbox"
                checked={props.metadataWrite.enabled}
                onChange={(event) =>
                  updateMetadataWrite({ enabled: event.currentTarget.checked })
                }
              />
              <div>
                <strong>清理后写入公开标记</strong>
                <span>
                  开启后会先清空原元数据，再写入你主动填写的 XMP
                  标题、作者、说明等字段。
                </span>
              </div>
            </label>

            <div className="setting-card">
              <div className="setting-head">
                <div>
                  <strong>基础标记</strong>
                  <span>适合图片和视频共同使用的公开字段。</span>
                </div>
              </div>

              <div className="setting-text-grid">
                <label className="setting-field">
                  <span>标题</span>
                  <input
                    type="text"
                    maxLength={120}
                    value={props.metadataWrite.title}
                    placeholder="例如 moeuu"
                    disabled={!props.metadataWrite.enabled}
                    onChange={(event) =>
                      updateMetadataWrite({ title: event.currentTarget.value })
                    }
                  />
                </label>

                <label className="setting-field">
                  <span>作者 / 创作者</span>
                  <input
                    type="text"
                    maxLength={120}
                    value={props.metadataWrite.author}
                    placeholder="可留空"
                    disabled={!props.metadataWrite.enabled}
                    onChange={(event) =>
                      updateMetadataWrite({ author: event.currentTarget.value })
                    }
                  />
                </label>

                <label className="setting-field setting-field-wide">
                  <span>描述 / 说明</span>
                  <textarea
                    maxLength={240}
                    rows={3}
                    value={props.metadataWrite.description}
                    placeholder="一段公开说明"
                    disabled={!props.metadataWrite.enabled}
                    onChange={(event) =>
                      updateMetadataWrite({
                        description: event.currentTarget.value,
                      })
                    }
                  />
                </label>

                <label className="setting-field">
                  <span>关键词</span>
                  <input
                    type="text"
                    maxLength={240}
                    value={props.metadataWrite.keywords}
                    placeholder="用逗号分隔"
                    disabled={!props.metadataWrite.enabled}
                    onChange={(event) =>
                      updateMetadataWrite({
                        keywords: event.currentTarget.value,
                      })
                    }
                  />
                </label>

                <label className="setting-field">
                  <span>版权声明</span>
                  <input
                    type="text"
                    maxLength={240}
                    value={props.metadataWrite.rights}
                    placeholder="例如 © moeuu"
                    disabled={!props.metadataWrite.enabled}
                    onChange={(event) =>
                      updateMetadataWrite({ rights: event.currentTarget.value })
                    }
                  />
                </label>
              </div>
              <span className="setting-footnote">
                如果开启但所有字段都为空，本次清理会保持纯清理模式。
              </span>
            </div>

            <details className="setting-card setting-advanced-block">
              <summary>
                <span>
                  <strong>高级标记</strong>
                  <small>评级、标签、版权链接</small>
                </span>
                <span className="setting-disclosure" aria-hidden="true">
                  展开
                </span>
              </summary>

              <div className="setting-text-grid">
                <label className="setting-field">
                  <span>评级</span>
                  <select
                    value={props.metadataWrite.rating}
                    disabled={!props.metadataWrite.enabled}
                    onChange={(event) =>
                      updateMetadataWrite({ rating: event.currentTarget.value })
                    }
                  >
                    <option value="">不写入</option>
                    <option value="0">0 星</option>
                    <option value="1">1 星</option>
                    <option value="2">2 星</option>
                    <option value="3">3 星</option>
                    <option value="4">4 星</option>
                    <option value="5">5 星</option>
                    <option value="-1">拒绝</option>
                  </select>
                </label>

                <label className="setting-field">
                  <span>颜色标签</span>
                  <input
                    type="text"
                    maxLength={120}
                    value={props.metadataWrite.label}
                    placeholder="例如 精选 / 公开"
                    disabled={!props.metadataWrite.enabled}
                    onChange={(event) =>
                      updateMetadataWrite({ label: event.currentTarget.value })
                    }
                  />
                </label>

                <label className="setting-field setting-field-wide">
                  <span>版权说明链接</span>
                  <input
                    type="url"
                    maxLength={240}
                    value={props.metadataWrite.rightsUrl}
                    placeholder="https://example.com/rights"
                    disabled={!props.metadataWrite.enabled}
                    onChange={(event) =>
                      updateMetadataWrite({
                        rightsUrl: event.currentTarget.value,
                      })
                    }
                  />
                </label>
              </div>
            </details>
          </div>
        ) : null}

        {activeTab === "behavior" ? (
          <div className="setting-stack">
            <label className="setting-check">
              <input
                type="checkbox"
                checked={props.autoOpenDetailsOnFailure}
                onChange={(event) =>
                  props.onAutoOpenDetailsOnFailureChange(
                    event.currentTarget.checked,
                  )
                }
              />
              <div>
                <strong>任务有失败项时自动打开运行详情</strong>
                <span>任务结束后若有失败项，自动展开错误列表。</span>
              </div>
            </label>

            <label className="setting-check">
              <input
                type="checkbox"
                checked={props.reopenRunDetailsOnLaunch}
                onChange={(event) =>
                  props.onReopenRunDetailsOnLaunchChange(
                    event.currentTarget.checked,
                  )
                }
              />
              <div>
                <strong>下次启动时恢复运行详情开关状态</strong>
                <span>开启后，程序会记住你上次是否展开了“运行详情”。</span>
              </div>
            </label>
          </div>
        ) : null}

        {activeTab === "environment" ? (
          <div className="setting-stack">
            <div className="setting-card">
              <div className="utility-chip-row">
                <StatusBadge
                  tone={
                    props.runtimeInfo?.exiftoolReady ? "success" : "warning"
                  }
                  label={
                    props.runtimeInfo?.exiftoolReady ? "引擎就绪" : "引擎未就绪"
                  }
                />
                <span className="topbar-meta-chip">
                  {props.runtimeInfo?.exiftoolVersion
                    ? `ExifTool ${props.runtimeInfo.exiftoolVersion}`
                    : "ExifTool"}
                </span>
                <span className="topbar-meta-chip">原地覆盖</span>
                <span className="topbar-meta-chip">
                  资源管理器右键可直接入队
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </UtilityDrawer>
  );
}
