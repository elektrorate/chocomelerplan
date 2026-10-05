import { doc, serverTimestamp, where } from 'firebase/firestore';
import { DateTime } from 'luxon';
import { col, deadline, emitSparkChange, enumValue, fail, getRecord, id, ids, list, metadata, object, ok, requireAdult, text, transaction, unsupported, type Json, type SparkContext } from './core';
import { readPenaltyGeneration, writePenaltyGeneration } from './penalties';

const FREQUENCIES = ['Une fois', 'Quotidien', 'Hebdomadaire', 'Mensuel', 'Annuel'] as const;
const frequencyCodes: Record<string, string> = { 'Une fois': 'none', Quotidien: 'daily', Hebdomadaire: 'weekly', Mensuel: 'monthly', Annuel: 'annual' };
const priorityCodes: Record<string, string> = { Haute: 'high', Moyenne: 'medium', Basse: 'low' };
const FIELDS = ['title', 'description', 'category', 'assigned_to', 'due_date', 'frequency', 'priority', 'recipe_id', 'penalty_amount', 'is_completed'];

function taskPatch(input: Json): Json {
    object(input, FIELDS);
    const patch: Json = {};
    if ('title' in input) patch.title = text(input.title, 'title', 200, 1);
    if ('description' in input) patch.description = text(input.description ?? '', 'description', 2000);
    if ('category' in input) patch.category = enumValue(input.category, ['general', 'cooking'], 'category');
    if ('assigned_to' in input) patch.assigned_to = ids(input.assigned_to);
    if ('due_date' in input) Object.assign(patch, deadline(input.due_date));
    if ('frequency' in input) patch.frequency = frequencyCodes[enumValue(input.frequency, FREQUENCIES, 'frequency')];
    if ('priority' in input) patch.priority = priorityCodes[enumValue(input.priority, ['Haute', 'Moyenne', 'Basse'], 'priority')];
    if ('recipe_id' in input) patch.recipe_id = input.recipe_id ? id(input.recipe_id) : null;
    if ('penalty_amount' in input) {
        if (![0, 5, 10].includes(input.penalty_amount)) fail('La penalidad debe ser 0, 5 o 10 EUR.');
        patch.penalty_amount_cents = input.penalty_amount * 100;
    }
    if ('is_completed' in input) {
        if (typeof input.is_completed !== 'boolean') fail('El estado de la tarea no es valido.');
        patch.is_completed = input.is_completed;
    }
    return patch;
}

async function hydrate(ctx: SparkContext, tasks: Json[]) {
    const members = await list(ctx, 'members');
    const byId = new Map(members.map(member => [member.id, member]));
    return tasks.map(task => ({ ...task, penalty_amount: task.penalty_amount_cents / 100,
        frequency: Object.keys(frequencyCodes).find(key => frequencyCodes[key] === task.frequency),
        priority: Object.keys(priorityCodes).find(key => priorityCodes[key] === task.priority),
        assigned_to_members: (task.assigned_to || []).flatMap((memberId: string) => {
            const member = byId.get(memberId);
            return member ? [{ id: member.id, name: member.name, color: member.color }] : [];
        }),
    }));
}

