// OpenCode TUI plugin: native /opencode-remote command — zero LLM turns.
// Registered by `openremote install` into ~/.config/opencode/opencode.json.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TuiPlugin, TuiCommand, TuiDialogStack } from "@opencode-ai/plugin/tui";

const CLI = join(homedir(), ".openremote", "bin", "openremote");

function run(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(CLI, args, { shell: false });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ ok: false, out: String(e) }));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim() }));
  });
}

const MENU: { label: string; args: string[] }[] = [
  { label: "▶  start worker", args: ["start"] },
  { label: "■  stop worker", args: ["stop"] },
  { label: "ⓘ  status", args: ["status"] },
  { label: "⚿  new pairing code", args: ["code"] },
  { label: "⟳  reinstall CLI", args: ["install"] },
];

export const tui: TuiPlugin = async (api) => {
  const register = api.command?.register;
  if (!register) return;

  register((): TuiCommand[] => [
    {
      title: "OpenRemote",
      value: "openremote",
      description: "remote bridge: start / stop / status / pairing (no LLM)",
      category: "openremote",
      slash: { name: "opencode-remote", aliases: ["or"] },
      onSelect: (dialog?: TuiDialogStack) => {
        if (!dialog) return;
        dialog.replace(
          () =>
            api.ui.DialogSelect<string>({
              title: "OpenRemote",
              placeholder: "pick an action…",
              options: MENU.map((m) => ({ title: m.label, value: m.args.join(" ") })),
              onSelect: async (opt) => {
                const args = opt.value.split(" ");
                dialog.clear();
                api.ui.toast({ variant: "info", title: "openremote", message: `running: openremote ${args[0]}…`, duration: 2500 });
                const { ok, out } = await run(args);
                api.ui.toast({
                  variant: ok ? "success" : "error",
                  title: `openremote ${args[0]}`,
                  message: out.split("\n").slice(0, 6).join(" · ") || (ok ? "done" : "failed"),
                  duration: args[0] === "code" || args[0] === "status" ? 12000 : 5000,
                });
              },
            }),
          () => {}
        );
      },
    },
  ]);
};

export default tui;
