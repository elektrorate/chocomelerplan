import { doc, getDocFromServer, serverTimestamp, Timestamp, where, type DocumentReference, type Transaction } from 'firebase/firestore';
import { getFirebase } from '../config';
import { col, emitSparkChange, fail, id, ids, list, object, ok, requireAdult, text, transaction, type Json, type SparkContext } from './core';

type ProposalWrites = { refs: Array<{ ref: DocumentReference; data: Json }>; generated: boolean };

export function penaltyId(taskId: string, occurrenceId: string, memberId: string) {
    return `${id(taskId)}_${id(occurrenceId)}_${id(memberId)}`;
}

export async function readPenaltyGeneration(tx: Transaction, ctx: SparkContext, task: Json): Promise<ProposalWrites> {
    if (task.penalty_generated || task.is_completed || task.deleted_at || !(task.due_at instanceof Timestamp) ||
        task.due_at.toMillis() >= Date.now() || ![500, 1000].includes(task.penalty_amount_cents) || !task.assigned_to?.length) return { refs: [], generated: false };
    const assigned = ids(task.assigned_to);
    const references = assigned.map(memberId => ({
        memberId, memberRef: doc(col(ctx, 'members'), memberId),
        ref: doc(col(ctx, 'penalties'), penaltyId(task.id, task.occurrence_id, memberId)),
    }));
    const snapshots = await Promise.all(references.map(async entry => ({ ...entry, member: await tx.get(entry.memberRef), penalty: await tx.get(entry.ref) })));
    const refs: ProposalWrites['refs'] = [];
    for (const snapshot of snapshots) {
        if (snapshot.penalty.exists()) continue;
        if (!snapshot.member.exists()) fail('No se puede conservar la penalidad: falta el perfil responsable.', 'failed-precondition');
        const member = snapshot.member.data();
        refs.push({ ref: snapshot.ref, data: {
            task_id: task.id, occurrence_id: task.occurrence_id, member_id: snapshot.memberId,
            task_title: task.title, member_name: member.name, member_color: member.color,
            due_date: task.due_date, due_at: task.due_at, amount_cents: task.penalty_amount_cents,
            status: 'review', generated_at: serverTimestamp(), generated_by: ctx.uid,
            reviewed_at: null, reviewed_by: null, reviewed_by_name: null, reason: '',
            paid_at: null, paid_by: null, paid_by_name: null, payment_reason: '',
        } });
    }
    return { refs, generated: true };
}

export function writePenaltyGeneration(tx: Transaction, proposals: ProposalWrites) {
    for (const proposal of proposals.refs) tx.set(proposal.ref, proposal.data);
}

export async function detectOverdueTasks(ctx: SparkContext, isActive = () => true): Promise<void> {
    if (ctx.role === 'child') return;
    const tasks = await list(ctx, 'tasks', [where('is_completed', '==', false), where('deleted_at', '==', null), where('penalty_generated', '==', false), where('due_at', '<=', Timestamp.now())]);
    let changed = false;
    // One transaction per occurrence keeps rule access counts below the batch limit.
    for (const entry of tasks) {
        if (!isActive()) return;
        const generated = await transaction(async tx => {
            const ref = doc(col(ctx, 'tasks'), entry.id);
            const current = await tx.get(ref);
            if (!current.exists()) return false;
            const proposals = await readPenaltyGeneration(tx, ctx, { ...current.data(), id: current.id });
            if (!proposals.generated || !isActive()) return false;
            writePenaltyGeneration(tx, proposals);
            tx.update(ref, { penalty_generated: true, updated_by: ctx.uid, updated_at: serverTimestamp() });
            return true;
        });
        changed ||= generated;
    }
    if (changed) { emitSparkChange('tasks'); emitSparkChange('rewards'); }
}

export function penaltyWire(record: Json): Json {
    return {
        ...record, occurrence_key: record.id, amount: record.amount_cents / 100,
        reviewed_by_uid: record.reviewed_by, reviewed_by: record.reviewed_by_name || record.reviewed_by,
        paid_by_uid: record.paid_by, paid_by: record.paid_by_name || record.paid_by,
    };
}

