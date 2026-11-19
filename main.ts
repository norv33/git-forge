// main.ts — entrypoint: `node --experimental-strip-types main.ts`.
//
// Lifecycle (the contract the trial harness expects):
//   1. Bind the forge to an ephemeral local port (never 8080).
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register so the suite finds it.
//   3. Long-poll GET $MAKEFUN_ENV_URL/done until {"done": true}.
//   4. Close the server and exit 0.
//
// Without MAKEFUN_ENV_URL the server runs standalone: it prints the port
// and keeps serving until killed, which is how local practice trials run it.

import { createApp, makeToken } from './app.ts';
import { Store } from './store.ts';

const POLL_INTERVAL_MS = 250;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`);
}

async function waitForDone(envUrl: string): Promise<void> {
  const base = envUrl.replace(/\/$/, '');
  for (;;) {
    try {
      const res = await fetch(`${base}/done`, { signal: AbortSignal.timeout(5000) });
      const text = await res.text();
      const parsed = JSON.parse(text) as { done?: boolean };
      if (parsed.done === true) return;
    } catch {
      // The harness may not be ready yet; keep polling.
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  const token = makeToken();
  const store = new Store();
  const server = createApp({ store, token });
  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) resolve(address.port);
      else reject(new Error('could not bind a port'));
    });
  });

  if (envUrl === '') {
    console.log(`git-forge listening on http://127.0.0.1:${port} (standalone mode)`);
    return;
  }

  await postJson(`${envUrl.replace(/\/$/, '')}/register`, { port });
  console.log(`git-forge registered on port ${port}`);
  await waitForDone(envUrl);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('git-forge done');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
