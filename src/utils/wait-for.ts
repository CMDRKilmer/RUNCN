import { sleep } from '@src/utils/sleep';

// Polls a condition until it holds or the timeout elapses. Returns whether the
// condition held.
export async function waitFor(
  condition: () => boolean,
  timeout = 5000,
  interval = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await sleep(interval);
  }
  return false;
}
