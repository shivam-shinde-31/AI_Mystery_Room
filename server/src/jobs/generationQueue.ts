type Task = () => Promise<void>;

export class GenerationQueue {
  private readonly pending: Task[] = [];
  private active = 0;

  constructor(private readonly concurrency = 2) {}

  enqueue(task: Task) {
    this.pending.push(task);
    this.pump();
  }

  private pump() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.active += 1;
      void task().finally(() => { this.active -= 1; this.pump(); });
    }
  }
}
