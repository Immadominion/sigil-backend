// ═══════════════════════════════════════════════════════════════
// SSE Event Bus — broadcasts events to connected clients
// ═══════════════════════════════════════════════════════════════

export interface SigilEvent {
  type:
    | "session_created"
    | "session_revoked"
    | "sessions_revoked_all"
    | "agent_heartbeat"
    | "agent_registered"
    | "agent_suspended"
    | "pairing_token_created"
    | "pairing_token_revoked";
  walletId: number;
  data: Record<string, unknown>;
  timestamp: string;
}

type Listener = (event: SigilEvent) => void;

class EventBus {
  // Map of walletId -> Set of listener functions
  private listeners = new Map<number, Set<Listener>>();

  subscribe(walletId: number, listener: Listener): () => void {
    if (!this.listeners.has(walletId)) {
      this.listeners.set(walletId, new Set());
    }
    this.listeners.get(walletId)!.add(listener);

    // Return unsubscribe function
    return () => {
      const set = this.listeners.get(walletId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(walletId);
      }
    };
  }

  emit(event: SigilEvent): void {
    const listeners = this.listeners.get(event.walletId);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  getConnectionCount(walletId: number): number {
    return this.listeners.get(walletId)?.size ?? 0;
  }
}

export const eventBus = new EventBus();
