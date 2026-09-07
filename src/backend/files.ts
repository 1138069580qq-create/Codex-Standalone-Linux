import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  open as openFd,
  close as closeFd,
  fstat as statFd,
  constants as fsConstants,
  createReadStream,
  promises as fs,
  type Stats
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { ConsoleError } from "./config";

const MAX_LIST_ENTRIES = 500;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_RELATIVE_PATH_CHARS = 4096;
const UPLOAD_DIRECTORY = ".codex-uploads";
const MAX_UPLOAD_NAME_CHARS = 120;
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_UPLOAD_BYTES / 3);

type ProjectEntry = { name: string; path: string; type: "file" | "directory"; size: number };
type SafeRelativePath = { relative: string; segments: string[] };
type ResolvedProjectPath = SafeRelativePath & {
  root: string;
  path: string;
  realPath: string;
  stat: Stats;
};
type GitExecution = { stdout: Buffer; overflow: boolean };

function fail(status: number, code: string, message: string): never {
  throw new ConsoleError(status, code, message);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function privateComponent(component: string): boolean {
  const value = component.toLowerCase();
  return (
    value === ".git" ||
    value === ".ssh" ||
    value === ".codex" ||
    value.startsWith(".env") ||
    value === "auth.json"
  );
}

function parseRelativePath(value: unknown, allowRoot: boolean): SafeRelativePath {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RELATIVE_PATH_CHARS ||
    value.includes("\0")
  ) {
    fail(400, "INVALID_PATH", "A non-empty relative project path is required.");
  }
  if (isAbsolutePath(value)) fail(400, "INVALID_PATH", "Project paths must be relative.");

  const rawSegments = value.replace(/\\/g, "/").split("/");
  if (rawSegments.some((part) => part === ".."))
    fail(400, "INVALID_PATH", "Project paths cannot contain parent traversal.");
  if (rawSegments.some((part) => part.includes(":")))
    fail(400, "INVALID_PATH", "Project paths cannot contain drive or stream syntax.");

  const segments = rawSegments.filter((part) => part.length > 0 && part !== ".");
  if (segments.some(privateComponent))
    fail(403, "PATH_FORBIDDEN", "This project path is not available through Codex.");
  if (!allowRoot && segments.length === 0) fail(400, "INVALID_PATH", "A file path is required.");
  return { relative: segments.length === 0 ? "." : segments.join("/"), segments };
}

function filesystemFailure(error: unknown, action: string): never {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR")
    fail(404, "FILE_NOT_FOUND", "The requested project path was not found.");
  if (code === "EACCES" || code === "EPERM")
    fail(403, "PATH_FORBIDDEN", "The requested project path is not accessible.");
  if (code === "ELOOP")
    fail(403, "PATH_FORBIDDEN", "Symbolic links are not permitted for project file operations.");
  fail(500, "FILE_OPERATION_FAILED", `Unable to ${action} the requested project path.`);
}

async function canonicalProjectRoot(root: string): Promise<string> {
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.includes("\0") ||
    !isAbsolutePath(root)
  ) {
    fail(400, "INVALID_ROOT", "A valid absolute project root is required.");
  }

  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    fail(400, "INVALID_ROOT", "The configured project root is unavailable.");
  }

  try {
    const stat = await fs.stat(realRoot);
    if (!stat.isDirectory())
      fail(400, "INVALID_ROOT", "The configured project root is not a directory.");
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    fail(400, "INVALID_ROOT", "The configured project root is unavailable.");
  }
  return realRoot;
}

function absoluteProjectPath(root: string, safePath: SafeRelativePath): string {
  const target = safePath.segments.length === 0 ? root : path.join(root, ...safePath.segments);
  if (!isWithin(root, target))
    fail(403, "PATH_FORBIDDEN", "The requested path escapes the project root.");
  return target;
}

async function assertNoSymlinkComponents(root: string, segments: readonly string[]): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      filesystemFailure(error, "inspect");
    }
    if (stat.isSymbolicLink())
      fail(403, "PATH_FORBIDDEN", "Symbolic links are not permitted for project file operations.");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev || left.ino !== right.ino) return false;
  // Some Windows/network filesystems do not expose stable inode values. In that case,
  // retain additional metadata checks instead of treating every zero inode as identical.
  if (left.dev !== 0 || left.ino !== 0) return true;
  return (
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
  );
}

