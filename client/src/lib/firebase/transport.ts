import {
    confirmPasswordReset, createUserWithEmailAndPassword, sendPasswordResetEmail,
    sendEmailVerification, signInWithEmailAndPassword, signOut, updateProfile, verifyPasswordResetCode,
} from 'firebase/auth';
import { doc, limit, onSnapshot, query, where, type QueryConstraint } from 'firebase/firestore';
import { getFirebase } from './config';
import { col, emitSparkChange, getAccount, getContext, object, SPARK_CHANGE_EVENT, unsupported, wire, type Json } from './spark/core';
import { handleIdentity } from './spark/identity';
import { handleTasks } from './spark/tasks';
import { detectOverdueTasks, handlePenalties } from './spark/penalties';
import { handleModules } from './spark/modules';
import type { DashboardPrefs } from '../../contexts/AuthContext';

export interface FirebaseUserProfile {
    id: string;
    email: string;
    name: string;
    family_id: string | null;
    member_id?: string | null;
    role?: 'parent' | 'enfant';
    is_owner: boolean;
    language?: string;
    currency?: string;
    avatar_url?: string | null;
    week_start_day?: number | null;
    disabled_modules?: string[];
    dashboard_prefs?: DashboardPrefs;
}
type UserResponse = { success: true; data: { user: FirebaseUserProfile } };
export const FIREBASE_AUTH_REFRESH_EVENT = 'openfamily:firebase-auth-refresh';
export const FIREBASE_REALTIME_EVENT = 'openfamily:firebase-realtime';

export function firebaseError(error: unknown): Error & { code?: string } {
    const source = error as { code?: string; message?: string; name?: string } | null;
    const code = source?.code;
    if (source?.name === 'Error' && source.message) return Object.assign(new Error(source.message), { code });
    const messages: Record<string, string> = {
        'auth/invalid-email': 'El correo electronico no es valido.',
        'auth/invalid-credential': 'El correo o la contrasena no son correctos.',
        'auth/user-not-found': 'El correo o la contrasena no son correctos.',
        'auth/wrong-password': 'El correo o la contrasena no son correctos.',
        'auth/email-already-in-use': 'Ya existe una cuenta con este correo.',
        'auth/weak-password': 'La contrasena es demasiado debil. Usa al menos 8 caracteres.',
        'auth/user-disabled': 'Esta cuenta esta deshabilitada.',
        'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos antes de reintentar.',
        'auth/network-request-failed': 'No se pudo conectar con Firebase. Comprueba tu conexion y reintenta.',
        'auth/expired-action-code': 'El enlace ha caducado. Solicita uno nuevo.',
        'auth/invalid-action-code': 'El enlace no es valido o ya se ha utilizado.',
        'auth/operation-not-allowed': 'El acceso por correo y contrasena no esta habilitado en Firebase.',
        'auth/invalid-api-key': 'La clave publica de Firebase no es valida. Revisa VITE_FIREBASE_API_KEY.',
        'auth/app-not-authorized': 'Esta aplicacion no esta autorizada en el proyecto Firebase.',
        'auth/unauthorized-domain': 'Este dominio no esta autorizado en Firebase Authentication.',
        'auth/user-token-expired': 'La sesion ha caducado. Vuelve a iniciar sesion.',
        'auth/invalid-user-token': 'No se pudo validar la sesion. Vuelve a iniciar sesion.',
        'auth/requires-recent-login': 'Vuelve a iniciar sesion para realizar esta accion.',
        'permission-denied': 'No tienes permiso para esta accion o las reglas no permiten estos datos.',
        'unavailable': 'No hay conexion con Firestore. No se ha confirmado la operacion. Comprueba tu conexion.',
        'resource-exhausted': 'Se ha alcanzado la cuota gratuita de Firestore. Reintenta cuando se restablezca.',
        'failed-precondition': source?.message?.includes('index') ? 'Esta consulta requiere un indice de Firestore. Solicita su configuracion sin activar facturacion.' : source?.message || 'No se cumplen las condiciones de la operacion.',
        'deadline-exceeded': 'El servidor no respondio a tiempo. Comprueba el resultado antes de repetir la accion.',
        'unimplemented': source?.message || 'Esta operacion no esta disponible en Firebase Spark.',
    };
    const fallback = code?.startsWith('auth/') ? `No se pudo completar la autenticacion con Firebase (${code}).` : source?.message || 'No se pudo completar la operacion en Firebase Spark.';
    return Object.assign(new Error((code && messages[code]) || fallback), { code });
}

