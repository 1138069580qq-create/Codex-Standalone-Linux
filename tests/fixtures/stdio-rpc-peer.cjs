"use strict";

// Test fixture only. stdout is deliberately reserved for newline-delimited
// JSON-RPC so it also catches accidental client assumptions about stderr.
const readline = require("node:readline");

const info = {
  userAgent: "codex-transport-stdio-fixture",
  codexHome: "/tmp/codex-fixture",
  platformFamily: "unix",
  platformOs: "linux"
};

let initialized = false;
let initializeParams;
let deferredRequestId;
let neverCount = 0;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exitCode = 2;
    return;
  }

  if (message && typeof message.method === "string") {
    if (message.method === "initialize") {
      initializeParams = message.params;
      write({ id: message.id, result: info });
      return;
    }
    if (message.method === "initialized") {
      initialized = true;
      write({ method: "fixture/handshake", params: {
        initialized: true,
        experimentalApi: initializeParams?.capabilities?.experimentalApi === true
      } });
      return;
    }
    if (message.method === "fixture/echo") {
      write({ id: message.id, result: { initialized, value: message.params } });
      return;
    }
    if (message.method === "fixture/server-request") {
      deferredRequestId = message.id;
      write({ id: "fixture-server-request", method: "fixture/approval", params: { question: "continue?" } });
      return;
    }
    if (message.method === "fixture/notify") {
      write({ method: "fixture/notification-observed", params: message.params });
      return;
    }
    if (message.method === "fixture/never") {
      neverCount += 1;
      write({ method: "fixture/never-observed", params: { count: neverCount } });
      return;
    }
    if (message.method === "fixture/disconnect") {
      setImmediate(() => process.exit(0));
      return;
    }
    if (message.method === "fixture/oversize") {
      write({ method: "fixture/large", params: { data: "x".repeat(2048) } });
      return;
    }
    write({ id: message.id, error: { code: -32601, message: "unknown fixture method" } });
    return;
  }

  if (message && message.id === "fixture-server-request" && deferredRequestId !== undefined) {
    const originalId = deferredRequestId;
    deferredRequestId = undefined;
    if (message.error) write({ id: originalId, error: message.error });
    else write({ id: originalId, result: { serverResponse: message.result } });
  }
});
