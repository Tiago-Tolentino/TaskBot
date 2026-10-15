import { BotSetupError } from './errors.js';

// A confirmação HTTP só acontece após persistir; o processamento usa a mesma
// deduplicação do monitor e não bloqueia novas entregas do ClickUp.
export async function createWebhookInbox({ store, processTask, onError = () => {}, retryMs = 30_000 }) {
  let state = await store.read() ?? { version: 1, taskIds: [] };
  if (state.version !== 1 || !Array.isArray(state.taskIds) || state.taskIds.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) {
    throw new BotSetupError('Fila de webhooks inválida. Preserve e verifique o arquivo em .data.');
  }
  let writes = Promise.resolve();
  let worker;
  let timer;
  let stopped = false;
  function update(change) {
    const result = writes.then(async () => {
      const next = change(state);
      await store.write(next);
      state = next;
    });
    writes = result.catch(() => {});
    return result;
  }
  function drain() {
    if (worker || stopped) return worker;
    clearTimeout(timer);
    worker = (async () => {
      const attempted = new Set();
      while (!stopped) {
        const id = state.taskIds.find((value) => !attempted.has(value));
        if (!id) break;
        attempted.add(id);
        try {
          await processTask(id);
          if (stopped) break;
          await update((current) => ({ ...current, taskIds: current.taskIds.filter((value) => value !== id) }));
        } catch (error) { if (!stopped) onError(error); }
      }
    })().finally(() => {
      worker = undefined;
      if (!stopped && state.taskIds.length) timer = setTimeout(drain, retryMs);
    });
    return worker;
  }
  return {
    start() { void drain(); },
    async enqueue(taskId) {
      if (stopped) throw new BotSetupError('Recepção de webhooks em encerramento.');
      await update((current) => {
        if (current.taskIds.includes(taskId)) return current;
        if (current.taskIds.length >= 10_000) throw new BotSetupError('Fila de webhooks cheia. A recuperação periódica continua ativa.');
        return { ...current, taskIds: [...current.taskIds, taskId] };
      });
      void drain();
    },
    async stop() { stopped = true; clearTimeout(timer); await worker; await writes; },
  };
}
