import {
    doc, getDocFromServer, query, queryEqual, Timestamp, where, writeBatch,
    type DocumentReference, type Query, type QueryConstraint, type Transaction,
} from 'firebase/firestore';
import { DateTime } from 'luxon';
import { getFirebase } from '../config';
import { assertOnline, cleanUndefined, col, list as fetchList, metadata, requireAdult, transaction, wire, type Json, type SparkContext } from './core';

const LIMIT = 200;
const ZONE = 'Europe/Madrid';
const pendingLists: Array<{ scope: string; query: Query; result: Promise<Json[]> }> = [];
function list(ctx: SparkContext, name: string, constraints: QueryConstraint[] = []): Promise<Json[]> {
    const scope = JSON.stringify([ctx.uid, ctx.familyId, ctx.role, ctx.memberId]);
    const requestQuery = query(col(ctx, name), ...constraints);
    const current = pendingLists.find(entry => entry.scope === scope && queryEqual(entry.query, requestQuery));
    if (current) return current.result;
    const result = fetchList(ctx, name, constraints).then(rows => {
        // A limit(200) response cannot prove that record 201 is absent. Never present a truncated total/export as complete.
        if (rows.length >= LIMIT) error(`La consulta de ${name} alcanza el limite de 200 registros. Reduce el rango; no se puede garantizar un resultado completo.`, 'resource-exhausted');
        return rows;
    });
    const entry = { scope, query: requestQuery, result };
    pendingLists.push(entry);
    void result.finally(() => { const index = pendingLists.indexOf(entry); if (index >= 0) pendingLists.splice(index, 1); }).catch(() => undefined);
    return result;
}
const CATEGORY_MODULES = ['shopping', 'recipe', 'budget'] as const;
const PILLARS = ['survival', 'wants', 'culture', 'extra'] as const;
export const DEFAULT_CATEGORIES = {
    shopping: ['Alimentation', 'Bebe', 'Menage', 'Sante', 'Autre'],
    recipe: ['Entr\u00e9e', 'Plat', 'Dessert', 'Snack'],
    budget: ['Logement', 'Alimentation', 'Transport', 'Sant\u00e9', 'Loisirs', 'Abonnements', 'Assurance', 'Enfants', 'Maison', 'Autre'],
};
const DEFAULT_PILLARS: Record<string, string> = { Logement: 'survival', Alimentation: 'survival', Transport: 'survival', 'Sant\u00e9': 'survival', Assurance: 'survival', Enfants: 'survival', Loisirs: 'culture', Autre: 'extra' };
const ok = (data: any) => ({ success: true, data: wire(data) });
function error(message: string, code = 'invalid-argument'): never { throw Object.assign(new Error(message), { code }); }
function excluded(feature = 'Esta funcion'): never { return error(`${feature}: funcion excluida de esta version Spark. Solo se usan Authentication y Firestore, sin servicios de pago.`, 'unimplemented'); }
function bounded<T>(rows: T[], label: string, max = LIMIT): T[] {
    if (rows.length > max) error(`${label}: limite de ${max} registros. Reduce el rango o divide la operacion.`, 'resource-exhausted');
    return rows;
}
function object(value: unknown, allowed: readonly string[]): Json {
    if (!value || typeof value !== 'object' || Array.isArray(value)) error('Se requiere un objeto.');
    for (const key of Object.keys(value)) if (!allowed.includes(key)) error(`Campo no permitido: ${key}.`);
    return value as Json;
}
function text(value: unknown, name: string, max: number, min = 0): string {
    if (typeof value !== 'string') error(`${name} debe ser texto.`);
    const result = value.trim();
    if (result.length < min || result.length > max) error(`${name}: longitud ${min}..${max}.`);
    return result;
}
function id(value: unknown): string {
    const result = text(value, 'ID', 128, 1);
    if (!/^[A-Za-z0-9-]{1,128}$/.test(result)) error('ID no valido.');
    return result;
}
function nullableId(value: unknown): string | null { return value === null || value === '' ? null : id(value); }
function integer(value: unknown, name: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) error(`${name}: entero ${min}..${max}.`);
    return value;
}
function queryInteger(value: unknown, name: string, min: number, max: number): number {
    return integer(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value, name, min, max);
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') error('Se requiere un booleano.'); return value; }
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
    if (typeof value !== 'string' || !choices.includes(value as T)) error(`${name} no valido.`);
    return value as T;
}
function nullableText(value: unknown, name: string, max: number): string | null { return value === null || value === '' ? null : text(value, name, max); }
function lines(value: unknown, name: string, max: number, length: number, required = false): string[] {
    if (!Array.isArray(value) || value.length > max || (required && !value.length)) error(`${name}: lista de ${required ? 1 : 0}..${max} elementos.`);
    return value.map(item => text(item, name, length, 1));
}
function ids(value: unknown): string[] {
    if (!Array.isArray(value)) error('Los participantes deben ser una lista.');
    const result = bounded(value.map(id), 'Participantes', 3);
    if (new Set(result).size !== result.length) error('Participantes duplicados.');
    return result;
}
function color(value: unknown): string { const result = text(value, 'color', 7, 7); if (!/^#[a-fA-F0-9]{6}$/.test(result)) error('Color no valido.'); return result; }
export function euroCents(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000_000) error('Importe no valido.');
    const result = Math.round(value * 100);
    if (Math.abs(value * 100 - result) > 0.000001) error('El importe admite como maximo dos decimales.');
    return result;
}
export function dateOnly(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) error('Fecha: YYYY-MM-DD.');
    const parsed = DateTime.fromISO(value, { zone: 'UTC' });
    if (!parsed.isValid || parsed.toISODate() !== value) error('La fecha no existe.');
    return value;
}
function localDateTime(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?)?$/.test(value)) error('Se requiere fecha/hora local sin offset.');
    dateOnly(value.slice(0, 10));
    const local = DateTime.fromISO(value, { zone: ZONE });
    const naive = DateTime.fromISO(value, { zone: 'UTC' });
    const format = "yyyy-MM-dd'T'HH:mm:ss.SSS";
    if (!local.isValid || !naive.isValid || local.toFormat(format) !== naive.toFormat(format)) error('Hora local inexistente en Europe/Madrid.');
    return naive.toFormat(format);
}
function expiry(value: unknown): Timestamp | null {
    if (value === null || value === '') return null;
    const local = DateTime.fromISO(localDateTime(value), { zone: ZONE });
    const millis = Math.min(...local.getPossibleOffsets().map((offset: DateTime) => offset.toMillis()));
    if (millis <= Date.now() || millis > Date.now() + 366 * 86400000) error('La caducidad debe estar dentro del proximo ano.');
    return Timestamp.fromMillis(millis);
}
function optionalDate(value: unknown): string | null { return value === null || value === '' ? null : dateOnly(value); }
function time(value: unknown): string {
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value)) error('Hora: HH:mm.');
    return value.slice(0, 5);
}
export function mealType(value: unknown): 'breakfast' | 'combined' {
    if (value === 'Petit-d\u00e9jeuner' || value === 'breakfast') return 'breakfast';
    if (['D\u00e9jeuner', 'D\u00eener', 'combined'].includes(value as string)) return 'combined';
    return error('Solo se admiten desayuno y almuerzo/cena. Snack historico requiere archivado, no conversion.');
}
const live = (row: Json) => !row.deleted_at && !row.archived_at;
const publicMember = (row: Json): Json => ({ id: row.id, name: row.name, color: row.color, role: row.role, linked_user_id: row.linked_user_id ?? null, deleted_at: row.deleted_at ?? null });
const privateDefaults = () => ({ birthdate: null, allergies: [], medications: [], emergency_contact_name: null, emergency_contact_phone: null, notes: null, monthly_income_cents: 0 });
const baseDefaults = () => ({ name: '', color: '#FF4466', role: 'Autre', linked_user_id: null, deleted_at: null });
const PROFILE_FIELDS = ['name', 'color', 'role', 'birthdate', 'allergies', 'medications', 'emergency_contact_name', 'emergency_contact_phone', 'notes', 'linked_user_id'];

