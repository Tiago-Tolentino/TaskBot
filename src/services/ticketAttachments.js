import { escapeMarkdown } from 'discord.js';

const PER_FILE = 8 * 1024 * 1024;
const TOTAL = 20 * 1024 * 1024;
const DOWNLOAD_HOSTS = ['clickup-attachments.com', 'clickup.com', 'amazonaws.com'];

export function attachmentUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    // URLs do ticket são dados externos. Não publicar links locais ou esquemas executáveis.
    if (!url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')
      || /\.(?:localhost|local|internal)$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeAttachments(files) {
  if (!Array.isArray(files)) return [];
  const seen = new Set();
  return files.flatMap((file) => {
    if (!file || file.deleted || file.hidden || file.is_folder) return [];
    const url = attachmentUrl(file.url);
    const downloadUrl = attachmentUrl(file.url_w_query) || url;
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ id: String(file.id || ''), name: String(file.title || `anexo${file.extension ? '.' + String(file.extension).replace(/^\./, '') : ''}`),
      size: Number.isFinite(Number(file.size)) && Number(file.size) >= 0 ? Number(file.size) : undefined,
      url, downloadUrl }];
  });
}

const canDownload = (value) => {
  const safe = attachmentUrl(value);
  if (!safe) return false;
  const host = new URL(safe).hostname;
  return DOWNLOAD_HOSTS.some((domain) => host === domain || host.endsWith('.' + domain));
};

export function attachmentField(ticket) {
  const files = ticket.attachments || [];
  if (!files.length) return null;
  const lines = [];
  let shown = 0;
  for (const file of files) {
    const name = escapeMarkdown([...file.name].slice(0, 65).join(''));
    let url = attachmentUrl(file.url) || ticket.url;
    if (url.length > 500) url = ticket.url;
    const line = `[${name}](<${url}>)`;
    if ([...lines, line].join('\n').length > 900) break;
    lines.push(line); shown++;
  }
  if (shown < files.length) lines.push(`Mais ${files.length - shown} anexo(s): [abrir ticket](<${ticket.url}>).`);
  return { name: `Anexos (${files.length})`, value: lines.join('\n') };
}

export async function prepareTicketAttachments(ticket, { fetchFile = fetch, signal, canAttach = true, perFileLimit = PER_FILE, totalLimit = TOTAL } = {}) {
  const files = [];
  let bytes = 0;
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  for (const [index, attachment] of (ticket.attachments || []).entries()) {
    if (!canAttach || files.length >= 10 || bytes >= totalLimit || deadline.aborted || attachment.size > perFileLimit
      || attachment.size > totalLimit - bytes || !canDownload(attachment.downloadUrl)) continue;
    let response;
    try {
      let url = attachment.downloadUrl;
      const requestSignal = AbortSignal.any([deadline, AbortSignal.timeout(10_000)]);
      for (let redirects = 0; redirects <= 3; redirects++) {
        // Sem Authorization: nunca enviar o token ClickUp a servidores de arquivos.
        response = await fetchFile(url, { redirect: 'manual', signal: requestSignal });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const next = new URL(response.headers.get('location'), url).href;
        await response.body?.cancel();
        if (redirects === 3 || !canDownload(next)) throw new Error();
        url = next;
      }
      if (!response.ok || !response.body) throw new Error();
      const limit = Math.min(perFileLimit, totalLimit - bytes);
      if (Number(response.headers.get('content-length')) > limit) throw new Error();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error();
        chunks.push(chunk);
      }
      const name = [...attachment.name.replace(/[\x00-\x1f\x7f/\\]/g, '_')].slice(0, 110).join('') || 'anexo';
      files.push({ attachment: Buffer.concat(chunks), name: `${index + 1}-${name}` });
      bytes += size;
    } catch {
      // O aviso continua com links mesmo se um arquivo exceder o limite ou falhar.
      try { if (response?.body && !response.body.locked) await response.body.cancel(); } catch { /* Corpo já encerrado. */ }
    }
  }
  return { files, omitted: (ticket.attachments?.length || 0) - files.length };
}
