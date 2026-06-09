export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) throw new Error("push after end");
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.queue.push(value);
  }

  end(): void {
    this.ended = true;
    let resolve = this.resolvers.shift();
    while (resolve) {
      resolve({ value: undefined as unknown as T, done: true });
      resolve = this.resolvers.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.queue.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