type Rule = (value: unknown) => any;
const str = (name: string, max: number, min = 0): Rule => value => text(value, name, max, min);
const opt = (name: string, max: number): Rule => value => nullableText(value, name, max);
const optInt = (name: string, min: number, max: number): Rule => value => value === null || value === '' ? null : integer(value, name, min, max);
const schemas: Record<string, { fields: Record<string, Rule>; defaults: () => Json; required: string[] }> = {
    recipes: {
        fields: { name: str('name', 200, 1), category: str('category', 50, 1), description: opt('description', 5000), ingredients: value => lines(value, 'ingredients', 100, 1000, true), instructions: value => lines(value, 'instructions', 100, 3000, true), prep_time: optInt('prep_time', 1, 10080), cook_time: optInt('cook_time', 1, 10080), servings: optInt('servings', 1, 1000), difficulty: value => value === null || value === '' ? null : choice(value, ['Facile', 'Moyen', 'Difficile'], 'difficulty'), tags: value => lines(value, 'tags', 30, 50), image_url: value => value === null || value === '' ? null : excluded('Las imagenes de recetas') },
        defaults: () => ({ description: null, prep_time: null, cook_time: null, servings: null, difficulty: null, tags: [], deleted_at: null }), required: ['name', 'category', 'ingredients', 'instructions'],
    },
    mealPlans: {
        fields: { date: dateOnly, meal_type: mealType, recipe_id: nullableId, custom_meal: opt('custom_meal', 500), notes: opt('notes', 2000) },
        defaults: () => ({ recipe_id: null, custom_meal: null, notes: null }), required: ['date', 'meal_type'],
    },
    shoppingItems: {
        fields: { name: str('name', 255, 1), category: str('category', 50, 1), quantity: value => { if (value === null || value === '') return null; if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100000) error('Cantidad no valida.'); return value; }, unit: opt('unit', 30), price: value => value === null || value === '' ? null : euroCents(value), notes: opt('notes', 2000), is_checked: bool },
        defaults: () => ({ quantity: null, unit: null, price_cents: null, notes: null, is_checked: false }), required: ['name', 'category'],
    },
    shoppingTemplates: {
        fields: { name: str('name', 100, 1), items: value => { if (!Array.isArray(value) || !value.length) error('La plantilla necesita productos.'); return bounded(value, 'Productos de plantilla', 20).map(item => validateModule('shoppingItems', item, true)); } }, defaults: () => ({}), required: ['name', 'items'],
    },
    calendarEvents: {
        fields: { title: str('title', 200, 1), description: opt('description', 5000), start_time: localDateTime, end_time: value => value === null || value === '' ? null : localDateTime(value), location: opt('location', 500), family_member_ids: ids, notes: opt('notes', 2000), color, is_all_day: bool, reminder_minutes: value => { if (!Array.isArray(value)) error('Recordatorios no validos.'); const result = bounded(value, 'Recordatorios', 10).map(item => integer(item, 'reminder_minutes', 0, 10080)); if (new Set(result).size !== result.length) error('Recordatorios duplicados.'); return result; }, reminder_30min: bool, reminder_1hour: bool, recurrence_frequency: value => value === 'none' ? 'none' : excluded('Los eventos recurrentes'), recurrence_interval: value => integer(value, 'recurrence_interval', 1, 1), recurrence_until: value => value === null || value === '' ? null : excluded('Los eventos recurrentes') },
        defaults: () => ({ description: null, end_time: null, location: null, family_member_ids: [], notes: null, color: '#DC4A60', is_all_day: false, reminder_minutes: [], recurrence_frequency: 'none', recurrence_interval: 1, recurrence_until: null }), required: ['title', 'start_time'],
    },
    budgetEntries: {
        fields: { category: str('category', 50, 1), amount: euroCents, date: dateOnly, description: opt('description', 2000), is_expense: bool, assigned_to: nullableId, add_to_calendar: value => bool(value) ? excluded('El enlace presupuesto-calendario') : false },
        defaults: () => ({ description: null, is_expense: true, assigned_to: null }), required: ['category', 'amount_cents', 'date'],
    },
    budgetLimits: {
        fields: { category: str('category', 50, 1), monthly_limit: euroCents, month: value => integer(value, 'month', 1, 12), year: value => integer(value, 'year', 1900, 9999) }, defaults: () => ({}), required: ['category', 'monthly_limit_cents', 'month', 'year'],
    },
    budgetRecurring: {
        fields: { label: str('label', 200, 1), amount: value => { const result = euroCents(value); if (!result) error('Se requiere un importe positivo.'); return result; }, category: str('category', 50, 1), start_date: dateOnly, recurrence_frequency: value => choice(value, ['daily', 'weekly', 'monthly', 'yearly'], 'recurrence_frequency'), recurrence_interval: value => integer(value, 'recurrence_interval', 1, 365), recurrence_until: optionalDate, is_expense: bool, is_active: bool, add_to_calendar: value => bool(value) ? excluded('El enlace presupuesto-calendario') : false },
        defaults: () => ({ category: 'Maison', recurrence_frequency: 'monthly', recurrence_interval: 1, recurrence_until: null, is_expense: true, is_active: true }), required: ['label', 'amount_cents', 'start_date'],
    },
    notes: {
        fields: { content: str('content', 500, 1), color: value => choice(value, ['yellow', 'pink', 'blue', 'green', 'orange'], 'color'), expires_at: expiry }, defaults: () => ({ color: 'yellow', expires_at: null }), required: ['content'],
    },
};
export function validateModule(name: string, input: unknown, creating = false): Json {
    const schema = schemas[name];
    if (!schema) error('Modulo no reconocido.');
    const body = object(cleanUndefined(input), Object.keys(schema.fields));
    const output: Json = creating ? schema.defaults() : {};
    for (const [field, value] of Object.entries(body)) {
        const result = schema.fields[field](value);
        if (['image_url', 'add_to_calendar', 'reminder_30min', 'reminder_1hour'].includes(field)) continue;
        output[['price', 'amount', 'monthly_limit'].includes(field) ? `${field}_cents` : field] = result;
    }
    if (name === 'calendarEvents' && !('reminder_minutes' in body) && ('reminder_30min' in body || 'reminder_1hour' in body)) {
        output.reminder_minutes = [...(body.reminder_30min ? [30] : []), ...(body.reminder_1hour ? [60] : [])];
    }
    if (!creating && !Object.keys(output).length) error('No hay campos persistentes que modificar.');
    if (creating) for (const field of schema.required) if (output[field] === undefined) error(`Falta ${field}.`);
    return cleanUndefined(output);
}
function complete(name: string, row: Json): void {
    if (name === 'mealPlans' && !row.recipe_id && !row.custom_meal) error('Se requiere receta o comida personalizada.');
    if (name === 'calendarEvents' && row.end_time && row.end_time < row.start_time) error('La hora final precede a la inicial.');
    if (name === 'budgetRecurring' && row.recurrence_until && row.recurrence_until < row.start_date) error('El fin de recurrencia precede al inicio.');
}
async function record(ctx: SparkContext, name: string, recordId: string): Promise<Json> {
    const snapshot = await getDocFromServer(doc(col(ctx, name), id(recordId)));
    if (!snapshot.exists()) error('Registro no encontrado.', 'not-found');
    return { ...snapshot.data(), id: snapshot.id };
}
async function txRecord(tx: Transaction, ref: DocumentReference, allowArchived = false): Promise<Json> {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists() || (!allowArchived && !live(snapshot.data()))) error('Registro o referencia no encontrado.', 'not-found');
    return { ...snapshot.data(), id: snapshot.id };
}
async function references(tx: Transaction, ctx: SparkContext, row: Json, previous: Json = {}): Promise<void> {
    const members = row.family_member_ids || (row.assigned_to ? [row.assigned_to] : []);
    for (const memberId of members) await txRecord(tx, doc(col(ctx, 'members'), id(memberId)), previous.family_member_ids?.includes(memberId) || previous.assigned_to === memberId);
    if (row.recipe_id) await txRecord(tx, doc(col(ctx, 'recipes'), id(row.recipe_id)), previous.recipe_id === row.recipe_id);
}
function effectiveCategories(data?: Json): typeof DEFAULT_CATEGORIES {
    return { shopping: data?.shopping || DEFAULT_CATEGORIES.shopping, recipe: data?.recipe || DEFAULT_CATEGORIES.recipe, budget: data?.budget || DEFAULT_CATEGORIES.budget };
}
async function readCategories(ctx: SparkContext): Promise<typeof DEFAULT_CATEGORIES> {
    return effectiveCategories((await getDocFromServer(doc(col(ctx, 'settings'), 'categories'))).data());
}
async function checkCategory(tx: Transaction, ctx: SparkContext, name: string, row: Json): Promise<void> {
    const module = name === 'recipes' ? 'recipe' : name.startsWith('shopping') ? 'shopping' : name.startsWith('budget') ? 'budget' : null;
    if (!module) return;
    const configured = effectiveCategories((await tx.get(doc(col(ctx, 'settings'), 'categories'))).data());
    const rows = name === 'shoppingTemplates' ? row.items : [row];
    for (const item of rows) if (!configured[module].includes(item.category)) error('Categoria desconocida.');
}
function recipeView(row: Json): Json { return { ...row, name: !live(row) ? `Archivada: ${row.name}` : row.name, readOnly: !live(row), archived: !live(row), image_url: null }; }
async function hydrate(ctx: SparkContext, name: string, rows: Json[]): Promise<Json[]> {
    const members = ['planningEntries', 'calendarEvents', 'budgetEntries'].includes(name) ? await list(ctx, 'members') : [];
    const byMember = new Map(members.map(row => [row.id, publicMember(row)]));
    const recipes = name === 'mealPlans' ? await list(ctx, 'recipes') : [];
    const byRecipe = new Map(recipes.map(row => [row.id, recipeView(row)]));
    return rows.map(row => {
        if (name === 'recipes') return recipeView(row);
        if (name === 'mealPlans') return { ...row, meal_type: mealType(row.meal_type) === 'breakfast' ? 'Petit-d\u00e9jeuner' : 'D\u00e9jeuner', recipe: row.recipe_id ? byRecipe.get(row.recipe_id) || { id: row.recipe_id, name: 'Receta archivada', readOnly: true, archived: true } : null };
        if (name === 'planningEntries') {
            const participants = row.family_member_ids.map((memberId: string) => byMember.get(memberId) || { id: memberId, name: 'Perfil archivado', color: '#808080', role: 'Autre' });
            return { ...row, participants, participant_ids: row.family_member_ids, family_member_id: row.family_member_ids[0], family_member_name: participants[0]?.name, family_member_color: participants[0]?.color, family_member_role: participants[0]?.role };
        }
        if (name === 'calendarEvents') return { ...row, family_members_data: row.family_member_ids.map((memberId: string) => byMember.get(memberId)).filter(Boolean), reminder_30min: row.reminder_minutes.includes(30), reminder_1hour: row.reminder_minutes.includes(60) };
        if (name === 'shoppingItems') return { ...row, price: row.price_cents === null ? null : row.price_cents / 100 };
        if (name === 'shoppingTemplates') return { ...row, items: row.items.map((item: Json) => ({ ...item, price: item.price_cents === null ? null : item.price_cents / 100 })) };
        if (name === 'budgetEntries') return { ...row, amount: row.amount_cents / 100, assigned_to_name: byMember.get(row.assigned_to)?.name || null, assigned_to_color: byMember.get(row.assigned_to)?.color || null, linked_calendar_event_id: null };
        if (name === 'budgetLimits') return { ...row, monthly_limit: row.monthly_limit_cents / 100 };
        if (name === 'budgetRecurring') return { ...row, amount: row.amount_cents / 100, debit_day: Number(row.start_date.slice(8)), linked_calendar_event_id: null };
        return row;
    });
}