async function resolveExistingPath(
  rootInput: string,
  relativePath: string,
  allowRoot = false
): Promise<ResolvedProjectPath> {
  const root = await canonicalProjectRoot(rootInput);
  const safePath = parseRelativePath(relativePath, allowRoot);
  const target = absoluteProjectPath(root, safePath);

  let before: Stats;
  try {
    before = await fs.lstat(target);
  } catch (error) {
    filesystemFailure(error, "inspect");
  }
  if (before.isSymbolicLink())
    fail(403, "PATH_FORBIDDEN", "Symbolic links are not permitted for project file operations.");

  await assertNoSymlinkComponents(root, safePath.segments);

  let realPath: string;
  try {
    realPath = await fs.realpath(target);
  } catch (error) {
    filesystemFailure(error, "resolve");
  }
  if (!isWithin(root, realPath))
    fail(403, "PATH_FORBIDDEN", "The requested path escapes the project root.");

  let after: Stats;
  try {
    after = await fs.lstat(target);
  } catch (error) {
    filesystemFailure(error, "inspect");
  }
  if (after.isSymbolicLink() || !sameFile(before, after))
    fail(409, "PATH_CHANGED", "The requested project path changed while it was being verified.");

  return { root, path: target, realPath, stat: after, ...safePath };
}

function noFollowFlag(): number {
  const value = (fsConstants as unknown as Record<string, number | undefined>).O_NOFOLLOW;
  return typeof value === "number" ? value : 0;
}

async function verifyOpenFile(
  resolved: ResolvedProjectPath,
  handleStat: Stats,
  maxSize: number
): Promise<void> {
  if (!handleStat.isFile()) fail(400, "NOT_A_FILE", "Only regular files can be downloaded.");
  if (handleStat.size > maxSize)
    fail(413, "FILE_TOO_LARGE", "The requested file exceeds the download size limit.");

  await assertNoSymlinkComponents(resolved.root, resolved.segments);

  let current: Stats;
  let realPath: string;
  try {
    current = await fs.lstat(resolved.path);
    realPath = await fs.realpath(resolved.path);
  } catch (error) {
    filesystemFailure(error, "verify");
  }
  if (
    current.isSymbolicLink() ||
    !sameFile(current, handleStat) ||
    !isWithin(resolved.root, realPath)
  ) {
    fail(409, "PATH_CHANGED", "The requested project path changed while it was being opened.");
  }
}

function readableName(safePath: SafeRelativePath): string {
  const name = safePath.segments[safePath.segments.length - 1];
  if (!name) fail(400, "INVALID_PATH", "A file path is required.");
  return name;
}

