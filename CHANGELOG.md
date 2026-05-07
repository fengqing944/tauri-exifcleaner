# Changelog

## 0.1.8 - 2026-05-07

- Changed the internal Tauri application identifier from `com.zero.metasweep` to `io.github.fengqing944.tagsweep`.
- This makes the app identity match the public GitHub project and current product name.
- Windows may treat this as a separate application from earlier builds, so previous local settings may not be reused automatically.

## 0.1.7 - 2026-05-07

- Added a formal release metadata flow with versioned release notes and SHA256 checksum files.
- Marked the bundled ExifTool runtime as vendored for GitHub language statistics.
- Disabled the default WebView context menu in the desktop app.
- Fixed About drawer external links so the open-source URL and email open through the system handler.
- Refined settings examples to use neutral, product-appropriate sample metadata.
- Unified and polished the run details drawer styling.
- Added support for selecting a custom mirror output directory.

## 0.1.6 - 2026-05-07

- Improved cleanup reporting for mixed success, unchanged, and failed files.
- Added PNG native metadata writing for public text fields.
- Added safer PNG cleanup behavior that preserves display-related chunks.
- Improved metadata preview truncation and large-queue behavior.
- Updated frontend tooling and bundled ExifTool.