export async function handleTasks(ctx: SparkContext, method: string, path: string, q: Json, input: Json): Promise<any | undefined> {
    const match = /^\/tasks(?:\/([^/]+)(\/next-occurrence)?)?$/.exec(path);
    if (!match) {
        if (path.startsWith('/tasks/')) return unsupported('La aprobacion por puntos no esta disponible en Spark.');
        return undefined;
    }
    const recordId = match[1] ? id(match[1]) : null;
    const nextOccurrence = Boolean(match[2]);
    if (method === 'GET' && !nextOccurrence) {
        if (recordId) return ok((await hydrate(ctx, [await getRecord(ctx, 'tasks', recordId)]))[0]);
        const constraints = [where('deleted_at', '==', null)];
        if (ctx.role === 'child') {
            if (!ctx.memberId) return ok([]);
            constraints.push(where('assigned_to', 'array-contains', ctx.memberId));
        }
        if (q.is_completed !== undefined) constraints.push(where('is_completed', '==', q.is_completed === 'true'));
        return ok(await hydrate(ctx, await list(ctx, 'tasks', constraints)));
    }
    if (!['POST', 'PUT', 'DELETE'].includes(method) || (method === 'POST' ? !!recordId && !nextOccurrence : !recordId || nextOccurrence)) return unsupported();
    if (ctx.role === 'child') {
        if (method !== 'PUT' || input.is_completed !== true) fail('Solo puedes completar tus tareas asignadas.', 'permission-denied');
        object(input, ['is_completed']);
    } else requireAdult(ctx);
    const patch = method === 'DELETE' || nextOccurrence ? (object(input, []), {}) : taskPatch(input);
    const ref = recordId ? doc(col(ctx, 'tasks'), recordId) : doc(col(ctx, 'tasks'));
    const occurrenceId = crypto.randomUUID();
    await transaction(async tx => {
        const current = await tx.get(ref);
        if (recordId && !current.exists()) fail('La tarea no existe.', 'not-found');
        const previous: Json | null = current.exists() ? { ...current.data(), id: current.id } : null;
        if (previous?.deleted_at) fail('La tarea esta archivada.', 'failed-precondition');
        if (ctx.role === 'child' && (!ctx.memberId || !previous?.assigned_to.includes(ctx.memberId))) fail('La tarea no esta asignada a tu perfil.', 'permission-denied');
        if (nextOccurrence && (!previous?.is_completed || previous.frequency === 'none')) fail('Completa una tarea recurrente antes de crear su siguiente ocurrencia.', 'failed-precondition');
        let next: Json = previous ? { ...previous, ...patch } : {
            title: '', description: '', category: 'general', assigned_to: [], due_date: null, due_at: null,
            frequency: 'none', priority: 'medium', recipe_id: null, penalty_amount_cents: 0,
            is_completed: false, completed_at: null, completed_by: null,
            occurrence_id: occurrenceId, penalty_generated: false, deleted_at: null, ...patch,
        };
        if (nextOccurrence) {
            if (!previous!.due_date) fail('La recurrencia requiere una fecha de vencimiento.', 'failed-precondition');
            const additions: Record<string, { days?: number; weeks?: number; months?: number; years?: number }> = { daily: { days: 1 }, weekly: { weeks: 1 }, monthly: { months: 1 }, annual: { years: 1 } };
            // Calendar arithmetic is neutral; deadline() validates Madrid's DST separately.
            const local = DateTime.fromISO(previous!.due_date, { zone: 'UTC' }).plus(additions[previous!.frequency]);
            next = { ...next, ...deadline(local.toFormat(previous!.due_date.length === 10 ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm")), occurrence_id: occurrenceId, penalty_generated: false, is_completed: false, completed_at: null, completed_by: null };
        }
        text(next.title, 'title', 200, 1);
        if (!previous && next.is_completed) fail('Las nuevas tareas deben crearse pendientes.');
        ids(next.assigned_to);
        if (next.category === 'cooking' && !next.recipe_id) fail('Selecciona una receta para la tarea de cocinar.');
        if (next.category !== 'cooking' && next.recipe_id) fail('Solo las tareas de cocinar pueden vincular una receta.');
        const memberIds = [...new Set<string>([...(previous?.assigned_to || []), ...next.assigned_to])];
        const members = await Promise.all(memberIds.map(async memberId => ({ memberId, snapshot: await tx.get(doc(col(ctx, 'members'), id(memberId))) })));
        for (const memberId of next.assigned_to) {
            const member = members.find(row => row.memberId === memberId)?.snapshot;
            const unchanged = previous && JSON.stringify(next.assigned_to) === JSON.stringify(previous.assigned_to);
            if (!member?.exists() || (member.data().deleted_at && (nextOccurrence || !unchanged))) fail('Un responsable ya no esta disponible.', 'failed-precondition');
        }
        if (next.recipe_id) {
            const recipe = await tx.get(doc(col(ctx, 'recipes'), next.recipe_id));
            if (!recipe.exists() || (recipe.data().deleted_at && previous?.recipe_id !== next.recipe_id)) fail('La receta no esta disponible.', 'failed-precondition');
        }
        const proposals = previous ? await readPenaltyGeneration(tx, ctx, previous) : { refs: [], generated: false };
        if (!nextOccurrence && proposals.generated) next.penalty_generated = true;
        if (method === 'DELETE') next.deleted_at = serverTimestamp();
        if (next.is_completed && !previous?.is_completed) { next.completed_at = serverTimestamp(); next.completed_by = ctx.uid; }
        if (!next.is_completed && previous?.is_completed && !nextOccurrence) {
            if (ctx.role === 'child') fail('Solo un adulto puede reabrir una tarea.', 'permission-denied');
            next.completed_at = null; next.completed_by = null;
        }
        delete next.id;
        writePenaltyGeneration(tx, proposals);
        tx.set(ref, { ...next, ...metadata(ctx, !previous) });
    });
    emitSparkChange('tasks'); emitSparkChange('rewards');
    return ok(method === 'DELETE' ? { id: ref.id } : (await hydrate(ctx, [await getRecord(ctx, 'tasks', ref.id)]))[0]);
}
