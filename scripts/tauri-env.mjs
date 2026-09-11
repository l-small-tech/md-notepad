#!/usr/bin/env node
/**
 * `pnpm run tauri …` goes through here so the native Whisper build finds
 * what it needs without every developer exporting the same variables:
 *
 * - Windows: a SHORT `CARGO_TARGET_DIR`. whisper.cpp's Vulkan shader
 *   generator is a nested CMake project ~150 characters below the target
 *   dir, and MSVC's build tooling still stops at MAX_PATH — from a worktree
 *   (or even the main checkout) it fails with
 *   `error C1083: Cannot open compiler generated file: ''`. The budget is
 *   tight — the nested project alone is ~170 characters and cargo's own
 *   `debug\build\whisper-rs-sys-<hash>\out\build` another 50 — so the
 *   target dir becomes `<SystemDrive>\t\<8-char hash of this checkout>`
 *   (`%LOCALAPPDATA%` is already too deep), one per checkout so worktrees
 *   never share a cargo lock, falling back to `%LOCALAPPDATA%\t\<hash>` if
 *   the drive root refuses the folder. An explicit `CARGO_TARGET_DIR` in
 *   the environment always wins.
 * - Windows: `VULKAN_SDK` from `C:\VulkanSDK\<newest>` if the installer's
 *   machine-wide variable has not reached this shell yet, `LIBCLANG_PATH`
 *   from Program Files\LLVM, and CMake on PATH from Program Files\CMake.
 *
 * Everything else is passed straight to the Tauri CLI.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };

if (process.platform === 'win32') {
  if (!env.CARGO_TARGET_DIR) {
    const hash = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 8);
    const drive = env.SystemDrive ?? 'C:';
    const candidates = [join(`${drive}\\`, 't', hash)];
    if (env.LOCALAPPDATA) {
      candidates.push(join(env.LOCALAPPDATA, 't', hash));
    }
    for (const dir of candidates) {
      try {
        mkdirSync(dir, { recursive: true });
        env.CARGO_TARGET_DIR = dir;
        break;
      } catch {
        // not writable here; try the next
      }
    }
    if (env.CARGO_TARGET_DIR) {
      console.log(
        `[tauri-env] CARGO_TARGET_DIR=${env.CARGO_TARGET_DIR} (short path for the Vulkan shader build)`,
      );
    } else {
      console.warn(
        '[tauri-env] could not create a short target dir; the Vulkan shader build may hit MAX_PATH',
      );
    }
  }
  if (!env.VULKAN_SDK && existsSync('C:\\VulkanSDK')) {
    const versions = readdirSync('C:\\VulkanSDK').filter((v) => /^\d+(\.\d+)+$/.test(v));
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const newest = versions.at(-1);
    if (newest) {
      env.VULKAN_SDK = join('C:\\VulkanSDK', newest);
      console.log(`[tauri-env] VULKAN_SDK=${env.VULKAN_SDK}`);
    }
  }
  const llvm = 'C:\\Program Files\\LLVM\\bin';
  if (!env.LIBCLANG_PATH && existsSync(join(llvm, 'libclang.dll'))) {
    env.LIBCLANG_PATH = llvm;
  }
  const prepend = [];
  if (env.VULKAN_SDK) prepend.push(join(env.VULKAN_SDK, 'Bin'));
  const cmake = 'C:\\Program Files\\CMake\\bin';
  if (existsSync(join(cmake, 'cmake.exe'))) prepend.push(cmake);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = [...prepend, env[pathKey] ?? ''].join(';');
}

const result = spawnSync('tauri', process.argv.slice(2), {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
