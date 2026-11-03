import { afterAll } from 'vitest';

const previous = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON');

// AppModule-based tests bypass main.ts; install its exact serializer before workers start.
Object.defineProperty(BigInt.prototype, 'toJSON', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: function (this: bigint) {
    return this.toString();
  },
});

// The root teardown runs after nested suites have closed their Nest apps and workers.
afterAll(() => {
  if (previous) Object.defineProperty(BigInt.prototype, 'toJSON', previous);
  else Reflect.deleteProperty(BigInt.prototype, 'toJSON');
});
