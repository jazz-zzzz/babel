import { clearAllBatchQueue, getBatchQueue } from "./batchQueue";

describe("BatchQueue", () => {
  afterEach(() => {
    clearAllBatchQueue();
  });

  test("processes higher priority tasks before older lower priority tasks", async () => {
    const batches = [];
    const queue = getBatchQueue(
      "priority",
      async (payloads) => {
        batches.push(payloads);
        return payloads;
      },
      {
        batchInterval: 0,
        batchSize: 2,
        batchLength: 1000,
        maxConcurrentBatches: 1,
      }
    );

    const low = queue.addTask("low", { priority: 0 });
    const high = queue.addTask("high", { priority: 10 });

    await expect(Promise.all([low, high])).resolves.toEqual(["low", "high"]);
    expect(batches[0]).toEqual(["high", "low"]);
  });

  test("allows multiple batches from the same queue to run concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const releases = [];
    const queue = getBatchQueue(
      "parallel",
      (payloads) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve(payloads);
          });
        });
      },
      {
        batchInterval: 0,
        batchSize: 1,
        batchLength: 1000,
        maxConcurrentBatches: 2,
      }
    );

    const first = queue.addTask("first");
    const second = queue.addTask("second");

    await Promise.resolve();
    await Promise.resolve();

    expect(maxActive).toBe(2);

    releases.forEach((release) => release());
    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
  });

  test("returns a fresh queue after clearing all queues", async () => {
    const firstQueue = getBatchQueue("reset", async (payloads) => payloads, {
      batchInterval: 0,
      batchSize: 1,
      batchLength: 1000,
    });

    clearAllBatchQueue();

    const secondQueue = getBatchQueue("reset", async (payloads) => payloads, {
      batchInterval: 0,
      batchSize: 1,
      batchLength: 1000,
    });

    expect(secondQueue).not.toBe(firstQueue);
    await expect(secondQueue.addTask("fresh")).resolves.toBe("fresh");
  });
});
