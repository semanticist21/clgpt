import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { updateInstall } from "../src/cli"

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString())
  }
  return result.stdout.toString().trim()
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clgpt-update-test-"))
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const active = join(root, "active")
  const bin = join(root, "bin")
  git(root, "init", "--bare", remote)
  git(root, "init", "-b", "main", work)
  git(work, "config", "user.email", "test@example.com")
  git(work, "config", "user.name", "clgpt test")
  await writeRelease(work, "old")
  git(work, "add", ".")
  git(work, "commit", "-m", "old")
  git(work, "remote", "add", "origin", remote)
  git(work, "push", "-u", "origin", "main")
  git(root, "clone", remote, active)
  return { root, remote, work, active, bin }
}

async function writeRelease(work: string, marker: string) {
  await mkdir(join(work, "src"), { recursive: true })
  await mkdir(join(work, "scripts"), { recursive: true })
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({ name: "clgpt", version: "1.0.0" }) + "\n",
  )
  await writeFile(join(work, "src", "marker.txt"), marker + "\n")
  await writeFile(join(work, "src", "cli.ts"), 'console.log("fixture")\n')
  const launcher = await readFile(join(import.meta.dir, "..", "scripts", "write-launcher.sh"), "utf8")
  await writeFile(
    join(work, "scripts", "write-launcher.sh"),
    launcher,
    { mode: 0o755 },
  )
}

async function publishUpdate(work: string) {
  git(work, "add", ".")
  git(work, "commit", "-m", "new")
  git(work, "push", "origin", "main")
}

describe("updateInstall", () => {
  test("installs and activates only the verified staged revision", async () => {
    const f = await fixture()
    try {
      await writeRelease(f.work, "new")
      await publishUpdate(f.work)
      await updateInstall(f.active, f.bin, f.remote)

      expect((await readFile(join(f.active, "src", "marker.txt"), "utf8")).trim()).toBe("new")
      expect((await readFile(join(f.active + ".previous", "src", "marker.txt"), "utf8")).trim()).toBe("old")
      const launcher = await readFile(join(f.bin, "clgpt"), "utf8")
      expect(launcher).toContain(`CLGPT_BIN_DIR=${f.bin}`)
      expect(launcher).toContain("CLGPT_BUN_BIN=")
      expect(launcher).toContain("run --no-install")
      expect(existsSync(join(f.bin, "clgpt"))).toBe(true)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  test("leaves the live revision untouched when dependency install fails", async () => {
    const f = await fixture()
    const failingBun = join(f.root, "bun-fails")
    try {
      await writeRelease(f.work, "new")
      await publishUpdate(f.work)
      await writeFile(
        failingBun,
        '#!/bin/sh\necho "simulated install failure" >&2\nexit 42\n',
        { mode: 0o755 },
      )
      const oldHead = git(f.active, "rev-parse", "HEAD")

      await expect(updateInstall(f.active, f.bin, f.remote, failingBun)).rejects.toThrow(
        /previous revision is still active/,
      )
      expect(git(f.active, "rev-parse", "HEAD")).toBe(oldHead)
      expect((await readFile(join(f.active, "src", "marker.txt"), "utf8")).trim()).toBe("old")
      expect(existsSync(f.active + ".previous")).toBe(false)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
