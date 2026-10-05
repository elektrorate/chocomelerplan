import { parseISO } from 'date-fns';

export interface PenaltyTask {
    id: string;
    title: string;
    is_completed: boolean;
    due_date?: string;
    assigned_to?: string[];
    penalty_amount?: number;
}

export interface PenaltyMember {
    id: string;
    name: string;
    color: string;
}

export interface PenaltyProposal {
    occurrence_key: string;
    task_id: string;
    task_title: string;
    member_id: string;
    member_name: string;
    member_color: string;
    due_date: string;
    amount: 5 | 10;
}

export interface Penalty extends PenaltyProposal {
    id: string;
    status: 'pending' | 'paid' | 'forgiven';
    reviewed_at: string;
    reviewed_by: string;
    reason: string;
    paid_at?: string;
    paid_by?: string;
    payment_reason?: string;
}

export interface PenaltySummary {
    review: PenaltyProposal[];
    pending: Penalty[];
    history: Penalty[];
    totals: Array<{ member_id: string; member_name: string; member_color: string; amount: number }>;
}

export function penaltyDeadline(value: string): Date | null {
    const date = parseISO(value);
    if (Number.isNaN(date.getTime())) return null;
    // Bare dates are local calendar days, not UTC midnights.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) date.setHours(23, 59, 59, 999);
    return date;
}

export function penaltyOccurrence(taskId: string, memberId: string, dueDate: string): string {
    return JSON.stringify([taskId, memberId, penaltyDeadline(dueDate)?.toISOString()]);
}

export function penaltySummary(tasks: PenaltyTask[], members: PenaltyMember[], records: Penalty[], now = new Date()): PenaltySummary {
    const reviewed = new Set(records.map(record => record.occurrence_key));
    const membersById = new Map(members.map(member => [member.id, member]));
    const review: PenaltyProposal[] = [];
    for (const task of tasks) {
        if (task.is_completed || !task.due_date || (task.penalty_amount !== 5 && task.penalty_amount !== 10)) continue;
        const deadline = penaltyDeadline(task.due_date);
        if (!deadline || now.getTime() <= deadline.getTime()) continue;
        for (const memberId of new Set(task.assigned_to || [])) {
            const member = membersById.get(memberId);
            const key = penaltyOccurrence(task.id, memberId, task.due_date);
            if (!member || reviewed.has(key)) continue;
            review.push({
                occurrence_key: key, task_id: task.id, task_title: task.title,
                member_id: member.id, member_name: member.name, member_color: member.color,
                due_date: task.due_date, amount: task.penalty_amount,
            });
        }
    }
    review.sort((a, b) => penaltyDeadline(a.due_date)!.getTime() - penaltyDeadline(b.due_date)!.getTime());
    const pending = records.filter(record => record.status === 'pending').map(record => ({ ...record }));
    const history = records.filter(record => record.status !== 'pending').map(record => ({ ...record }))
        .sort((a, b) => (b.paid_at || b.reviewed_at).localeCompare(a.paid_at || a.reviewed_at));
    const totals = new Map(members.map(member => [member.id, {
        member_id: member.id, member_name: member.name, member_color: member.color, amount: 0,
    }]));
    // Confirmed snapshots remain payable even if their task/member is removed.
    for (const record of pending) {
        const total = totals.get(record.member_id) || {
            member_id: record.member_id, member_name: record.member_name, member_color: record.member_color, amount: 0,
        };
        total.amount += record.amount;
        totals.set(record.member_id, total);
    }
    return { review, pending, history, totals: [...totals.values()] };
}
