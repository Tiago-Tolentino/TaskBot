import { extractTicketSummary } from '../services/ticketSummary.js';

export class ClickUpError extends Error {}

export const normalizeSearch = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function validateListId(listId) {
  if (typeof listId !== 'string' || !/^\d+$/.test(listId.trim())) {
    throw new ClickUpError('Preencha CLICKUP_TICKETS_LIST_ID no .env com o ID da lista Tickets do space Suporte B2C.');
  }
}

export async function requestClickUp(path, token, signal, { method = 'GET', body } = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new ClickUpError('Preencha CLICKUP_API_TOKEN no arquivo .env antes de validar a conexão.');
  }

  try {
    const response = await fetch(`https://api.clickup.com/api/v2${path}`, {
      method,
      headers: {
        Authorization: token.trim(),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 401) {
      throw new ClickUpError('O ClickUp recusou a autenticação. Verifique CLICKUP_API_TOKEN no .env.');
    }
    if (response.status === 403) {
      throw new ClickUpError('Acesso ao ClickUp negado. Verifique o token e as permissões da conta.');
    }
    if (response.status === 429) {
      throw new ClickUpError('Limite de requisições do ClickUp atingido. Aguarde e tente novamente.');
    }
    if (response.status === 404) {
      throw Object.assign(new ClickUpError('Recurso do ClickUp não encontrado ou inacessível. Verifique o ID da lista e as permissões da conta.'), { status: 404 });
    }
    if (!response.ok) {
      throw new ClickUpError(`Não foi possível validar a conexão com o ClickUp (HTTP ${response.status}).`);
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ClickUpError) throw error;
    // Erros e respostas externos podem conter dados sensíveis; não propagá-los.
    throw new ClickUpError('Falha ao consultar o ClickUp. Verifique a conexão de rede e tente novamente.');
  }
}

export async function getAuthorizedUser(token = process.env.CLICKUP_API_TOKEN) {
  const payload = await requestClickUp('/user', token);
  if (!payload?.user || !['string', 'number'].includes(typeof payload.user.id)) {
    throw new ClickUpError('O ClickUp retornou uma resposta inesperada; a conexão não foi confirmada.');
  }
  return payload.user;
}

export async function getAllTickets({
  token = process.env.CLICKUP_API_TOKEN,
  listId = process.env.CLICKUP_TICKETS_LIST_ID,
  status,
  assigneeId,
  createdAfter,
  updatedAfter,
  signal: externalSignal,
} = {}) {
  validateListId(listId);
  if (assigneeId && !/^\d+$/.test(assigneeId)) {
    throw new ClickUpError('Selecione um responsável nas sugestões do ClickUp.');
  }

  const tickets = new Map();
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  // Consulta ativos e arquivados separadamente; concluídos também são incluídos.
  for (const archived of [false, true]) {
    const seenPages = new Set();
    for (let page = 0; ; page++) {
      const query = new URLSearchParams({
        page: String(page), archived: String(archived),
        include_closed: 'true', include_timl: 'true', subtasks: 'true', order_by: 'id',
      });
      if (status) query.append('statuses[]', status);
      if (assigneeId) query.append('assignees[]', assigneeId);
      if (createdAfter !== undefined) query.set('date_created_gt', String(createdAfter));
      if (updatedAfter !== undefined) query.set('date_updated_gt', String(updatedAfter));
      const data = await requestClickUp(`/list/${listId.trim()}/task?${query}`, token, signal);
      if (!Array.isArray(data?.tasks)) {
        throw new ClickUpError('O ClickUp retornou uma página de tickets inválida. A listagem completa não foi confirmada.');
      }
      if (!data.tasks.length) break;

      const ids = data.tasks.map((task) => {
        if (!task || typeof task.id !== 'string' || !task.id || typeof task.name !== 'string') {
          throw new ClickUpError('O ClickUp retornou um ticket inválido. A listagem completa não foi confirmada.');
        }
        return task.id;
      });
      const signature = JSON.stringify(ids);
      if (seenPages.has(signature)) {
        throw new ClickUpError('O ClickUp repetiu uma página de tickets. A listagem completa não foi confirmada; tente novamente.');
      }
      seenPages.add(signature);

      for (const task of data.tasks) {
        if (status && normalizeSearch(task.status?.status) !== normalizeSearch(status)) continue;
        if (assigneeId && !task.assignees?.some((user) => String(user.id) === assigneeId)) continue;
        tickets.set(task.id, normalizeTicket(task));
      }
      // Uma página curta com last_page=false ainda exige a próxima consulta.
      if (data.last_page === true) break;
    }
  }
  return [...tickets.values()];
}

export async function loadTicketFilterOptions({
  token = process.env.CLICKUP_API_TOKEN,
  listId = process.env.CLICKUP_TICKETS_LIST_ID,
  workspaceId = process.env.CLICKUP_WORKSPACE_ID,
} = {}) {
  validateListId(listId);
  if (!workspaceId || !/^\d+$/.test(workspaceId)) {
    throw new ClickUpError('Preencha CLICKUP_WORKSPACE_ID no .env para carregar as sugestões de responsáveis.');
  }
  const [list, data] = await Promise.all([
    requestClickUp(`/list/${listId.trim()}`, token), requestClickUp('/team', token),
  ]);
  const workspace = data.teams?.find((team) => String(team.id) === workspaceId);
  if (!Array.isArray(list.statuses) || !Array.isArray(workspace?.members)) {
    throw new ClickUpError('Não foi possível carregar os status e os usuários do workspace configurado no ClickUp.');
  }
  const users = new Map();
  for (const { user } of workspace.members) {
    if (user?.id !== undefined && user?.id !== null) {
      users.set(String(user.id), { id: String(user.id), name: user.username || `Usuário ${user.id}` });
    }
  }
  return {
    statuses: [...new Set(list.statuses.map((item) => item.status).filter((value) => typeof value === 'string' && value))],
    users: [...users.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
  };
}


export function normalizeTicket(task) {
  if (!task || typeof task.id !== 'string' || !task.id || typeof task.name !== 'string') {
    throw new ClickUpError('O ClickUp retornou um ticket inválido.');
  }
  return {
    id: task.id, name: task.name, status: task.status?.status || 'Sem status',
    createdAt: Number(task.date_created) || 0,
    assignees: (task.assignees || []).map((user) => ({ id: String(user.id), name: user.username || `Usuário ${user.id}` })),
    summary: extractTicketSummary(task), url: `https://app.clickup.com/t/${encodeURIComponent(task.id)}`,
  };
}

export async function getTicket({ taskId, listId = process.env.CLICKUP_TICKETS_LIST_ID, token = process.env.CLICKUP_API_TOKEN, signal } = {}) {
  validateListId(listId);
  if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new ClickUpError('ID de ticket inválido.');
  let task;
  try { task = await requestClickUp(`/task/${encodeURIComponent(taskId)}`, token, signal); }
  catch (error) { if (error.status === 404) return null; throw error; }
  // O webhook já está limitado à lista; confirme também a lista principal do recurso.
  if (String(task?.list?.id) !== listId) return null;
  return normalizeTicket(task);
}
