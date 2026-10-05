import {
    collection, doc, getDocFromServer, getDocsFromServer, limit, query, runTransaction,
    serverTimestamp, Timestamp, type CollectionReference, type QueryConstraint, type Transaction,
} from 'firebase/firestore';
import { DateTime } from 'luxon';
import { getFirebase } from '../config';

export type Json = Record<string, any>;
export type SparkContext = {
    familyId: string;
    uid: string;
    role: 'admin' | 'adult' | 'child';
    memberId: string | null;
    displayName: string;
};
export const SPARK_CHANGE_EVENT = 'openfamily:spark-change';
export const MAX_RESULTS = 200;
export const TIMEZONE = 'Europe/Madrid';

export function fail(message: string, code = 'invalid-argument'): never {
    throw Object.assign(new Error(message), { code });
}

export function unsupported(message = 'Esta operacion no esta disponible en Firebase Spark.'): never {
    return fail(message, 'unimplemented');
}

export function object(value: unknown, allowed?: readonly string[]): Json {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Los datos deben ser un objeto.');
    const result = value as Json;
    if (allowed && Object.keys(result).some(key => !allowed.includes(key))) fail('La operacion contiene campos no admitidos.');
    return result;
}

export function text(value: unknown, name: string, max = 100, min = 0): string {
    if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail(`El campo ${name} no es valido.`);
    return value.trim();
}

export function id(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value)) fail('El identificador no es valido.');
    return value;
}

export function ids(value: unknown, max = 3): string[] {
    if (!Array.isArray(value) || value.length > max) fail(`Se admiten como maximo ${max} responsables.`);
    const result = value.map(id);
    if (new Set(result).size !== result.length) fail('Los identificadores no pueden repetirse.');
    return result;
}

export function enumValue<T extends string>(value: unknown, values: readonly T[], name: string): T {
    if (!values.includes(value as T)) fail(`El campo ${name} no es valido.`);
    return value as T;
}

export async function getAccount() {
    const { auth, ready } = getFirebase();
    await ready;
    await auth.authStateReady();
    if (!auth.currentUser) fail('Inicia sesion para continuar.', 'unauthenticated');
    return auth.currentUser;
}

export async function getContext(): Promise<SparkContext> {
    const account = await getAccount();
    const { db, auth } = getFirebase();
    const profile = await getDocFromServer(doc(db, 'users', account.uid));
    if (!profile.exists()) fail('Es necesario crear tu perfil.', 'not-found');
    const familyId = profile.data().active_family_id;
    if (!familyId) fail('Crea una familia o acepta una invitacion.', 'failed-precondition');
    id(familyId);
    const membership = await getDocFromServer(doc(db, 'families', familyId, 'memberships', account.uid));
    if (!membership.exists()) fail('Ya no perteneces a esta familia.', 'membership-revoked');
    const member = membership.data();
    const role = enumValue(member.role, ['admin', 'adult', 'child'] as const, 'role');
    if (auth.currentUser?.uid !== account.uid) fail('La sesion ha cambiado.', 'session-changed');
    return { familyId, uid: account.uid, role, memberId: member.member_id || null, displayName: profile.data().name };
}

export function col(ctx: SparkContext, name: string): CollectionReference {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) fail('Coleccion no valida.');
    return collection(getFirebase().db, 'families', id(ctx.familyId), name);
}

export async function list(ctx: SparkContext, name: string, constraints: QueryConstraint[] = []): Promise<Json[]> {
    const snapshot = await getDocsFromServer(query(col(ctx, name), ...constraints, limit(MAX_RESULTS)));
    return snapshot.docs.map(row => ({ ...row.data(), id: row.id }));
}

export async function getRecord(ctx: SparkContext, name: string, recordId: string): Promise<Json> {
    const snapshot = await getDocFromServer(doc(col(ctx, name), id(recordId)));
    if (!snapshot.exists()) fail('No se encontro el registro.', 'not-found');
    return { ...snapshot.data(), id: snapshot.id };
}

export function requireAdult(ctx: SparkContext) {
    if (ctx.role === 'child') fail('Solo los adultos pueden realizar esta accion.', 'permission-denied');
}

export function requireAdmin(ctx: SparkContext) {
    if (ctx.role !== 'admin') fail('Solo el administrador puede realizar esta accion.', 'permission-denied');
}

export function assertOnline() {
    if (typeof navigator !== 'undefined' && !navigator.onLine) fail('Esta accion requiere conexion. No se guardan operaciones pendientes sin conexion.', 'unavailable');
}

export async function transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    assertOnline();
    const account = await getAccount();
    const { db, auth } = getFirebase();
    return runTransaction(db, async tx => {
        if (auth.currentUser?.uid !== account.uid) fail('La sesion ha cambiado.', 'session-changed');
        const result = await operation(tx);
        if (auth.currentUser?.uid !== account.uid) fail('La sesion ha cambiado.', 'session-changed');
        return result;
    });
}

export function metadata(ctx: SparkContext, create = false): Json {
    return {
        ...(create ? { created_by: ctx.uid, created_at: serverTimestamp() } : {}),
        updated_by: ctx.uid, updated_at: serverTimestamp(),
    };
}

export function cleanUndefined<T>(value: T): T {
    if (Array.isArray(value)) return value.map(cleanUndefined) as T;
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, cleanUndefined(item)])) as T;
    }
    return value;
}

export function wire<T>(value: T): T {
    if (value instanceof Timestamp) return value.toDate().toISOString() as T;
    if (Array.isArray(value)) return value.map(wire) as T;
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)])) as T;
    }
    return value;
}

export function ok<T>(data: T) { return { success: true as const, data: wire(data) }; }

export function emitSparkChange(entity: string) {
    window.dispatchEvent(new CustomEvent(SPARK_CHANGE_EVENT, { detail: { entity, uid: getFirebase().auth.currentUser?.uid } }));
}

export function deadline(value: unknown): { due_date: string | null; due_at: Timestamp | null } {
    if (value === null || value === '' || value === undefined) return { due_date: null, due_at: null };
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::00)?)?$/.test(value)) fail('El vencimiento debe tener formato YYYY-MM-DD o YYYY-MM-DDTHH:mm.');
    const normalized = value.replace(' ', 'T').slice(0, 16);
    const dateOnly = normalized.length === 10;
    let date = DateTime.fromISO(normalized, { zone: TIMEZONE });
    if (!date.isValid || date.toFormat(dateOnly ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm") !== normalized) fail('La fecha no es valida o la hora no existe por el cambio de horario.');
    date = dateOnly ? date.endOf('day') : date.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0];
    return { due_date: normalized, due_at: Timestamp.fromMillis(date.toMillis()) };
}
