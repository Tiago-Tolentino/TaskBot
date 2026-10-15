export function extractTicketSummary(task) {
  const text = (task.text_content || task.description || '').replace(/\r\n/g, '\n').trim();
  if (!text) return 'Resumo não informado.';
  const lines = text.split('\n');
  const heading = /^\s*(?:#{1,6}\s*)?(?:\*\*)?Resumo(?:\*\*)?\s*(?::\s*(.*))?$/i;
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return text;
  const summary = [lines[start].match(heading)[1] || ''];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#{1,6}\s+\S|↗\s*Abrir|(?:\*\*)?(?:Cliente|Situação|Atributos do ticket|Conversa recente|Sincronização)(?:\*\*)?\s*:?\s*$)/i.test(line)) break;
    summary.push(line);
  }
  return summary.join('\n').trim() || 'Resumo não informado.';
}
