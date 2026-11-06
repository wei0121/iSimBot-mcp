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

/** Simulator launchd uses UIKitApplication:<bundle>[instance] labels. Reject
 * incomplete/malformed listings instead of interpreting a failed query as stopped. */
export function simulatorAppIsRunning(stdout: string, bundleId: string): boolean {
  const rows = stdout.trim().split(/\r?\n/);
  if (rows.shift()?.trim().split(/\s+/).join(' ') !== 'PID Status Label') throw new Error('Invalid simulator process listing');
  let running = false;
  for (const line of rows) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !/^(?:-|[1-9]\d*)$/.test(fields[0]) || !/^-?\d+$/.test(fields[1])) throw new Error('Invalid simulator process row');
    if (fields[2].startsWith(`UIKitApplication:${bundleId}[`) && fields[0] !== '-') running = true;
  }
  return running;
}
