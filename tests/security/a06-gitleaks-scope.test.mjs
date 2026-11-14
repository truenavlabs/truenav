// A06: the allowlist for published attestation reports must not silence every rule in those files.
// A planted canary credential under an exempt fixture path must still be reported. The scan uses
// a temporary git repo and `gitleaks git`, because `gitleaks dir` reports absolute paths and the
// allowlist is anchored to the repository-relative path. Skips cleanly when the gitleaks binary
// is absent: CI installs gitleaks 8.30.1 only in the secrets job of .github/workflows/ci.yml, so
// this test is skipped in the npm test jobs and runs here when the binary is on PATH, in GITLEAKS,
// or at /tmp/gopath/bin/gitleaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, cpSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG = join(root, ".gitleaks.toml");
const FIXTURE = "tee/fixtures/attestation-report.json.b64";
const CANDIDATES = [process.env.GITLEAKS, "/tmp/gopath/bin/gitleaks", "gitleaks"].filter(Boolean);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "TrueNav Labs",
  GIT_AUTHOR_EMAIL: "dev@truenavlabs.invalid",
  GIT_COMMITTER_NAME: "TrueNav Labs",
  GIT_COMMITTER_EMAIL: "dev@truenavlabs.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function resolveGitleaks() {
  for (const c of CANDIDATES) {
    if (c.includes("/") && existsSync(c)) return c;
    const r = spawnSync(c, ["version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

function git(dir, args) {
  const r = spawnSync("git", ["-c", "user.name=TrueNav Labs", "-c", "user.email=dev@truenavlabs.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r;
}

const bin = resolveGitleaks();
const skip = bin ? false : "gitleaks binary is absent; CI installs it only in the secrets job";

// Assembled at runtime so this file itself is not a gitleaks hit. Clearly fake: AWS is AKIA plus A-P,
// GitHub is the ghp_ prefix plus a TESTCANARY marker and zeros.
const awsCanary = ["AKIA", "ABCD", "EFGH", "IJKL", "MNOP"].join("");
const githubCanary = ["ghp_", "TESTCANARYGITHUBTOKEN", "0".repeat(15)].join("");

test("A06: a planted canary in an exempt attestation fixture path is still reported", { skip }, () => {
  assert.ok(existsSync(CONFIG), ".gitleaks.toml is missing");
  assert.ok(existsSync(join(root, FIXTURE)), `${FIXTURE} is missing`);
  const dir = mkdtempSync(join(tmpdir(), "a06-gitleaks-"));
  try {
    const dest = join(dir, FIXTURE);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(root, FIXTURE), dest);
    appendFileSync(dest, `\n${awsCanary}\n${githubCanary}\n`);
    git(dir, ["init"]);
    git(dir, ["add", FIXTURE]);
    git(dir, ["commit", "-m", "a06 canary"]);
    const report = join(dir, "gitleaks-report.json");
    const r = spawnSync(bin, ["git", "--no-banner", "--log-opts=--all", "-c", CONFIG, "--report-format", "json", "--report-path", report, dir], { encoding: "utf8" });
    assert.ok(r.status === 0 || r.status === 1, `gitleaks failed (status ${r.status}): ${r.stderr || r.stdout}`);
    const raw = existsSync(report) ? readFileSync(report, "utf8").trim() : "";
    const findings = raw ? JSON.parse(raw) : [];
    assert.ok(Array.isArray(findings), "gitleaks report is not a JSON array");
    const secrets = findings.map((f) => f.Secret || "").join("\n");
    assert.match(secrets, new RegExp(awsCanary), `aws-access-token canary was not reported; findings: ${summarize(findings)}`);
    assert.match(secrets, new RegExp(githubCanary), `github-pat canary was not reported; findings: ${summarize(findings)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function summarize(findings) {
  if (!findings.length) return "(none)";
  return findings.map((f) => `${f.RuleID || "?"} ${f.File || ""}`).join("; ");
}
