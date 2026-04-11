import { beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const accessMock = vi.fn();
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = resolve(testDir, "..", "..");

vi.mock("node:fs/promises", () => ({
  access: accessMock,
}));

describe("studio runtime resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("prefers the repository-local tsx loader for monorepo sources", async () => {
    const studioSourcePath = join("/repo", "packages", "studio", "src", "api", "index.ts");
    const tsxLoaderPath = join("/repo", "packages", "studio", "node_modules", "tsx", "dist", "loader.mjs");
    
    accessMock.mockImplementation(async (path: string) => {
      if (
        path === studioSourcePath ||
        path === tsxLoaderPath
      ) {
        return;
      }
      throw new Error(`missing: ${path}`);
    });

    const { resolveStudioLaunch } = await import("../commands/studio.js");
    const launch = await resolveStudioLaunch("/repo/test-project");

    expect(launch).toEqual({
      studioEntry: studioSourcePath,
      command: "node",
      args: [
        "--import",
        tsxLoaderPath,
        studioSourcePath,
        "/repo/test-project",
      ],
    });
  });

  it("finds monorepo packages/studio sources from a project directory", async () => {
    const studioSourcePath = join("/repo", "packages", "studio", "src", "api", "index.ts");
    
    accessMock.mockImplementation(async (path: string) => {
      if (path === studioSourcePath) {
        return;
      }
      throw new Error(`missing: ${path}`);
    });

    const { resolveStudioLaunch } = await import("../commands/studio.js");
    const launch = await resolveStudioLaunch("/repo/test-project");

    expect(launch).toEqual({
      studioEntry: studioSourcePath,
      command: "npx",
      args: ["tsx", studioSourcePath, "/repo/test-project"],
    });
  });

  it("uses node for built JavaScript entries", async () => {
    const builtEntryPath = join("/repo", "test-project", "node_modules", "@actalk", "inkos-studio", "dist", "api", "index.js");
    
    accessMock.mockImplementation(async (path: string) => {
      if (path === builtEntryPath) {
        return;
      }
      throw new Error(`missing: ${path}`);
    });

    const { resolveStudioLaunch } = await import("../commands/studio.js");
    const launch = await resolveStudioLaunch("/repo/test-project");

    expect(launch).toEqual({
      studioEntry: builtEntryPath,
      command: "node",
      args: [builtEntryPath, "/repo/test-project"],
    });
  });

  it("falls back to the CLI installation's bundled studio runtime", async () => {
    const bundledStudioPath = join(cliPackageRoot, "node_modules", "@actalk", "inkos-studio", "dist", "api", "index.js");
    
    accessMock.mockImplementation(async (path: string) => {
      if (path === bundledStudioPath) {
        return;
      }
      throw new Error(`missing: ${path}`);
    });

    const { resolveStudioLaunch } = await import("../commands/studio.js");
    const launch = await resolveStudioLaunch("/repo/test-project");

    expect(launch).toEqual({
      studioEntry: bundledStudioPath,
      command: "node",
      args: [bundledStudioPath, "/repo/test-project"],
    });
  });

  it("returns a browser launch spec for macOS", async () => {
    const { resolveBrowserLaunch } = await import("../commands/studio.js");
    expect(resolveBrowserLaunch("darwin", "http://localhost:4567")).toEqual({
      command: "open",
      args: ["http://localhost:4567"],
    });
  });

  it("returns a browser launch spec for Windows", async () => {
    const { resolveBrowserLaunch } = await import("../commands/studio.js");
    expect(resolveBrowserLaunch("win32", "http://localhost:4567")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://localhost:4567"],
    });
  });

  it("returns a browser launch spec for Linux", async () => {
    const { resolveBrowserLaunch } = await import("../commands/studio.js");
    expect(resolveBrowserLaunch("linux", "http://localhost:4567")).toEqual({
      command: "xdg-open",
      args: ["http://localhost:4567"],
    });
  });
});
