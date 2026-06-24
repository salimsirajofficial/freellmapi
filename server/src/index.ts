import './env.js';
import { initEncryptionKey } from './lib/crypto.js';
import { seedModelsIfEmpty } from './db/supabase-queries.js';
import { createApp } from './app.js';

const PORT = process.env.PORT ?? 3001;
const HOST = process.env.HOST ?? '::';

async function main() {
  initEncryptionKey();
  await seedModelsIfEmpty();

  const app = createApp();

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`Server running on http://${display}:${PORT}`);
    console.log(`Proxy endpoint: http://${display}:${PORT}/v1/chat/completions`);
  };

  const server = app.listen(Number(PORT), HOST, onReady(HOST));
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (!process.env.HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[server] IPv6 unavailable on this host — falling back to 0.0.0.0 (IPv4-only)');
      app.listen(Number(PORT), '0.0.0.0', onReady('0.0.0.0'));
      return;
    }
    console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
  process.exit(1);
});
