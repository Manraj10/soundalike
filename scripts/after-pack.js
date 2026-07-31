"use strict";

// Embed the icon and version metadata into the packaged exe.
//
// electron-builder normally does this itself, but only when
// signAndEditExecutable is on -- and that is off here because extracting its
// winCodeSign cache fails on Windows without Developer Mode (the archive
// contains macOS symlinks). rcedit is the tool that actually writes the icon
// and it has no such dependency, so we invoke it directly at the one point
// where it still matters: after the app directory is built, before the
// installer packs it.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function findRcedit() {
  const cache = path.join(os.homedir(), "AppData", "Local", "electron-builder", "Cache", "winCodeSign");
  if (!fs.existsSync(cache)) return null;
  // Prefer the newest cache dir; any of them ships the same rcedit.
  const dirs = fs.readdirSync(cache)
    .map((d) => path.join(cache, d, "rcedit-x64.exe"))
    .filter((p) => fs.existsSync(p));
  return dirs.length ? dirs[dirs.length - 1] : null;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icon = path.join(context.packager.projectDir, "build", "icon.ico");
  if (!fs.existsSync(exe)) throw new Error(`afterPack: no exe at ${exe}`);
  if (!fs.existsSync(icon)) throw new Error(`afterPack: no icon at ${icon}`);

  const rcedit = findRcedit();
  if (!rcedit) {
    // Do not fail the build over cosmetics, but do not pretend it worked.
    console.warn("afterPack: rcedit not found; exe keeps the default Electron icon");
    return;
  }

  const v = context.packager.appInfo.version;
  execFileSync(rcedit, [
    exe,
    "--set-icon", icon,
    "--set-version-string", "ProductName", "Soundalike",
    "--set-version-string", "FileDescription", "Local voice cloning",
    "--set-version-string", "CompanyName", "Manraj Singh",
    "--set-version-string", "LegalCopyright", `MIT © ${new Date().getFullYear()}`,
    "--set-file-version", v,
    "--set-product-version", v,
  ], { stdio: "inherit" });

  console.log(`afterPack: embedded icon + version metadata into ${path.basename(exe)}`);
};
