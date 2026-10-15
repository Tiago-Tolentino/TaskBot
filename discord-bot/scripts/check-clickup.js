import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ClickUpError, getAuthorizedUser } from '../src/integrations/clickup.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

try {
  await getAuthorizedUser();
  console.log('[INFO] Conexão com o ClickUp validada com sucesso!');
} catch (error) {
  const message = error instanceof ClickUpError
    ? error.message
    : 'Não foi possível validar a conexão com o ClickUp.';
  console.error(`[ERRO] ${message}`);
  process.exitCode = 1;
}
