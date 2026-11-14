import { describe, expect, it } from "vitest";
import { isAllowedPanelCommand } from "../src/panel";

describe("isAllowedPanelCommand", () => {
  it.each([
    "omnicopilot.refreshModels",
    "omnicopilot.openDashboard",
    "omnicopilot.configureCliTool",
    "omnicopilot.installOmniRoute",
    "omnicopilot.openGitHub",
    "omnicopilot.openSettings",
  ])("accepts the panel command %s", (command) => {
    expect(isAllowedPanelCommand(command)).toBe(true);
  });

  it.each([
    "workbench.action.terminal.sendSequence",
    "omnicopilot.setApiKey",
    "omnicopilot.refreshModels ",
    "",
  ])("rejects %j", (command) => {
    expect(isAllowedPanelCommand(command)).toBe(false);
  });

  it.each([[undefined], [null], [42], [{}], [["omnicopilot.openGitHub"]]])(
    "rejects the non-string %j",
    (command) => {
      expect(isAllowedPanelCommand(command)).toBe(false);
    }
  );
});
