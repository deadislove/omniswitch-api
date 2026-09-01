import { Semaphore } from './semaphore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Semaphore', () => {
  it('runs a call immediately when under the concurrency limit', async () => {
    const sem = new Semaphore(2);
    const result = await sem.run(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('caps concurrent execution at maxConcurrent — the 3rd call does not start until one of the first two finishes', async () => {
    const sem = new Semaphore(2);
    const started: number[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const runs = gates.map((gate, i) =>
      sem.run(async () => {
        started.push(i);
        await gate.promise;
        return i;
      }),
    );

    // Give the microtask queue a tick to let the first two acquire.
    await new Promise((r) => setImmediate(r));
    expect(started.sort()).toEqual([0, 1]);

    gates[0].resolve();
    await new Promise((r) => setImmediate(r));
    expect(started.sort()).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    const results = await Promise.all(runs);
    expect(results.sort()).toEqual([0, 1, 2]);
  });

  it('releases the permit even when the wrapped function throws', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The permit must have been released — this would hang otherwise.
    const result = await sem.run(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('serves queued callers in FIFO order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const gate = deferred<void>();

    const first = sem.run(async () => {
      await gate.promise;
    });
    await new Promise((r) => setImmediate(r));

    const second = sem.run(async () => {
      order.push(2);
    });
    const third = sem.run(async () => {
      order.push(3);
    });

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual([2, 3]);
  });
});