export async function listProjectFiles(
  root: string,
  relativePath = "."
): Promise<{ entries: ProjectEntry[] }> {
  const resolved = await resolveExistingPath(root, relativePath, true);
  if (!resolved.stat.isDirectory())
    fail(400, "NOT_A_DIRECTORY", "The requested project path is not a directory.");

  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(resolved.path);
  } catch (error) {
    filesystemFailure(error, "list");
  }

  const entries: ProjectEntry[] = [];
  try {
    for await (const item of directory) {
      if (entries.length >= MAX_LIST_ENTRIES) break;
      const childSegments = [...resolved.segments, item.name];
      if (childSegments.some(privateComponent)) continue;

      const child = path.join(resolved.path, item.name);
      let stat: Stats;
      try {
        stat = await fs.lstat(child);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
        const realPath = await fs.realpath(child);
        if (!isWithin(resolved.root, realPath)) continue;
      } catch {
        // A concurrent rename/removal must not make directory enumeration fail.
        continue;
      }

      entries.push({
        name: item.name,
        path: [...childSegments].join("/"),
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.isDirectory() ? 0 : stat.size
      });
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  return { entries };
}

export async function openProjectDownload(
  root: string,
  relativePath: string
): Promise<{ stream: Readable; name: string; size: number }> {
  const resolved = await resolveExistingPath(root, relativePath);
  if (!resolved.stat.isFile()) fail(400, "NOT_A_FILE", "Only regular files can be downloaded.");
  if (resolved.stat.size > MAX_DOWNLOAD_BYTES)
    fail(413, "FILE_TOO_LARGE", "The requested file exceeds the download size limit.");
  let fd: number | undefined;
  const close = (descriptor: number) =>
    new Promise<void>((resolve) => closeFd(descriptor, () => resolve()));
  try {
    // A numeric descriptor has exactly one owner. Do not combine FileHandle GC
    // ownership with Koa's ReadStream auto-destroy/auto-close lifecycle.
    fd = await new Promise<number>((resolve, reject) =>
      openFd(resolved.path, fsConstants.O_RDONLY | noFollowFlag(), (error, descriptor) =>
        error ? reject(error) : resolve(descriptor)
      )
    );
    const stat = await new Promise<Stats>((resolve, reject) =>
      statFd(fd!, (error, value) => (error ? reject(error) : resolve(value)))
    );
    await verifyOpenFile(resolved, stat, MAX_DOWNLOAD_BYTES);
    if (stat.size === 0) {
      await close(fd);
      fd = undefined;
      return { stream: Readable.from([]), name: readableName(resolved), size: 0 };
    }
    const stream = createReadStream(resolved.path, {
      fd,
      autoClose: true,
      start: 0,
      end: stat.size - 1
    });
    fd = undefined; // ownership transfers to ReadStream, including disconnects
    return { stream, name: readableName(resolved), size: stat.size };
  } catch (error) {
    if (fd !== undefined) await close(fd);
    if (error instanceof ConsoleError) throw error;
    filesystemFailure(error, "open");
  }
}

function base64Value(charCode: number): number {
  if (charCode >= 65 && charCode <= 90) return charCode - 65;
  if (charCode >= 97 && charCode <= 122) return charCode - 71;
  if (charCode >= 48 && charCode <= 57) return charCode + 4;
  if (charCode === 43) return 62;
  if (charCode === 47) return 63;
  return -1;
}

function decodedBase64Size(value: string): number | undefined {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return undefined;
  let padding = 0;
  if (value.charCodeAt(value.length - 1) === 61) padding += 1;
  if (value.charCodeAt(value.length - 2) === 61) padding += 1;
  return (value.length / 4) * 3 - padding;
}

function isCanonicalBase64(value: string, decodedSize: number): boolean {
  if (value.length === 0) return decodedSize === 0;
  const padding = (value.length / 4) * 3 - decodedSize;
  if (padding < 0 || padding > 2) return false;
  const contentEnd = value.length - padding;
  if (contentEnd === 0) return false;
  for (let index = 0; index < contentEnd; index += 1) {
    if (base64Value(value.charCodeAt(index)) < 0) return false;
  }
  for (let index = contentEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  const finalValue = base64Value(value.charCodeAt(contentEnd - 1));
  return (
    padding === 0 ||
    (padding === 1 && (finalValue & 0b11) === 0) ||
    (padding === 2 && (finalValue & 0b1111) === 0)
  );
}

function decodeBase64(base64: unknown): Buffer {
  if (typeof base64 !== "string")
    fail(400, "INVALID_UPLOAD", "Upload content must be canonical base64 data.");
  if (base64.length > MAX_BASE64_CHARS)
    fail(413, "UPLOAD_TOO_LARGE", "The decoded upload exceeds the 4 MiB limit.");
  const expectedSize = decodedBase64Size(base64);
  if (expectedSize === undefined)
    fail(400, "INVALID_UPLOAD", "Upload content must be canonical base64 data.");
  if (expectedSize > MAX_UPLOAD_BYTES)
    fail(413, "UPLOAD_TOO_LARGE", "The decoded upload exceeds the 4 MiB limit.");
  if (!isCanonicalBase64(base64, expectedSize))
    fail(400, "INVALID_UPLOAD", "Upload content must be canonical base64 data.");

  const data = Buffer.from(base64, "base64");
  if (data.length !== expectedSize || data.toString("base64") !== base64) {
    fail(400, "INVALID_UPLOAD", "Upload content must be canonical base64 data.");
  }
  return data;
}

function safeUploadName(name: unknown): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 255 ||
    name.includes("\0") ||
    isAbsolutePath(name) ||
    /[\\/:]/.test(name) ||
    name === "." ||
    name === ".."
  ) {
    fail(400, "INVALID_UPLOAD_NAME", "Upload names must be a single safe file name.");
  }

  const normalized = name
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, MAX_UPLOAD_NAME_CHARS);
  return normalized || "upload";
}

