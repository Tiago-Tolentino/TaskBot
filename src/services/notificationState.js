import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BotSetupError } from './errors.js';

export function createNotificationStore(path) {
  return {
    async read() {
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new BotSetupError('Não foi possível ler o estado dos avisos. Corrija o arquivo em .data antes de reativar o monitor.');
      }
    },
    async write(state) {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      } catch {
        throw new BotSetupError('Não foi possível salvar o estado dos avisos em .data. Verifique as permissões do diretório.');
      }
    },
  };
}
