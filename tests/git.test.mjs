/**
 * Unit tests for scripts/lib/git.mjs.
 *
 * Every test owns a throwaway repository under os.tmpdir(); the whole suite is
 * skipped when git is not on PATH.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { collectReviewContext, resolveReviewTarget } from "../scripts/lib/git.mjs";
import { cleanup, gitAvailable, initGitRepo, makeTempDir, runGit, writeFile } from "./helpers.mjs";

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    cleanup(dir);
  }
});

function tempRepo() {
  const dir = makeTempDir("dsh-git-");
  tempDirs.push(dir);
  initGitRepo(dir);
  return dir;
}

function commitAll(dir, message) {
  const added = runGit(dir, ["add", "."]);
  assert.equal(added.status, 0, added.stderr);
  const committed = runGit(dir, ["commit", "-m", message]);
  assert.equal(committed.status, 0, committed.stderr);
}

describe("lib/git.mjs", { skip: gitAvailable ? false : "git is not on PATH" }, () => {
  it("resolveReviewTarget returns working-tree mode when the tree is dirty", () => {
    const dir = tempRepo();
    writeFile(dir, "untracked.txt", "dirty\n");

    assert.deepEqual(resolveReviewTarget(dir, { scope: "auto" }), {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    });
  });

  it("resolveReviewTarget returns branch mode when the tree is clean", () => {
    const dir = tempRepo();

    assert.deepEqual(resolveReviewTarget(dir, {}), {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: false
    });
  });

  it("an explicit --base forces branch mode even when the tree is dirty", () => {
    const dir = tempRepo();
    writeFile(dir, "untracked.txt", "dirty\n");

    assert.deepEqual(resolveReviewTarget(dir, { base: "main" }), {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true
    });
  });

  it("an unsupported scope throws even when --base is given", () => {
    const dir = tempRepo();
    assert.throws(() => resolveReviewTarget(dir, { scope: "everything", base: "main" }), /Unsupported review scope "everything"/);
  });

  it("an unsupported scope throws", () => {
    const dir = tempRepo();
    assert.throws(() => resolveReviewTarget(dir, { scope: "everything" }), /Unsupported review scope "everything"/);
  });

  it("collectReviewContext returns a bounded inline working-tree context", () => {
    const dir = tempRepo();
    writeFile(dir, "tracked.txt", "changed\n");
    const target = resolveReviewTarget(dir, {});
    const context = collectReviewContext(dir, target);

    assert.equal(context.target, target, "the resolved target is echoed");
    assert.equal(context.mode, "working-tree");
    assert.equal(context.inputMode, "inline-diff");
    assert.equal(context.fileCount, 1);
    assert.deepEqual(context.changedFiles, ["tracked.txt"]);
    for (const header of ["## Git Status", "## Staged Diff", "## Unstaged Diff", "## Untracked Files"]) {
      assert.ok(context.content.includes(header), "missing section " + header);
    }
    assert.match(context.summary, /^Reviewing 0 staged, 1 unstaged, and 0 untracked file\(s\)\.$/);
  });

  it("collectReviewContext degrades to a lightweight summary for a large tree", () => {
    const dir = tempRepo();
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      writeFile(dir, name, "x\n");
    }
    const context = collectReviewContext(dir, resolveReviewTarget(dir, {}));

    assert.equal(context.inputMode, "self-collect");
    assert.equal(context.fileCount, 3);
    assert.ok(context.content.includes("## Changed Files"));
    assert.ok(context.content.includes("## Staged Diff Stat"));
    assert.ok(context.content.includes("## Unstaged Diff Stat"));
    assert.equal(context.content.includes("## Staged Diff\n"), false, "no unbounded inline diff section");
    assert.match(context.collectionGuidance, /Inspect the target diff yourself/);
  });

  it("collectReviewContext collects a branch context for the resolved target", () => {
    const dir = tempRepo();
    const branch = runGit(dir, ["checkout", "-b", "feature"]);
    assert.equal(branch.status, 0, branch.stderr);
    writeFile(dir, "feature.txt", "feature work\n");
    commitAll(dir, "feature work");

    const target = resolveReviewTarget(dir, { base: "main" });
    const context = collectReviewContext(dir, target);

    assert.equal(context.target, target);
    assert.equal(context.mode, "branch");
    assert.equal(context.branch, "feature");
    assert.equal(context.inputMode, "inline-diff");
    assert.equal(context.fileCount, 1);
    assert.deepEqual(context.changedFiles, ["feature.txt"]);
    for (const header of ["## Commit Log", "## Diff Stat", "## Branch Diff"]) {
      assert.ok(context.content.includes(header), "missing section " + header);
    }
    assert.match(context.summary, /^Reviewing branch feature against main from merge-base [0-9a-f]+\.$/);
  });
});
