import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../program.js";

describe("tui command", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("launches the TUI when no subcommand is provided", async () => {
    const launchTui = vi.fn(async () => {});
    const program = createProgram({ launchTui });

    await program.parseAsync([], { from: "user" });

    expect(launchTui).toHaveBeenCalledTimes(1);
  });

  it("launches the TUI when the explicit tui command is used", async () => {
    const launchTui = vi.fn(async () => {});
    const program = createProgram({ launchTui });

    await program.parseAsync(["tui"], { from: "user" });

    expect(launchTui).toHaveBeenCalledTimes(1);
  });
});
