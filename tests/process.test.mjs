/**
 * Unit tests for scripts/lib/process.mjs.
 *
 * platform/killImpl/runCommandImpl/isAliveImpl are always injected: no real
 * process is signalled and no real time is ever waited on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isProcessAlive, terminateProcessTree } from "../scripts/lib/process.mjs";

const noopSleep = () => Promise.resolve();

/** A killImpl that records every (pid, signal) pair and always succeeds. */
function recordingKillImpl() {
  const calls = [];
  return {
    calls,
    fn: (pid, signal) => {
      calls.push([pid, signal]);
    }
  };
}

/**
 * An isAliveImpl with kill(pid, 0) semantics: report "alive" for the first
 * aliveTimes probes, then throw ESRCH so the process counts as gone.
 * Number.POSITIVE_INFINITY models a process that never disappears.
 */
function recordingIsAliveImpl(aliveTimes) {
  const calls = [];
  let probes = 0;
  return {
    calls,
    fn: (pid, signal) => {
      calls.push([pid, signal]);
      probes += 1;
      if (probes > aliveTimes) {
        const error = new Error("kill ESRCH");
        error.code = "ESRCH";
        throw error;
      }
    }
  };
}

/** A runCommandImpl that records its arguments and reports a clean exit. */
function recordingRunCommandImpl() {
  const calls = [];
  return {
    calls,
    fn: (command, args, options) => {
      calls.push({ command, args, options });
      return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
    }
  };
}

/**
 * Injectable terminateProcessTree options.
 *
 * graceMs/confirmMs are 0 so the exit-confirmation polls can never sleep:
 * terminateProcessTree does not forward a sleep override to
 * waitForProcessExit, so a 0ms bound is what keeps these tests instant. The
 * no-op sleep is still injected to document the intended override point.
 */
function inject({ aliveTimes = 0, ...overrides } = {}) {
  const kill = recordingKillImpl();
  const run = recordingRunCommandImpl();
  const alive = recordingIsAliveImpl(aliveTimes);
  return {
    kill,
    run,
    alive,
    options: {
      platform: "linux",
      graceMs: 0,
      confirmMs: 0,
      sleep: noopSleep,
      killImpl: kill.fn,
      runCommandImpl: run.fn,
      isAliveImpl: alive.fn,
      ...overrides
    }
  };
}

const esrch = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });

