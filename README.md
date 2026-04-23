# TagSweep

基于 `Tauri 2`、`Rust`、`React 19` 实现的桌面版元数据清理器，目标是做成一个独立设计、现代化、性能更强、交互更像原生程序的元数据清理应用。

## 当前版本已实现

- 多文件拖拽
- 多文件夹拖拽
- 递归扫描文件夹
- 队列追加，不会因为二次拖入直接清空旧任务
- 镜像输出模式
- 原地覆盖模式
- 并发批处理
- Rust 后端实时推送进度
- 失败项汇总
- Windows 打包并内置 `ExifTool`
- 常驻 `ExifTool` worker 池，避免逐文件反复拉起进程

## 技术方案

- 前端: `React 19 + TypeScript + Vite`
- 桌面容器: `Tauri 2`
- 后端: `Rust`
- 元数据清理引擎: `ExifTool 13.56` Windows 64-bit 资源包

应用没有走“网页感”布局，而是做成了桌面工作台样式：

- 顶部总览区
- 左侧导入/设置/预览工作流
- 右侧运行状态/活动流/根路径摘要
- 拖拽高亮和批量处理反馈

## 支持方式

当前代码内置了常见格式过滤，覆盖了常见图片、视频和文档场景，例如：

- `jpg`, `jpeg`, `png`, `webp`, `gif`, `tif`, `tiff`
- `heic`, `heif`, `avif`
- `mp4`, `mov`, `m4a`, `wav`, `mp3`, `wmv`, `avi`
- `pdf`
- 部分 RAW 扩展名

实际清理由 `ExifTool` 完成，具体写入能力仍以 `ExifTool` 为准。

## 运行开发

```bash
npm install
npm run tauri dev
```

## 生产构建

```bash
npm run tauri build
```

本地已成功打包生成：

- `G:\Demo\tauri-exifcleaner\src-tauri\target\release\bundle\nsis\TagSweep_0.1.3_x64-setup.exe`

## 项目结构

- `src/App.tsx`: 主界面与交互逻辑
- `src/App.css`: 桌面化视觉样式
- `src-tauri/src/lib.rs`: 扫描、过滤、路径规划、并发清理、进度事件
- `src-tauri/resources/exiftool/`: 内置 ExifTool 资源

## 后续可继续增强

- 缩略图预览与文件类型图标细分
- 拖入后自动分组和筛选
- 更多输出策略
- 设置持久化
- 国际化
- macOS / Linux 的 ExifTool 资源与签名分发
