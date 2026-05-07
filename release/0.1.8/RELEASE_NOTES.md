# TagSweep 0.1.8

TagSweep 0.1.8 updates the app's internal desktop identity to match the public project name and GitHub repository.

## Highlights

- Changed the Tauri application identifier from `com.zero.metasweep` to `io.github.fengqing944.tagsweep`.
- Updated app version metadata to `0.1.8` across npm, Cargo, and Tauri configuration.
- Added release notes and SHA256 checksum artifacts for the new Windows installer.

## Compatibility Note

Because the internal app identifier changed, Windows may treat this build as a separate application from earlier `com.zero.metasweep` builds. Existing local preferences and window state may not be reused automatically.

## Windows Installer

- File: `TagSweep_0.1.8_x64-setup.exe`
- Size: `10,174,424 bytes`
- SHA256: `8fc421a44e8d2c9ea4321e675a5cbfceb90cd9b66db99700a786258c59d00f87`

## Verification

- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run tauri build`
