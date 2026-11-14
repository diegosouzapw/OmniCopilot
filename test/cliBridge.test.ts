import { describe, expect, it } from "vitest";
import { CLI_TOOLS, resolveCliCommand } from "../src/cliBridge";

const linux = { platform: "linux" as const };
const cmdExe = { platform: "win32" as const, shellPath: "C:\\Windows\\System32\\cmd.exe" };
const winPath = "C:\\Program Files (x86)\\nodejs\\omniroute.cmd";

describe("resolveCliCommand", () => {
  it.each([
    "omniroute",
    "npx omniroute",
    "/usr/local/bin/omniroute",
    "~/bin/omniroute",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\omniroute.cmd",
  ])("accepts %s and returns it unchanged", (value) => {
    expect(resolveCliCommand(value, linux)).toEqual({ ok: true, command: value });
    expect(resolveCliCommand(`  ${value}  `, cmdExe)).toEqual({ ok: true, command: value });
  });

  it("double-quotes a quoted executable path on cmd.exe, without the call operator", () => {
    expect(resolveCliCommand(`"${winPath}"`, cmdExe)).toEqual({
      ok: true,
      command: `"${winPath}"`,
    });
  });

  it.each(["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\Windows\\System32\\powershell.exe"])(
    "prefixes the call operator for PowerShell (%s)",
    (shellPath) => {
      expect(resolveCliCommand(`"${winPath}"`, { platform: "win32", shellPath })).toEqual({
        ok: true,
        command: `& "${winPath}"`,
      });
    }
  );

  it("single-quotes a quoted executable path on linux", () => {
    expect(resolveCliCommand("'/opt/my tools/omniroute'", linux)).toEqual({
      ok: true,
      command: "'/opt/my tools/omniroute'",
    });
  });

  it("re-quotes a path that was wrapped in the other quote character", () => {
    expect(resolveCliCommand('"/opt/my tools/omniroute"', linux)).toEqual({
      ok: true,
      command: "'/opt/my tools/omniroute'",
    });
  });

  it.each([
    "omniroute; curl x | sh",
    "omniroute && id",
    "`id`",
    "$(id)",
    "omniroute | tee",
    "a\nb",
    "omni'route",
    'omni"route',
    "omniroute > f",
    "",
    "   ",
    '"',
    winPath,
    "omniroute (x86)",
  ])("rejects %j", (value) => {
    expect(resolveCliCommand(value, linux)).toEqual({ ok: false });
    expect(resolveCliCommand(value, cmdExe)).toEqual({ ok: false });
  });

  it.each(["'", '"', "`", "$", ";", "&", "|", "<", ">", "\n"])(
    "rejects a quoted value whose inside holds %j",
    (bad) => {
      for (const quote of ['"', "'"]) {
        const value = `${quote}/opt/my${bad}tools/omniroute${quote}`;
        expect(resolveCliCommand(value, linux)).toEqual({ ok: false });
        expect(resolveCliCommand(value, cmdExe)).toEqual({ ok: false });
      }
    }
  );

  it("rejects a value with mismatched quotes", () => {
    expect(resolveCliCommand(`"/opt/omniroute'`, linux)).toEqual({ ok: false });
  });
});

describe("CLI_TOOLS", () => {
  it("lists the Gemini, Zed, WhyCodes and 5dive setups", () => {
    const subcommands = CLI_TOOLS.map((tool) => tool.subcommand);
    for (const sub of ["setup-gemini", "setup-zed", "setup-whycodes", "setup-5dive"]) {
      expect(subcommands).toContain(sub);
    }
  });

  it("gives every tool a unique id and a setup-* subcommand", () => {
    expect(new Set(CLI_TOOLS.map((tool) => tool.id)).size).toBe(CLI_TOOLS.length);
    for (const tool of CLI_TOOLS) expect(tool.subcommand).toMatch(/^setup-[a-z0-9]+$/);
  });
});
