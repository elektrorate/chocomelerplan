import assert from 'node:assert/strict';
import { test } from 'node:test';
import { penaltyDeadline, penaltyOccurrence, penaltySummary, type Penalty, type PenaltyTask, type PenaltySummary } from '../src/lib/penalties';
import { mockRequest } from '../src/demo/mockApi';

const members = [{ id: 'a', name: 'Alex', color: '#2563EB' }, { id: 'b', name: 'Sam', color: '#DB2777' }];
const task: PenaltyTask = { id: 'task', title: 'Cocinar', assigned_to: ['a'], due_date: '2026-10-03', penalty_amount: 5, is_completed: false };
const now = new Date(2026, 9, 4, 12);

test('date-only deadlines expire after the entire local day, including across DST', () => {
    for (const day of ['2026-10-03', '2026-03-29', '2026-10-25']) {
        const deadline = penaltyDeadline(day)!;
        assert.equal(deadline.getHours(), 23);
        assert.equal(deadline.getMinutes(), 59);
        assert.equal(deadline.getSeconds(), 59);
        assert.equal(deadline.getMilliseconds(), 999);
        const dated = { ...task, due_date: day };
        assert.equal(penaltySummary([dated], members, [], deadline).review.length, 0);
        assert.equal(penaltySummary([dated], members, [], new Date(deadline.getTime() + 1)).review.length, 1);
    }
});

test('datetime deadlines preserve the exact time and normalize equivalent timestamps', () => {
    const timed = { ...task, due_date: '2026-10-04T11:30:00' };
    const deadline = penaltyDeadline(timed.due_date)!;
    assert.equal(penaltySummary([timed], members, [], new Date(deadline.getTime() - 1)).review.length, 0);
    assert.equal(penaltySummary([timed], members, [], new Date(deadline.getTime() + 1)).review.length, 1);
    assert.equal(penaltyOccurrence('t', 'a', '2026-10-04T12:00:00Z'), penaltyOccurrence('t', 'a', '2026-10-04T14:00:00+02:00'));
});

test('only incomplete, assigned, overdue tasks with an economic penalty are proposed', () => {
    const excluded = [
        { ...task, id: 'completed', is_completed: true },
        { ...task, id: 'unassigned', assigned_to: [] },
        { ...task, id: 'missing-member', assigned_to: ['deleted'] },
        { ...task, id: 'no-deadline', due_date: undefined },
        { ...task, id: 'invalid-date', due_date: '2026-02-30' },
        { ...task, id: 'future', due_date: '2026-10-05' },
        { ...task, id: 'today', due_date: '2026-10-04' },
        { ...task, id: 'no-penalty', penalty_amount: 0 },
        { ...task, id: 'invalid-penalty', penalty_amount: 15 },
    ];
    assert.deepEqual(penaltySummary(excluded, members, [], now).review, []);
    assert.equal(penaltyDeadline('not-a-date'), null);
    assert.equal(penaltyDeadline('2026-02-30'), null);
});

test('each responsible gets one proposal, with a new deadline defining a new occurrence', () => {
    const multiple = { ...task, assigned_to: ['a', 'a', 'b'], penalty_amount: 10 };
    const summary = penaltySummary([multiple], members, [], now);
    assert.equal(summary.review.length, 2);
    assert.equal(summary.review.reduce((total, entry) => total + entry.amount, 0), 20);
    const reviewed: Penalty = { ...summary.review[0], id: 'p', status: 'forgiven', reviewed_at: now.toISOString(), reviewed_by: 'Adulto', reason: 'Justificada' };
    assert.deepEqual(penaltySummary([multiple], members, [reviewed], now).review.map(entry => entry.member_id), ['b']);
    assert.equal(penaltySummary([{ ...multiple, due_date: '2026-10-02' }], members, [reviewed], now).review.length, 2);
});

test('confirmed snapshots survive completion, edits, and deleted tasks or members; totals exclude history', () => {
    const proposal = penaltySummary([task], members, [], now).review[0];
    const records: Penalty[] = [
        { ...proposal, id: 'pending5', status: 'pending', reviewed_at: now.toISOString(), reviewed_by: 'Adulto', reason: 'Confirmada' },
        { ...proposal, id: 'pending10', amount: 10, status: 'pending', reviewed_at: now.toISOString(), reviewed_by: 'Adulto', reason: '' },
        { ...proposal, id: 'paid', status: 'paid', reviewed_at: now.toISOString(), reviewed_by: 'Adulto', reason: '', paid_at: now.toISOString() },
        { ...proposal, id: 'forgiven', status: 'forgiven', reviewed_at: now.toISOString(), reviewed_by: 'Adulto', reason: 'Excepción' },
    ];
    const summary = penaltySummary([{ ...task, is_completed: true, title: 'Editada', penalty_amount: 10 }], members, records, now);
    assert.equal(summary.review.length, 0);
    assert.equal(summary.pending[0].task_title, 'Cocinar');
    assert.equal(summary.pending[0].amount, 5);
    assert.equal(summary.totals.find(member => member.member_id === 'a')?.amount, 15);
    assert.equal(summary.history.length, 2);
    assert.equal(penaltySummary([], [], records, now).totals[0].amount, 15);
});

const request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await mockRequest<{ success: boolean; data: T }>(method, path, body);
    assert.equal(response.success, true);
    return response.data;
};
const summary = () => request<PenaltySummary>('GET', '/api/penalties');

