/** Bounded polling; each query receives only the remaining time budget. */
export async function waitUntilRunning(check: (remainingMs: number) => Promise<boolean>, timeoutMs = 10000, intervalMs = 200): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check(Math.max(1, Math.ceil(deadline - performance.now())))) return;
    const remaining = deadline - performance.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  throw new Error('App process did not report Running before the deadline. Launch may have occurred; inspect the simulator before retrying.');
}

export function appIsRunning(stdout: string, bundleId: string): boolean {
  const text = stdout.trim();
  const apps = !text ? [] : text.startsWith('[') ? JSON.parse(text)
    : text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (!Array.isArray(apps)) throw new Error('Invalid application status response');
  return apps.some(app => app.bundle_id === bundleId && app.process_state === 'Running');
}