const ROUTES: Record<string, string> = { '/recipes': 'recipes', '/meal-plans': 'mealPlans', '/shopping/templates': 'shoppingTemplates', '/shopping': 'shoppingItems', '/appointments': 'calendarEvents', '/budget/entries': 'budgetEntries', '/budget/limits': 'budgetLimits', '/budget/recurring': 'budgetRecurring', '/notes': 'notes' };
async function filtered(ctx: SparkContext, name: string, input: Json): Promise<Json[]> {
    const allowed: Record<string, string[]> = { recipes: ['category', 'difficulty'], mealPlans: ['start_date', 'end_date'], calendarEvents: ['start_date', 'end_date'], budgetEntries: ['start_date', 'end_date', 'category', 'assigned_to'], budgetLimits: ['month', 'year'] };
    const q = { ...object(input, allowed[name] || []) };
    const constraints: QueryConstraint[] = [];
    for (const field of ['start_date', 'end_date']) if (q[field] !== undefined) q[field] = name === 'calendarEvents' && q[field].length !== 10 ? localDateTime(q[field]) : dateOnly(q[field]);
    const end = name === 'calendarEvents' && q.end_date?.length === 10 ? `${q.end_date}T23:59:59.999` : q.end_date;
    if (q.start_date && end && q.start_date > end) error('Rango de fechas no valido.');
    if (name === 'calendarEvents') { if (end) constraints.push(where('start_time', '<=', end)); }
    else if (['mealPlans', 'budgetEntries'].includes(name)) {
        if (q.start_date) constraints.push(where('date', '>=', q.start_date));
        if (q.end_date) constraints.push(where('date', '<=', q.end_date));
    }
    for (const field of ['category', 'difficulty']) if (q[field] !== undefined) {
        text(q[field], field, 50, 1);
        if (name === 'recipes' || (name === 'budgetEntries' && !q.start_date && !q.end_date)) constraints.push(where(field, '==', q[field]));
    }
    if (q.assigned_to !== undefined) { id(q.assigned_to); if (!q.start_date && !q.end_date) constraints.push(where('assigned_to', '==', q.assigned_to)); }
    for (const [field, min, max] of [['month', 1, 12], ['year', 1900, 9999]] as const) if (q[field] !== undefined) { q[field] = queryInteger(q[field], field, min, max); constraints.push(where(field, '==', q[field])); }
    const rows = await list(ctx, name, constraints);
    return rows.filter(row => (name === 'recipes' || live(row)) &&
        !(name === 'mealPlans' && (row.meal_type === 'Snack' || row.meal_type === 'snack')) &&
        !(name === 'notes' && row.expires_at && row.expires_at.toMillis() <= Date.now()) &&
        !(name === 'calendarEvents' && q.start_date && (row.end_time || row.start_time) < q.start_date) &&
        ['category', 'difficulty', 'assigned_to'].every(field => q[field] === undefined || row[field] === q[field]));
}
async function crud(ctx: SparkContext, method: string, name: string, recordId: string | null, q: Json, input: unknown): Promise<any> {
    if (name.startsWith('budget')) requireAdult(ctx);
    if (method === 'GET') {
        const rows = recordId ? [await record(ctx, name, recordId)] : await filtered(ctx, name, q);
        if (recordId) { object(q, []); if (name !== 'recipes' && (!live(rows[0]) || ['Snack', 'snack'].includes(rows[0].meal_type))) error('Registro archivado.', 'not-found'); }
        rows.sort((a, b) => name === 'notes' || name === 'shoppingItems' ? (b.created_at?.toMillis() || 0) - (a.created_at?.toMillis() || 0) : String(a.date || a.start_time || a.name || a.id).localeCompare(String(b.date || b.start_time || b.name || b.id)));
        const data = await hydrate(ctx, name, rows);
        return ok(recordId ? data[0] : data);
    }
    if (!['POST', 'PUT', 'DELETE'].includes(method) || (method === 'POST' ? !!recordId : !recordId)) return excluded();
    object(q, []);
    const body = method === 'DELETE' ? object(input, []) : object(input, Object.keys(schemas[name].fields));
    const patch = method === 'DELETE' ? {} : validateModule(name, body, method === 'POST');
    const checkOnly = name === 'shoppingItems' && method === 'PUT' && Object.keys(patch).length === 1 && 'is_checked' in patch;
    if (!checkOnly) requireAdult(ctx);
    if (name === 'budgetLimits' && method === 'PUT' && ['category', 'month', 'year'].some(field => field in patch)) error('Usa POST /budget/limits para otra categoria o mes.');
    const limitId = name === 'budgetLimits' && method === 'POST' ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([patch.category, patch.month, patch.year])))), byte => byte.toString(16).padStart(2, '0')).join('') : null;
    const ref = recordId || limitId ? doc(col(ctx, name), id(recordId || limitId)) : doc(col(ctx, name));
    await transaction(async tx => {
        const existing = await tx.get(ref);
        if (method === 'POST' && name !== 'budgetLimits' && existing.exists()) error('Identificador en uso. Reintenta la creacion.', 'already-exists');
        if (method !== 'POST' && (!existing.exists() || !live(existing.data()!))) error('Registro no encontrado.', 'not-found');
        const previous = existing.data() || {};
        if (checkOnly && ctx.role === 'child') {
            if (!ctx.memberId) error('Se requiere un perfil vinculado.', 'permission-denied');
            await txRecord(tx, doc(col(ctx, 'members'), id(ctx.memberId)));
        }
        if (method === 'DELETE') {
            if (name === 'recipes') tx.update(ref, { deleted_at: metadata(ctx).updated_at, ...metadata(ctx) });
            else tx.delete(ref);
            return;
        }
        const row = { ...previous, ...patch };
        if (name === 'mealPlans') {
            if (['Snack', 'snack'].includes(previous.meal_type)) error('Los snacks historicos son de solo lectura.');
            patch.meal_type = mealType(row.meal_type);
        }
        if (name === 'calendarEvents' && !('reminder_minutes' in body) && ('reminder_30min' in body || 'reminder_1hour' in body)) {
            patch.reminder_minutes = [...new Set([...(previous.reminder_minutes || []).filter((minute: number) => !(minute === 30 && 'reminder_30min' in body) && !(minute === 60 && 'reminder_1hour' in body)), ...(body.reminder_30min ? [30] : []), ...(body.reminder_1hour ? [60] : [])])];
        }
        complete(name, row);
        if (!checkOnly) { await references(tx, ctx, row, previous); await checkCategory(tx, ctx, name, row); }
        if (name === 'notes' && !existing.exists()) Object.assign(patch, { author_uid: ctx.uid, author_name: ctx.displayName.slice(0, 100) });
        tx.set(ref, cleanUndefined({ ...patch, ...metadata(ctx, !existing.exists()) }), { merge: true });
    });
    if (method === 'DELETE') return ok({ id: ref.id, deleted: true });
    // Server readback occurs only after the acknowledged commit; never report a local pending write as saved.
    return ok((await hydrate(ctx, name, [await record(ctx, name, ref.id)]))[0]);
}

