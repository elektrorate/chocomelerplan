import { initializeApp } from 'firebase/app';
import { browserLocalPersistence, connectAuthEmulator, getAuth, setPersistence } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache } from 'firebase/firestore';

export const IS_DEMO = import.meta.env.VITE_DEMO === 'true';
export const IS_FIREBASE = !IS_DEMO && import.meta.env.VITE_DATA_BACKEND !== 'legacy';

export function getFirebaseConfigError(): string | null {
    if (!IS_FIREBASE) return null;
    const backend = import.meta.env.VITE_DATA_BACKEND;
    if (backend && backend !== 'firebase') return 'VITE_DATA_BACKEND debe ser firebase o legacy.';
    if (import.meta.env.VITE_FIREBASE_USE_EMULATORS === 'true') {
        if (!import.meta.env.DEV || !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) {
            return 'Los emuladores Firebase solo se permiten en desarrollo local.';
        }
        if (!(import.meta.env.VITE_FIREBASE_PROJECT_ID || 'demo-chocomelerplan').startsWith('demo-')) {
            return 'Los emuladores requieren un proyecto ficticio cuyo ID comience por demo-.';
        }
        return null;
    }
    const required = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'] as const;
    const missing = required.filter(key => !import.meta.env[key]?.trim());
    return missing.length ? `Falta la configuracion publica de Firebase: ${missing.join(', ')}. No se usara otro backend ni datos de demostracion.` : null;
}

function initializeFirebase() {
    if (!IS_FIREBASE) throw new Error('Firebase no esta activo en este modo.');
    const error = getFirebaseConfigError();
    if (error) throw new Error(error);
    const emulators = import.meta.env.VITE_FIREBASE_USE_EMULATORS === 'true';
    const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || 'demo-chocomelerplan';
    const app = initializeApp({
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'demo-api-key',
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
        projectId,
        appId: import.meta.env.VITE_FIREBASE_APP_ID || 'demo-app-id',
    }, 'chocomelerplan-client');
    const auth = getAuth(app);
    const db = initializeFirestore(app, { localCache: memoryLocalCache() });
    if (emulators) {
        connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        connectFirestoreEmulator(db, '127.0.0.1', 8080);
    }
    const ready = setPersistence(auth, browserLocalPersistence);
    // The provider surfaces persistence errors; avoid an unhandled rejection meanwhile.
    void ready.catch(() => undefined);
    return { app, auth, db, ready };
}

let firebase: ReturnType<typeof initializeFirebase> | undefined;

export function getFirebase() {
    return firebase ??= initializeFirebase();
}
