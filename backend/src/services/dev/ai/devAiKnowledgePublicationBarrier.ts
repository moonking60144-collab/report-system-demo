export interface DevAiKnowledgePublicationBarrier {
  withRead<T>(operation: () => Promise<T>): Promise<T>;
  withWrite<T>(operation: () => Promise<T>): Promise<T>;
}

type Waiter = {
  kind: "read" | "write";
  resolve: () => void;
};

export function createDevAiKnowledgePublicationBarrier(): DevAiKnowledgePublicationBarrier {
  let activeReaders = 0;
  let writerActive = false;
  const queue: Waiter[] = [];

  function drain(): void {
    if (writerActive) return;
    if (activeReaders > 0) {
      while (queue[0]?.kind === "read") {
        const waiter = queue.shift()!;
        activeReaders += 1;
        waiter.resolve();
      }
      return;
    }
    if (queue[0]?.kind === "write") {
      writerActive = true;
      queue.shift()!.resolve();
      return;
    }
    while (queue[0]?.kind === "read") {
      const waiter = queue.shift()!;
      activeReaders += 1;
      waiter.resolve();
    }
  }

  function acquire(kind: Waiter["kind"]): Promise<void> {
    return new Promise((resolve) => {
      queue.push({ kind, resolve });
      drain();
    });
  }

  return {
    async withRead<T>(operation: () => Promise<T>): Promise<T> {
      await acquire("read");
      try {
        return await operation();
      } finally {
        activeReaders -= 1;
        drain();
      }
    },
    async withWrite<T>(operation: () => Promise<T>): Promise<T> {
      await acquire("write");
      try {
        return await operation();
      } finally {
        writerActive = false;
        drain();
      }
    },
  };
}

export const devAiKnowledgePublicationBarrier =
  createDevAiKnowledgePublicationBarrier();