async function family(ctx: SparkContext, method: string, recordId: string | null, q: Json, input: unknown): Promise<any> {
    object(q, []);
    if (method === 'GET') {
        const base = (recordId ? [await record(ctx, 'members', recordId)] : await list(ctx, 'members')).filter(live);
        if (recordId && !base.length) error('Perfil archivado.', 'not-found');
        // Never even request privateProfiles with a child account: rules, not UI hiding, protect these documents.
        const privateRows = ctx.role === 'child' ? [] : recordId
            ? [await getDocFromServer(doc(col(ctx, 'privateProfiles'), recordId))].filter(snapshot => snapshot.exists()).map(snapshot => ({ ...snapshot.data(), id: snapshot.id }))
            : await list(ctx, 'privateProfiles');
        const byId = new Map<string, Json>(privateRows.map(row => [row.id, row]));
        const data = base.map(row => {
            if (ctx.role === 'child') return publicMember(row);
            const privateRow = byId.get(row.id) || {};
            const extra = Object.fromEntries(Object.keys(privateDefaults()).map(key => [key, privateRow[key] ?? privateDefaults()[key as keyof ReturnType<typeof privateDefaults>]]));
            return { ...row, ...extra, monthly_income: extra.monthly_income_cents / 100 };
        }).sort((a, b) => a.name.localeCompare(b.name));
        return ok(recordId ? data[0] : data);
    }
    if (!['POST', 'PUT', 'DELETE'].includes(method) || (method === 'POST' ? !!recordId : !recordId)) return excluded();
    requireAdult(ctx);
    const body = object(input, method === 'DELETE' ? [] : PROFILE_FIELDS);
    const base: Json = method === 'POST' ? baseDefaults() : {};
    const extra: Json = {};
    for (const [key, value] of Object.entries(body)) {
        if (key === 'name') base.name = text(value, key, 100, 1);
        else if (key === 'color') base.color = color(value);
        else if (key === 'role') base.role = text(value, key, 50, 1);
        else if (key === 'linked_user_id') {
            // The legacy form echoes this field before issuing the separate admin link request.
            // Never persist it here or treat a descriptive profile as an authorization source.
            const linked = nullableId(value);
            if (method === 'POST' && linked) error('Crea el perfil primero y vincula la cuenta mediante /family/:id/link.');
        } else if (key === 'birthdate') extra[key] = optionalDate(value);
        else if (key === 'allergies' || key === 'medications') extra[key] = lines(value, key, 50, 200);
        else extra[key] = nullableText(value, key, key === 'notes' ? 2000 : key === 'emergency_contact_phone' ? 50 : 100);
    }
    if (method === 'POST' && !base.name) error('Falta el nombre.');
    if (method === 'PUT' && !Object.keys(base).length && !Object.keys(extra).length) error('No hay cambios de perfil. Usa el endpoint de vinculacion.');
    const ref = recordId ? doc(col(ctx, 'members'), recordId) : doc(col(ctx, 'members'));
    const privateRef = doc(col(ctx, 'privateProfiles'), ref.id);
    const assignments: Array<{ collection: string; rows: Json[] }> = [];
    if (method === 'DELETE') for (const collection of ['tasks', 'planningEntries', 'calendarEvents']) assignments.push({ collection, rows: await list(ctx, collection, [where(collection === 'tasks' ? 'assigned_to' : 'family_member_ids', 'array-contains', ref.id)]) });
    await transaction(async tx => {
        const current = await tx.get(ref);
        const currentPrivate = method === 'DELETE' ? null : await tx.get(privateRef);
        if (method === 'POST' && (current.exists() || currentPrivate?.exists())) error('Identificador de perfil en uso. Reintenta la creacion.', 'already-exists');
        if (method !== 'POST' && (!current.exists() || !live(current.data()!))) error('Perfil no encontrado.', 'not-found');
        if (method === 'DELETE') {
            if (current.data()!.linked_user_id) error('Desvincula la cuenta antes de archivar el perfil.', 'failed-precondition');
            const now = DateTime.now().setZone(ZONE);
            for (const assignment of assignments) for (const row of assignment.rows) {
                const snapshot = await tx.get(doc(col(ctx, assignment.collection), row.id));
                if (!snapshot.exists() || !live(snapshot.data())) continue;
                const data = snapshot.data();
                const active = assignment.collection === 'tasks' ? !data.is_completed && data.assigned_to.includes(ref.id)
                    : assignment.collection === 'planningEntries' ? data.family_member_ids.includes(ref.id) && (!data.specific_date || DateTime.fromISO(data.specific_date, { zone: 'UTC' }).plus({ days: data.end_time < data.start_time ? 1 : 0 }).toISODate()! >= now.toISODate()!)
                    : data.family_member_ids.includes(ref.id) && (data.end_time || data.start_time) >= now.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");
                if (active) error('El perfil tiene asignaciones activas. Retiralas antes de archivarlo.', 'failed-precondition');
            }
            tx.update(ref, { deleted_at: metadata(ctx).updated_at, ...metadata(ctx) });
            return;
        }
        tx.set(ref, { ...base, ...metadata(ctx, !current.exists()) }, { merge: true });
        tx.set(privateRef, { ...(currentPrivate!.exists() ? {} : privateDefaults()), ...extra, ...metadata(ctx, !currentPrivate!.exists()) }, { merge: true });
    });
    if (method === 'DELETE') return ok({ id: ref.id, deleted: true });
    return family(ctx, 'GET', ref.id, {}, {});
}

