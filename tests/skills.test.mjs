/**
 * Static tests for the shared Codex/Claude skills contract.
 *
 * The skills are the agent-directed path to the companion runtime, so their
 * execution-mode guidance is asserted directly: an agent that delegates to DSH
 * must stay alive with a foreground --wait call and hand the final output back,
 * never detaching a background worker the result could not be delivered from.
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSkill(name) {
  return fs.readFileSync(path.join(REPO_ROOT, "skills", name, "SKILL.md"), "utf8");
}

test("dsh-delegate keeps the invoking agent alive with a foreground --wait call", () => {
  const source = readSkill("dsh-delegate");
  assert.match(source, /Run `task` with `--wait` in the foreground/);
  assert.match(source, /Stay alive until it returns/);
  assert.match(source, /do not\s+detach\s+`--background` for agent-directed work/);
  assert.match(source, /only when the user explicitly asks to fire-and-forget a job/);
  assert.match(source, /task --wait "<the task>"/);
});

test("dsh-review keeps the invoking agent alive with a foreground --wait call", () => {
  const source = readSkill("dsh-review");
  assert.match(source, /Run `review` with `--wait` in the foreground/);
  assert.match(source, /Stay alive until it returns/);
  assert.match(source, /do not\s+detach\s+`--background` for agent-directed work/);
  assert.match(source, /only when the user explicitly asks to fire-and-forget a job/);
  assert.match(source, /review --adversarial --wait/);
});