let scope = { uid: null as string | null, familyId: null as string | null };
let authorityKey = '';
let sessionVersion = 0;
const entityVersions = new Map<string, number>();
type CacheEntry = { entities: string[]; value?: unknown; promise?: Promise<unknown> };
const cache = new Map<string, CacheEntry>();
type Hub = { callbacks: Set<() => void>; stop: () => void };
const hubs = new Map<string, Hub>();
const localSubscribers = new Map<string, Set<() => void>>();
let changeBridgeStarted = false;
let scan: { key: string; promise: Promise<void> } | null = null;

function entitiesFor(path: string): string[] {
    if (path === '/categories') return ['recipes', 'shopping', 'budget'];
    if (path.startsWith('/auth/')) return path === '/auth/modules' ? ['auth', 'family'] : ['auth'];
    if (path.startsWith('/tasks')) return ['tasks'];
    if (path.startsWith('/penalties') || path.startsWith('/rewards')) return ['rewards'];
    if (path.startsWith('/family') || path.startsWith('/families') || path.startsWith('/invites')) return ['family'];
    if (path.startsWith('/recipes')) return ['recipes'];
    if (path.startsWith('/meal-plans')) return ['meal-plans'];
    if (path.startsWith('/planning')) return ['planning'];
    if (path.startsWith('/appointments')) return ['appointments'];
    if (path.startsWith('/shopping')) return ['shopping'];
    if (path.startsWith('/budget')) return ['budget'];
    if (path.startsWith('/notes')) return ['notes'];
    return ['dashboard', 'family', 'tasks', 'recipes', 'meal-plans', 'planning', 'appointments', 'shopping', 'budget', 'notes', 'rewards'];
}

export function invalidateFirebaseCache(entity?: string) {
    const affected = entity === 'categories' ? ['recipes', 'shopping', 'budget'] : entity === 'family' ? ['family', 'auth', 'tasks', 'planning', 'appointments', 'meal-plans', 'rewards', 'budget']
        : entity === 'recipes' ? ['recipes', 'tasks', 'meal-plans'] : entity === 'tasks' ? ['tasks', 'rewards'] : entity ? [entity] : null;
    if (!affected) { cache.clear(); entityVersions.clear(); scan = null; return; }
    for (const key of affected) entityVersions.set(key, (entityVersions.get(key) || 0) + 1);
    for (const [key, entry] of cache) if (entry.entities.some(item => affected.includes(item))) cache.delete(key);
}

function startChangeBridge() {
    if (changeBridgeStarted) return;
    changeBridgeStarted = true;
    window.addEventListener(SPARK_CHANGE_EVENT, event => {
        const detail = (event as CustomEvent).detail;
        if (detail.uid !== scope.uid) return;
        invalidateFirebaseCache(detail.entity);
        localSubscribers.get(detail.entity)?.forEach(callback => callback());
        if (detail.entity === 'rewards') localSubscribers.get('tasks')?.forEach(callback => callback());
    });
}

export function setFirebaseSession(uid: string | null, familyId: string | null, membershipKey = '') {
    if (scope.uid === uid && scope.familyId === familyId && authorityKey === membershipKey) return;
    scope = { uid, familyId };
    authorityKey = membershipKey;
    sessionVersion++;
    invalidateFirebaseCache();
    for (const hub of hubs.values()) hub.stop();
    hubs.clear(); localSubscribers.clear();
}

export function requestFirebaseAuthRefresh() {
    sessionVersion++;
    invalidateFirebaseCache();
    window.dispatchEvent(new CustomEvent(FIREBASE_AUTH_REFRESH_EVENT, { detail: { blocking: true } }));
}

