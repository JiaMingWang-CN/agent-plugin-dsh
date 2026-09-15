/**
 * Shared helpers for the codex-plugin-dsh unit-test suite.
 *
 * Nothing here may touch the user's real state root: every helper that runs the
 * companion points DSH_COMPANION_DATA at a fresh temp directory under os.tmpdir().
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the codex-plugin-dsh workspace root. */
export const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Absolute path of plugins/dsh/scripts/lib/<name>. */
export function libPath(name) {
  return path.join(repoRoot, "plugins", "dsh", "scripts", "lib", name);
}

/** Absolute path of the companion entry point. */
export const companionPath = path.join(repoRoot, "plugins", "dsh", "scripts", "dsh-companion.mjs");

/** A fresh directory under os.tmpdir(); the caller owns it and must clean it up. */
export function makeTempDir(prefix = "codex-plugin-dsh-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write text to name inside dir (creating parent directories). Returns the path. */
export function writeFile(dir, name, text) {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
  return filePath;
}

/** Best-effort recursive removal. */
export function cleanup(dir) {
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the companion in a child process.
 *
 * DSH_COMPANION_DATA always points at a fresh temp directory, so no companion
 * call can read or write the real per-user state root. Returns
 * { status, stdout, stderr, dataDir }: the caller owns dataDir and should pass
 * it to cleanup() from an after()/t.after() hook.
 */
export function runCompanion(args, { cwd = repoRoot, env = {}, input } = {}) {
  const dataDir = makeTempDir("dsh-companion-data-");
  const result = spawnSync(process.execPath, [companionPath, ...args], {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env, DSH_COMPANION_DATA: dataDir }
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    dataDir
  };
}

/** Whether git can be executed on this machine. */
export const gitAvailable = (() => {
  try {
    const result = spawnSync("git", ["--version"], { encoding: "utf8" });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
})();

/** Run one git command in dir. Never throws; inspect status/error. */
export function runGit(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

/**
 * Create a throwaway repository in dir: one commit on branch "main".
 *
 * Throws with a skip hint when git is unavailable, so callers guard on the
 * exported gitAvailable flag (node:test's { skip }) before calling it.
 */
export function initGitRepo(dir) {
  if (!gitAvailable) {
    throw new Error("git is not on PATH; skipping this Git-dependent test");
  }
  const git = (args) => {
    const result = runGit(dir, args);
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error("git " + args.join(" ") + " failed: " + result.stderr.trim());
    }
    return result.stdout;
  };

  git(["init"]);
  git(["config", "user.email", "dsh-tests@example.invalid"]);
  git(["config", "user.name", "DSH Tests"]);
  // Pin the branch name: detectDefaultBranch() must find a known candidate.
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFile(dir, "tracked.txt", "initial\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
  return dir;
}
