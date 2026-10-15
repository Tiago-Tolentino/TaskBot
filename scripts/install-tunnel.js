import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Instalação local, sem sudo, a partir das releases oficiais da Cloudflare.
let temporary;
try {
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error();
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const assetName = `cloudflared-${process.platform}-${arch}${process.platform === 'darwin' ? '.tgz' : ''}`;
  const releaseResponse = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { signal: AbortSignal.timeout(30_000) });
  if (!releaseResponse.ok) throw new Error();
  const release = await releaseResponse.json();
  const asset = release.assets?.find((item) => item.name === assetName);
  if (!asset?.digest?.startsWith('sha256:') || !asset.browser_download_url?.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) throw new Error();
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
  if (!download.ok) throw new Error();
  const bytes = Buffer.from(await download.arrayBuffer());
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error();
  const destination = fileURLToPath(new URL('../.tools/', import.meta.url));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  temporary = await mkdtemp(join(tmpdir(), 'tasksbot-tunnel-'));
  const archive = join(temporary, assetName);
  await writeFile(archive, bytes, { mode: 0o600 });
  let executable = archive;
  if (process.platform === 'darwin') {
    await promisify(execFile)('tar', ['-xzf', archive, '-C', temporary, 'cloudflared']);
    executable = join(temporary, 'cloudflared');
  }
  // Copiar antes de rename evita EXDEV entre volumes distintos.
  const { copyFile } = await import('node:fs/promises');
  await copyFile(executable, join(destination, 'cloudflared.new'));
  await chmod(join(destination, 'cloudflared.new'), 0o700);
  await rename(join(destination, 'cloudflared.new'), join(destination, 'cloudflared'));
  console.log(`[INFO] cloudflared ${release.tag_name} instalado em .tools/cloudflared; SHA-256 conferido.`);
} catch {
  console.error('[ERRO] Não foi possível instalar cloudflared da release oficial com SHA-256. Verifique a rede ou instale pelo gerenciador do seu sistema e configure CLOUDFLARED_PATH.');
  process.exitCode = 1;
} finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
