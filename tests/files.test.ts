import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { ConsoleError } from "../src/backend/config";
import {
  attachmentPath,
  listProjectFiles,
  openProjectDownload,
  projectDiff,
  uploadProjectFile
} from "../src/backend/files";

const MIB = 1024 * 1024;

async function temporaryProject(): Promise<string> {
  // Intentionally leave fixtures in the OS temporary area: repository rules prohibit bulk deletion.
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-files-test-"));
}

async function writeFixture(
  root: string,
  relativePath: string,
  data: string | Buffer
): Promise<string> {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  return target;
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ConsoleError, `expected ConsoleError, received ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function streamBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function command(binary: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd, windowsHide: true }, (error) =>
      error ? reject(error) : resolve()
    );
  });
}

async function hasGit(): Promise<boolean> {
  try {
    await command("git", ["--version"], process.cwd());
    return true;
  } catch {
    return false;
  }
}

test("listProjectFiles exposes only safe entries and stops at 500 inspected entries", async () => {
  const root = await temporaryProject();
  await writeFixture(root, "visible.ts", "export const visible = true;\n");
  await writeFixture(root, "src/index.ts", "export {};\n");
  await writeFixture(root, ".git/config", "private\n");
  await writeFixture(root, ".ssh/id_ed25519", "private\n");
  await writeFixture(root, ".codex/config.toml", "private\n");
  await writeFixture(root, ".env", "TOKEN=secret\n");
  await writeFixture(root, ".env.local", "TOKEN=secret\n");
  await writeFixture(root, "auth.json", '{"token":"secret"}\n');

  const rootEntries = await listProjectFiles(root);
  const names = rootEntries.entries.map((entry) => entry.name);
  assert.ok(names.includes("visible.ts"));
  assert.ok(names.includes("src"));
  for (const forbidden of [".git", ".ssh", ".codex", ".env", ".env.local", "auth.json"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be enumerated`);
  }

  const sourceEntries = await listProjectFiles(root, "src");
  assert.deepEqual(sourceEntries.entries, [
    {
      name: "index.ts",
      path: "src/index.ts",
      type: "file",
      size: Buffer.byteLength("export {};\n")
    }
  ]);

  for (let index = 0; index < 505; index += 1) {
    await writeFixture(root, `many/${index.toString().padStart(3, "0")}.txt`, "x");
  }
  const bounded = await listProjectFiles(root, "many");
  assert.ok(bounded.entries.length <= 500);
});

test("rejects absolute, NUL, traversal, and private paths", async () => {
  const root = await temporaryProject();
  await writeFixture(root, "visible.txt", "ok");

  await expectCode(listProjectFiles(root, "../outside"), "INVALID_PATH");
  await expectCode(openProjectDownload(root, path.resolve(root, "visible.txt")), "INVALID_PATH");
  await expectCode(openProjectDownload(root, "visible.txt\0suffix"), "INVALID_PATH");
  await expectCode(listProjectFiles(root, ".git"), "PATH_FORBIDDEN");
  await expectCode(projectDiff(root, ".env"), "PATH_FORBIDDEN");
});

test("openProjectDownload yields a bounded node Readable for regular project files", async () => {
  const root = await temporaryProject();
  await writeFixture(root, "notes.txt", "download body");
  await fs.mkdir(path.join(root, "directory"));

  const download = await openProjectDownload(root, "notes.txt");
  assert.ok(download.stream instanceof Readable);
  assert.equal(download.name, "notes.txt");
  assert.equal(download.size, Buffer.byteLength("download body"));
  assert.equal((await streamBuffer(download.stream)).toString("utf8"), "download body");

  await expectCode(openProjectDownload(root, "directory"), "NOT_A_FILE");
  const large = await fs.open(path.join(root, "too-large.bin"), "w");
  try {
    await large.truncate(512 * MIB + 1);
  } finally {
    await large.close();
  }
  await expectCode(openProjectDownload(root, "too-large.bin"), "FILE_TOO_LARGE");
});