const PLANNING_FIELDS = ['family_member_id', 'family_member_ids', 'schedule_type', 'title', 'day_of_week', 'start_time', 'end_time', 'specific_date', 'location', 'notes'];
export function validatePlanning(input: unknown, previous: Json = {}): Json {
    const body = object(cleanUndefined(input), PLANNING_FIELDS);
    const row: Json = { specific_date: null, location: null, notes: null, excluded_dates: [], ...previous };
    if ('family_member_ids' in body) row.family_member_ids = ids(body.family_member_ids);
    else if ('family_member_id' in body) row.family_member_ids = [id(body.family_member_id)];
    if (!row.family_member_ids?.length) error('Se requiere al menos un participante.');
    if ('family_member_ids' in body && 'family_member_id' in body && body.family_member_id !== row.family_member_ids[0]) error('El participante principal no coincide.');
    row.title = text(body.title ?? row.title, 'title', 200, 1);
    row.schedule_type = choice(body.schedule_type ?? row.schedule_type, ['work', 'school', 'study', 'activity', 'other'], 'schedule_type');
    row.day_of_week = integer(body.day_of_week ?? row.day_of_week, 'day_of_week', 1, 7);
    row.start_time = time(body.start_time ?? row.start_time);
    row.end_time = time(body.end_time ?? row.end_time);
    if (row.start_time === row.end_time) error('Las horas inicial y final deben ser diferentes.');
    if ('specific_date' in body) row.specific_date = optionalDate(body.specific_date);
    if (row.specific_date) {
        const date = DateTime.fromISO(row.specific_date, { zone: 'UTC' });
        if (date.weekday !== row.day_of_week) error('El dia de la semana no coincide con la fecha.');
        localDateTime(`${row.specific_date}T${row.start_time}`);
        localDateTime(`${date.plus({ days: row.end_time < row.start_time ? 1 : 0 }).toISODate()}T${row.end_time}`);
    }
    for (const key of ['location', 'notes']) if (key in body) row[key] = nullableText(body[key], key, key === 'notes' ? 2000 : 500);
    return row;
}
export function planningConflict(a: Json, b: Json): boolean {
    if (!a.family_member_ids.some((memberId: string) => b.family_member_ids.includes(memberId))) return false;
    const anchor = DateTime.fromISO(a.specific_date || b.specific_date || '2026-01-05', { zone: 'UTC' });
    const intervals = (row: Json): Array<[number, number]> => {
        const dates = row.specific_date ? [DateTime.fromISO(row.specific_date, { zone: 'UTC' })] : Array.from({ length: 17 }, (_, offset) => anchor.plus({ days: offset - 8 })).filter(date => date.weekday === row.day_of_week && ((!a.specific_date && !b.specific_date) || !row.excluded_dates.includes(date.toISODate())));
        return dates.map(date => [DateTime.fromISO(`${date.toISODate()}T${row.start_time}`, { zone: 'UTC' }).toMillis(), DateTime.fromISO(`${date.plus({ days: row.end_time < row.start_time ? 1 : 0 }).toISODate()}T${row.end_time}`, { zone: 'UTC' }).toMillis()]);
    };
    const ai = intervals(a), bi = intervals(b);
    return ai.some(([as, ae]) => bi.some(([bs, be]) => as < be && bs < ae));
}
async function planningRows(ctx: SparkContext, weekStart?: string): Promise<Json[]> {
    if (!weekStart) return list(ctx, 'planningEntries');
    const from = DateTime.fromISO(dateOnly(weekStart), { zone: 'UTC' });
    const [weekly, specific] = await Promise.all([
        list(ctx, 'planningEntries', [where('specific_date', '==', null)]),
        list(ctx, 'planningEntries', [where('specific_date', '>=', from.minus({ days: 1 }).toISODate()), where('specific_date', '<=', from.plus({ days: 7 }).toISODate())]),
    ]);
    return bounded([...new Map([...weekly, ...specific].map(row => [row.id, row])).values()], 'Planificacion semanal');
}
async function planning(ctx: SparkContext, method: string, path: string, q: Json, input: unknown): Promise<any> {
    const parts = path.split('/').slice(2);
    const recordId = parts[0] && parts[0] !== 'bulk' ? id(parts[0]) : null;
    if (method === 'GET' && parts.length <= 1 && parts[0] !== 'bulk') {
        const query = object(q, ['member_id', 'day_of_week', 'schedule_type', 'week_start']);
        if (query.member_id) id(query.member_id);
        const day = query.day_of_week === undefined ? null : queryInteger(query.day_of_week, 'day_of_week', 1, 7);
        if (query.schedule_type !== undefined) choice(query.schedule_type, ['work', 'school', 'study', 'activity', 'other'], 'schedule_type');
        const week = query.week_start === undefined ? null : DateTime.fromISO(dateOnly(query.week_start), { zone: 'UTC' });
        const rows = recordId ? [await record(ctx, 'planningEntries', recordId)] : await planningRows(ctx, query.week_start);
        const data = await hydrate(ctx, 'planningEntries', rows.filter(row => live(row) && (!query.member_id || row.family_member_ids.includes(query.member_id)) && (day === null || row.day_of_week === day) && (!query.schedule_type || row.schedule_type === query.schedule_type) && (!week || !row.specific_date || (row.specific_date >= week.toISODate()! && row.specific_date < week.plus({ days: 7 }).toISODate()!))).sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)));
        if (recordId && !data.length) error('Registro no encontrado en este filtro.', 'not-found');
        return ok(recordId ? data[0] : data);
    }
    object(q, []); requireAdult(ctx);
    if (recordId && parts[1] === 'exceptions' && ((method === 'POST' && parts.length === 2) || (method === 'DELETE' && parts.length === 3))) {
        const date = method === 'POST' ? dateOnly(object(input, ['date']).date) : (object(input, []), dateOnly(parts[2]));
        const existing = method === 'DELETE' ? await planningRows(ctx, date) : [];
        const ref = doc(col(ctx, 'planningEntries'), recordId);
        await transaction(async tx => {
            const row = await txRecord(tx, ref);
            if (row.specific_date || DateTime.fromISO(date).weekday !== row.day_of_week) error('La excepcion debe corresponder al dia de una serie semanal.');
            const dates = new Set<string>(row.excluded_dates);
            if (method === 'POST') dates.add(date); else dates.delete(date);
            bounded([...dates], 'Excepciones');
            for (const other of existing.filter(item => item.id !== recordId)) {
                const snapshot = await tx.get(doc(col(ctx, 'planningEntries'), other.id));
                if (snapshot.exists() && planningConflict({ ...row, specific_date: date, excluded_dates: [...dates] }, snapshot.data())) error('Restaurar esta fecha crea un conflicto.', 'already-exists');
            }
            tx.update(ref, { excluded_dates: [...dates].sort(), ...metadata(ctx) });
        });
        return ok((await hydrate(ctx, 'planningEntries', [await record(ctx, 'planningEntries', recordId)]))[0]);
    }
    const bulk = path === '/planning/bulk' && method === 'POST';
    if (!bulk && !((method === 'POST' && !parts.length) || (['PUT', 'DELETE'].includes(method) && parts.length === 1 && recordId))) return excluded();
    if (method === 'DELETE') {
        object(input, []);
        await transaction(async tx => { const ref = doc(col(ctx, 'planningEntries'), recordId!); await txRecord(tx, ref); tx.delete(ref); });
        return ok({ id: recordId, deleted: true });
    }
    const body = object(input, bulk ? [...PLANNING_FIELDS.filter(key => !['day_of_week', 'specific_date'].includes(key)), 'day_of_week_list', 'replace_conflicts', 'source_entry_id', 'week_start'] : PLANNING_FIELDS);
    if (!Object.keys(body).length) error('No hay cambios.');
    const days = bulk ? (() => { if (!Array.isArray(body.day_of_week_list) || !body.day_of_week_list.length) error('Se requieren dias.'); const values = bounded(body.day_of_week_list, 'Dias', 7).map(value => integer(value, 'day_of_week', 1, 7)); if (new Set(values).size !== values.length) error('Dias duplicados.'); return values; })() : [];
    const replace = bulk && body.replace_conflicts !== undefined ? bool(body.replace_conflicts) : false;
    const sourceId = bulk ? body.source_entry_id === undefined ? null : nullableId(body.source_entry_id) : recordId;
    const week = bulk && body.week_start !== undefined && body.week_start !== null && body.week_start !== '' ? DateTime.fromISO(dateOnly(body.week_start), { zone: 'UTC' }) : null;
    // Web transactions cannot query collections. Re-read every known document in the transaction;
    // a concurrent INSERT absent from this bounded query can still introduce a scheduling conflict.
    const known = await planningRows(ctx);
    const generatedRefs = (bulk ? days : [0]).map(() => doc(col(ctx, 'planningEntries')));
    const outcome = await transaction(async tx => {
        const previous = sourceId ? await txRecord(tx, doc(col(ctx, 'planningEntries'), sourceId)) : {};
        const existing: Json[] = [];
        for (const row of known.filter(item => item.id !== sourceId)) {
            const snapshot = await tx.get(doc(col(ctx, 'planningEntries'), row.id));
            if (snapshot.exists() && live(snapshot.data())) existing.push({ ...snapshot.data(), id: snapshot.id });
        }
        if (sourceId) existing.push({ ...previous, id: sourceId });
        const payload = Object.fromEntries(Object.entries(body).filter(([key]) => PLANNING_FIELDS.includes(key)));
        const candidates: Json[] = (bulk ? days : [body.day_of_week ?? previous.day_of_week]).map((day, index) => ({
            ...validatePlanning({ ...payload, day_of_week: day, ...(bulk ? { specific_date: week ? week.plus({ days: (day - week.weekday + 7) % 7 }).toISODate() : null } : {}) }, previous),
            id: sourceId && (!bulk || day === previous.day_of_week) ? sourceId : generatedRefs[index].id,
        }));
        for (const row of candidates) await references(tx, ctx, row, previous);
        const conflicts = candidates.map(row => ({ day_of_week: row.day_of_week, conflict_ids: existing.filter(other => other.id !== row.id && planningConflict(row, other)).map(other => other.id) })).filter(row => row.conflict_ids.length);
        for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) if (planningConflict(candidates[a], candidates[b])) error('Los dias seleccionados se solapan entre si.');
        if (conflicts.length && !replace) {
            if (!bulk) error('Horario incompatible para estos participantes.', 'already-exists');
            return { ids: [] as string[], created: 0, updated: 0, conflicts };
        }
        const changes = new Map<string, Json | null>();
        for (const row of candidates) for (const other of existing.filter(entry => entry.id !== row.id && planningConflict(row, entry))) {
            if (row.specific_date && !other.specific_date) {
                const dates = new Set<string>((changes.get(other.id) || other).excluded_dates);
                const date = DateTime.fromISO(row.specific_date, { zone: 'UTC' });
                for (let offset = -1; offset <= 1; offset++) {
                    const occurrence = date.plus({ days: offset });
                    if (occurrence.weekday === other.day_of_week && planningConflict(row, { ...other, specific_date: occurrence.toISODate() })) dates.add(occurrence.toISODate()!);
                }
                bounded([...dates], 'Excepciones'); changes.set(other.id, { excluded_dates: [...dates].sort() });
            } else changes.set(other.id, null);
        }
        bounded([...changes.keys(), ...candidates.map(row => row.id)], 'Escrituras de planificacion', 20);
        for (const [entryId, change] of changes) { const ref = doc(col(ctx, 'planningEntries'), entryId); if (change) tx.update(ref, { ...change, ...metadata(ctx) }); else tx.delete(ref); }
        for (const row of candidates) {
            const ref = doc(col(ctx, 'planningEntries'), row.id);
            const fields = ['family_member_ids', 'day_of_week', 'specific_date', 'start_time', 'end_time', 'excluded_dates', 'title', 'schedule_type', 'location', 'notes'];
            tx.set(ref, { ...Object.fromEntries(fields.map(key => [key, row[key]])), ...metadata(ctx, !existing.some(entry => entry.id === row.id)) }, { merge: true });
        }
        const created = candidates.filter(row => !existing.some(entry => entry.id === row.id)).length;
        return { ids: candidates.map(row => row.id as string), created, updated: candidates.length - created, conflicts: [] };
    });
    const entries = await hydrate(ctx, 'planningEntries', await Promise.all(outcome.ids.map(entryId => record(ctx, 'planningEntries', entryId))));
    return ok(bulk ? { entries, created: outcome.created, updated: outcome.updated, conflicts: outcome.conflicts, conflict_check: 'known-documents-only' } : entries[0]);
}

