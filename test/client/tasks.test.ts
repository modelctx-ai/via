// The pure side of tasks (client/tasks.ts): reading what a task in `input_required` waits for.
import { describe, expect, it } from 'vitest';
import { inputRequestsOf, readTask } from '../../src/client/tasks';

const ask = { method: 'elicitation/create', params: { message: 'Which region?', mode: 'form', requestedSchema: { type: 'object', properties: {} } } };

describe('inputRequestsOf', () => {
  it('lists the requests of a stateless-protocol tasks/get result with their keys, methods and parameters', () => {
    const raw = { taskId: 't', status: 'input_required', inputRequests: { first: ask, second: { method: 'sampling/createMessage', params: { maxTokens: 1 } } } };
    expect(inputRequestsOf(raw)).toEqual([
      { key: 'first', method: 'elicitation/create', params: ask.params },
      { key: 'second', method: 'sampling/createMessage', params: { maxTokens: 1 } },
    ]);
    expect(readTask(raw)?.inputMethods).toEqual(['elicitation/create', 'sampling/createMessage']);
  });

  it('is undefined where there is nothing to answer, and keeps an entry it does not understand as an unknown request', () => {
    expect(inputRequestsOf(undefined)).toBeUndefined();
    expect(inputRequestsOf({ taskId: 't', status: 'working' })).toBeUndefined();
    expect(inputRequestsOf({ inputRequests: {} })).toBeUndefined();
    expect(inputRequestsOf({ inputRequests: [] })).toBeUndefined();
    expect(inputRequestsOf({ inputRequests: { odd: 'text' } })).toEqual([{ key: 'odd', method: 'unknown request', params: undefined }]);
  });
});
