import { processDueRetries } from "./relayboard";

const RETRY_POLL_INTERVAL_MS = 1_000;

export async function runRetryWorkerCycle() {
  return processDueRetries();
}

export function createRetryWorker(
  runCycle: () => Promise<unknown> = runRetryWorkerCycle,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout
) {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    try {
      await runCycle();
    } catch (error) {
      console.error("[Relayboard] Retry worker cycle failed", error);
    } finally {
      if (running) timer = schedule(() => void run(), RETRY_POLL_INTERVAL_MS);
    }
  };

  return {
    start() {
      if (running) return Promise.resolve();
      running = true;
      return run();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}

const persistentRetryWorker = createRetryWorker();

export function startRetryWorker() {
  void persistentRetryWorker.start();
}
