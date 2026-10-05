import React, { useEffect, useRef, useState } from 'react';
import { Check, Clock, History, RefreshCw, Scale } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { api } from '../lib/api';
import { IS_FIREBASE } from '../lib/firebase/config';
import { penaltyDeadline } from '../lib/penalties';
import type { Penalty, PenaltyProposal, PenaltySummary } from '../lib/penalties';
import { Badge, Button, Card, CardContent, Dialog, Textarea } from '../components/ui';

const euros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const dates = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });

type PenaltyAction =
    | { kind: 'pending' | 'forgiven'; entry: PenaltyProposal }
    | { kind: 'pay'; entry: Penalty };

const Rewards: React.FC = () => {
    const { user } = useAuth();
    const isAdult = Boolean(user && (user.is_owner || user.role !== 'enfant'));
    const [summary, setSummary] = useState<(PenaltySummary & { truncated?: boolean }) | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [actionError, setActionError] = useState('');
    const [action, setAction] = useState<PenaltyAction | null>(null);
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const mounted = useRef(false);
    const requestId = useRef(0);
    const submitting = useRef(false);
    const error = actionError || loadError;

    const load = async (afterMutation = false, detect = false) => {
        if (!mounted.current || (submitting.current && !afterMutation)) return;
        const id = ++requestId.current;
        setRefreshing(true);
        try {
            const response = IS_FIREBASE && isAdult && detect
                ? await api.post<{ success: true; data: PenaltySummary & { truncated?: boolean } }>('/api/penalties/detect', {})
                : await api.get<{ success: true; data: PenaltySummary & { truncated?: boolean } }>('/api/penalties');
            if (!mounted.current || id !== requestId.current) return;
            // Copy API snapshots: demo responses can share objects with their store.
            setSummary({
                truncated: response.data.truncated,
                review: response.data.review.map(entry => ({ ...entry })),
                pending: response.data.pending.map(entry => ({ ...entry })),
                history: response.data.history.map(entry => ({ ...entry })),
                totals: response.data.totals.map(member => ({ ...member })),
            });
            setLoadError('');
        } catch (err) {
            if (mounted.current && id === requestId.current) {
                setLoadError(err instanceof Error ? err.message : 'No se pudieron cargar las penalidades.');
            }
        } finally {
            if (mounted.current && id === requestId.current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    };

    useEffect(() => {
        mounted.current = true;
        void load(false, true);
        const timer = IS_FIREBASE ? undefined : window.setInterval(() => { void load(); }, 30_000);
        return () => {
            mounted.current = false;
            ++requestId.current;
            window.clearInterval(timer);
        };
    }, []);
    useWebSocketUpdates('tasks', () => { void load(); });
    useWebSocketUpdates('rewards', () => { void load(); });

    const openAction = (next: PenaltyAction) => {
        if (!isAdult || submitting.current) return;
        setActionError('');
        setReason('');
        setAction(next);
    };

    const closeAction = () => {
        if (!submitting.current) setAction(null);
    };

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!isAdult || !action || submitting.current) return;
        submitting.current = true;
        ++requestId.current;
        setSaving(true);
        setActionError('');
        try {
            if (action.kind === 'pay') {
                await api.post(`/api/penalties/${encodeURIComponent(action.entry.id)}/pay`, { reason: reason.trim() });
            } else {
                await api.post('/api/penalties/review', {
                    occurrence_key: action.entry.occurrence_key,
                    status: action.kind,
                    reason: reason.trim(),
                });
            }
            await load(true);
            if (mounted.current) setAction(null);
        } catch (err) {
            if (mounted.current) {
                setActionError(err instanceof Error ? err.message : 'No se pudo registrar la penalidad. Inténtalo de nuevo.');
            }
        } finally {
            submitting.current = false;
            if (mounted.current) {
                setSaving(false);
                setRefreshing(false);
            }
        }
    };

    const formatDate = (value?: string) => {
        if (!value) return 'Sin fecha indicada';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Fecha no válida' : dates.format(date);
    };

    const entryDetails = (entry: PenaltyProposal) => {
        const deadline = penaltyDeadline(entry.due_date);
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(entry.due_date);
        return (
            <div className="min-w-0 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge className="max-w-full gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: entry.member_color }} aria-hidden="true" />
                        <span className="break-words">Responsable: {entry.member_name}</span>
                    </Badge>
                </div>
                <h3 className="break-words text-body font-semibold">{entry.task_title}</h3>
                <p className="text-caption text-muted-foreground">
                    Vencimiento: {deadline && !Number.isNaN(deadline.getTime()) ? dates.format(deadline) : 'Fecha no válida'}
                    {dateOnly && ' (fin del día, 23:59)'}
                </p>
            </div>
        );
    };

    const reviewDetails = (entry: Penalty) => (
        <div className="space-y-1 border-t border-border pt-3 text-caption text-muted-foreground">
            <p>Revisada el {formatDate(entry.reviewed_at)}</p>
            <p className="break-words">Revisada por: {entry.reviewed_by || 'Sin revisor indicado'}</p>
            <p className="whitespace-pre-wrap break-words">Motivo: {entry.reason?.trim() || 'Sin motivo indicado'}</p>
        </div>
    );

    const review = summary?.review || [];
    const pending = summary?.pending || [];
    const history = summary?.history || [];
    const totals = summary?.totals || [];
    const grandTotal = totals.reduce((total, member) => total + member.amount, 0);
    const actionLabel = action?.kind === 'pay' ? 'Marcar como pagada'
        : action?.kind === 'forgiven' ? 'Perdonar penalidad' : 'Confirmar penalidad';

    return (
        <div className="mx-auto max-w-6xl space-y-8">
            <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div className="min-w-0">
                    <h1 className="mb-2 flex items-center gap-3 text-h1"><Scale className="h-7 w-7 shrink-0 text-primary" />Penalidades</h1>
                    <p className="text-body text-muted-foreground">
                        Revisa las tareas vencidas y registra su penalidad. Solo se lleva un registro: no se realizan cargos ni cobros automáticos.
                    </p>
                    <p className="mt-2 text-caption text-muted-foreground">El importe de cada penalidad corresponde a cada responsable, no se reparte entre los participantes.</p>
                </div>
                <Button variant="secondary" disabled={refreshing || saving} onClick={() => { void load(false, true); }} className="shrink-0">
                    <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                    {refreshing ? 'Actualizando...' : 'Actualizar'}
                </Button>
            </header>

            {!isAdult && <p className="rounded-input border border-border bg-surface-2 px-4 py-3 text-caption">Solo los adultos pueden revisar penalidades o marcarlas como pagadas.</p>}
            {IS_FIREBASE && <p className="text-caption text-muted-foreground">Spark detecta vencimientos al abrir la aplicación o esta página y al pulsar Actualizar como adulto. No hay detección periódica en segundo plano.</p>}
            {summary?.truncated && <p role="status" className="rounded-input border border-warning/30 bg-warning/10 px-4 py-3 text-caption">Vista parcial: alguna lista alcanzó el límite de 200 registros. Puede haber más penalidades que no se muestran.</p>}
            {error && <div role="alert" className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">{error}</div>}
            {loading && <p role="status" className="flex items-center gap-3 text-muted-foreground"><span className="spinner-brand" />Cargando penalidades...</p>}

            <section aria-labelledby="penalties-review" className="space-y-4" aria-busy={loading}>
                <div className="flex flex-wrap items-center gap-3">
                    <Clock className="h-5 w-5 text-warning" aria-hidden="true" />
                    <h2 id="penalties-review" className="text-h2">Por revisar</h2>
                    <Badge variant="warning">{review.length}</Badge>
                </div>
                <p className="text-caption text-muted-foreground">Propuestas de 5 o 10 EUR por responsable. Un adulto debe confirmar o perdonar cada propuesta.</p>
                {!loading && summary && review.length === 0 && <Card><CardContent className="p-5 text-caption text-muted-foreground">No hay penalidades por revisar.</CardContent></Card>}
                <div className="grid gap-4 md:grid-cols-2">
                    {review.map(entry => (
                        <Card key={entry.occurrence_key}>
                            <CardContent className="space-y-4 p-5">
                                {entryDetails(entry)}
                                <p className="text-body font-semibold tabular-nums">Importe propuesto: {euros.format(entry.amount)} <span className="text-caption font-normal text-muted-foreground">por responsable</span></p>
                                {isAdult && <div className="flex flex-col gap-2 sm:flex-row">
                                    <Button disabled={saving} onClick={() => openAction({ kind: 'pending', entry })}>Confirmar penalidad</Button>
                                    <Button variant="secondary" disabled={saving} onClick={() => openAction({ kind: 'forgiven', entry })}>Perdonar</Button>
                                </div>}
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </section>

            <section aria-labelledby="penalties-pending" className="space-y-4" aria-busy={loading}>
                <div className="flex flex-wrap items-center gap-3">
                    <Scale className="h-5 w-5 text-primary" aria-hidden="true" />
                    <h2 id="penalties-pending" className="text-h2">Pendientes de pago</h2>
                    <Badge variant="primary">{pending.length}</Badge>
                </div>
                {summary && <Card className="border-primary/20 bg-primary/5">
                    <CardContent className="space-y-4 p-5">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <h3 className="text-body font-semibold">Total pendiente</h3>
                            <p className="font-serif text-3xl tabular-nums">{euros.format(grandTotal)}</p>
                        </div>
                        {totals.length > 0 && <ul className="grid gap-3 border-t border-primary/20 pt-4 sm:grid-cols-2 lg:grid-cols-3">
                            {totals.map(member => <li key={member.member_id} className="flex min-w-0 items-center gap-2 text-caption">
                                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: member.member_color }} aria-hidden="true" />
                                <span className="min-w-0 flex-1 break-words">{member.member_name}</span>
                                <span className="shrink-0 font-semibold tabular-nums">{euros.format(member.amount)}</span>
                            </li>)}
                        </ul>}
                    </CardContent>
                </Card>}
                {!loading && summary && pending.length === 0 && <Card><CardContent className="p-5 text-caption text-muted-foreground">No hay penalidades pendientes de pago.</CardContent></Card>}
                <div className="grid gap-4 md:grid-cols-2">
                    {pending.map(entry => <Card key={entry.id}>
                        <CardContent className="space-y-4 p-5">
                            <Badge variant="warning">Pendiente de pago</Badge>
                            {entryDetails(entry)}
                            <p className="text-body font-semibold tabular-nums">{euros.format(entry.amount)} <span className="text-caption font-normal text-muted-foreground">por responsable</span></p>
                            {reviewDetails(entry)}
                            {isAdult && <Button disabled={saving} onClick={() => openAction({ kind: 'pay', entry })} className="w-full sm:w-auto">
                                <Check className="mr-2 h-4 w-4" aria-hidden="true" />Marcar como pagada
                            </Button>}
                        </CardContent>
                    </Card>)}
                </div>
            </section>

            <section aria-labelledby="penalties-history" className="space-y-4" aria-busy={loading}>
                <div className="flex flex-wrap items-center gap-3">
                    <History className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                    <h2 id="penalties-history" className="text-h2">Historial</h2>
                    <Badge>{history.length}</Badge>
                </div>
                <p className="text-caption text-muted-foreground">Penalidades pagadas o perdonadas. Los registros confirmados no se editan ni se eliminan.</p>
                {!loading && summary && history.length === 0 && <Card><CardContent className="p-5 text-caption text-muted-foreground">Todavía no hay penalidades pagadas o perdonadas.</CardContent></Card>}
                <div className="grid gap-4 md:grid-cols-2">
                    {history.map(entry => <Card key={entry.id}>
                        <CardContent className="space-y-4 p-5">
                            <Badge variant={entry.status === 'paid' ? 'success' : 'secondary'}>{entry.status === 'paid' ? 'Pagada' : 'Perdonada'}</Badge>
                            {entryDetails(entry)}
                            <p className="text-body font-semibold tabular-nums">{euros.format(entry.amount)} <span className="text-caption font-normal text-muted-foreground">por responsable{entry.status === 'forgiven' ? ' (importe perdonado)' : ''}</span></p>
                            {reviewDetails(entry)}
                            {entry.status === 'paid' && <div className="space-y-1 border-t border-border pt-3 text-caption text-muted-foreground">
                                <p>Pagada el {formatDate(entry.paid_at)}</p>
                                <p className="break-words">Pago registrado por: {entry.paid_by || 'Sin responsable indicado'}</p>
                                <p className="whitespace-pre-wrap break-words">Motivo del pago: {entry.payment_reason?.trim() || 'Sin motivo indicado'}</p>
                            </div>}
                        </CardContent>
                    </Card>)}
                </div>
            </section>

            <Dialog
                open={action !== null}
                onOpenChange={open => { if (!open) closeAction(); }}
                title={actionLabel}
                description={action?.kind === 'pay' ? 'Solo se registrará el pago. No se realizará ningún cobro.'
                    : action?.kind === 'forgiven' ? 'La propuesta se guardará como perdonada, sin importe pendiente de pago.'
                        : 'La penalidad quedará registrada como pendiente de pago. No se realizará ningún cargo.'}
                className={saving ? '[&>div:first-child>button]:pointer-events-none [&>div:first-child>button]:opacity-50' : undefined}
            >
                {action && <form onSubmit={submit} className="space-y-4" aria-busy={saving}>
                    {entryDetails(action.entry)}
                    <p className="rounded-input bg-surface-2 px-3 py-3 text-body font-semibold tabular-nums">
                        {euros.format(action.entry.amount)} por responsable
                    </p>
                    {error && <div role="alert" className="rounded-input border border-danger/30 bg-danger/10 px-3 py-3 text-caption text-danger">{error}</div>}
                    {!isAdult && <p className="text-caption text-danger">Solo los adultos pueden revisar penalidades o marcarlas como pagadas.</p>}
                    <Textarea
                        label={action.kind === 'pay' ? 'Motivo del pago (opcional)' : 'Motivo de la revisión (opcional)'}
                        aria-label={action.kind === 'pay' ? 'Motivo del pago (opcional)' : 'Motivo de la revisión (opcional)'}
                        value={reason}
                        onChange={event => setReason(event.target.value)}
                        placeholder="Si lo deseas, añade un motivo."
                        maxLength={500}
                        disabled={saving || !isAdult}
                    />
                    <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
                        <Button type="button" variant="secondary" disabled={saving} onClick={closeAction}>Cancelar</Button>
                        {isAdult && <Button type="submit" disabled={saving}>{saving ? 'Guardando...' : actionLabel}</Button>}
                    </div>
                </form>}
            </Dialog>
        </div>
    );
};

export default Rewards;
