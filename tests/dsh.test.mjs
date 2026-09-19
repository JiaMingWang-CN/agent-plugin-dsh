/** Unit tests for the DshRuntime process-exit accounting.
 *
 * The end-to-end suite drives a fake ACP server, but a signal death and a
 * voluntary exit differ only in what the child's "exit" event reports. A
 * stub child pins those cases down everywhere: the fake runtime cannot
 * reproduce a signal death on Windows, where TerminateProcess reports an
 * exit code rather than a signal.
 */

import assert from "node:assert";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { DshRuntime } from "../scripts/lib/dsh.mjs";

/** A child that supports only the lifecycle the runtime observes. */
function stubChild(pid = 4321) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = { destroyed: false, end() { child.stdin.destroyed = true; } };
  child.pid = pid;
  return child;
}

function makeRuntime(child) {
  return new DshRuntime(child, { platform: "linux", cwd: "/tmp", command: "dsh" });
}

test("a death by signal is recorded as a nonzero exit, never 0", async () => {
  const child = stubChild();
  const runtime = makeRuntime(child);
  child.emit("exit", null, "SIGKILL");
  assert.equal(runtime.exitCode, 1, "a signal death must not look like a clean exit");
  const shutdown = await runtime.shutdown();
  assert.equal(shutdown.exited, true);
  assert.equal(shutdown.code, 1);
  assert.equal(shutdown.method, "signal:SIGKILL", "the method names the signal, not already-exited");
});

test("a clean exit keeps exit code 0 and the already-exited method", async () => {
  const child = stubChild();
  const runtime = makeRuntime(child);
  child.emit("exit", 0, null);
  assert.equal(runtime.exitCode, 0);
  assert.equal((await runtime.shutdown()).method, "already-exited");
});

test("a nonzero exit code the child reports is kept as-is", async () => {
  const child = stubChild();
  const runtime = makeRuntime(child);
  child.emit("exit", 3, null);
  assert.equal(runtime.exitCode, 3);
});

test("a signal death is named in the shutdown a caller reads", async () => {
  const child = stubChild();
  const runtime = makeRuntime(child);
  child.stderr.emit("data", "the runtime crashed");
  child.emit("exit", null, "SIGSEGV");
  assert.equal(runtime.exitCode, 1);
  const shutdown = await runtime.shutdown();
  assert.equal(shutdown.method, "signal:SIGSEGV");
});
