import { expect, test } from "bun:test";
import {
  isLoopbackHost,
  runServeCommand,
  parseServeArgs,
  validateUiDir,
} from "../../src/cli/serve.ts";
import type { QuayRuntime } from "../../src/runtime/quay_runtime.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parseServeArgs accepts host and port flags", () => {
  expect(parseServeArgs(["--host", "localhost", "--port", "9732"])).toEqual({
    ok: true,
    hostname: "localhost",
    port: 9732,
    uiDir: null,
  });
  expect(parseServeArgs(["--ui-dir", "../quay-ui/dist"])).toEqual({
    ok: true,
    hostname: "127.0.0.1",
    port: 9731,
    uiDir: "../quay-ui/dist",
  });
  expect(parseServeArgs(["--ui-dir=../quay-ui/dist"])).toEqual({
    ok: true,
    hostname: "127.0.0.1",
    port: 9731,
    uiDir: "../quay-ui/dist",
  });
  expect(parseServeArgs(["--port=70000"])).toEqual({
    ok: false,
    message: "--port must be an integer from 1 to 65535",
  });
  expect(parseServeArgs(["--port=0"])).toEqual({
    ok: false,
    message: "--port must be an integer from 1 to 65535",
  });
  expect(parseServeArgs(["--host", "0.0.0.0"])).toEqual({
    ok: false,
    message: "--host must be a loopback address: 127.0.0.1, ::1, or localhost",
  });
  expect(parseServeArgs(["--ui-dir"])).toEqual({
    ok: false,
    message: "--ui-dir requires a value",
  });
});

test("isLoopbackHost accepts loopback hosts and rejects network binds", () => {
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost("127.10.20.30")).toBe(true);
  expect(isLoopbackHost("localhost")).toBe(true);
  expect(isLoopbackHost("::1")).toBe(true);
  expect(isLoopbackHost("0.0.0.0")).toBe(false);
  expect(isLoopbackHost("192.168.1.5")).toBe(false);
});

test("runServeCommand starts server and stops it after shutdown", async () => {
  const io = bufferIO();
  let stopped = false;
  const exitCode = await runServeCommand(
    ["--host", "127.0.0.1", "--port", "9732"],
    {} as QuayRuntime,
    io,
    {
      waitForShutdown: async () => {},
      startServer: ({ hostname, port }) => ({
        hostname,
        port,
        url: `http://${hostname}:${port}`,
        server: {} as ReturnType<typeof Bun.serve>,
        stop: () => {
          stopped = true;
        },
      }),
    },
  );

  expect(exitCode).toBe(0);
  expect(stopped).toBe(true);
  expect(JSON.parse(io.out())).toEqual({
    listening: true,
    url: "http://127.0.0.1:9732",
    host: "127.0.0.1",
    port: 9732,
    api_version: "v1",
  });
});

test("runServeCommand validates ui dir and passes resolved path to server", async () => {
  const uiDir = makeUiDir();
  try {
    const io = bufferIO();
    let receivedUiDir: string | null | undefined;
    const exitCode = await runServeCommand(
      ["--ui-dir", uiDir],
      {} as QuayRuntime,
      io,
      {
        waitForShutdown: async () => {},
        startServer: ({ hostname, port, uiDir }) => {
          receivedUiDir = uiDir;
          return {
            hostname,
            port,
            url: `http://${hostname}:${port}`,
            server: {} as ReturnType<typeof Bun.serve>,
            stop: () => {},
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(receivedUiDir).toBe(uiDir);
    expect(JSON.parse(io.out())).toMatchObject({
      listening: true,
      ui_dir: uiDir,
    });
  } finally {
    rmSync(uiDir, { recursive: true, force: true });
  }
});

test("runServeCommand rejects invalid ui dir before starting server", async () => {
  const uiDir = mkdtempSync(join(tmpdir(), "quay-ui-empty-"));
  try {
    const io = bufferIO();
    const exitCode = await runServeCommand(
      ["--ui-dir", uiDir],
      {} as QuayRuntime,
      io,
      {
        waitForShutdown: async () => {},
        startServer: () => {
          throw new Error("server should not start");
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(io.out()).toBe("");
    expect(JSON.parse(io.err())).toEqual({
      error: "startup_error",
      message: `--ui-dir must contain index.html: ${join(uiDir, "index.html")}`,
    });
  } finally {
    rmSync(uiDir, { recursive: true, force: true });
  }
});

test("validateUiDir rejects missing and non-directory paths clearly", () => {
  const root = mkdtempSync(join(tmpdir(), "quay-ui-invalid-"));
  try {
    const filePath = join(root, "asset.txt");
    writeFileSync(filePath, "not a directory");

    expect(validateUiDir(join(root, "missing"))).toEqual({
      ok: false,
      message: `--ui-dir path does not exist: ${join(root, "missing")}`,
    });
    expect(validateUiDir(filePath)).toEqual({
      ok: false,
      message: `--ui-dir must point to a directory: ${filePath}`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeUiDir(): string {
  const uiDir = mkdtempSync(join(tmpdir(), "quay-ui-dist-"));
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><div id=\"root\"></div>");
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log('quay');");
  return uiDir;
}