test("uploadProjectFile writes unique 0600 files and attachmentPath accepts only those uploads", async () => {
  const root = await temporaryProject();
  const body = Buffer.from("uploaded body\n");
  const uploaded = await uploadProjectFile(root, "report (final).txt", body.toString("base64"));

  assert.match(uploaded.path, /^\.codex-uploads\/[0-9a-f-]{36}-[A-Za-z0-9._-]+$/);
  const stored = path.join(root, ...uploaded.path.split("/"));
  const storedStat = await fs.lstat(stored);
  assert.ok(storedStat.isFile());
  assert.ok(!storedStat.isSymbolicLink());
  assert.equal((await fs.readFile(stored)).toString("utf8"), body.toString("utf8"));
  if (process.platform !== "win32") assert.equal(storedStat.mode & 0o777, 0o600);

  const absoluteAttachment = await attachmentPath(root, uploaded.path);
  assert.ok(path.isAbsolute(absoluteAttachment));
  assert.equal(absoluteAttachment, await fs.realpath(stored));
  await expectCode(attachmentPath(root, "visible.txt"), "ATTACHMENT_FORBIDDEN");
  await expectCode(attachmentPath(root, `${uploaded.path}/nested`), "ATTACHMENT_FORBIDDEN");
  await expectCode(uploadProjectFile(root, "bad.txt", "dXBsb2Fk\n"), "INVALID_UPLOAD");
  await expectCode(
    uploadProjectFile(root, "large.bin", Buffer.alloc(4 * MIB + 1).toString("base64")),
    "UPLOAD_TOO_LARGE"
  );
});

test("refuses symlink escape routes for listings, downloads, uploads, and attachments", async (t) => {
  const root = await temporaryProject();
  const outside = await temporaryProject();
  const secret = await writeFixture(outside, "secret.txt", "outside secret");

  try {
    await fs.symlink(secret, path.join(root, "escape.txt"));
    await fs.mkdir(path.join(root, ".codex-uploads"));
    await fs.symlink(secret, path.join(root, ".codex-uploads", "escape.txt"));
  } catch {
    t.skip("The current filesystem does not permit test symlinks.");
    return;
  }

  const listed = await listProjectFiles(root);
  assert.ok(!listed.entries.some((entry) => entry.name === "escape.txt"));
  await expectCode(openProjectDownload(root, "escape.txt"), "PATH_FORBIDDEN");
  await expectCode(attachmentPath(root, ".codex-uploads/escape.txt"), "PATH_FORBIDDEN");

  const uploadRoot = await temporaryProject();
  await fs.symlink(outside, path.join(uploadRoot, ".codex-uploads"), "dir");
  await expectCode(
    uploadProjectFile(uploadRoot, "blocked.txt", Buffer.from("x").toString("base64")),
    "PATH_FORBIDDEN"
  );
});

test("projectDiff is bounded, read-only, excludes private paths, and treats path names as pathspecs", async (t) => {
  if (!(await hasGit())) {
    t.skip("git is not installed on this test host.");
    return;
  }

  const nonGitRoot = await temporaryProject();
  await writeFixture(nonGitRoot, "file.txt", "not git\n");
  await expectCode(projectDiff(nonGitRoot), "NOT_GIT_REPOSITORY");

  const root = await temporaryProject();
  await command("git", ["init"], root);
  await command("git", ["config", "user.email", "files-test@example.invalid"], root);
  await command("git", ["config", "user.name", "Files Test"], root);
  await writeFixture(root, "public.txt", "before\n");
  await writeFixture(root, ".env", "secret before\n");
  await writeFixture(root, "--not-an-option.ts", "option before\n");
  await writeFixture(root, "large.txt", "");
  await command("git", ["add", "--", "."], root);
  await command("git", ["commit", "-m", "initial"], root);

  await writeFixture(root, "public.txt", "public changed\n");
  await writeFixture(root, ".env", "secret changed\n");
  await writeFixture(root, "--not-an-option.ts", "option changed\n");
  const normal = await projectDiff(root);
  assert.equal(normal.truncated, false);
  assert.match(normal.text, /public changed/);
  assert.doesNotMatch(normal.text, /secret changed|\.env/);

  const explicitRoot = await projectDiff(root, ".");
  assert.doesNotMatch(explicitRoot.text, /secret changed|\.env/);
  const optionPath = await projectDiff(root, "--not-an-option.ts");
  assert.match(optionPath.text, /option changed/);

  await writeFixture(root, "large.txt", "x".repeat(320 * 1024));
  const limited = await projectDiff(root, "large.txt");
  assert.equal(limited.truncated, true);
  assert.ok(Buffer.byteLength(limited.text, "utf8") <= 256 * 1024);
});
