// OpenCode TUI plugin: native /openremote slash command - zero LLM turns.
// Installed by `openremote install` as a SINGLE file into
// ~/.config/opencode/plugins/openremote-tui.js, so this module must stay
// self-contained: only node:* builtins, no relative imports.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TuiCommand, TuiDialogStack, TuiPluginApi } from "@opencode-ai/plugin/tui";

const HOME = join(homedir(), ".openremote");
const CLI = join(HOME, "bin", "openremote");
const STATE_FILE = join(HOME, "state.json");
const AUTH_FILE = join(homedir(), ".config", "openremote", "auth.json");
const TUI_SERVER_FILE = join(HOME, "tui-server.json");

type Status = {
  running: boolean;
  pid?: number | null;
  paired: boolean;
  serverUrl?: string | null;
  serverOk?: boolean;
  viewers?: number | null;
  sessions?: Array<{ id: string; title?: string | null; status: string }>;
  lastHeartbeat?: string | null;
  webUrl?: string;
  error?: string | null;
};

function readJson<T>(path: string): Partial<T> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Partial<T>;
  } catch {
    return null;
  }
}

function isPaired(): boolean {
  return Boolean(readJson<{ ownerId?: string }>(STATE_FILE)?.ownerId && existsSync(AUTH_FILE));
}

/**
 * The TUI owns this OpenCode server; hand its URL to the worker (state file +
 * env) so `openremote connect` never spawns a second, empty server.
 */
function serverUrlOf(api: TuiPluginApi): string | undefined {
  try {
    const holder = api.client as unknown as {
      client?: { getConfig?: () => { baseUrl?: string } };
    };
    const url = holder.client?.getConfig?.().baseUrl;
    return typeof url === "string" && url ? url.replace(/\/$/, "") : undefined;
  } catch {
    return undefined;
  }
}

function handOverServer(url: string | undefined): void {
  if (!url) return;
  try {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(TUI_SERVER_FILE, JSON.stringify({ url, at: Date.now() }), { mode: 0o600 });
  } catch {}
  process.env.OPENCODE_SERVER_URL = url;
}

function run(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    if (!existsSync(CLI)) {
      resolve({
        ok: false,
        out: `CLI not installed - run \`openremote install\` in the repo first (${CLI}).`,
      });
      return;
    }
    let out = "";
    const child = spawn(CLI, args, { shell: false });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ ok: false, out: String(e) }));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim() }));
  });
}

async function fetchStatus(): Promise<Status | null> {
  const { ok, out } = await run(["status", "--json"]);
  if (!ok && !out.trim()) return null;
  const start = out.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(out.slice(start)) as Status;
  } catch {
    return null;
  }
}

function summarize(s: Status | null): string {
  if (!s) return "could not read status - is `openremote install` up to date?";
  const sessions = s.sessions ?? [];
  const viewers = s.viewers ?? 0;
  const lines = [
    `worker:     ${s.running ? `running (pid ${s.pid ?? "?"})` : "stopped"}`,
    `opencode:   ${
      s.serverOk ? `✓ ${s.serverUrl}` : s.serverUrl ? `✗ ${s.serverUrl} unreachable` : "not reachable"
    }`,
    `phone:      ${viewers} linked`,
    `sessions:   ${sessions.length}${sessions.length >= 10 ? "+" : ""}`,
  ];
  if (s.error) lines.push(`error:      ${s.error}`);
  if (!s.paired) lines.push("", "not paired with Supabase yet - start the worker first.");
  return lines.join("\n");
}

const tui = async (api: TuiPluginApi) => {
  const register = api.command?.register;
  if (register) {
    register((): TuiCommand[] => [
      {
        title: "OpenRemote",
        value: "openremote",
        description: "remote bridge: status, start/stop, pairing (no LLM)",
        category: "openremote",
        slash: { name: "openremote", aliases: ["or", "opencode-remote"] },
        onSelect: (dialog?: TuiDialogStack) => {
          if (!dialog) return;
          void openMenu(api, dialog);
        },
      },
    ]);
  }
  // OpenCode's server-side loader expects the default export object's hooks.
  return {};
};

async function openMenu(api: TuiPluginApi, dialog: TuiDialogStack, bootstrapped = false): Promise<void> {
  handOverServer(serverUrlOf(api));

  let status = await fetchStatus();

  // If worker not running or not paired, start it!
  if (!status?.running || !isPaired()) {
    api.ui.toast({ variant: "info", title: "openremote", message: "starting bridge worker…" });
    const { ok, out } = await run(["connect"]);
    if (!ok) {
      api.ui.toast({
        variant: "error",
        title: "openremote connect",
        message: out.split("\n").slice(0, 4).join(" · ") || "worker failed to start",
        duration: 8000,
      });
    }
    status = await fetchStatus();
  }

  // When no phone is linked yet (or on initial launch), immediately provide pairing code!
  if (!bootstrapped && (!status?.viewers || status.viewers === 0)) {
    const { ok, out } = await run(["code"]);
    if (ok) {
      const webUrl = readJson<{ webUrl?: string }>(STATE_FILE)?.webUrl ?? "https://openremote-link.vercel.app";
      dialog.replace(() =>
        api.ui.DialogAlert({
          title: "OpenRemote · Pairing Code",
          message: `${out}\n\nEnter it on your phone:\n${webUrl}`,
          onConfirm: () => void openMenu(api, dialog, true),
        })
      );
      return;
    }
  }

  const options: Array<{ title: string; value: string; description?: string }> = [
    {
      title: "⚿  new pairing code",
      value: "code",
      description: "single use, valid 10 minutes",
    },
    status?.running
      ? { title: "■  stop worker", value: "stop", description: "machine goes offline" }
      : { title: "▶  start worker", value: "connect", description: "expose sessions to the web app" },
  ];
  if ((status?.viewers ?? 0) > 0) {
    options.push({ title: "✂  unlink all phones", value: "unlink" });
  }

  dialog.replace(() =>
    api.ui.DialogSelect<string>({
      title: summarize(status),
      placeholder: "pick an action…",
      options,
      onSelect: (opt) => void runAction(api, dialog, opt.value, bootstrapped),
    })
  );
}

async function runAction(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  action: string,
  bootstrapped: boolean
): Promise<void> {
  const { ok, out } = await run(action.split(" "));

  if (action === "code") {
    if (ok) {
      const webUrl = readJson<{ webUrl?: string }>(STATE_FILE)?.webUrl ?? "https://openremote-link.vercel.app";
      dialog.replace(() =>
        api.ui.DialogAlert({
          title: "OpenRemote · Pairing Code",
          message: `${out}\n\nEnter it on your phone:\n${webUrl}`,
          onConfirm: () => void openMenu(api, dialog, true),
        })
      );
      return;
    }
  }

  api.ui.toast({
    variant: ok ? "success" : "error",
    title: `openremote ${action}`,
    message: out.split("\n").slice(0, 6).join(" · ") || (ok ? "done" : "failed"),
    duration: ok ? 5000 : 8000,
  });
  if (ok) await openMenu(api, dialog, bootstrapped || action === "connect");
  else await openMenu(api, dialog, bootstrapped);
}

export default { id: "openremote", tui };
