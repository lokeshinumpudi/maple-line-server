import { experimental_evaluate } from 'ai';

/** @param {import('./world-planner.js').Evaluator} [evaluate] */
export function createEvaluationGate(evaluate = experimental_evaluate) {
  /** @type {Promise<unknown>|null} */
  let active = null;
  let waiting = false;
  /** @param {Parameters<typeof experimental_evaluate>[0]} request */
  async function run(request) {
    if (request.abortSignal?.aborted) throw new Error('Cancelled');
    const pending = Promise.resolve().then(() => evaluate(request));
    active = pending;
    try {
      return await pending;
    } finally {
      if (active === pending) active = null;
    }
  }
  return {
    /** @param {Parameters<typeof experimental_evaluate>[0]} request */
    async background(request) {
      if (active || waiting) throw new Error('Evaluation busy');
      return run(request);
    },
    /** @param {Parameters<typeof experimental_evaluate>[0]} request */
    async foreground(request) {
      if (waiting) throw new Error('World request already queued');
      waiting = true;
      try {
        if (active) {
          const pending = active;
          await new Promise((resolve, reject) => {
            const abort = () => reject(new Error('Cancelled'));
            request.abortSignal?.addEventListener('abort', abort, { once: true });
            void pending
              .catch(() => {})
              .then(() => {
                request.abortSignal?.removeEventListener('abort', abort);
                resolve(undefined);
              });
            if (request.abortSignal?.aborted) abort();
          });
        }
        return await run(request);
      } finally {
        waiting = false;
      }
    },
  };
}
