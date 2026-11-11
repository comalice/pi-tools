import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(root, "skills", "wizard", "template.sh");
const wizardPath = path.join(root, "scripts", "spoke-onboard.sh");

function libraryPrefix(contents: string) {
  const stageStart = contents.indexOf("run_wizard() {");
  assert.notEqual(stageStart, -1, "wizard is missing its stage section");
  return contents.slice(0, stageStart);
}

describe("spoke onboarding wizard", () => {
  it("has valid bash syntax", async () => {
    const result = spawnSync("bash", ["-n", wizardPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("keeps the shared wizard library byte-identical to the template", async () => {
    const [template, wizard] = await Promise.all([
      readFile(templatePath, "utf8"),
      readFile(wizardPath, "utf8"),
    ]);
    assert.equal(libraryPrefix(wizard), libraryPrefix(template));
  });

  it("declares five ordered onboarding stages", async () => {
    const wizard = await readFile(wizardPath, "utf8");
    assert.match(wizard, /^TOTAL_STAGES=5$/m);
    const stages = [...wizard.matchAll(/^stage "([^"]+)"$/gm)].map((match) => match[1]);
    assert.deepEqual(stages, [
      "Preflight / overlay reachability",
      "Hub-side preparation",
      "Enroll spoke SSH key",
      "Join the memory hub",
      "Verify the spoke",
    ]);
  });
});
