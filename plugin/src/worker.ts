import { loadState } from "./config.js";
import { ensureAuth } from "./supabase.js";
import { detectServerUrl } from "./opencode.js";
import { registerSessions, handleEvent, deliverPrompts, markOffline, pumpEvents } from "./sync.js";
import { sweep } from "./cleanup.js";
import { writePid, clearPid, isRunning } from "./state.js";

const POLL_MS = 2500;
const SWEEP_MS = 60 * 60 * 1000;

async function main() {
  if (isRunning() && isRunning() !== process.pid) {
    console.error("openremote worker already running (pid %s)", isRunning());
    process.exit(1);
  }
  writePid();

  const stop = () => {
    clearPid();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  let state = await ensureAuth(loadState());
  const sb = state.client;
  const serverUrl = await detectServerUrl(state.state.serverUrl);

  const activeIds = new Set<string>();
  const sessions = await registerSessions(sb, state.state, serverUrl);
  for (const s of sessions) activeIds.add(s.id);
  console.log(`openremote worker up → ${serverUrl} | sessions: ${[...activeIds].join(", ")}`);

  let lastSweep = 0;

  const loop = (async () => {
    for await (const ev of pumpEvents(serverUrl)) {
      try {
        await handleEvent(sb, state.state, ev, activeIds);
      } catch (e) {
        console.error("handleEvent:", e);
      }
    }
  })().catch((e) => {
    console.error("event stream ended:", e);
    clearPid();
    process.exit(1);
  });

  setInterval(async () => {
    try {
      await deliverPrompts(sb, state.state, serverUrl, activeIds);
      if (Date.now() - lastSweep > SWEEP_MS) {
        lastSweep = Date.now();
        await sweep(sb, state.state, activeIds);
      }
    } catch (e) {
      console.error("poll:", e);
    }
  }, POLL_MS);

  await loop;
}

main().catch((e) => {
  console.error(e?.message ?? e);
  clearPid();
  process.exit(1);
});