test('demo API validates, reviews, forgives, pays, blocks duplicates and enforces adult permissions', async () => {
    const seed = await summary();
    assert.deepEqual([seed.review.length, seed.pending.length, seed.history.length], [2, 2, 2]);
    assert.equal(seed.totals.reduce((total, member) => total + member.amount, 0), 15);

    await assert.rejects(request('POST', '/api/tasks', { title: 'Invalid', penalty_amount: 15 }), /penalidad debe/);
    await assert.rejects(request('POST', '/api/tasks', { title: 'Invalid', penalty_amount: '5' }), /penalidad debe/);
    const created = await request<PenaltyTask & { recipe_id: string }>('POST', '/api/tasks', {
        title: 'Cocina de prueba', category: 'cooking', recipe_id: 'r1', assigned_to: ['m-dad'], due_date: '2020-01-01T12:30:00', penalty_amount: 5,
    });
    await request('PUT', `/api/tasks/${created.id}`, { title: 'Cocina editada', penalty_amount: 10 });
    const tasks = await request<Array<PenaltyTask & { recipe_id: string; assigned_to_members: Array<{ name: string }> }>>('GET', '/api/tasks');
    const edited = tasks.find(entry => entry.id === created.id)!;
    assert.equal(edited.recipe_id, 'r1');
    assert.deepEqual(edited.assigned_to, ['m-dad']);
    assert.equal(edited.assigned_to_members[0].name, 'Alex');
    assert.equal(edited.due_date, '2020-01-01T12:30:00');
    assert.equal(edited.penalty_amount, 10);
    const proposal = (await summary()).review.find(entry => entry.task_id === created.id)!;
    await assert.rejects(request('POST', '/api/penalties/review', { occurrence_key: proposal.occurrence_key, status: 'paid' }), /confirmar o perdonar/);
    await assert.rejects(request('POST', '/api/penalties/review', { occurrence_key: proposal.occurrence_key, status: 'pending', reason: 'x'.repeat(501) }), /500 caracteres/);

    const confirmed = await request<Penalty>('POST', '/api/penalties/review', { occurrence_key: proposal.occurrence_key, status: 'pending', reason: '  Incumplimiento revisado  ', amount: 5 });
    assert.equal(confirmed.amount, 10); // The mock derives the amount, never trusts the review payload.
    assert.equal(confirmed.reason, 'Incumplimiento revisado');
    assert.ok(confirmed.reviewed_at);
    await assert.rejects(request('POST', '/api/penalties/review', { occurrence_key: proposal.occurrence_key, status: 'pending' }), /ya ha sido revisado/);
    await assert.rejects(request('POST', '/api/penalties/review', { occurrence_key: proposal.occurrence_key, status: 'forgiven' }), /ya ha sido revisado/);
    await request('PUT', `/api/tasks/${created.id}`, { is_completed: true, title: 'Completada tarde', penalty_amount: 0 });
    assert.equal((await summary()).pending.find(entry => entry.id === confirmed.id)?.task_title, 'Cocina editada');
    assert.equal((await summary()).totals.find(entry => entry.member_id === 'm-dad')?.amount, 20);
    await request('DELETE', `/api/tasks/${created.id}`);
    assert.ok((await summary()).pending.some(entry => entry.id === confirmed.id));

    const forgiveness = seed.review.find(entry => entry.amount === 5)!;
    const forgiven = await request<Penalty>('POST', '/api/penalties/review', { occurrence_key: forgiveness.occurrence_key, status: 'forgiven', reason: 'Causa justificada' });
    assert.ok((await summary()).history.some(entry => entry.id === forgiven.id && entry.reason === 'Causa justificada'));
    await assert.rejects(request('POST', `/api/penalties/${forgiven.id}/pay`), /penalidades pendientes/);

    await request('PUT', '/api/auth/profile', { is_owner: false, role: 'enfant' });
    try {
        await assert.rejects(request('POST', '/api/penalties/review', { occurrence_key: seed.review[0].occurrence_key, status: 'pending' }), /Solo un adulto/);
        await assert.rejects(request('POST', `/api/penalties/${confirmed.id}/pay`), /Solo un adulto/);
        await assert.rejects(request('PUT', '/api/tasks/cook1', { penalty_amount: 10 }), /Solo un adulto/);
    } finally {
        await request('PUT', '/api/auth/profile', { is_owner: true, role: 'parent' });
    }

    const paid = await request<Penalty>('POST', `/api/penalties/${confirmed.id}/pay`, { reason: 'Pago manual' });
    assert.equal(paid.status, 'paid');
    assert.equal(paid.reason, 'Incumplimiento revisado');
    assert.equal(paid.payment_reason, 'Pago manual');
    assert.ok(paid.paid_at);
    await assert.rejects(request('POST', `/api/penalties/${confirmed.id}/pay`), /penalidades pendientes/);
    const final = await summary();
    assert.equal(final.totals.find(entry => entry.member_id === 'm-dad')?.amount, 10);
    assert.equal(final.history.filter(entry => entry.id === confirmed.id).length, 1);
    assert.equal(final.review.filter(entry => entry.occurrence_key === forgiveness.occurrence_key).length, 0);

    const noLongerOverdue = await request<PenaltyTask>('POST', '/api/tasks', { title: 'Cambió', due_date: '2020-01-01', assigned_to: ['m-dad'], penalty_amount: 5 });
    const stale = (await summary()).review.find(entry => entry.task_id === noLongerOverdue.id)!;
    await request('PUT', `/api/tasks/${noLongerOverdue.id}`, { is_completed: true });
    await assert.rejects(request('POST', '/api/penalties/review', { occurrence_key: stale.occurrence_key, status: 'pending' }), /ya no está incumplida/);
});
