import React, {
    createContext,
    useContext,
    useEffect,
    useRef,
    useCallback,
    useState,
    ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { wsBase } from '../lib/serverConfig';
import { IS_DEMO, IS_FIREBASE } from '../lib/firebase/config';
import { FIREBASE_REALTIME_EVENT, subscribeFirebaseEntity, subscribeFirebaseFamily } from '../lib/firebase/transport';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WsEntity =
    | 'tasks'
    | 'shopping'
    | 'appointments'
    | 'family'
    | 'budget'
    | 'recipes'
    | 'meal-plans'
    | 'planning'
    | 'notifications'
    | 'integrations'
    | 'rewards'
    | 'notes'
    | 'posts';

export type WsAction = 'created' | 'updated' | 'deleted';

export interface WsUpdateMessage {
    type: 'update';
    entity: WsEntity;
    action: WsAction;
}

type Subscriber = () => void;

interface WebSocketContextType {
    /** Subscribe to updates for a given entity. Returns an unsubscribe function. */
    subscribe: (entity: WsEntity, cb: Subscriber) => () => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const WebSocketContext = createContext<WebSocketContextType | undefined>(undefined);

// The WebSocket base is resolved by `wsBase()` (serverConfig): same-origin on the
// web, derived from the configured server URL in the native app.

const RECONNECT_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 25_000;

// ─── Provider ────────────────────────────────────────────────────────────────

export const WebSocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const { user } = useAuth();
    const { pathname } = useLocation();
    const [realtimeError, setRealtimeError] = useState<string | null>(null);

    // Map entity → set of subscriber callbacks
    const subscribers = useRef<Map<WsEntity, Set<Subscriber>>>(new Map());

    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const reconnectDelay = useRef(RECONNECT_DELAY_MS);
    const unmounted = useRef(false);

    // Notify all subscribers for a given entity
    const notify = useCallback((entity: WsEntity) => {
        const cbs = subscribers.current.get(entity);
        if (cbs) {
            cbs.forEach((cb) => cb());
        }
    }, []);

    const clearPing = () => {
        if (pingTimer.current) {
            clearInterval(pingTimer.current);
            pingTimer.current = null;
        }
    };

    const connect = useCallback(() => {
        if (unmounted.current || !user || IS_DEMO || IS_FIREBASE) return;

        // Close any existing socket
        if (wsRef.current) {
            wsRef.current.onclose = null;
            wsRef.current.close();
        }

        const ws = new WebSocket(`${wsBase()}/ws`);
        wsRef.current = ws;

        ws.onopen = () => {
            reconnectDelay.current = RECONNECT_DELAY_MS;

            // Authenticate with JWT; never send the raw userId
            ws.send(JSON.stringify({ type: 'auth', token: api.getToken() }));

            // Heartbeat to keep connection alive through proxies
            clearPing();
            pingTimer.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, PING_INTERVAL_MS);
        };

        ws.onmessage = (event: MessageEvent) => {
            try {
                const msg = JSON.parse(event.data as string) as WsUpdateMessage;
                if (msg.type === 'update' && msg.entity) {
                    notify(msg.entity);
                }
            } catch {
                // ignore malformed frames
            }
        };

        ws.onclose = () => {
            clearPing();
            if (unmounted.current) return;

            // Exponential back-off reconnection
            reconnectTimer.current = setTimeout(() => {
                reconnectDelay.current = Math.min(
                    reconnectDelay.current * 2,
                    RECONNECT_MAX_DELAY_MS,
                );
                connect();
            }, reconnectDelay.current);
        };

        ws.onerror = () => {
            // onclose will fire after onerror, reconnect handled there
            ws.close();
        };
    }, [user, notify]);

    // Connect when user is available, disconnect on logout
    useEffect(() => {
        if (IS_FIREBASE) return;
        unmounted.current = false;

        if (user) {
            connect();
        }

        return () => {
            unmounted.current = true;
            clearPing();
            if (reconnectTimer.current) {
                clearTimeout(reconnectTimer.current);
            }
            if (wsRef.current) {
                wsRef.current.onclose = null;
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [user, connect]);

    useEffect(() => {
        if (!IS_FIREBASE || !user?.family_id) { setRealtimeError(null); return; }
        const onStatus = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            setRealtimeError(detail.status === 'connected' ? null : detail.message || 'Sin conexion en tiempo real. Intentando reconectar.');
        };
        const onOffline = () => setRealtimeError('Sin conexion. Las acciones solo se guardan cuando el servidor las confirma.');
        const onOnline = () => setRealtimeError('Conexion recuperada. Esperando la sincronizacion.');
        window.addEventListener(FIREBASE_REALTIME_EVENT, onStatus);
        window.addEventListener('offline', onOffline);
        window.addEventListener('online', onOnline);
        const unsubscribe = subscribeFirebaseFamily(user.family_id, entity => notify(entity as WsEntity));
        if (!navigator.onLine) onOffline();
        return () => {
            unsubscribe();
            window.removeEventListener(FIREBASE_REALTIME_EVENT, onStatus);
            window.removeEventListener('offline', onOffline);
            window.removeEventListener('online', onOnline);
        };
    }, [user?.id, user?.family_id, user?.role, user?.is_owner, user?.member_id, notify]);

    const subscribe = useCallback((entity: WsEntity, cb: Subscriber): (() => void) => {
        if (IS_FIREBASE) {
            const pageEntity = entity === 'tasks' && pathname === '/rewards' ? 'rewards' : entity;
            return user?.family_id ? subscribeFirebaseEntity(user.family_id, pageEntity, cb) : () => {};
        }
        if (!subscribers.current.has(entity)) {
            subscribers.current.set(entity, new Set());
        }
        subscribers.current.get(entity)!.add(cb);

        return () => {
            subscribers.current.get(entity)?.delete(cb);
        };
    }, [user?.id, user?.family_id, user?.role, user?.is_owner, user?.member_id, pathname]);

    return (
        <WebSocketContext.Provider value={{ subscribe }}>
            {IS_FIREBASE && user?.family_id && realtimeError && (
                <div role="status" className="border-b border-border bg-card px-4 py-2 text-center text-body-sm text-destructive">
                    {realtimeError}
                </div>
            )}
            {children}
        </WebSocketContext.Provider>
    );
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export const useWebSocket = (): WebSocketContextType => {
    const ctx = useContext(WebSocketContext);
    if (!ctx) {
        throw new Error('useWebSocket must be used inside <WebSocketProvider>');
    }
    return ctx;
};