export function expandRecurring(series: Json[], fromDate: string, endDate: string): Json[] {
    const from = DateTime.fromISO(dateOnly(fromDate), { zone: 'UTC' }); dateOnly(endDate);
    if (fromDate > endDate) return [];
    const rows: Json[] = [];
    for (const row of bounded(series, 'Series recurrentes').filter(item => item.is_active)) {
        const anchor = DateTime.fromISO(dateOnly(row.start_date), { zone: 'UTC' });
        const frequency = choice(row.recurrence_frequency, ['daily', 'weekly', 'monthly', 'yearly'], 'recurrence_frequency');
        const interval = integer(row.recurrence_interval, 'recurrence_interval', 1, 365);
        const unit = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[frequency] as 'days' | 'weeks' | 'months' | 'years';
        const until = row.recurrence_until ? dateOnly(row.recurrence_until) : endDate;
        let index = Math.max(0, Math.floor(from.diff(anchor, unit).get(unit) / interval) - 1);
        for (;; index++) {
            // Advance from the original anchor, never from a clamped February date.
            const date = anchor.plus({ [unit]: index * interval });
            if (!date.isValid || date.year > 9999) break;
            const value = date.toISODate()!;
            if (value > endDate || value > until) break;
            if (value < fromDate) continue;
            rows.push({ ...row, series_id: row.id, date: value, occurrence_date: value, is_recurring_occurrence: true, amount: row.amount_cents / 100, debit_day: date.day, is_pointed: false, pointed_at: null, reconciliation_available: false, linked_calendar_event_id: null });
            bounded(rows, 'Ocurrencias recurrentes');
        }
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
export function recurringTotals(series: Json[], fromDate: string, endDate: string): { income: number; expenses: number } {
    dateOnly(fromDate); dateOnly(endDate);
    const result = { income: 0, expenses: 0 };
    if (fromDate > endDate) return result;
    for (const row of bounded(series, 'Series recurrentes').filter(item => item.is_active)) {
        const anchor = DateTime.fromISO(dateOnly(row.start_date), { zone: 'UTC' });
        const until = row.recurrence_until ? dateOnly(row.recurrence_until) : endDate;
        const lastDate = until < endDate ? until : endDate;
        if (lastDate < row.start_date || lastDate < fromDate) continue;
        const frequency = choice(row.recurrence_frequency, ['daily', 'weekly', 'monthly', 'yearly'], 'recurrence_frequency');
        const interval = integer(row.recurrence_interval, 'recurrence_interval', 1, 365);
        const unit = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[frequency] as 'days' | 'weeks' | 'months' | 'years';
        const at = (index: number): string => { const date = anchor.plus({ [unit]: index * interval }); return !date.isValid || date.year > 9999 ? '9999-99-99' : date.toISODate()!; };
        let first = Math.max(0, Math.floor(DateTime.fromISO(fromDate, { zone: 'UTC' }).diff(anchor, unit).get(unit) / interval) - 1);
        let last = Math.floor(DateTime.fromISO(lastDate, { zone: 'UTC' }).diff(anchor, unit).get(unit) / interval) + 1;
        while (at(first) < fromDate) first++;
        while (last >= 0 && at(last) > lastDate) last--;
        const field = row.is_expense ? 'expenses' : 'income';
        result[field] += Math.max(0, last - first + 1) * integer(row.amount_cents, 'amount_cents', 0, 1_000_000_000);
        if (!Number.isSafeInteger(result[field])) error('El total excede el rango monetario seguro.', 'resource-exhausted');
    }
    return result;
}
function monthRange(q: Json, defaults = false): { month: number; year: number; start: string; end: string } {
    const now = DateTime.now().setZone(ZONE);
    const month = queryInteger(q.month ?? (defaults ? now.month : undefined), 'month', 1, 12);
    const year = queryInteger(q.year ?? (defaults ? now.year : undefined), 'year', 1900, 9999);
    const first = DateTime.fromObject({ year, month, day: 1 }, { zone: 'UTC' });
    return { month, year, start: first.toISODate()!, end: first.endOf('month').toISODate()! };
}
function sumCents(rows: Json[], expense: boolean): number {
    const total = rows.filter(row => row.is_expense === expense).reduce((sum, row) => sum + integer(row.amount_cents, 'amount_cents', 0, 1_000_000_000), 0);
    if (!Number.isSafeInteger(total)) error('El total excede el rango monetario seguro.', 'resource-exhausted');
    return total;
}
export function budgetStatistics(rows: Json[], members: Json[] = []): Json {
    const income = sumCents(rows, false), expenses = sumCents(rows, true);
    const categories = new Map<string, number>(), byMember = new Map<string, Json>();
    const byId = new Map(members.map(row => [row.id, row]));
    for (const row of rows.filter(item => item.is_expense)) {
        categories.set(row.category, (categories.get(row.category) || 0) + row.amount_cents);
        if (row.assigned_to) {
            const member = byId.get(row.assigned_to), key = JSON.stringify([row.assigned_to, row.category]);
            const bucket = byMember.get(key) || { assigned_to: row.assigned_to, member_name: member?.name || 'Perfil archivado', member_color: member?.color || '#808080', category: row.category, amount_cents: 0 };
            bucket.amount_cents += row.amount_cents; byMember.set(key, bucket);
        }
    }
    return { totalIncome: income / 100, totalExpenses: expenses / 100, balance: (income - expenses) / 100,
        byCategory: [...categories].map(([category, cents]) => ({ category, category_total: cents / 100 })),
        byMember: [...byMember.values()].map(({ amount_cents, ...row }) => ({ ...row, amount: amount_cents / 100 })),
    };
}
async function budget(ctx: SparkContext, method: string, path: string, q: Json): Promise<any | undefined> {
    const known = ['/budget/statistics', '/budget/statistics/monthly', '/budget/forecast'];
    if (!(path === '/budget/recurring' && method === 'GET') && !/^\/budget\/recurring\/[^/]+\/point$/.test(path) && !known.includes(path)) return undefined;
    requireAdult(ctx);
    if (/^\/budget\/recurring\/[^/]+\/point$/.test(path)) return excluded('La conciliacion de recurrencias');
    if (path === '/budget/recurring' && method === 'GET') {
        object(q, ['month', 'year']); const range = monthRange(q, true);
        return ok(expandRecurring(await list(ctx, 'budgetRecurring', [where('start_date', '<=', range.end)]), range.start, range.end));
    }
    if (!known.includes(path)) return undefined;
    if (method !== 'GET') return excluded();
    object(q, path.endsWith('/monthly') ? ['year'] : path.endsWith('/forecast') ? ['month', 'year', 'as_of'] : ['month', 'year']);
    const year = queryInteger(q.year, 'year', 1900, 9999);
    if (path.endsWith('/monthly')) {
        const [entries, series] = await Promise.all([list(ctx, 'budgetEntries', [where('date', '>=', `${year}-01-01`), where('date', '<=', `${year}-12-31`)]), list(ctx, 'budgetRecurring', [where('start_date', '<=', `${year}-12-31`)])]);
        return ok(Array.from({ length: 12 }, (_, index) => {
            const range = monthRange({ year, month: index + 1 }), actual = entries.filter(row => row.date >= range.start && row.date <= range.end);
            const recurring = recurringTotals(series, range.start, range.end);
            const income = sumCents(actual, false) + recurring.income, expenses = sumCents(actual, true) + recurring.expenses;
            return { month: index + 1, totalIncome: income / 100, totalExpenses: expenses / 100, balance: (income - expenses) / 100, recurringIncome: recurring.income / 100, recurringExpenses: recurring.expenses / 100 };
        }));
    }
    const range = monthRange(q);
    const [entries, series] = await Promise.all([
        list(ctx, 'budgetEntries', [where('date', '>=', range.start), where('date', '<=', range.end)]),
        list(ctx, 'budgetRecurring', [where('start_date', '<=', range.end)]),
    ]);
    const occurrences = expandRecurring(series, range.start, range.end);
    if (path === '/budget/statistics') return ok(budgetStatistics([...entries, ...occurrences], await list(ctx, 'members')));
    const history = await list(ctx, 'budgetEntries', [where('date', '<', range.start)]);
    const historical = recurringTotals(series, '0001-01-01', DateTime.fromISO(range.start, { zone: 'UTC' }).minus({ days: 1 }).toISODate()!);
    const asOf = q.as_of === undefined ? DateTime.now().setZone(ZONE).toISODate()! : dateOnly(q.as_of);
    const due = occurrences.filter(row => row.date <= asOf), upcoming = occurrences.filter(row => row.date > asOf);
    const opening = sumCents(history, false) - sumCents(history, true) + historical.income - historical.expenses;
    const income = sumCents(entries, false), expenses = sumCents(entries, true), dueIncome = sumCents(due, false), dueExpenses = sumCents(due, true), upcomingIncome = sumCents(upcoming, false), upcomingExpenses = sumCents(upcoming, true);
    const current = opening + income - expenses + dueIncome - dueExpenses, forecast = current + upcomingIncome - upcomingExpenses;
    if (![opening, current, forecast].every(Number.isSafeInteger)) error('El saldo excede el rango seguro.', 'resource-exhausted');
    return ok({ openingBalance: opening / 100, oneTimeIncome: income / 100, oneTimeExpenses: expenses / 100, dueRecurringIncome: dueIncome / 100, dueRecurringExpenses: dueExpenses / 100, upcomingRecurringIncome: upcomingIncome / 100, upcomingRecurringExpenses: upcomingExpenses / 100, income: income / 100, pointedRecurring: dueExpenses / 100, unpointedRecurring: upcomingExpenses / 100, currentBalance: current / 100, forecastBalance: forecast / 100 });
}

async function shoppingActions(ctx: SparkContext, method: string, path: string, q: Json, input: unknown): Promise<any | undefined> {
    const apply = path.match(/^\/shopping\/templates\/([^/]+)\/apply$/);
    const ingredients = path === '/recipes/add-to-shopping' && method === 'POST';
    const clear = path === '/shopping/checked/clear' && method === 'DELETE';
    if (!(apply && method === 'POST') && !ingredients && !clear) return undefined;
    object(q, []); requireAdult(ctx);
    assertOnline();
    if (getFirebase().auth.currentUser?.uid !== ctx.uid) error('La sesion ha cambiado.', 'session-changed');
    const body = object(input, ingredients ? ['items', 'recipeName'] : []);
    if (clear) {
        const rows = bounded(await list(ctx, 'shoppingItems', [where('is_checked', '==', true)]), 'Productos que eliminar', 100);
        if (rows.length) { const batch = writeBatch(getFirebase().db); for (const row of rows) batch.delete(doc(col(ctx, 'shoppingItems'), row.id)); await batch.commit(); }
        return ok({ cleared: rows.length });
    }
    let duplicateCount = 0;
    let items: Json[];
    const [configured, existing] = await Promise.all([readCategories(ctx), ingredients ? list(ctx, 'shoppingItems') : Promise.resolve([] as Json[])]);
    if (apply) {
        const template = await record(ctx, 'shoppingTemplates', id(apply[1]));
        items = bounded<Json>(template.items, 'Productos de plantilla', 20).map(item => ({ ...item, is_checked: false }));
        if (!items.length) error('Plantilla vacia.');
    } else {
        const names = bounded(lines(body.items, 'items', 20, 255, true), 'Ingredientes', 20).map(name => text(name.replace(/^\[[^\]]+\]\s*/, ''), 'name', 255, 1));
        const recipeName = body.recipeName === undefined ? null : nullableText(body.recipeName, 'recipeName', 200);
        const existingNames = new Set(existing.map(row => row.name.trim().toLocaleLowerCase()));
        const category = configured.shopping.includes('Alimentation') ? 'Alimentation' : configured.shopping[0];
        items = [];
        for (const name of names) {
            const key = name.toLocaleLowerCase();
            if (existingNames.has(key)) { duplicateCount++; continue; }
            existingNames.add(key); items.push(validateModule('shoppingItems', { name, category, notes: recipeName }, true));
        }
    }
    if (items.some(item => !configured.shopping.includes(item.category))) error('Categoria de plantilla desconocida.');
    const refs = items.map(() => doc(col(ctx, 'shoppingItems')));
    if (items.length) {
        const batch = writeBatch(getFirebase().db);
        items.forEach((item, index) => batch.set(refs[index], { ...item, ...metadata(ctx, true) }));
        await batch.commit();
        await Promise.all(refs.map(ref => record(ctx, 'shoppingItems', ref.id)));
    }
    return ingredients ? { success: true, addedCount: items.length, duplicateCount } : ok({ addedCount: items.length });
}

async function categories(ctx: SparkContext, method: string, q: Json, input: unknown): Promise<any> {
    object(q, []);
    if (method === 'GET') return ok({ categories: await readCategories(ctx) });
    if (method !== 'PUT') return excluded();
    requireAdult(ctx);
    const body = object(input, ['module', 'categories', 'renames']);
    const module = choice(body.module, CATEGORY_MODULES, 'module'), next = lines(body.categories, 'categories', 30, 50, true);
    if (new Set(next).size !== next.length) error('Categorias duplicadas.');
    if (body.renames !== undefined) {
        if (!body.renames || typeof body.renames !== 'object' || Array.isArray(body.renames)) error('renames debe ser un objeto.');
        bounded(Object.entries(body.renames), 'Cambios de nombre', 30).forEach(([from, to]) => { text(from, 'from', 50, 1); text(to, 'to', 50, 1); if (from !== to) excluded('El cambio de nombre con propagacion'); });
    }
    const ref = doc(col(ctx, 'settings'), 'categories');
    await transaction(async tx => {
        const existing = await tx.get(ref), current = effectiveCategories(existing.data());
        if (body.renames && Object.keys(body.renames).some(from => !current[module].includes(from) || !next.includes(from))) error('Categoria inexistente en renames.');
        if (current[module].some(value => !next.includes(value))) excluded('La eliminacion de categorias con propagacion');
        tx.set(ref, { ...current, [module]: next, ...metadata(ctx, !existing.exists()) }, { merge: true });
    });
    return ok({ categories: effectiveCategories(await record(ctx, 'settings', 'categories')) });
}
function pillarFor(category: string, mapping: Json): string {
    return Object.prototype.hasOwnProperty.call(mapping, category) ? mapping[category] : Object.prototype.hasOwnProperty.call(DEFAULT_PILLARS, category) ? DEFAULT_PILLARS[category] : 'wants';
}
async function kakeibo(ctx: SparkContext, method: string, path: string, q: Json, input: unknown): Promise<any> {
    requireAdult(ctx);
    if (path === '/kakeibo/income' && method === 'PUT') {
        object(q, []); const body = object(input, ['incomes']);
        if (!body.incomes || typeof body.incomes !== 'object' || Array.isArray(body.incomes)) error('incomes debe ser un objeto.');
        const incomes = bounded(Object.entries(body.incomes), 'Ingresos de perfiles', 10).map(([memberId, value]) => ({ id: id(memberId), monthly_income_cents: euroCents(value) }));
        if (!incomes.length) error('No hay ingresos que actualizar.');
        await transaction(async tx => {
            const existing = new Map<string, Json | undefined>();
            for (const row of incomes) {
                await txRecord(tx, doc(col(ctx, 'members'), row.id));
                existing.set(row.id, (await tx.get(doc(col(ctx, 'privateProfiles'), row.id))).data());
            }
            for (const row of incomes) tx.set(doc(col(ctx, 'privateProfiles'), row.id), { ...(existing.get(row.id) ? {} : privateDefaults()), monthly_income_cents: row.monthly_income_cents, ...metadata(ctx, !existing.get(row.id)) }, { merge: true });
        });
        const saved = await Promise.all(incomes.map(row => record(ctx, 'privateProfiles', row.id)));
        return ok({ incomes: Object.fromEntries(saved.map(row => [row.id, row.monthly_income_cents / 100])) });
    }
    if (path === '/kakeibo/month' && method === 'PUT') {
        object(q, []); const body = object(input, ['month', 'year', 'savings_goal', 'notes']);
        const month = integer(body.month, 'month', 1, 12), year = integer(body.year, 'year', 1900, 9999);
        const patch: Json = { month, year };
        if ('savings_goal' in body) patch.savings_goal_cents = euroCents(body.savings_goal);
        if ('notes' in body) patch.notes = nullableText(body.notes, 'notes', 2000);
        if (Object.keys(patch).length === 2) error('No hay cambios.');
        const ref = doc(col(ctx, 'kakeiboMonths'), `${year}-${String(month).padStart(2, '0')}`);
        await transaction(async tx => {
            const existing = await tx.get(ref);
            tx.set(ref, { ...(existing.exists() ? {} : { savings_goal_cents: 0, notes: null }), ...patch, ...metadata(ctx, !existing.exists()) }, { merge: true });
        });
        const saved = await record(ctx, 'kakeiboMonths', ref.id);
        return ok({ ...saved, savings_goal: saved.savings_goal_cents / 100 });
    }
    if (path === '/kakeibo/pillars') {
        object(q, []); const ref = doc(col(ctx, 'settings'), 'kakeibo');
        if (method === 'PUT') {
            const body = object(input, ['mapping']);
            if (!body.mapping || typeof body.mapping !== 'object' || Array.isArray(body.mapping)) error('mapping debe ser un objeto.');
            const mapping = Object.fromEntries(bounded(Object.entries(body.mapping), 'Pilares', 30).map(([category, pillar]) => [text(category, 'category', 50, 1), choice(pillar, PILLARS, 'pillar')]));
            await transaction(async tx => {
                const current = await tx.get(ref), configured = effectiveCategories((await tx.get(doc(col(ctx, 'settings'), 'categories'))).data());
                if (Object.keys(mapping).some(category => !configured.budget.includes(category))) error('Categoria de presupuesto desconocida.');
                tx.set(ref, { mapping, ...metadata(ctx, !current.exists()) }, { merge: true });
            });
            return ok({ mapping: (await record(ctx, 'settings', 'kakeibo')).mapping });
        }
        if (method === 'GET') {
            const [snapshot, categories] = await Promise.all([getDocFromServer(ref), readCategories(ctx)]);
            return ok({ pillars: PILLARS, mapping: Object.fromEntries(categories.budget.map((category: string) => [category, pillarFor(category, snapshot.data()?.mapping || {})])) });
        }
        return excluded();
    }
    if (path !== '/kakeibo' || method !== 'GET') return excluded();
    object(q, ['month', 'year']); const range = monthRange(q);
    const [members, privateRows, entries, series, month, pillars] = await Promise.all([
        list(ctx, 'members'), list(ctx, 'privateProfiles'), list(ctx, 'budgetEntries', [where('date', '>=', range.start), where('date', '<=', range.end)]),
        list(ctx, 'budgetRecurring', [where('start_date', '<=', range.end)]), getDocFromServer(doc(col(ctx, 'kakeiboMonths'), `${range.year}-${String(range.month).padStart(2, '0')}`)),
        getDocFromServer(doc(col(ctx, 'settings'), 'kakeibo')),
    ]);
    const byId = new Map<string, Json>(privateRows.map((row: Json): [string, Json] => [row.id, row]));
    const incomes = members.filter(live).map((row: Json) => ({ id: row.id, name: row.name, color: row.color, monthly_income: (byId.get(row.id)?.monthly_income_cents || 0) / 100 }));
    const salaries = members.filter(live).reduce((sum: number, row: Json) => sum + (byId.get(row.id)?.monthly_income_cents || 0), 0);
    const rows = [...entries, ...expandRecurring(series, range.start, range.end)], statistics = budgetStatistics(rows);
    const extra = sumCents(rows, false), expenses = sumCents(rows, true), income = salaries + extra, goal = month.data()?.savings_goal_cents || 0;
    const byPillar: Json = { survival: 0, wants: 0, culture: 0, extra: 0 };
    const byCategory = statistics.byCategory.map((row: Json) => { const pillar = pillarFor(row.category, pillars.data()?.mapping || {}); byPillar[pillar] += Math.round(row.category_total * 100); return { category: row.category, amount: row.category_total, pillar }; });
    for (const pillar of PILLARS) byPillar[pillar] /= 100;
    return ok({ month: range.month, year: range.year, incomes, salaryIncome: salaries / 100, extraIncome: extra / 100, totalIncome: income / 100, savingsGoal: goal / 100, availableToSpend: (income - goal) / 100, totalExpenses: expenses / 100, actualSavings: (income - expenses) / 100, savingsGoalReached: income - expenses >= goal, byPillar, byCategory, notes: month.data()?.notes || null });
}

async function notifications(ctx: SparkContext, method: string, path: string, q: Json, input: unknown): Promise<any> {
    object(q, []);
    if (method === 'GET' && ['/notifications', '/notifications/unread-count'].includes(path)) {
        const rows = await list(ctx, 'notifications', [where('recipient_uid', '==', ctx.uid)]);
        rows.sort((a, b) => (b.created_at?.toMillis() || 0) - (a.created_at?.toMillis() || 0));
        return ok(path.endsWith('/unread-count') ? { count: rows.filter(row => !row.is_read).length } : rows);
    }
    const read = path.match(/^\/notifications\/([^/]+)\/read$/);
    if (method === 'PUT' && (read || path === '/notifications/read-all')) {
        object(input, []);
        const rows = read ? [await record(ctx, 'notifications', id(read[1]))] : await list(ctx, 'notifications', [where('recipient_uid', '==', ctx.uid), where('is_read', '==', false)]);
        bounded(rows, 'Notificaciones que marcar', 20);
        if (rows.length) await transaction(async tx => {
            for (const row of rows) {
                const current = await txRecord(tx, doc(col(ctx, 'notifications'), row.id));
                if (current.recipient_uid !== ctx.uid) error('Esta notificacion pertenece a otra cuenta.', 'permission-denied');
            }
            for (const row of rows) tx.update(doc(col(ctx, 'notifications'), row.id), { is_read: true, ...metadata(ctx) });
        });
        const saved = await Promise.all(rows.map(row => record(ctx, 'notifications', row.id)));
        return ok({ updated: saved.filter(row => row.is_read).length });
    }
    return excluded('El servicio de notificaciones automaticas');
}

async function dashboard(ctx: SparkContext, q: Json): Promise<any> {
    object(q, []);
    const now = DateTime.now().setZone(ZONE), to = now.plus({ days: 7 });
    const taskConstraints = [where('deleted_at', '==', null), where('is_completed', '==', false)];
    if (ctx.role === 'child' && ctx.memberId) taskConstraints.push(where('assigned_to', 'array-contains', ctx.memberId));
    const [tasks, shopping, events] = await Promise.all([
        ctx.role === 'child' && !ctx.memberId ? Promise.resolve([] as Json[]) : list(ctx, 'tasks', taskConstraints), list(ctx, 'shoppingItems', [where('is_checked', '==', false)]),
        list(ctx, 'calendarEvents', [where('start_time', '>=', now.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS")), where('start_time', '<=', to.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS"))]),
    ]);
    const stats: Json = { pendingTasks: tasks.filter(live).length, shoppingItems: shopping.length, upcomingAppointments: events.length };
    if (ctx.role !== 'child') {
        const range = monthRange({ month: now.month, year: now.year });
        const [entries, recurring, limits] = await Promise.all([
            list(ctx, 'budgetEntries', [where('date', '>=', range.start), where('date', '<=', range.end)]),
            list(ctx, 'budgetRecurring', [where('start_date', '<=', range.end)]), list(ctx, 'budgetLimits', [where('month', '==', range.month), where('year', '==', range.year)]),
        ]);
        const totals = budgetStatistics([...entries, ...expandRecurring(recurring, range.start, range.end)]);
        stats.thisMonthExpenses = totals.totalExpenses;
        stats.budgetAlerts = limits.filter(limit => totals.byCategory.some((category: Json) => category.category === limit.category && Math.round(category.category_total * 100) > limit.monthly_limit_cents)).length;
    }
    return ok(stats);
}

