// electron-builder afterPack hook: flips the Electron fuses of the packaged executable.
// Runs after electron-builder embedded the asar integrity resource and before signing
// (fuses must be flipped before the binary is signed).
//   RunAsNode off                         ELECTRON_RUN_AS_NODE cannot turn Wicaby.exe into node.exe
//   EnableNodeOptionsEnvironmentVariable  NODE_OPTIONS is ignored
//   EnableNodeCliInspectArguments off     --inspect / --inspect-brk are ignored
//   EnableEmbeddedAsarIntegrityValidation app.asar must match the hash embedded in the exe
//   OnlyLoadAppFromAsar                   no app/ folder or loose files next to app.asar
import path from 'node:path';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';

export const FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const name = packager.appInfo.productFilename;
  const exe =
    electronPlatformName === 'win32'
      ? path.join(appOutDir, `${name}.exe`)
      : electronPlatformName === 'darwin'
        ? path.join(appOutDir, `${name}.app`)
        : path.join(appOutDir, packager.executableName ?? name);
  await flipFuses(exe, FUSES);
  console.log(`  • electron fuses flipped  file=${path.relative(process.cwd(), exe)}`);
}