async function uploadDirectory(root: string): Promise<string> {
  const directory = path.join(root, UPLOAD_DIRECTORY);
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail(403, "PATH_FORBIDDEN", "The upload directory is not a safe project directory.");
    await assertNoSymlinkComponents(root, [UPLOAD_DIRECTORY]);
    const realPath = await fs.realpath(directory);
    if (!isWithin(root, realPath))
      fail(403, "PATH_FORBIDDEN", "The upload directory escapes the project root.");
    return directory;
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    filesystemFailure(error, "prepare upload");
  }
}

async function verifyUploadedHandle(
  root: string,
  destination: string,
  storedName: string,
  handleStat: Stats
): Promise<void> {
  if (!handleStat.isFile())
    fail(409, "PATH_CHANGED", "The upload destination is not a regular file.");
  await assertNoSymlinkComponents(root, [UPLOAD_DIRECTORY, storedName]);

  let current: Stats;
  let realPath: string;
  try {
    current = await fs.lstat(destination);
    realPath = await fs.realpath(destination);
  } catch (error) {
    filesystemFailure(error, "verify upload");
  }
  if (current.isSymbolicLink() || !sameFile(current, handleStat) || !isWithin(root, realPath)) {
    fail(409, "PATH_CHANGED", "The upload destination changed while it was being opened.");
  }
}

export async function uploadProjectFile(
  root: string,
  name: string,
  base64: string
): Promise<{ path: string }> {
  const projectRoot = await canonicalProjectRoot(root);
  const data = decodeBase64(base64);
  const storedName = `${randomUUID()}-${safeUploadName(name)}`;
  const directory = await uploadDirectory(projectRoot);
  const destination = path.join(directory, storedName);

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    // O_CREAT | O_EXCL is the numeric equivalent of "wx"; it never overwrites
    // an existing path (including an existing symlink). The requested mode is 0600.
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag();
    handle = await fs.open(destination, flags, 0o600);
    await verifyUploadedHandle(projectRoot, destination, storedName, await handle.stat());
    await handle.writeFile(data);
    await handle.chmod(0o600);
    await handle.sync();
    await verifyUploadedHandle(projectRoot, destination, storedName, await handle.stat());
    return { path: `${UPLOAD_DIRECTORY}/${storedName}` };
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    if (errorCode(error) === "EEXIST")
      fail(409, "UPLOAD_CONFLICT", "A generated upload name already exists; retry the upload.");
    filesystemFailure(error, "write upload");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  fail(500, "FILE_OPERATION_FAILED", "Unable to write the uploaded project file.");
}

export async function attachmentPath(root: string, relativePath: string): Promise<string> {
  const safePath = parseRelativePath(relativePath, false);
  if (safePath.segments.length !== 2 || safePath.segments[0].toLowerCase() !== UPLOAD_DIRECTORY) {
    fail(
      403,
      "ATTACHMENT_FORBIDDEN",
      "Only files previously uploaded to .codex-uploads can be attached."
    );
  }

  const resolved = await resolveExistingPath(root, safePath.relative);
  if (!resolved.stat.isFile())
    fail(400, "NOT_A_FILE", "Only regular uploaded files can be attached.");
  if (resolved.stat.size > MAX_UPLOAD_BYTES)
    fail(413, "FILE_TOO_LARGE", "The uploaded attachment exceeds the 4 MiB limit.");
  return resolved.realPath;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "GIT_DIR" ||
      key === "GIT_WORK_TREE" ||
      key === "GIT_COMMON_DIR" ||
      key === "GIT_INDEX_FILE" ||
      key === "GIT_CONFIG_GLOBAL" ||
      key === "GIT_CONFIG_SYSTEM" ||
      key === "GIT_CONFIG_COUNT" ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_EXTERNAL_DIFF = "";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function asBuffer(value: Buffer | string | undefined): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value || "", "utf8");
}