describe("terminateProcessTree", () => {
  it("returns attempted:false and exited:false for an invalid pid", async () => {
    for (const pid of [0, -1, Number.NaN]) {
      const { run, options } = inject({ platform: "win32" });
      const report = await terminateProcessTree(pid, options);

      assert.deepEqual(report, {
        attempted: false,
        delivered: false,
        exited: false,
        method: null,
        detail: "no pid recorded for this job"
      });
      assert.equal(run.calls.length, 0, "no terminator may run without a pid");
    }
  });

  it("win32: terminates the tree with taskkill /PID <pid> /T /F", async () => {
    const { run, alive, options } = inject({ platform: "win32", cwd: "C:/ws", env: { A: "1" } });
    const report = await terminateProcessTree(4242, options);

    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].command, "taskkill");
    assert.deepEqual(run.calls[0].args, ["/PID", "4242", "/T", "/F"]);
    assert.equal(run.calls[0].options.cwd, "C:/ws");
    assert.deepEqual(run.calls[0].options.env, { A: "1" });

    assert.equal(report.attempted, true);
    assert.equal(report.delivered, true);
    assert.equal(report.exited, true);
    assert.equal(report.method, "taskkill");
    assert.deepEqual(alive.calls, [[4242, 0]]);
  });

  it("win32: escalates to a forced taskkill when the tree survives", async () => {
    const { run, options } = inject({ platform: "win32", aliveTimes: 1 });
    const report = await terminateProcessTree(4242, options);

    assert.equal(run.calls.length, 2, "the force pass repeats the same taskkill argv");
    assert.deepEqual(run.calls[1].args, ["/PID", "4242", "/T", "/F"]);
    assert.equal(report.delivered, true);
    assert.equal(report.method, "taskkill-force");
    assert.equal(report.exited, true);
  });

  it("posix: signals the negative pgid and then the pid", async () => {
    const { kill, options } = inject({ platform: "linux", pgid: 9001 });
    const report = await terminateProcessTree(4242, options);

    assert.deepEqual(kill.calls, [[-9001, "SIGTERM"], [4242, "SIGTERM"]]);
    assert.equal(report.method, "process-group");
    assert.equal(report.delivered, true);
    assert.equal(report.exited, true);
  });

  it("posix: escalates to SIGKILL when the process is still alive", async () => {
    const { kill, options } = inject({ platform: "linux", pgid: 9001, aliveTimes: 1 });
    const report = await terminateProcessTree(4242, options);

    assert.deepEqual(kill.calls, [
      [-9001, "SIGTERM"],
      [4242, "SIGTERM"],
      [-9001, "SIGKILL"],
      [4242, "SIGKILL"]
    ]);
    assert.equal(report.exited, true);
  });

  it("posix: without a pgid it only signals the pid", async () => {
    const { kill, options } = inject({ platform: "linux", aliveTimes: 1 });
    const report = await terminateProcessTree(4242, options);

    assert.deepEqual(kill.calls, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    assert.equal(report.method, "process");
    assert.equal(report.exited, true);
  });

  it("never claims exit from signal delivery alone", async () => {
    const { kill, alive, options } = inject({
      platform: "linux",
      pgid: 9001,
      aliveTimes: Number.POSITIVE_INFINITY
    });
    const started = Date.now();
    const report = await terminateProcessTree(4242, options);

    assert.equal(report.attempted, true);
    assert.equal(report.delivered, true, "the signals were delivered");
    assert.equal(report.exited, false, "delivery is not proof of exit");
    assert.equal(report.detail, "process 4242 was still running after termination (group 9001)");
    assert.equal(alive.calls.length, 2, "one grace poll plus one confirmation poll");
    for (const [pid, signal] of alive.calls) {
      assert.equal(pid, 4242);
      assert.equal(signal, 0);
    }
    assert.ok(kill.calls.length >= 2);
    assert.ok(Date.now() - started < 2000, "the terminator must not block on real time");
  });

  it("treats ESRCH from kill as 'target absent', not as delivery", async () => {
    const calls = [];
    const killImpl = (pid, signal) => {
      calls.push([pid, signal]);
      throw esrch();
    };
    const { alive, options } = inject({ platform: "linux", killImpl });
    const report = await terminateProcessTree(4242, options);

    assert.deepEqual(calls, [[4242, "SIGTERM"]], "the absent target ends the escalation");
    assert.equal(report.attempted, true);
    assert.equal(report.delivered, false);
    assert.equal(report.exited, true);
    assert.deepEqual(alive.calls, [[4242, 0]]);
  });
});

describe("isProcessAlive", () => {
  it("reports a pid that kill 0 accepts as alive", () => {
    assert.equal(isProcessAlive(4242, () => {}), true);
  });

  it("treats EPERM as alive (another user owns the process)", () => {
    const killImpl = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    assert.equal(isProcessAlive(4242, killImpl), true);
  });

  it("treats ESRCH as gone", () => {
    const killImpl = () => {
      throw esrch();
    };
    assert.equal(isProcessAlive(4242, killImpl), false);
  });

  it("treats any other failure as gone and never probes an invalid pid", () => {
    const killImpl = () => {
      throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
    };
    assert.equal(isProcessAlive(4242, killImpl), false);

    let probes = 0;
    const counting = () => {
      probes += 1;
    };
    for (const pid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(isProcessAlive(pid, counting), false);
    }
    assert.equal(probes, 0);
  });
});