const EXPORT_COLLECTIONS = ['members', 'privateProfiles', 'recipes', 'tasks', 'penalties', 'penaltyTotals', 'planningEntries', 'mealPlans', 'shoppingItems', 'shoppingTemplates', 'calendarEvents', 'budgetEntries', 'budgetLimits', 'budgetRecurring', 'kakeiboMonths', 'notes', 'notifications'];
async function exportData(ctx: SparkContext, q: Json): Promise<any> {
    requireAdult(ctx); object(q, []);
    const family = await getDocFromServer(doc(getFirebase().db, 'families', ctx.familyId));
    if (!family.exists()) error('Familia no encontrada.', 'not-found');
    const collections: Json = {};
    let count = 0;
    for (const name of EXPORT_COLLECTIONS) {
        const rows = await list(ctx, name, name === 'notifications' ? [where('recipient_uid', '==', ctx.uid)] : []);
        count += rows.length;
        if (count > LIMIT) error('La exportacion portable supera 200 registros. Utiliza una migracion administrativa de solo lectura para conjuntos mayores.', 'resource-exhausted');
        collections[name] = rows;
    }
    const settings = await Promise.all(['categories', 'kakeibo'].map(async key => {
        const snapshot = await getDocFromServer(doc(col(ctx, 'settings'), key));
        return snapshot.exists() ? { ...snapshot.data(), id: key } : null;
    }));
    collections.settings = settings.filter(Boolean);
    if (count + collections.settings.length > LIMIT) error('La exportacion portable supera 200 registros.', 'resource-exhausted');
    // Collection queries cannot share a Web SDK transaction snapshot. This is a portable
    // best-effort export, not a backup or a privileged identity/membership migration.
    const familyData = family.data();
    const data = wire({ format: 'chocomelerplan-firestore', version: '1.0', exported_at: new Date().toISOString(), family_id: ctx.familyId,
        family: { id: ctx.familyId, name: familyData.name, timezone: familyData.timezone, currency: familyData.currency, disabled_modules: familyData.disabled_modules || [] },
        consistency: 'bounded-per-collection', collections });
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 8 * 1024 * 1024) error('La exportacion supera 8 MB.', 'resource-exhausted');
    return ok(data);
}

