# TagSweep 0.1.7

TagSweep 0.1.7 focuses on making the app feel more like a polished desktop release: cleaner GitHub metadata, safer release artifacts, better system integration, and more professional in-app wording.

## Highlights

- Added release notes and SHA256 checksum artifacts for the Windows installer.
- Updated the app version to `0.1.7` across npm, Cargo, and Tauri configuration.
- Marked bundled ExifTool files as vendored so GitHub language statistics better reflect TagSweep's own Rust, TypeScript, and CSS source.
- Disabled the default WebView right-click menu inside the desktop app.
- Fixed About drawer links to open through the system browser/mail handler.
- Replaced informal metadata examples with neutral, official-looking sample values.
- Polished run details drawer styling and mirror output directory behavior.

## Windows Installer

- File: `TagSweep_0.1.7_x64-setup.exe`
- Size: `10,169,562 bytes`
- SHA256: `7d7570eb55cb60b3ce3544948e1f63cc64e091fdb390f33d5a9a314d8f134748`

## Verification

- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run tauri build`