function runGit(cwd: string, args: string[], maxBuffer: number): Promise<GitExecution> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        shell: false,
        windowsHide: true,
        timeout: 5_000,
        maxBuffer,
        encoding: "buffer",
        env: gitEnvironment()
      },
      (error, stdout, _stderr) => {
        const output = asBuffer(stdout as Buffer | string | undefined);
        if (!error) {
          resolve({ stdout: output, overflow: false });
          return;
        }
        if (errorCode(error) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ stdout: output.subarray(0, MAX_DIFF_BYTES), overflow: true });
          return;
        }
        reject(error);
      }
    );
  });
}

function gitFailure(error: unknown): never {
  const code = errorCode(error);
  if (code === "ENOENT")
    fail(
      503,
      "GIT_UNAVAILABLE",
      "Git is required for project diffs but is not available on this server."
    );
  if (
    code === "ETIMEDOUT" ||
    (typeof error === "object" && error !== null && (error as { killed?: unknown }).killed === true)
  ) {
    fail(504, "GIT_TIMEOUT", "Git diff exceeded the server time limit.");
  }
  fail(502, "GIT_DIFF_FAILED", "Git could not produce a read-only project diff.");
}

async function assertDiffPathSafe(root: string, safePath: SafeRelativePath): Promise<void> {
  if (safePath.segments.length === 0) return;
  const target = absoluteProjectPath(root, safePath);
  let stat: Stats;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    // A deleted tracked path has no working-tree entry but remains safe to pass as a git pathspec.
    if (errorCode(error) === "ENOENT") return;
    filesystemFailure(error, "inspect");
  }
  if (stat.isSymbolicLink())
    fail(403, "PATH_FORBIDDEN", "Symbolic links are not permitted for project file operations.");
  await assertNoSymlinkComponents(root, safePath.segments);
  try {
    const realPath = await fs.realpath(target);
    if (!isWithin(root, realPath))
      fail(403, "PATH_FORBIDDEN", "The requested path escapes the project root.");
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    filesystemFailure(error, "resolve");
  }
}

function defaultDiffExclusions(): string[] {
  const privateNames = [".git", ".ssh", ".codex", ".env", ".env.*", "auth.json"];
  const exclusions: string[] = [];
  for (const name of privateNames) {
    exclusions.push(
      `:(exclude)${name}`,
      `:(exclude)${name}/**`,
      `:(exclude)**/${name}`,
      `:(exclude)**/${name}/**`
    );
  }
  return exclusions;
}

export async function projectDiff(
  root: string,
  relativePath?: string
): Promise<{ text: string; truncated: boolean }> {
  const projectRoot = await canonicalProjectRoot(root);
  const safePath = relativePath === undefined ? undefined : parseRelativePath(relativePath, true);
  if (safePath) await assertDiffPathSafe(projectRoot, safePath);

  try {
    const probe = await runGit(
      projectRoot,
      ["--no-pager", "rev-parse", "--is-inside-work-tree"],
      4096
    );
    if (probe.overflow || probe.stdout.toString("utf8").trim() !== "true") {
      fail(409, "NOT_GIT_REPOSITORY", "Project diffs are available only for Git working trees.");
    }
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    if (errorCode(error) === "ENOENT") gitFailure(error);
    fail(409, "NOT_GIT_REPOSITORY", "Project diffs are available only for Git working trees.");
  }

  const paths =
    safePath && safePath.segments.length > 0
      ? [`:(literal)${safePath.relative}`, ...defaultDiffExclusions()]
      : [".", ...defaultDiffExclusions()];
  const args = [
    "--no-pager",
    "-c",
    "core.pager=cat",
    "-c",
    "diff.external=false",
    "-c",
    "pager.diff=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--",
    ...paths
  ];

  try {
    const result = await runGit(projectRoot, args, MAX_DIFF_BYTES);
    return {
      text: result.stdout.subarray(0, MAX_DIFF_BYTES).toString("utf8"),
      truncated: result.overflow
    };
  } catch (error) {
    gitFailure(error);
  }
}
