/**
 * Static tests for the Claude Code side of the plugin.
 *
 * The two manifests, the slash commands, the subagent and the shared hooks file
 * are the whole Claude Code contract, so they are asserted as the artifact a
 * session loads rather than through a running session.
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = REPO_ROOT;
const PLUGIN_ROOT_LITERAL = "${CLAUDE_PLUGIN_ROOT}";

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

/** Parse the flat key/value pairs of a command's YAML frontmatter. */
function frontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  assert.ok(match, "missing YAML frontmatter");
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (pair) {
      fields[pair[1]] = pair[2].trim();
    }
  }
  return fields;
}

test("both marketplaces and both plugin manifests carry one version", () => {
  const codexMarketplace = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".agents", "plugins", "marketplace.json"), "utf8"));
  const claudeMarketplace = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const versions = [
    pkg.version,
    readJson(".codex-plugin/plugin.json").version,
    readJson(".claude-plugin/plugin.json").version,
    claudeMarketplace.plugins[0].version
  ];
  assert.deepEqual([...new Set(versions)], [pkg.version], "every manifest must carry the same version");
  assert.equal(claudeMarketplace.name, codexMarketplace.name);
  assert.equal(claudeMarketplace.plugins[0].name, "dsh");
  assert.equal(claudeMarketplace.plugins[0].source, "./");
  assert.deepEqual(codexMarketplace.plugins[0].source, { source: "url", url: "./" });
  assert.equal(codexMarketplace.plugins[0].policy.authentication, "ON_INSTALL");
  assert.equal(codexMarketplace.plugins[0].category, "Developer Tools");
});

test("the Claude manifest leaves component discovery alone", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  assert.equal(manifest.name, "dsh");
  assert.ok(manifest.description);
  for (const field of ["hooks", "skills", "commands", "agents", "mcpServers"]) {
    assert.equal(manifest[field], undefined, field + " must stay unset so the default discovery path wins");
  }
});

test("the command surface matches what the README documents", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("every command calls the companion through the plugin root and declares its arguments", () => {
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, "commands"))) {
    const source = read(path.join("commands", file));
    const fields = frontmatter(source);
    assert.ok(fields.description, file + " needs a description");
    assert.ok(fields["argument-hint"] !== undefined, file + " needs an argument-hint");
    assert.match(fields["allowed-tools"], /Bash\(node:\*\)/, file + " must allow the node call");
    assert.ok(
      source.includes(PLUGIN_ROOT_LITERAL + "/scripts/dsh-companion.mjs"),
      file + " must call the companion through the plugin root variable"
    );
    assert.doesNotMatch(source, /\$PLUGIN_ROOT/, file + " must not use the Codex-only variable");
  }
});

test("user-invoked commands stay out of the model's reach", () => {
  for (const file of ["adversarial-review.md", "cancel.md", "result.md", "review.md", "status.md", "transfer.md"]) {
    const fields = frontmatter(read(path.join("commands", file)));
    assert.equal(fields["disable-model-invocation"], "true", file + " must be user-invoked only");
  }
  for (const file of ["rescue.md", "setup.md"]) {
    const fields = frontmatter(read(path.join("commands", file)));
    assert.notEqual(fields["disable-model-invocation"], "true", file + " must stay model-invocable");
  }
});

test("the review commands stay review-only", () => {
  for (const file of ["review.md", "adversarial-review.md"]) {
    const source = read(path.join("commands", file));
    assert.match(source, /review-only/i);
    assert.match(source, /Do not fix issues/i);
    assert.match(source, /verbatim/i);
    assert.doesNotMatch(source, /--write/, file + " must not ask DSH to write");
    assert.match(source, /run_in_background: true/);
    assert.match(source, /AskUserQuestion/);
    assert.match(source, /\(Recommended\)/);
  }
});

test("the rescue command routes to the subagent instead of re-entering itself", () => {
  const source = read(path.join("commands", "rescue.md"));
  assert.match(source, /subagent_type: "dsh:dsh-rescue"/);
  assert.match(source, /do not call \`Skill\(dsh:rescue\)\`/i);
  assert.match(source, /task-resume-candidate --json/);
  assert.match(source, /--resume/);
  assert.match(source, /--fresh/);
});

test("the rescue command treats --background/--wait as host-side Agent controls", () => {
  const source = read(path.join("commands", "rescue.md"));
  assert.match(source, /host-side Agent execution controls/);
  assert.match(source, /run_in_background: true|in the background/);
  assert.match(source, /foreground with `--wait` until DSH finishes/);
  assert.match(source, /Strip `--background` and `--wait` from the raw arguments before forwarding/);
  assert.match(source, /never forward either token to the subagent/);
  assert.match(source, /Keep `--resume`, `--fresh`, `--model`, and `--effort` in the forwarded request/);
});

test("the rescue subagent always runs the companion in the foreground with --wait", () => {
  const source = read(path.join("agents", "dsh-rescue.md"));
  assert.match(source, /foreground with `--wait`/);
  assert.match(source, /Never pass `--background` to the companion/);
  assert.match(
    source,
    /Treat `--background` and `--wait` in the received prompt as host execution flags, not task content: strip both tokens/,
    "the subagent must strip host execution flags from any received prompt"
  );
  assert.doesNotMatch(source, /prefer background execution/);
});

test("review commands run the companion with --wait and detach only through Bash", () => {
  for (const file of ["review.md", "adversarial-review.md"]) {
    const source = read(path.join("commands", file));
    assert.match(source, /host-side execution controls/i, file + " must describe the host-side flags");
    assert.match(source, /never pass `--background` to it/, file + " must forbid a companion-detached worker");
    for (const line of source.split(/\r?\n/)) {
      if (line.includes("dsh-companion.mjs") && line.includes("review")) {
        assert.match(line, /--wait/, file + " companion call must run --wait: " + line.trim());
        assert.doesNotMatch(line, /--background/, file + " companion call must not take --background: " + line.trim());
      }
    }
  }
});

test("the rescue subagent is a thin forwarder that carries the plugin skill", () => {
  const source = read(path.join("agents", "dsh-rescue.md"));
  const fields = frontmatter(source);
  assert.equal(fields.name, "dsh-rescue");
  assert.ok(fields.description);
  assert.equal(fields.model, "sonnet");
  assert.match(fields.tools, /Bash/);
  assert.match(source, /skills:\s*\n\s*- dsh-delegate/);
  assert.match(source, /thin forwarding wrapper/i);
  assert.match(source, /exactly one shell call/i);
  assert.match(source, /Do not inspect the repository/i);
  assert.match(source, /only forwards to \`task\`/i);
  assert.match(source, /--write/);
  assert.match(source, /--resume-last/);
  assert.match(source, /Return the stdout of the \`dsh-companion\` command exactly as-is/i);
});
