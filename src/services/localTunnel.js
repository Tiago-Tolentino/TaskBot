import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BotSetupError } from './errors.js';

export async function startLocalTunnel({ port, binary, signal }) {
  const local = fileURLToPath(new URL('../../.tools/cloudflared', import.meta.url));
  if (!binary) {
    try { await access(local); binary = local; } catch { binary = 'cloudflared'; }
  }
  const child = spawn(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // O processo do túnel não precisa receber os tokens do bot.
    env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
  });
  let finished = false;
  const closed = new Promise((resolve) => {
    child.once('error', () => { finished = true; resolve(); });
    child.once('close', () => { finished = true; resolve(); });
  });
  async function stop() {
    if (finished) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await closed;
    clearTimeout(force);
  }
  const abort = () => { void stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  void closed.then(() => signal?.removeEventListener('abort', abort));
  if (signal?.aborted) { await stop(); throw new BotSetupError('Inicialização do túnel cancelada.'); }
  try {
    const url = await new Promise((resolve, reject) => {
      let log = '';
      let endpoint;
      const timeout = setTimeout(() => reject(new BotSetupError('O túnel local não conectou em 60 segundos. A recuperação periódica permanece ativa.')), 60_000);
      const consume = (chunk) => {
        log = (log + chunk.toString()).slice(-16_384);
        endpoint ||= log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
        if (endpoint && log.includes('Registered tunnel connection')) { clearTimeout(timeout); resolve(endpoint); }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      void closed.then(() => {
        clearTimeout(timeout);
        reject(new BotSetupError('O túnel local foi encerrado. Verifique a rede e a instalação de cloudflared (npm run tunnel:install).'));
      });
    });
    return { url, closed, stop };
  } catch (error) { await stop(); throw error; }
}