/** Compatibility envelopes for API-stripped paths; Firestore rules remain the authority. */
export async function handleModules(ctx: SparkContext, method: string, path: string, q: Json, input: unknown): Promise<any | undefined> {
    input = input === undefined || input === null ? {} : cleanUndefined(input);
    if (method === 'GET' && path === '/integrations') { object(q, []); return ok([]); }
    if (method === 'GET' && path === '/ai/settings') { object(q, []); return ok({ configured: false, enabled: false }); }
    if (method === 'GET' && path === '/calendar/subscriptions') { object(q, []); return ok([]); }
    if (/^\/(?:integrations|ai|calendar)(?:\/|$)/.test(path) || path === '/recipes/import-url' || path === '/data/import' || path.startsWith('/budget/from-appointment/')) return excluded();
    if (path === '/data/export') return method === 'GET' ? exportData(ctx, q) : excluded();
    if (path === '/categories') return categories(ctx, method, q, input);
    if (path === '/dashboard') return method === 'GET' ? dashboard(ctx, q) : excluded();
    if (/^\/notifications(?:\/|$)/.test(path)) return notifications(ctx, method, path, q, input);
    if (/^\/kakeibo(?:\/|$)/.test(path)) return kakeibo(ctx, method, path, q, input);
    if (/^\/planning(?:\/|$)/.test(path)) return planning(ctx, method, path, q, input);
    if (path === '/family' || /^\/family\/[^/]+$/.test(path)) return family(ctx, method, path === '/family' ? null : id(path.slice('/family/'.length)), q, input);
    const shopping = await shoppingActions(ctx, method, path, q, input);
    if (shopping !== undefined) return shopping;
    if (/^\/budget(?:\/|$)/.test(path)) { const result = await budget(ctx, method, path, q); if (result !== undefined) return result; }
    for (const base of Object.keys(ROUTES).sort((a, b) => b.length - a.length)) {
        if (path === base) return crud(ctx, method, ROUTES[base], null, q, input);
        if (path.startsWith(`${base}/`) && !path.slice(base.length + 1).includes('/')) return crud(ctx, method, ROUTES[base], id(path.slice(base.length + 1)), q, input);
    }
    if (Object.keys(ROUTES).some(base => path.startsWith(`${base}/`))) return excluded();
    return undefined;
}
