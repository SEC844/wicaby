## Summary

<!-- What does this change, and why? Link related issues: "Fixes #123". -->

## Areas

- [ ] Desktop (`apps/desktop`)
- [ ] Android TV (`apps/android/tv`)
- [ ] Android mobile (`apps/android/mobile`)
- [ ] Android shared (`apps/android/core`, `apps/android/mesh-ui`, `apps/android/livetv-ui`)
- [ ] Mesh helper (`packages/mesh`)
- [ ] Tools, mocks, checks (`tools/`)
- [ ] CI, release, docs

## How was it tested?

<!-- Mock server (tools/mock-server), emulator, real device... Add screenshots or a short clip for UI changes. -->

## Checklist

- [ ] Desktop: `npm run check`, `npm run checks` and `npm run build` pass
- [ ] Android: `./gradlew testDebugUnitTest :tv:assembleDebug :mobile:assembleDebug lint` passes in `apps/android`
- [ ] Mesh: `go test ./...` passes in `packages/mesh`, and no AGPL NetBird package is linked
- [ ] New or changed strings exist in French and English (desktop i18n, Android `values/` and `values-en/`)
- [ ] User-facing changes: docs updated (`README.md`, `README.fr.md`, `docs/`) and a line added to `CHANGELOG.md` under "Unreleased"
- [ ] No secrets, keystores, `local.properties`, logs or real server addresses committed
