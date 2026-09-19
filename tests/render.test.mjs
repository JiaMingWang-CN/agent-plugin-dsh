/** Unit tests for plugins/dsh/scripts/lib/render.mjs. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderCancelReport,
  renderSetupReport,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/dsh/scripts/lib/render.mjs";

const SECRET = "sk-dsh-test-must-never-be-printed";

function setupReport(overrides = {}) {
  return {
    dsh: { available: true, detail: "/usr/local/bin/dsh" },
    dshHome: "/home/user/.dsh",
    profile: "acp",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    effort: "profile default",
    // "value" is planted deliberately: the renderer must name the credential
    // source and must never echo credential material, even if a report carries it.
    credentials: {
      found: true,
      source: "process environment",
      checked: ["process environment"],
      value: SECRET
    },
    stateRoot: "/tmp/dsh-companion/state/ws-0123456789abcdef",
    stopReviewGate: false,
    ...overrides
  };
}

describe("renderTaskResult", () => {
  it("returns a non-empty raw output unchanged, byte-for-byte", () => {
    const outputs = [
      "final answer",
      "final answer\n",
      "line one\nline two\n\nline four\n",
      "  leading and trailing spaces  ",
      "crlf\r\nline\r\n",
      "no trailing newline"
    ];
    for (const rawOutput of outputs) {
      const rendered = renderTaskResult({ rawOutput, failureMessage: "failure text" });
      assert.strictEqual(rendered, rawOutput);
      assert.equal(rendered.includes("failure text"), false);
      assert.equal(rendered.includes("DSH task"), false, "no banner is added");
    }
  });

  it("returns an empty string for missing output instead of inventing a body", () => {
    // NOTE: an earlier revision of render.mjs fell back to failureMessage and to a
    // "<title> produced no output." banner. The current contract is a pure body
    // passthrough: a failed turn reports on stderr, so nothing may be synthesized
    // here, and no fallback text may leak into the delegated task's stdout.
    assert.strictEqual(renderTaskResult({ rawOutput: "", failureMessage: "boom" }), "");
    assert.strictEqual(renderTaskResult({ rawOutput: undefined, failureMessage: "boom" }), "");
    assert.strictEqual(renderTaskResult({ rawOutput: null, failureMessage: "" }), "");
    assert.strictEqual(
      renderTaskResult({ rawOutput: "", failureMessage: "boom" }, { title: "DSH review" }),
      "",
      "no banner, no title"
    );
    assert.strictEqual(renderTaskResult({ rawOutput: "   \n\t\n" }), "   \n\t\n", "whitespace is body, not absence");
  });
});

describe("renderSetupReport", () => {
  it("names the credential source and never prints a key value", () => {
    const text = renderSetupReport(setupReport());

    assert.ok(text.includes("dsh: available (/usr/local/bin/dsh)"));
    assert.ok(text.includes("credentials: DEEPSEEK_API_KEY found via process environment"));
    assert.equal(text.includes(SECRET), false, "credential material must never be rendered");
    assert.ok(text.includes("state root: /tmp/dsh-companion/state/ws-0123456789abcdef"));
    assert.ok(text.includes("stop review gate: disabled"));
    assert.equal(text.includes("Fix:"), false);
  });

  it("lists the checked locations when no credential is found", () => {
    const text = renderSetupReport(
      setupReport({
        dsh: { available: false, detail: "not found" },
        credentials: {
          found: false,
          source: null,
          checked: ["process environment", "/home/user/.dsh/.credentials.yaml"],
          value: SECRET
        }
      })
    );

    assert.ok(text.includes("dsh: NOT available (not found)"));
    assert.ok(
      text.includes("credentials: DEEPSEEK_API_KEY not found (checked process environment, /home/user/.dsh/.credentials.yaml)")
    );
    assert.equal(text.includes(SECRET), false);
    assert.ok(text.includes("Fix:"));
    assert.ok(text.includes("Install DeepSeek Harness"));
    assert.ok(text.includes("Set DEEPSEEK_API_KEY"));
  });
});

describe("renderCancelReport", () => {
  it("states that the cancelled session is not offered for resume", () => {
    const text = renderCancelReport({ id: "job-9", kind: "task", termination: "taskkill /T /F" });

    assert.ok(text.startsWith("Cancelled job-9 (task)."));
    assert.ok(text.includes("Termination: taskkill /T /F"));
    assert.match(text, /not offered for resume/);
    assert.match(text, /process tree was terminated/);
  });

  it("omits the termination line when none was recorded", () => {
    const text = renderCancelReport({ id: "job-10", kind: "review" });

    assert.ok(text.includes("Cancelled job-10 (review)."));
    assert.equal(text.includes("Termination:"), false);
    assert.match(text, /not offered for resume/);
  });
});

describe("renderStoredJobResult", () => {
  it("includes the session id and the stored rendered body", () => {
    const text = renderStoredJobResult(
      { id: "job-7", status: "completed", kind: "task" },
      { sessionId: "sess-abc", stopReason: "end_turn", result: { rendered: "# Answer\n\nbody text" } }
    );

    assert.ok(text.startsWith("job-7  completed  task"));
    assert.ok(text.includes("DSH session: sess-abc"));
    assert.ok(text.includes("stop reason: end_turn"));
    assert.ok(text.includes("# Answer"));
    assert.ok(text.includes("body text"));
  });

  it("falls back to the job's own session id and reports a missing body", () => {
    const text = renderStoredJobResult({ id: "job-8", status: "failed", kind: "review", sessionId: "sess-from-job" }, null);

    assert.ok(text.includes("DSH session: sess-from-job"));
    assert.ok(text.includes("(no stored output)"));
  });
});
