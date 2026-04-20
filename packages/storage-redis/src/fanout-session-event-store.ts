import type { SessionEvent, SessionEventBus, SessionEventStore } from "@oah/engine-core";

export class FanoutSessionEventStore implements SessionEventStore {
  readonly #primary: SessionEventStore;
  readonly #bus: SessionEventBus;

  constructor(primary: SessionEventStore, bus: SessionEventBus) {
    this.#primary = primary;
    this.#bus = bus;
  }

  async append(input: Omit<SessionEvent, "id" | "cursor" | "createdAt">): Promise<SessionEvent> {
    const event = await this.#primary.append(input);
    await this.#bus.publish(event);
    return event;
  }

  async deleteById(eventId: string): Promise<void> {
    await this.#primary.deleteById(eventId);
  }

  async listSince(sessionId: string, cursor?: string, runId?: string): Promise<SessionEvent[]> {
    return this.#primary.listSince(sessionId, cursor, runId);
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const seen = new Set<string>();
    const order: string[] = [];
    let active = true;
    let unsubscribeSecondary: (() => Promise<void> | void) | undefined;

    const forward = (event: SessionEvent) => {
      if (!active || event.sessionId !== sessionId || seen.has(event.id)) {
        return;
      }

      seen.add(event.id);
      order.push(event.id);
      if (order.length > 1024) {
        const oldest = order.shift();
        if (oldest) {
          seen.delete(oldest);
        }
      }

      listener(event);
    };

    const unsubscribePrimary = this.#primary.subscribe(sessionId, forward);

    void this.#bus.subscribe(sessionId, forward).then(
      (unsubscribe) => {
        if (!active) {
          void unsubscribe();
          return;
        }

        unsubscribeSecondary = unsubscribe;
      },
      () => undefined
    );

    return () => {
      active = false;
      unsubscribePrimary();
      void unsubscribeSecondary?.();
    };
  }
}
