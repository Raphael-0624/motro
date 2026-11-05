import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class VisitCounter {
  #queue = Promise.resolve();
  #count;

  constructor(file) { this.file = file; }

  increment() {
    const operation = this.#queue.then(async () => {
      if (this.#count === undefined) {
        try {
          const { count } = JSON.parse(await readFile(this.file, 'utf8'));
          if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid visit counter');
          this.#count = count;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          this.#count = 0;
        }
      }
      const count = this.#count + 1;
      if (!Number.isSafeInteger(count)) throw new Error('Visit counter exhausted');
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ count }) + '\n', { mode: 0o600, flush: true });
        await rename(temporary, this.file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      this.#count = count;
      return count;
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