function normalize(endpoint: string) {
    if (!endpoint.startsWith('/') || endpoint.startsWith('//') || /[#\\\x00-\x1f]/.test(endpoint)) throw new Error('La ruta de datos no es valida.');
    const [raw, search = ''] = endpoint.split('?');
    const path = raw.replace(/^\/api(?=\/|$)/, '').replace(/\/$/, '') || '/';
    if (path.split('/').some(part => part === '.' || part === '..') || /%|\/\//.test(path)) throw new Error('La ruta de datos no es valida.');
    const q: Json = Object.create(null);
    for (const [key, value] of new URLSearchParams(search)) {
        if (Object.prototype.hasOwnProperty.call(q, key)) throw new Error('Los parametros de consulta no pueden repetirse.');
        q[key] = value;
    }
    return { path, q };
}

export async function detectFirebaseOverdueTasks(familyId: string, force = false): Promise<void> {
    const ctx = await getContext();
    if (ctx.familyId !== familyId) return;
    const key = JSON.stringify([ctx.uid, familyId, entityVersions.get('tasks') || 0]);
    if (!force && scan?.key === key) return scan.promise;
    const version = sessionVersion;
    const promise = detectOverdueTasks(ctx, () => version === sessionVersion && scope.uid === ctx.uid && scope.familyId === familyId);
    scan = { key, promise };
    void promise.catch(() => { if (scan?.promise === promise) scan = null; });
    return promise;
}

export async function firebaseRequest<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const { auth, ready } = getFirebase();
    await ready; await auth.authStateReady(); startChangeBridge();
    const uid = auth.currentUser?.uid ?? null;
    if (scope.uid !== uid) setFirebaseSession(uid, null);
    const { path, q } = normalize(endpoint);
    const input = body === undefined || body === null ? {} : object(body);
    const version = sessionVersion;
    const key = JSON.stringify([uid, scope.familyId, endpoint]);
    const entities = entitiesFor(path);
    const versions = entities.map(entity => entityVersions.get(entity) || 0);
    if (method === 'GET') {
        const existing = cache.get(key);
        if (existing?.promise) return existing.promise as Promise<T>;
        if (existing && 'value' in existing) return existing.value as T;
    }
    const entry: CacheEntry = { entities };
    const operation = (async () => {
        try {
            let response = await handleIdentity(method, path, q, input);
            let moduleMutation = false;
            if (response === undefined) {
                const ctx = await getContext();
                if (scope.familyId && ctx.familyId !== scope.familyId) { requestFirebaseAuthRefresh(); throw new Error('La familia activa ha cambiado.'); }
                if (path === '/penalties' && method === 'GET') await detectFirebaseOverdueTasks(ctx.familyId, true);
                for (const handler of [handleTasks, handlePenalties, handleModules]) {
                    response = await handler(ctx, method, path, q, input);
                    if (response !== undefined) { moduleMutation = handler === handleModules && method !== 'GET'; break; }
                }
            }
            if (response === undefined) unsupported();
            if (response?.success !== true) throw new Error(response?.error || 'La operacion de Firestore no se ha confirmado.');
            const membershipAcknowledgement = method !== 'GET' && response?.data?.user?.id === uid &&
                ['/auth/bootstrap', '/families', '/invites/join', '/invites/leave'].includes(path);
            if (auth.currentUser?.uid !== uid || (version !== sessionVersion && !membershipAcknowledgement)) throw new Error('La sesion o la familia ha cambiado. Reintenta la consulta.');
            if (method !== 'GET') for (const entity of entities) invalidateFirebaseCache(entity);
            if (moduleMutation) for (const entity of entities) emitSparkChange(entity);
            const result = wire(response) as T;
            if (method === 'GET' && cache.get(key) === entry && entities.every((entity, index) => (entityVersions.get(entity) || 0) === versions[index])) {
                entry.value = result;
            }
            return result;
        } catch (error) {
            if (version === sessionVersion && (error as { code?: string }).code === 'membership-revoked') requestFirebaseAuthRefresh();
            throw firebaseError(error);
        } finally {
            if (cache.get(key) === entry) {
                delete entry.promise;
                if (!('value' in entry)) cache.delete(key);
            }
        }
    })();
    if (method === 'GET') { entry.promise = operation; cache.set(key, entry); }
    return operation;
}

let authOperation: Promise<unknown> | null = null;
let bootstrap: { uid: string; name: string; inviteToken?: string } | null = null;
export async function waitForFirebaseAuthOperation() { if (authOperation) await authOperation; }

export async function firebaseRestoreUser(): Promise<UserResponse> {
    const { auth, ready } = getFirebase();
    await ready; await auth.authStateReady();
    const account = auth.currentUser;
    if (!account) throw new Error('No hay una sesion activa.');
    invalidateFirebaseCache('auth');
    if (bootstrap && bootstrap.uid === account.uid) {
        const { name, inviteToken } = bootstrap;
        const response = await firebaseRequest<UserResponse>('POST', '/api/auth/bootstrap', { name, ...(inviteToken ? { inviteToken } : {}) });
        bootstrap = null;
        return response;
    }
    try { return await firebaseRequest<UserResponse>('GET', '/api/auth/me'); }
    catch (error) {
        if ((error as { code?: string }).code !== 'not-found') throw error;
        if (auth.currentUser?.uid !== account.uid) throw new Error('La sesion ha cambiado.');
        return firebaseRequest<UserResponse>('POST', '/api/auth/bootstrap', { name: account.displayName || account.email?.split('@')[0] || 'Mi cuenta' });
    }
}

export function firebaseSignIn(email: string, password: string) {
    const operation = (async () => {
        try {
            const { auth, ready } = getFirebase(); await ready; await auth.authStateReady();
            const account = await signInWithEmailAndPassword(auth, email, password);
            setFirebaseSession(account.user.uid, null);
            return { success: true, ...(await firebaseRestoreUser()).data };
        } catch (error) { throw firebaseError(error); }
    })();
    authOperation = operation;
    void operation.finally(() => { if (authOperation === operation) authOperation = null; }).catch(() => undefined);
    return operation;
}

export function firebaseRegister(email: string, password: string, name: string, inviteToken?: string) {
    const operation = (async () => {
        try {
            const { auth, ready } = getFirebase(); await ready; await auth.authStateReady();
            const account = await createUserWithEmailAndPassword(auth, email, password);
            setFirebaseSession(account.user.uid, null); bootstrap = { uid: account.user.uid, name, inviteToken };
            await updateProfile(account.user, { displayName: name });
            return { success: true, ...(await firebaseRestoreUser()).data };
        } catch (error) { throw firebaseError(error); }
    })();
    authOperation = operation;
    void operation.finally(() => { if (authOperation === operation) authOperation = null; }).catch(() => undefined);
    return operation;
}

export async function firebaseSignOut(): Promise<void> {
    const { auth, ready } = getFirebase(); await ready; await auth.authStateReady();
    setFirebaseSession(null, null); invalidateFirebaseCache();
    try { await signOut(auth); bootstrap = null; } catch (error) { throw firebaseError(error); }
}
export async function firebaseForgotPassword(email: string) {
    try { const { auth, ready } = getFirebase(); await ready; await sendPasswordResetEmail(auth, email); } catch (error) { throw firebaseError(error); }
}
export async function firebaseSendEmailVerification() {
    try { await sendEmailVerification(await getAccount()); } catch (error) { throw firebaseError(error); }
}
export async function firebaseVerifyPasswordReset(oobCode: string) {
    try { const { auth, ready } = getFirebase(); await ready; return await verifyPasswordResetCode(auth, oobCode); } catch (error) { throw firebaseError(error); }
}
export async function firebaseResetPassword(oobCode: string, password: string) {
    try { const { auth, ready } = getFirebase(); await ready; await confirmPasswordReset(auth, oobCode, password); } catch (error) { throw firebaseError(error); }
}

function realtimeStatus(status: string, message?: string) {
    window.dispatchEvent(new CustomEvent(FIREBASE_REALTIME_EVENT, { detail: { status, message } }));
}

function sharedListener(key: string, callback: () => void, start: (notify: () => void) => () => void) {
    let hub = hubs.get(key);
    if (!hub) {
        const callbacks = new Set<() => void>();
        hub = { callbacks, stop: start(() => callbacks.forEach(cb => cb())) };
        hubs.set(key, hub);
    }
    hub.callbacks.add(callback);
    const subscribedHub = hub;
    return () => {
        subscribedHub.callbacks.delete(callback);
        if (!subscribedHub.callbacks.size) { subscribedHub.stop(); if (hubs.get(key) === subscribedHub) hubs.delete(key); }
    };
}

export function subscribeFirebaseEntity(familyId: string, entity: string, callback: () => void): () => void {
    startChangeBridge();
    if (entity === 'rewards') invalidateFirebaseCache('rewards');
    let active = true;
    const version = sessionVersion;
    const stops: Array<() => void> = [];
    const localKey = entity;
    if (!localSubscribers.has(localKey)) localSubscribers.set(localKey, new Set());
    localSubscribers.get(localKey)!.add(callback);
    void (async () => {
        try {
            const ctx = await getContext();
            if (!active || version !== sessionVersion || ctx.familyId !== familyId) return;
            if (entity === 'budget' && ctx.role === 'child') return;
            const collections: Record<string, string[]> = {
                tasks: ['tasks', 'members'], recipes: ['recipes', 'settings'], 'meal-plans': ['mealPlans'], planning: ['planningEntries', 'members'],
                appointments: ['calendarEvents', 'members'], shopping: ['shoppingItems', 'shoppingTemplates', 'settings'],
                budget: ['budgetEntries', 'budgetLimits', 'budgetRecurring', 'kakeiboMonths', 'privateProfiles', 'members', 'settings'],
                family: ['members', 'memberships', ...(ctx.role === 'child' ? [] : ['privateProfiles'])],
                notes: ['notes'], rewards: ['penalties', 'penaltyTotals', 'tasks', 'members'],
            };
            const watches = (collections[entity] || []).flatMap(name =>
                (name === 'penalties' ? ['review', 'pending', 'history'] : ['default']).map(variant => ({ name, variant })));
            for (const { name, variant } of watches) {
                const constraints: QueryConstraint[] = [];
                if (name === 'tasks') {
                    constraints.push(where('deleted_at', '==', null));
                    if (entity === 'rewards') constraints.push(where('is_completed', '==', false));
                    if (ctx.role === 'child') { if (!ctx.memberId) continue; constraints.push(where('assigned_to', 'array-contains', ctx.memberId)); }
                }
                if (name === 'recipes') constraints.push(where('deleted_at', '==', null));
                if (name === 'penalties' && ctx.role === 'child') { if (!ctx.memberId) continue; constraints.push(where('member_id', '==', ctx.memberId)); }
                if (name === 'penalties') constraints.push(variant === 'history' ? where('status', 'in', ['forgiven', 'paid']) : where('status', '==', variant));
                const ownTotal = name === 'penaltyTotals' && ctx.role === 'child';
                if (ownTotal && !ctx.memberId) continue;
                const discriminator = name === 'tasks' && entity === 'rewards' ? 'pending-tasks' : variant;
                const key = JSON.stringify([ctx.uid, familyId, name, discriminator, ctx.role, ctx.memberId]);
                const changeEntity = name === 'settings' ? 'categories' : ['members', 'memberships', 'privateProfiles'].includes(name) ? 'family'
                    : name === 'tasks' ? 'tasks' : entity;
                stops.push(sharedListener(key, callback, notify => {
                    let initial = true;
                    if (ownTotal) {
                        let previous: string | null = null;
                        return onSnapshot(doc(col(ctx, name), ctx.memberId!), { includeMetadataChanges: true }, snapshot => {
                            if (ctx.uid !== scope.uid || familyId !== scope.familyId || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
                            const next = JSON.stringify(wire(snapshot.data() || {}));
                            if (previous !== null && next !== previous) { invalidateFirebaseCache('rewards'); notify(); }
                            previous = next;
                        }, error => { if (ctx.uid === scope.uid && familyId === scope.familyId) { requestFirebaseAuthRefresh(); realtimeStatus('error', firebaseError(error).message); } });
                    }
                    return onSnapshot(query(col(ctx, name), ...constraints, limit(200)), { includeMetadataChanges: true }, snapshot => {
                        if (ctx.uid !== scope.uid || familyId !== scope.familyId) return;
                        const server = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
                        realtimeStatus(server ? 'connected' : 'reconnecting');
                        if (!server) return;
                        if (!initial && snapshot.docChanges().length) { invalidateFirebaseCache(changeEntity); notify(); }
                        initial = false;
                    }, error => {
                        if (ctx.uid !== scope.uid || familyId !== scope.familyId) return;
                        invalidateFirebaseCache(entity);
                        if (error.code === 'permission-denied') requestFirebaseAuthRefresh();
                        realtimeStatus('error', firebaseError(error).message);
                    });
                }));
            }
        } catch (error) {
            if (active && version === sessionVersion) { if ((error as { code?: string }).code === 'membership-revoked') requestFirebaseAuthRefresh(); realtimeStatus('error', firebaseError(error).message); }
        }
    })();
    return () => { active = false; stops.forEach(stop => stop()); localSubscribers.get(localKey)?.delete(callback); };
}

export function subscribeFirebaseFamily(familyId: string, callback: (entity: string) => void, onError?: (error: Error) => void): () => void {
    const { db, auth } = getFirebase();
    const uid = auth.currentUser?.uid;
    if (!uid) return () => {};
    const stops = [doc(db, 'families', familyId), doc(db, 'families', familyId, 'memberships', uid)].map(ref => {
        let previous: string | null = null;
        return sharedListener(`${uid}:${ref.path}`, () => callback('family'), notify => onSnapshot(ref, { includeMetadataChanges: true }, snapshot => {
            if (uid !== scope.uid || familyId !== scope.familyId) return;
            const server = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
            realtimeStatus(server ? 'connected' : 'reconnecting');
            if (!server) return;
            if (!snapshot.exists()) { requestFirebaseAuthRefresh(); return; }
            const next = JSON.stringify(wire(snapshot.data()));
            if (previous !== null && next !== previous) { invalidateFirebaseCache('family'); notify(); requestFirebaseAuthRefresh(); }
            previous = next;
        }, error => {
            if (uid !== scope.uid || familyId !== scope.familyId) return;
            requestFirebaseAuthRefresh(); const translated = firebaseError(error); realtimeStatus('error', translated.message); onError?.(translated);
        }));
    });
    return () => stops.forEach(stop => stop());
}
