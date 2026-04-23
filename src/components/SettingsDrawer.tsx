import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { RuntimeInfo } from "../app-shared";
import { StatusBadge } from "./AppPrimitives";

export function SettingsDrawer(props: {
  isOpen: boolean;
  runtimeInfo: RuntimeInfo | null;
  parallelism: number;
  autoOpenDetailsOnFailure: boolean;
  reopenRunDetailsOnLaunch: boolean;
  onClose: () => void;
  onParallelismChange: (value: number) => void;
  onResetParallelism: () => void;
  onAutoOpenDetailsOnFailureChange: (value: boolean) => void;
  onReopenRunDetailsOnLaunchChange: (value: boolean) => void;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

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
    ).filter((element) => !element.hasAttribute("disabled"));

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
          <section className="utility-section">
            <div className="task-block-head">
              <strong>执行偏好</strong>
              <span>会自动记住</span>
            </div>

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
          </section>

          <section className="utility-section">
            <div className="task-block-head">
              <strong>界面行为</strong>
              <span>同样会持久化</span>
            </div>

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
          </section>

          <section className="utility-section">
            <div className="task-block-head">
              <strong>当前环境</strong>
              <span>只读信息</span>
            </div>

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
          </section>
        </div>
      </aside>
    </div>
  );
}
