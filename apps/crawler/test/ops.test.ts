/**
 * Ops tests — spec 07 Scenario 7 (launchd plist + install/uninstall scripts).
 *
 * These shell out to `plutil` and `bash -n` and assert the exit codes and
 * extracted plist values. The plist under test is the committed TEMPLATE (with
 * valid placeholder values), so `plutil -lint` must pass BEFORE substitution.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const OPS = path.join(REPO_ROOT, "ops");
const PLIST = path.join(OPS, "com.jobscout.crawl.plist");

/** Run a command; resolve with { code, stdout, stderr } (never rejects). */
async function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("Scenario 7 — launchd plist is valid and correctly configured", () => {
  it("plutil -lint exits 0", async () => {
    const { code } = await run("plutil", ["-lint", PLIST]);
    expect(code).toBe(0);
  });

  it("Label extracts to com.jobscout.crawl", async () => {
    const { stdout } = await run("plutil", ["-extract", "Label", "raw", PLIST]);
    expect(stdout.trim()).toBe("com.jobscout.crawl");
  });

  it("StartInterval extracts to 10800 (3 hours)", async () => {
    const { stdout } = await run("plutil", ["-extract", "StartInterval", "raw", PLIST]);
    expect(stdout.trim()).toBe("10800");
  });

  it("RunAtLoad is true", async () => {
    const { stdout } = await run("plutil", ["-extract", "RunAtLoad", "raw", PLIST]);
    expect(stdout.trim()).toBe("true");
  });

  it("StandardOutPath and StandardErrorPath contain Library/Logs/jobscout/", async () => {
    const out = await run("plutil", ["-extract", "StandardOutPath", "raw", PLIST]);
    const err = await run("plutil", ["-extract", "StandardErrorPath", "raw", PLIST]);
    expect(out.stdout).toContain("Library/Logs/jobscout/");
    expect(err.stdout).toContain("Library/Logs/jobscout/");
  });

  it("ProgramArguments contains --trigger followed by launchd", async () => {
    // Extract the ProgramArguments array as XML to STDOUT (`-o -`); without
    // `-o -`, plutil -extract rewrites the source file in place.
    const { stdout } = await run("plutil", [
      "-extract",
      "ProgramArguments",
      "xml1",
      "-o",
      "-",
      PLIST,
    ]);
    const strings = [...stdout.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    const idx = strings.indexOf("--trigger");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(strings[idx + 1]).toBe("launchd");
  });

  it("install-launchd.sh and uninstall-launchd.sh pass bash -n", async () => {
    const install = await run("bash", ["-n", path.join(OPS, "install-launchd.sh")]);
    const uninstall = await run("bash", ["-n", path.join(OPS, "uninstall-launchd.sh")]);
    expect(install.code).toBe(0);
    expect(uninstall.code).toBe(0);
  });

  it("run-crawl.sh passes bash -n", async () => {
    const wrapper = await run("bash", ["-n", path.join(OPS, "run-crawl.sh")]);
    expect(wrapper.code).toBe(0);
  });
});
