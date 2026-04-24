import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { MetadataWritePreferences, RuntimeInfo } from "../app-shared";
import { StatusBadge } from "./AppPrimitives";

type SettingsTabId = "execution" | "metadata" | "behavior" | "environment";

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string; caption: string }> = [
  { id: "execution", label: "执行", caption: "速度" },
  { id: "metadata", label: "标记", caption: "标题/作者" },
  { id: "behavior", label: "界面", caption: "详情" },
  { id: "environment", label: "环境", caption: "只读" },
];

export function SettingsDrawer(props: {
  isOpen: boolean;
  runtimeInfo: RuntimeInfo | null;
  parallelism: number;
  autoOpenDetailsOnFailure: boolean;
  reopenRunDetailsOnLaunch: boolean;
  metadataWrite: MetadataWritePreferences;
  onClose: () => void;
  onParallelismChange: (value: number) => void;
  onResetParallelism: () => void;
  onAutoOpenDetailsOnFailureChange: (value: boolean) => void;
  onReopenRunDetailsOnLaunchChange: (value: boolean) => void;
  onMetadataWriteChange: (value: MetadataWritePreferences) => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("execution");
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (props.isOpen) {
      closeButtonRef.current?.focus();
    }
  }, [props.isOpen]);

  const activeTabMeta =
    SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];

  const handleTabButtonKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tabId: SettingsTabId,
  ) => {
    const currentIndex = SETTINGS_TABS.findIndex((tab) => tab.id === tabId);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
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

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const drawer = drawerRef.current;
    if (!drawer) {
      return;
    }

    const focusableElements = Array.from(
      drawer.querySelectorAll<HTMLElement>(
        'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        !element.hasAttribute("disabled") && element.getAttribute("tabindex") !== "-1",
    );

    if (!focusableElements.length) {
      event.preventDefault();
      drawer.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      if (!activeElement || activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      }
      return;
    }

    if (activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  if (!props.isOpen) {
    return null;
  }

  return (
    <div className="details-drawer-backdrop" onClick={props.onClose}>
      <aside
        ref={drawerRef}
        className="details-drawer utility-drawer"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="details-drawer-head utility-drawer-head">
          <div>
            <strong>设置</strong>
            <span>这里的偏好会自动保存在本机，下次启动继续生效。</span>
          </div>
          <button ref={closeButtonRef} className="button" type="button" onClick={props.onClose}>
            关闭
          </button>
        </div>

        <div className="details-drawer-body utility-drawer-body">
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
                {activeTab === "metadata" && "清理完成后，可选择写入你自己的公开标记。"}
                {activeTab === "behavior" && "控制任务详情和失败提示的显示方式。"}
                {activeTab === "environment" && "当前运行环境信息，仅用于确认状态。"}
              </span>
            </div>

            {activeTab === "execution" ? (
              <div className="setting-stack">
                <div className="setting-card">
                  <div className="setting-head">
                    <div>
                      <strong>默认并发</strong>
                      <span>调高会更快，调低会更稳。当前设置会在下次启动继续使用。</span>
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
                    <button className="button" type="button" onClick={props.onResetParallelism}>
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

            {activeTab === "metadata" ? (
              <div className="setting-stack">
                <label className="setting-check">
                  <input
                    type="checkbox"
                    checked={props.metadataWrite.enabled}
                    onChange={(event) =>
                      props.onMetadataWriteChange({
                        ...props.metadataWrite,
                        enabled: event.currentTarget.checked,
                      })
                    }
                  />
                  <div>
                    <strong>清理后写入标题和作者</strong>
                    <span>开启后会先清空原元数据，再写入你主动填写的 XMP 标题/作者。</span>
                  </div>
                </label>

                <div className="setting-card">
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
                          props.onMetadataWriteChange({
                            ...props.metadataWrite,
                            title: event.currentTarget.value,
                          })
                        }
                      />
                    </label>

                    <label className="setting-field">
                      <span>作者</span>
                      <input
                        type="text"
                        maxLength={120}
                        value={props.metadataWrite.author}
                        placeholder="可留空"
                        disabled={!props.metadataWrite.enabled}
                        onChange={(event) =>
                          props.onMetadataWriteChange({
                            ...props.metadataWrite,
                            author: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                  </div>
                  <span className="setting-footnote">
                    如果开启但标题和作者都为空，本次清理会保持纯清理模式。
                  </span>
                </div>
              </div>
            ) : null}

            {activeTab === "behavior" ? (
              <div className="setting-stack">
                <label className="setting-check">
                  <input
                    type="checkbox"
                    checked={props.autoOpenDetailsOnFailure}
                    onChange={(event) =>
                      props.onAutoOpenDetailsOnFailureChange(event.currentTarget.checked)
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
                      props.onReopenRunDetailsOnLaunchChange(event.currentTarget.checked)
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
                      tone={props.runtimeInfo?.exiftoolReady ? "success" : "warning"}
                      label={props.runtimeInfo?.exiftoolReady ? "引擎就绪" : "引擎未就绪"}
                    />
                    <span className="topbar-meta-chip">
                      {props.runtimeInfo?.exiftoolVersion
                        ? `ExifTool ${props.runtimeInfo.exiftoolVersion}`
                        : "ExifTool"}
                    </span>
                    <span className="topbar-meta-chip">原地覆盖</span>
                    <span className="topbar-meta-chip">资源管理器右键可直接入队</span>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}
