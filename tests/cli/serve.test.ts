import { expect, test } from "bun:test";
import {
  isLoopbackHost,
  runServeCommand,
  parseServeArgs,
} from "../../src/cli/serve.ts";
import type { QuayRuntime } from "../../src/runtime/quay_runtime.ts";
import { bufferIO } from "../../src/cli/io.ts";

test("parseServeArgs accepts host and port flags", () => {
  expect(parseServeArgs(["--host", "localhost", "--port", "9732"])).toEqual({
    ok: true,
    hostname: "localhost",
    port: 9732,
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