async function summary(ctx: SparkContext) {
    const memberFilters = ctx.role === 'child' ? [where('member_id', '==', ctx.memberId || '__unlinked__')] : [];
    const [review, pending, history, members] = await Promise.all([
        list(ctx, 'penalties', [...memberFilters, where('status', '==', 'review')]),
        list(ctx, 'penalties', [...memberFilters, where('status', '==', 'pending')]),
        list(ctx, 'penalties', [...memberFilters, where('status', 'in', ['forgiven', 'paid'])]),
        list(ctx, 'members'),
    ]);
    let storedTotals: Json[];
    if (ctx.role === 'child') {
        const total = ctx.memberId ? await getDocFromServer(doc(col(ctx, 'penaltyTotals'), ctx.memberId)) : null;
        storedTotals = total?.exists() ? [{ ...total.data(), id: total.id }] : [];
    } else storedTotals = await list(ctx, 'penaltyTotals');
    if (storedTotals.length >= 200) fail('Los totales alcanzan el limite de 200 perfiles. No se puede mostrar una deuda familiar completa.', 'resource-exhausted');
    const memberMap = new Map(members.map(member => [member.id, member]));
    const snapshots = new Map([...review, ...pending, ...history].map(record => [record.member_id, record]));
    const totals = storedTotals.map(total => ({
        member_id: total.id,
        member_name: memberMap.get(total.id)?.name || snapshots.get(total.id)?.member_name || 'Perfil no disponible',
        member_color: memberMap.get(total.id)?.color || snapshots.get(total.id)?.member_color || '#8B5CF6',
        amount: total.amount_cents / 100,
    }));
    return ok({ review: review.map(penaltyWire), pending: pending.map(penaltyWire), history: history.map(penaltyWire), totals,
        truncated: review.length === 200 || pending.length === 200 || history.length === 200 || storedTotals.length === 200 });
}

async function transition(ctx: SparkContext, recordId: string, status: 'pending' | 'forgiven' | 'paid', reason: string) {
    requireAdult(ctx);
    if (!/^[A-Za-z0-9-]+_[A-Za-z0-9-]+_[A-Za-z0-9-]+$/.test(recordId)) fail('La penalidad no es valida.');
    const ref = doc(col(ctx, 'penalties'), recordId);
    await transaction(async tx => {
        const [penalty, profile, membership] = await Promise.all([
            tx.get(ref), tx.get(doc(getFirebase().db, 'users', ctx.uid)), tx.get(doc(col(ctx, 'memberships'), ctx.uid)),
        ]);
        if (!penalty.exists()) fail('No se encontro la penalidad.', 'not-found');
        if (!['admin', 'adult'].includes(membership.data()?.role)) fail('Solo los adultos pueden revisar penalidades.', 'permission-denied');
        const current = penalty.data();
        if (current.status === status) return;
        if (current.status !== (status === 'paid' ? 'pending' : 'review')) fail('La penalidad ya ha cambiado. Actualiza la lista.', 'failed-precondition');
        const totalsRef = doc(col(ctx, 'penaltyTotals'), id(current.member_id));
        const totals = status === 'forgiven' ? null : await tx.get(totalsRef);
        const currentAmount = totals?.data()?.amount_cents ?? 0;
        if (!Number.isSafeInteger(currentAmount) || currentAmount < 0 || ![500, 1000].includes(current.amount_cents)) fail('Los importes almacenados no son validos.', 'failed-precondition');
        const newAmount = currentAmount + (status === 'pending' ? current.amount_cents : status === 'paid' ? -current.amount_cents : 0);
        if (newAmount < 0 || newAmount > 1_000_000_000) fail('El total pendiente no permite esta transicion. Actualiza y reintenta.', 'failed-precondition');
        const actorName = profile.data()!.name;
        tx.update(ref, status === 'paid'
            ? { status, paid_at: serverTimestamp(), paid_by: ctx.uid, paid_by_name: actorName, payment_reason: reason }
            : { status, reviewed_at: serverTimestamp(), reviewed_by: ctx.uid, reviewed_by_name: actorName, reason });
        if (status !== 'forgiven') tx.set(totalsRef, { amount_cents: newAmount, last_penalty_id: recordId, updated_at: serverTimestamp() });
        tx.set(doc(col(ctx, 'auditEvents')), { actor_uid: ctx.uid, action: `penalty.${status}`, entity_id: recordId, created_at: serverTimestamp() });
    });
    emitSparkChange('rewards');
    const record = await getDocFromServer(ref);
    if (!record.exists()) fail('No se pudo leer la penalidad confirmada.', 'not-found');
    return ok(penaltyWire({ ...record.data(), id: record.id }));
}

export async function handlePenalties(ctx: SparkContext, method: string, path: string, _q: Json, input: Json): Promise<any | undefined> {
    if (path === '/penalties' && method === 'GET') return summary(ctx);
    if (path === '/penalties/detect' && method === 'POST') { object(input, []); requireAdult(ctx); await detectOverdueTasks(ctx); return summary(ctx); }
    if (path === '/penalties/review' && method === 'POST') {
        object(input, ['occurrence_key', 'status', 'reason']);
        if (!['pending', 'forgiven'].includes(input.status)) fail('El estado de revision no es valido.');
        return transition(ctx, text(input.occurrence_key, 'occurrence_key', 400, 1), input.status, text(input.reason ?? '', 'reason', 500));
    }
    const payment = /^\/penalties\/([^/]+)\/pay$/.exec(path);
    if (payment && method === 'POST') { object(input, ['reason']); return transition(ctx, payment[1], 'paid', text(input.reason ?? '', 'reason', 500)); }
    if (path.startsWith('/penalties')) fail('Esta operacion de penalidades no esta disponible.', 'unimplemented');
    return undefined;
}
