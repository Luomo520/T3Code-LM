import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export type SshTargetOperation = "sftp-send" | "sftp-receive" | "ssh-diagnostics";

interface TargetQueue {
  readonly permit: Semaphore.Semaphore;
  waiting: number;
  active: SshTargetOperation | null;
}

const maximumWaitingPerDevice = 16;

export function makeSshTargetQueue() {
  const targets = new Map<string, TargetQueue>();
  const connections = Semaphore.makeUnsafe(2);

  return {
    status(deviceId: string) {
      const queue = targets.get(deviceId);
      return { waiting: queue?.waiting ?? 0, active: queue?.active ?? null };
    },

    run<A, E, R, QueueError>(
      deviceId: string,
      operation: SshTargetOperation,
      task: Effect.Effect<A, E, R>,
      queueFull: QueueError,
    ): Effect.Effect<A, E | QueueError, R> {
      return Effect.suspend<A, E | QueueError, R>(() => {
        const queue = targets.get(deviceId) ?? {
          permit: Semaphore.makeUnsafe(1),
          waiting: 0,
          active: null,
        };
        if (queue.waiting >= maximumWaitingPerDevice) return Effect.fail(queueFull);
        targets.set(deviceId, queue);
        queue.waiting++;
        let started = false;
        return queue.permit
          .withPermit(
            connections.withPermit(
              Effect.sync(() => {
                queue.waiting--;
                queue.active = operation;
                started = true;
              }).pipe(
                Effect.andThen(task),
                // 许可释放前清空占用，后续请求可安全更新同一条设备记录。
                Effect.ensuring(
                  Effect.sync(() => {
                    queue.active = null;
                  }),
                ),
              ),
            ),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (!started) queue.waiting--;
                if (queue.waiting === 0 && queue.active === null) targets.delete(deviceId);
              }),
            ),
          );
      });
    },
  };
}
