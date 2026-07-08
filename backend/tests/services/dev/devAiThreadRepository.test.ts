import test from "node:test";
import assert from "node:assert/strict";
import { createDevAiThreadRepository } from "../../../src/services/dev/ai/devAiThreadRepository";

test("Dev AI thread repository 依 owner_actor 隔離 thread", async () => {
  const repo = createDevAiThreadRepository({
    dbFile: ":memory:",
    idFactory: (() => {
      let seq = 0;
      return () => `id-${++seq}`;
    })(),
  });

  const alice = await repo.createThread({
    ownerActor: "alice",
    title: "Alice thread",
    mode: "auto",
    context: {},
    now: "2026-07-03T00:00:00.000Z",
  });
  await repo.createThread({
    ownerActor: "bob",
    title: "Bob thread",
    mode: "auto",
    context: {},
    now: "2026-07-03T00:00:01.000Z",
  });

  assert.equal((await repo.listThreads("alice", 10)).length, 1);
  assert.equal(await repo.getThread("bob", alice.id), null);

  await repo.close();
});

test("Dev AI thread repository 可寫入 messages 與 artifacts", async () => {
  const repo = createDevAiThreadRepository({
    dbFile: ":memory:",
    idFactory: (() => {
      let seq = 0;
      return () => `id-${++seq}`;
    })(),
  });
  const thread = await repo.createThread({
    ownerActor: "alice",
    title: "Thread",
    mode: "general",
    context: { formPath: "default/devtest/51" },
    now: "2026-07-03T00:00:00.000Z",
  });

  const message = await repo.appendMessage({
    ownerActor: "alice",
    threadId: thread.id,
    role: "assistant",
    content: "回答",
    intent: "general",
    model: "gemini",
    now: "2026-07-03T00:00:01.000Z",
    metadata: { chatId: "chat-1" },
  });
  await repo.appendArtifact({
    threadId: thread.id,
    messageId: message.id,
    type: "chat-result",
    payload: { sources: [] },
    now: "2026-07-03T00:00:01.000Z",
  });
  await repo.updateThreadAfterMessage({
    ownerActor: "alice",
    threadId: thread.id,
    preview: "hello",
    updatedAt: "2026-07-03T00:00:02.000Z",
  });

  assert.equal((await repo.listMessages("alice", thread.id)).length, 1);
  assert.equal((await repo.listArtifacts("alice", thread.id)).length, 1);
  assert.equal((await repo.getThread("alice", thread.id))?.lastMessagePreview, "hello");

  await repo.close();
});

test("Dev AI thread repository 可裁剪舊 messages 與 artifacts", async () => {
  const repo = createDevAiThreadRepository({
    dbFile: ":memory:",
    idFactory: (() => {
      let seq = 0;
      return () => `id-${++seq}`;
    })(),
  });
  const thread = await repo.createThread({
    ownerActor: "alice",
    title: "Thread",
    mode: "general",
    context: {},
    now: "2026-07-03T00:00:00.000Z",
  });

  for (let index = 0; index < 5; index += 1) {
    const message = await repo.appendMessage({
      ownerActor: "alice",
      threadId: thread.id,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `訊息 ${index}`,
      intent: "general",
      now: `2026-07-03T00:00:0${index}.000Z`,
    });
    await repo.appendArtifact({
      threadId: thread.id,
      messageId: message.id,
      type: "chat-result",
      payload: { index },
      now: `2026-07-03T00:00:0${index}.000Z`,
    });
  }

  await repo.pruneThreadItems({
    ownerActor: "alice",
    threadId: thread.id,
    maxMessages: 2,
    maxArtifacts: 1,
  });

  assert.deepEqual(
    (await repo.listMessages("alice", thread.id, 10)).map((message) => message.content),
    ["訊息 3", "訊息 4"]
  );
  assert.equal((await repo.listArtifacts("alice", thread.id, 10)).length, 1);

  await repo.close();
});

test("Dev AI thread repository 可刪除過期封存與超量 threads", async () => {
  const repo = createDevAiThreadRepository({
    dbFile: ":memory:",
    idFactory: (() => {
      let seq = 0;
      return () => `id-${++seq}`;
    })(),
  });
  await repo.createThread({
    ownerActor: "alice",
    title: "old",
    mode: "general",
    context: {},
    now: "2026-01-01T00:00:00.000Z",
  });
  const archived = await repo.createThread({
    ownerActor: "alice",
    title: "archived",
    mode: "general",
    context: {},
    now: "2026-07-01T00:00:00.000Z",
  });
  await repo.archiveThread("alice", archived.id, "2026-07-01T00:00:00.000Z");
  await repo.createThread({
    ownerActor: "alice",
    title: "newer",
    mode: "general",
    context: {},
    now: "2026-07-03T00:00:00.000Z",
  });

  await repo.pruneActorThreads({
    ownerActor: "alice",
    now: "2026-07-03T00:00:00.000Z",
    maxThreads: 1,
    activeRetentionDays: 180,
    archivedRetentionDays: 1,
  });

  assert.deepEqual(
    (await repo.listThreads("alice", 10)).map((thread) => thread.title),
    ["newer"]
  );

  await repo.close();
});
