import { ClickUpError, loadTicketFilterOptions, normalizeSearch } from '../integrations/clickup.js';

export function createTicketFilterProvider(load = loadTicketFilterOptions) {
  let cached;
  let pending;
  let key;
  return async function getFilters() {
    const currentKey = JSON.stringify([process.env.CLICKUP_API_TOKEN, process.env.CLICKUP_TICKETS_LIST_ID, process.env.CLICKUP_WORKSPACE_ID]);
    if (currentKey !== key) { cached = undefined; pending = undefined; key = currentKey; }
    if (cached && Date.now() - cached.time < 5 * 60_000) return cached.value;
    if (!pending) {
      const loading = load().then((value) => {
        if (key === currentKey) cached = { value, time: Date.now() };
        return value;
      }).finally(() => { if (pending === loading) pending = undefined; });
      pending = loading;
    }
    return pending;
  };
}

export const getTicketFilters = createTicketFilterProvider();

export function resolveTicketFilters(options, available) {
  const rawStatus = options?.getString('status')?.trim();
  const rawUser = options?.getString('responsavel')?.trim();
  const status = rawStatus ? available.statuses.find((item) => normalizeSearch(item) === normalizeSearch(rawStatus)) : undefined;
  const user = rawUser ? available.users.find((item) => item.id === rawUser) : undefined;
  if (rawStatus && !status) throw new ClickUpError('Status inválido. Selecione um dos status sugeridos pelo ClickUp.');
  if (rawUser && !user) throw new ClickUpError('Responsável inválido. Selecione o usuário nas sugestões do ClickUp.');
  return { status, assigneeId: user?.id, assigneeName: user?.name };
}

export function buildFilterSuggestions(available, option, query) {
  const search = normalizeSearch(query);
  const choices = option === 'status'
    ? available.statuses.map((status) => ({ name: status, value: status }))
    : option === 'responsavel'
      ? available.users.map((user) => ({ name: `${user.name} (${user.id})`, value: user.id }))
      : [];
  return choices.filter((choice) => normalizeSearch(choice.name).includes(search))
    .slice(0, 25).map((choice) => ({ ...choice, name: [...choice.name].slice(0, 100).join('') }));
}
