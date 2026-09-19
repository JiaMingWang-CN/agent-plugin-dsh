/** Unit tests for scripts/lib/args.mjs (parseArgs). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArgs } from "../scripts/lib/args.mjs";

/** The option surface of the "task" subcommand, plus a few aliases. */
const TASK_CONFIG = {
  valueOptions: ["cwd", "prompt-file", "model", "effort", "base", "scope", "dsh-profile"],
  booleanOptions: ["json", "background", "wait", "write", "fresh", "adversarial"],
  aliasMap: { b: "base", c: "cwd", m: "model", j: "json", w: "write" }
};

describe("parseArgs", () => {
  it("reads value options from the following token", () => {
    const { options, positionals } = parseArgs(["--base", "origin/main", "--model", "flash"], TASK_CONFIG);
    assert.deepEqual(options, { base: "origin/main", model: "flash" });
    assert.deepEqual(positionals, []);
  });

  it("reads boolean options as true", () => {
    const { options, positionals } = parseArgs(["--json", "--wait"], TASK_CONFIG);
    assert.deepEqual(options, { json: true, wait: true });
    assert.deepEqual(positionals, []);
  });

  it("reads the --key=value inline form", () => {
    const { options, positionals } = parseArgs(["--cwd=/tmp/ws", "--effort=high"], TASK_CONFIG);
    assert.deepEqual(options, { cwd: "/tmp/ws", effort: "high" });
    assert.deepEqual(positionals, []);
  });

  it("honors an inline value on a boolean option", () => {
    assert.deepEqual(parseArgs(["--json=false"], TASK_CONFIG).options, { json: false });
    assert.deepEqual(parseArgs(["--json=true"], TASK_CONFIG).options, { json: true });
  });

  it("resolves short aliases to their long option", () => {
    assert.deepEqual(parseArgs(["-b", "main"], TASK_CONFIG).options, { base: "main" });
    assert.deepEqual(parseArgs(["-c", "/tmp/ws"], TASK_CONFIG).options, { cwd: "/tmp/ws" });
    assert.deepEqual(parseArgs(["-j"], TASK_CONFIG).options, { json: true });
    assert.deepEqual(parseArgs(["-w", "prompt"], TASK_CONFIG), { options: { write: true }, positionals: ["prompt"] });
  });

  it("treats every token after -- as a positional", () => {
    const { options, positionals } = parseArgs(["--json", "--", "--base", "-x", "plain text"], TASK_CONFIG);
    assert.deepEqual(options, { json: true });
    assert.deepEqual(positionals, ["--base", "-x", "plain text"]);
  });

  it("throws when a value option has no value", () => {
    assert.throws(() => parseArgs(["--base"], TASK_CONFIG), /Missing value for --base/);
    assert.throws(() => parseArgs(["-b"], TASK_CONFIG), /Missing value for -b/);
    assert.throws(() => parseArgs(["--json", "--effort"], TASK_CONFIG), /Missing value for --effort/);
  });

  it("falls through unknown flags into positionals", () => {
    const { options, positionals } = parseArgs(["--nope", "value", "-z", "prompt text"], TASK_CONFIG);
    assert.deepEqual(options, {});
    assert.deepEqual(positionals, ["--nope", "value", "-z", "prompt text"]);
  });

  it("keeps plain tokens and a lone dash as positionals", () => {
    const { options, positionals } = parseArgs(["review", "-", "the", "diff"], TASK_CONFIG);
    assert.deepEqual(options, {});
    assert.deepEqual(positionals, ["review", "-", "the", "diff"]);
  });

  it("lets a value option consume a flag-looking token", () => {
    assert.deepEqual(parseArgs(["--base", "--json"], TASK_CONFIG).options, { base: "--json" });
  });
});
