import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { PID_FILE, ensureHome } from "./config.js";

export function isRunning(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    try { unlinkSync(PID_FILE); } catch {}
    return null;
  }
}

export function writePid(): void {
  ensureHome();
  writeFileSync(PID_FILE, String(process.pid));
}

export function clearPid(): void {
  try { unlinkSync(PID_FILE); } catch {}
}

export function stopWorker(): boolean {
  const pid = isRunning();
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  return true;
}
