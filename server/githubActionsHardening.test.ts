import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../.github/workflows"
);
const USES_KEY_PATTERN = /^\s*(?:-\s*)?uses\s*:/;
const ACTION_REFERENCE_PATTERN =
  /^\s*(?:-\s*)?uses\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))(?:\s+#\s*(\S.*))?\s*$/;
const IMMUTABLE_ACTION_PATTERN = /^[^/@\s]+\/[^@\s]+@[0-9a-f]{40}$/;
const IMMUTABLE_DOCKER_ACTION_PATTERN =
  /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const READABLE_VERSION_PATTERN = /^v\d+(?:\.\d+){0,2}(?:\s|$)/;

function listWorkflowFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listWorkflowFiles(entryPath);
    }

    return /\.ya?ml$/.test(entry.name) ? [entryPath] : [];
  });
}

function findUsesViolations(lines: string[], relativePath: string): string[] {
  const violations: string[] = [];

  lines.forEach((line, index) => {
    if (!USES_KEY_PATTERN.test(line)) return;

    const match = line.match(ACTION_REFERENCE_PATTERN);
    if (!match) {
      violations.push(
        `${relativePath}:${index + 1} uses reference could not be parsed`
      );
      return;
    }

    const actionReference = match[1] ?? match[2] ?? match[3];
    const versionComment = match[4];
    if (actionReference.startsWith("./")) return;

    if (actionReference.startsWith("docker://")) {
      if (!IMMUTABLE_DOCKER_ACTION_PATTERN.test(actionReference)) {
        violations.push(
          `${relativePath}:${index + 1} Docker action is not pinned to a sha256 digest`
        );
      }
      return;
    }

    if (!IMMUTABLE_ACTION_PATTERN.test(actionReference)) {
      violations.push(
        `${relativePath}:${index + 1} is not pinned to a full commit SHA`
      );
    }
    if (!versionComment || !READABLE_VERSION_PATTERN.test(versionComment)) {
      violations.push(
        `${relativePath}:${index + 1} is missing a readable version comment`
      );
    }
  });

  return violations;
}

describe("GitHub Actions supply-chain hardening", () => {
  it("pins every external action to an immutable reference", () => {
    const violations: string[] = [];

    for (const workflowPath of listWorkflowFiles(WORKFLOWS_DIRECTORY)) {
      const relativePath = path.relative(
        path.resolve(import.meta.dirname, ".."),
        workflowPath
      );
      const lines = readFileSync(workflowPath, "utf8").split("\n");

      violations.push(...findUsesViolations(lines, relativePath));
    }

    expect(violations).toEqual([]);
  });

  it("rejects Docker actions referenced by tag or without a digest", () => {
    const digest = "a".repeat(64);
    const lines = [
      `uses: docker://ghcr.io/example/action@sha256:${digest}`,
      "uses: docker://ghcr.io/example/action:v1",
      "uses: 'docker://ghcr.io/example/action'",
      "  - uses: ghcr.io/example/action@v1",
    ];

    expect(findUsesViolations(lines, "fixture.yml")).toEqual([
      "fixture.yml:2 Docker action is not pinned to a sha256 digest",
      "fixture.yml:3 Docker action is not pinned to a sha256 digest",
      "fixture.yml:4 is not pinned to a full commit SHA",
      "fixture.yml:4 is missing a readable version comment",
    ]);
  });
});
