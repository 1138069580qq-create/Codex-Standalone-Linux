import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ConsoleError,
  defaultConfig,
  permissions,
  requireProject,
  validateConfig,
  type ConsoleConfig,
  type Project
} from "../src/backend/config";

function project(id: string, root: string, grants: Project["grants"] = []): Project {
  return { id, name: id, root, grants };
}

function config(projects: Project[], codexHome?: string): ConsoleConfig {
  const value = defaultConfig();
  return {
    ...value,
    enabled: true,
    transport: { ...value.transport, endpoint: "/tmp/test-codex.sock" },
    projects
  };
}

async function expectInvalid(value: unknown): Promise<void> {
  await assert.rejects(
    validateConfig(value),
    (error: unknown) =>
      error instanceof ConsoleError && error.status === 400 && error.code === "INVALID_CONFIG"
  );
}

test("ACL denies anonymous users, grants signed-in admins, and isolates project capabilities", () => {
  const shared = project("shared", "/workspace/shared", [
    { userId: "viewer", permissions: ["view"] },
    { userId: "sender", permissions: ["view", "send"] },
    { userId: "files-user", permissions: ["view", "files"] }
  ]);

  assert.deepEqual(permissions(shared, { uuid: "", elevated: false }), {
    view: false,
    send: false,
    approve: false,
    files: false
  });
  assert.deepEqual(permissions(shared, { uuid: "", elevated: true }), {
    view: false,
    send: false,
    approve: false,
    files: false
  });
  assert.throws(
    () => requireProject(config([shared]), { uuid: "", elevated: false }, "shared"),
    (error: unknown) => error instanceof ConsoleError && error.code === "PROJECT_FORBIDDEN"
  );

  assert.deepEqual(permissions(shared, { uuid: "admin", elevated: true }), {
    view: true,
    send: true,
    approve: true,
    files: true
  });
  assert.equal(
    requireProject(config([shared]), { uuid: "admin", elevated: true }, "shared", "files"),
    shared
  );

  assert.deepEqual(permissions(shared, { uuid: "viewer", elevated: false }), {
    view: true,
    send: false,
    approve: false,
    files: false
  });
  assert.equal(
    requireProject(config([shared]), { uuid: "viewer", elevated: false }, "shared", "view"),
    shared
  );
  assert.throws(
    () => requireProject(config([shared]), { uuid: "viewer", elevated: false }, "shared", "send"),
    (error: unknown) => error instanceof ConsoleError && error.code === "PROJECT_FORBIDDEN"
  );

  assert.deepEqual(permissions(shared, { uuid: "sender", elevated: false }), {
    view: true,
    send: true,
    approve: false,
    files: false
  });
  assert.throws(
    () => requireProject(config([shared]), { uuid: "sender", elevated: false }, "shared", "files"),
    (error: unknown) => error instanceof ConsoleError && error.code === "PROJECT_FORBIDDEN"
  );

  assert.deepEqual(permissions(shared, { uuid: "files-user", elevated: false }), {
    view: true,
    send: false,
    approve: false,
    files: true
  });
  assert.throws(
    () =>
      requireProject(config([shared]), { uuid: "files-user", elevated: false }, "shared", "send"),
    (error: unknown) => error instanceof ConsoleError && error.code === "PROJECT_FORBIDDEN"
  );
});

test("configuration rejects overlapping project roots and every Codex credential-root containment direction", async (t) => {
  const oldHome = process.env.CODEX_HOME;
  t.after(() => {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "elements-codex-config-"));
  const first = path.join(root, "first");
  const nested = path.join(first, "nested");
  const credentials = path.join(root, "credentials");
  const projectInsideCredentials = path.join(credentials, "project");
  const broaderProject = path.join(root, "broader-project");
  const credentialsInsideProject = path.join(broaderProject, ".codex-private");
  await Promise.all([
    mkdir(nested, { recursive: true }),
    mkdir(projectInsideCredentials, { recursive: true }),
    mkdir(credentialsInsideProject, { recursive: true })
  ]);

  await expectInvalid(config([project("first", first), project("nested", nested)]));

  process.env.CODEX_HOME = credentials;
  await expectInvalid(
    config([project("inside-credentials", projectInsideCredentials)], credentials)
  );

  process.env.CODEX_HOME = credentialsInsideProject;
  await expectInvalid(
    config([project("contains-credentials", broaderProject)], credentialsInsideProject)
  );
});
