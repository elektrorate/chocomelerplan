import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
import { IS_FIREBASE } from '../lib/firebase/config';
import { Plus, CheckSquare, Square, Trash2, Edit2, Filter, Scale, Hourglass, Check, X } from 'lucide-react';
import { Card, CardContent, Button, Dialog, Input, Select, Textarea, DatePicker, Badge, useToast } from '../components/ui';
import { format, parseISO } from 'date-fns';
import { dateLocale } from '../i18n/format';
import { Link } from 'react-router-dom';
import { ChefHat } from 'lucide-react';

interface Task {
    category?: string;
    recipe_id?: string;
    id: string;
    title: string;
    description?: string;
    is_completed: boolean;
    due_date?: string;
    frequency?: string;
    priority?: string;
    assigned_to?: string[];
    assigned_to_members?: Array<{ id: string; name: string; color: string }>;
    points?: number;
    penalty_amount?: number;
    pending_approval?: boolean;
    completed_at?: string;
    created_at: string;
}

interface FamilyMember {
    id: string;
    name: string;
    color: string;
}

const Tasks: React.FC = () => {
    const { t } = useTranslation(['tasks', 'common']);
    const { user } = useAuth();
    const { showToast } = useToast();
    const isParent = Boolean(user && (user.is_owner || user.role !== 'enfant'));
    const PRIORITIES = [
        { value: 'Haute', label: t('tasks:priorities.Haute') },
        { value: 'Moyenne', label: t('tasks:priorities.Moyenne') },
        { value: 'Basse', label: t('tasks:priorities.Basse') },
    ];
    const FREQUENCIES = [
        { value: 'Une fois', label: t('tasks:frequencies.Une fois') },
        { value: 'Quotidien', label: t('tasks:frequencies.Quotidien') },
        { value: 'Hebdomadaire', label: t('tasks:frequencies.Hebdomadaire') },
        { value: 'Mensuel', label: t('tasks:frequencies.Mensuel') },
        { value: 'Annuel', label: t('tasks:frequencies.Annuel') },
    ];
    const priorityLabel = (v?: string) => (v ? t(`tasks:priorities.${v}`, { defaultValue: v }) : '');
    const frequencyLabel = (v?: string) => (v ? t(`tasks:frequencies.${v}`, { defaultValue: v }) : '');
    const [tasks, setTasks] = useState<Task[]>([]);
    const [recipes, setRecipes] = useState<Array<{ id: string; name: string; readOnly?: boolean; archived?: boolean; deleted_at?: string; archived_at?: string }>>([]);
    const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [filterPriority, setFilterPriority] = useState<string>('');
    const [filterStatus, setFilterStatus] = useState<string>('all');
    const [filterMember, setFilterMember] = useState<string>('');
    const [error, setError] = useState('');
    const [nextOccurrenceId, setNextOccurrenceId] = useState<string | null>(null);

    // Form state
    const [formData, setFormData] = useState({
        title: '',
        description: '',
        due_date: '',
        due_time: '',
        frequency: 'Une fois',
        priority: 'Moyenne',
        assigned_to: [] as string[],
        penalty_amount: '0',
        category: 'cooking',
        recipe_id: '',
    });

    useEffect(() => {
        loadTasks();
        loadFamilyMembers();
        void loadRecipes();
    }, []);
    useWebSocketUpdates('tasks', () => { void loadTasks(); });
    useWebSocketUpdates('recipes', () => { void loadRecipes(); });

    const loadRecipes = async () => {
        try {
            const response = await api.get<{ success: boolean; data: typeof recipes }>('/api/recipes');
            if (response.success) setRecipes(response.data);
        } catch (error) {
            setError(error instanceof Error ? error.message : 'No se pudieron cargar las recetas.');
        }
    };

    const loadTasks = async () => {
        try {
            const response = await api.get<{ success: boolean; data: Task[] }>('/api/tasks');
            if (response.success) {
                setTasks([...response.data]);
            }
        } catch (error) {
            console.error('Failed to load tasks:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.loadTasks'));
        } finally {
            setLoading(false);
        }
    };

    const loadFamilyMembers = async () => {
        try {
            const response = await api.get<{ success: boolean; data: FamilyMember[] }>('/api/family');
            if (response.success) {
                setFamilyMembers(response.data);
            }
        } catch (error) {
            console.error('Failed to load family members:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.loadMembers'));
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (IS_FIREBASE && !isParent) return;
        setError('');
        if (IS_FIREBASE && formData.assigned_to.length > 3) {
            setError('Selecciona como máximo 3 responsables por tarea.');
            return;
        }
        if (formData.category === 'cooking' && !formData.recipe_id) {
            setError('Selecciona una receta para la tarea de cocinar.');
            return;
        }
        try {
            const { due_time, penalty_amount, ...fields } = formData;
            const unchangedDeadline = editingTask?.due_date && formData.due_date === editingTask.due_date.slice(0, 10)
                && due_time === (editingTask.due_date.slice(11, 16) || '');
            const payload: Record<string, unknown> = {
                ...fields,
                due_date: unchangedDeadline ? editingTask!.due_date : formData.due_date ? `${formData.due_date}${due_time ? `T${due_time}` : ''}` : null,
                recipe_id: formData.category === 'cooking' ? formData.recipe_id || null : null,
                ...(isParent ? { penalty_amount: Number(penalty_amount) } : {}),
            };
            if (editingTask) {
                await api.put(`/api/tasks/${editingTask.id}`, payload);
            } else {
                await api.post('/api/tasks', payload);
            }
            setDialogOpen(false);
            resetForm();
            loadTasks();
        } catch (error) {
            console.error('Failed to save task:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.saveTask'));
        }
    };

    const handleToggleComplete = async (task: Task) => {
        if (IS_FIREBASE && !isParent && (task.is_completed || !user?.member_id || !task.assigned_to?.includes(user.member_id))) return;
        try {
            const response = await api.put<{ success: boolean; data: Task }>(`/api/tasks/${task.id}`, {
                is_completed: !task.is_completed,
            });
            // A child completing a points chore: the points wait for a parent.
            if (!task.is_completed && response.success && response.data?.pending_approval) {
                showToast({
                    title: t('tasks:approval.toastTitle'),
                    description: t('tasks:approval.toastDescription'),
                });
            }
            loadTasks();
        } catch (error) {
            console.error('Failed to toggle task:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.toggleTask'));
        }
    };

    const handleNextOccurrence = async (task: Task) => {
        if (!isParent || nextOccurrenceId) return;
        setNextOccurrenceId(task.id);
        setError('');
        try {
            await api.post(`/api/tasks/${task.id}/next-occurrence`, {});
            await loadTasks();
        } catch (error) {
            setError(error instanceof Error ? error.message : 'No se pudo crear la siguiente ocurrencia.');
        } finally {
            setNextOccurrenceId(null);
        }
    };

    const handleApprove = async (task: Task) => {
        try {
            await api.post(`/api/tasks/${task.id}/approve`, {});
            loadTasks();
        } catch (error) {
            console.error('Failed to approve task:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.approveTask'));
        }
    };

    const handleReject = async (task: Task) => {
        try {
            await api.post(`/api/tasks/${task.id}/reject`, {});
            loadTasks();
        } catch (error) {
            console.error('Failed to reject task:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.rejectTask'));
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm(t('tasks:confirmDelete'))) return;
        try {
            await api.delete(`/api/tasks/${id}`);
            loadTasks();
        } catch (error) {
            console.error('Failed to delete task:', error);
            setError(error instanceof Error ? error.message : t('tasks:errors.deleteTask'));
        }
    };

    const handleEdit = (task: Task) => {
        setEditingTask(task);
        setFormData({
            title: task.title,
            description: task.description || '',
            // due_date is either a bare "yyyy-MM-dd" date or a naive local datetime
            // ("yyyy-MM-ddTHH:mm:ss" / "yyyy-MM-dd HH:mm:ss"); the first 10 chars
            // are always the local date — no Date round-trip (and no UTC shift).
            due_date: task.due_date ? task.due_date.slice(0, 10) : '',
            due_time: task.due_date ? task.due_date.slice(11, 16) : '',
            frequency: task.frequency || 'Une fois',
            priority: task.priority || 'Moyenne',
            assigned_to: task.assigned_to || [],
            penalty_amount: String(task.penalty_amount || 0),
            category: task.category || (task.recipe_id ? 'cooking' : 'general'),
            recipe_id: task.recipe_id || '',
        });
        setDialogOpen(true);
    };

    const resetForm = () => {
        setEditingTask(null);
        setFormData({
            title: '',
            description: '',
            due_date: '',
            due_time: '',
            frequency: 'Une fois',
            priority: 'Moyenne',
            assigned_to: [],
            penalty_amount: '0',
            category: 'cooking',
            recipe_id: '',
        });
    };

    const filteredTasks = tasks.filter((task) => {
        if (filterPriority && task.priority !== filterPriority) return false;
        if (filterStatus === 'completed' && !task.is_completed) return false;
        if (filterStatus === 'pending' && task.is_completed) return false;
        if (filterMember === '__unassigned__' && task.assigned_to && task.assigned_to.length > 0) return false;
        if (filterMember && filterMember !== '__unassigned__' && !(task.assigned_to || []).includes(filterMember)) return false;
        return true;
    });

    const getPriorityColor = (priority?: string) => {
        switch (priority) {
            case 'Haute':
                return 'danger';
            case 'Moyenne':
                return 'warning';
            case 'Basse':
                return 'success';
            default:
                return 'default';
        }
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center min-h-[50vh]">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="text-muted-foreground font-medium animate-pulse">{t('tasks:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-6xl mx-auto space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-h1 mb-1">Cocinar y tareas</h1>
                    <p className="text-muted-foreground text-body">La cocina primero: organiza quién cocina y qué receta prepara.</p>
                </div>
                {(!IS_FIREBASE || isParent) && <Button onClick={() => { resetForm(); setDialogOpen(true); }}>
                    <Plus className="w-4 h-4 mr-2" />
                    Nueva tarea de cocina
                </Button>}
            </div>
            {IS_FIREBASE && !isParent && <p className="text-caption text-muted-foreground">Solo puedes completar tus tareas asignadas. Los adultos crean, editan y reabren las tareas.</p>}

            {/* Filters */}
            <Card>
                <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-2">
                            <Filter className="h-4 w-4 text-muted-foreground" />
                            <span className="text-body-sm font-medium">{t('tasks:filters.label')}</span>
                        </div>
                        <Select
                            value={filterStatus}
                            onValueChange={setFilterStatus}
                            options={[
                                { value: 'all', label: t('tasks:filters.statusAll') },
                                { value: 'pending', label: t('tasks:filters.statusPending') },
                                { value: 'completed', label: t('tasks:filters.statusCompleted') },
                            ]}
                            className="w-40"
                        />
                        <Select
                            value={filterPriority}
                            onValueChange={setFilterPriority}
                            options={[
                                { value: '', label: t('tasks:filters.allPriorities') },
                                ...PRIORITIES,
                            ]}
                            className="w-48"
                        />
                        <Select
                            value={filterMember}
                            onValueChange={setFilterMember}
                            options={[
                                { value: '', label: t('tasks:filters.allMembers') },
                                { value: '__unassigned__', label: t('tasks:filters.unassigned') },
                                ...familyMembers.map((m) => ({ value: m.id, label: m.name })),
                            ]}
                            className="w-48"
                        />
                        {(filterPriority || filterStatus !== 'all' || filterMember) && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    setFilterPriority('');
                                    setFilterStatus('all');
                                    setFilterMember('');
                                }}
                            >
                                {t('common:actions.reset')}
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* Tasks List */}
            <div className="space-y-3">
                {filteredTasks.length === 0 ? (
                    <Card>
                        <CardContent className="p-8 text-center">
                            <CheckSquare className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-50" />
                            <p className="text-muted-foreground">
                                {tasks.length === 0
                                    ? t('tasks:empty.none')
                                    : t('tasks:empty.noMatch')}
                            </p>
                        </CardContent>
                    </Card>
                ) : (
                    [...filteredTasks].sort((a, b) => Number(b.category === 'cooking' || !!b.recipe_id) - Number(a.category === 'cooking' || !!a.recipe_id)).map((task) => (
                        <Card
                            key={task.id}
                            className={`transition-all hover:shadow-md ${task.category === 'cooking' || task.recipe_id ? 'border-primary border-l-4 bg-primary/5 ' : ''} ${task.pending_approval
                                ? 'border-amber-300 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20'
                                : task.is_completed ? 'opacity-60' : ''}`}
                        >
                            <CardContent className="p-4">
                                <div className="flex items-start gap-4">
                                    <button
                                        aria-label={`${task.is_completed ? 'Marcar pendiente' : 'Completar'}: ${task.title}`}
                                        onClick={() => handleToggleComplete(task)}
                                        disabled={IS_FIREBASE && !isParent && (task.is_completed || !user?.member_id || !task.assigned_to?.includes(user.member_id))}
                                        className="mt-1 flex-shrink-0 disabled:cursor-default disabled:opacity-50"
                                    >
                                        {task.is_completed ? (
                                            <CheckSquare className="h-5 w-5 text-emerald-600" />
                                        ) : (
                                            <Square className="h-5 w-5 text-muted-foreground hover:text-nexus-blue transition-colors" />
                                        )}
                                    </button>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
                                            <div className="flex-1 min-w-0">
                                                <h3
                                                    className={`text-body font-semibold mb-1 ${task.is_completed ? 'line-through text-muted-foreground' : ''
                                                        }`}
                                                >
                                                    {task.title}
                                                </h3>
                                                {(task.category === 'cooking' || task.recipe_id) && <div className="flex flex-wrap items-center gap-3 mb-3 text-primary"><span className="inline-flex items-center gap-1 text-sm font-semibold"><ChefHat className="h-4 w-4" /> Cocinar</span>{task.recipe_id && <Link className="text-sm underline underline-offset-4 font-medium" to={`/recipes?recipe=${encodeURIComponent(task.recipe_id)}`}>Ver receta: {recipes.find(r => r.id === task.recipe_id)?.name || 'Receta asociada'}</Link>}</div>}
                                                {task.description && (
                                                    <p className="text-body-sm text-muted-foreground mb-2">
                                                        {task.description}
                                                    </p>
                                                )}
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Badge variant={task.penalty_amount ? 'warning' : 'default'} className="flex items-center gap-1">
                                                        <Scale className="h-3 w-3" />
                                                        {task.penalty_amount ? `Penalidad: ${task.penalty_amount} €` : 'Sin penalidad'}
                                                    </Badge>
                                                    {task.pending_approval && (
                                                        <Badge variant="warning" className="flex items-center gap-1">
                                                            <Hourglass className="h-3 w-3" />
                                                            {t('tasks:approval.pendingBadge')}
                                                        </Badge>
                                                    )}
                                                    {task.priority && (
                                                        <Badge variant={getPriorityColor(task.priority)}>
                                                            {priorityLabel(task.priority)}
                                                        </Badge>
                                                    )}
                                                    {task.frequency && task.frequency !== 'Une fois' && (
                                                        <Badge variant="secondary">{frequencyLabel(task.frequency)}</Badge>
                                                    )}
                                                    {task.due_date && (
                                                        <Badge variant="default">
                                                            {t('tasks:due', { date: format(parseISO(task.due_date), task.due_date.length > 10 ? 'dd MMM yyyy HH:mm' : 'dd MMM yyyy', { locale: dateLocale() }) })}
                                                        </Badge>
                                                    )}
                                                {(task.assigned_to_members || []).map((member) => (
                                                        <Badge
                                                            key={member.id}
                                                            variant="primary"
                                                            className="flex items-center gap-1"
                                                        >
                                                            <div
                                                                className="w-2 h-2 rounded-full"
                                                                style={{ backgroundColor: member.color }}
                                                            />
                                                            {member.name}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {!IS_FIREBASE && isParent && task.pending_approval && (
                                                    <>
                                                        <Button
                                                            variant="secondary"
                                                            size="sm"
                                                            onClick={() => handleApprove(task)}
                                                            className="text-success"
                                                        >
                                                            <Check className="h-4 w-4 mr-1" />
                                                            {t('tasks:approval.approve')}
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => handleReject(task)}
                                                            className="text-destructive"
                                                        >
                                                            <X className="h-4 w-4 mr-1" />
                                                            {t('tasks:approval.reject')}
                                                        </Button>
                                                    </>
                                                )}
                                                {IS_FIREBASE && isParent && task.is_completed && task.due_date && task.frequency && task.frequency !== 'Une fois' && <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    disabled={nextOccurrenceId !== null}
                                                    onClick={() => void handleNextOccurrence(task)}
                                                >{nextOccurrenceId === task.id ? 'Creando...' : 'Siguiente ocurrencia'}</Button>}
                                                {(!IS_FIREBASE || isParent) && <><Button
                                                    variant="ghost"
                                                    size="sm"
                                                    aria-label={`Editar: ${task.title}`}
                                                    onClick={() => handleEdit(task)}
                                                >
                                                    <Edit2 className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    aria-label={`Eliminar: ${task.title}`}
                                                    onClick={() => handleDelete(task.id)}
                                                >
                                                    <Trash2 className="h-4 w-4 text-red-500" />
                                                </Button>
                                                </>}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))
                )}
            </div>

            {/* Dialog */}
            <Dialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title={editingTask ? t('tasks:dialog.editTitle') : t('tasks:dialog.createTitle')}
                description={t('tasks:dialog.description')}
            >
                <form onSubmit={handleSubmit} className="space-y-4">
                    {error && <p role="alert" className="text-danger text-sm">{error}</p>}
                    <div className="space-y-2"><p className="text-sm font-medium">Tipo de tarea</p><Select value={formData.category} onValueChange={category => setFormData({ ...formData, category, recipe_id: category === 'cooking' ? formData.recipe_id : '' })} options={[{ value: 'cooking', label: 'Cocinar' }, { value: 'general', label: 'Otra tarea' }]} /></div>
                    {formData.category === 'cooking' && <div className="space-y-2"><p className="text-sm font-medium">Receta asociada</p><Select value={formData.recipe_id} onValueChange={recipe_id => setFormData({ ...formData, recipe_id, title: formData.title || `Cocinar ${recipes.find(r => r.id === recipe_id)?.name || ''}` })} options={[{ value: '', label: 'Seleccionar receta' }, ...recipes.filter(r => !IS_FIREBASE || r.id === editingTask?.recipe_id || (!r.readOnly && !r.archived && !r.deleted_at && !r.archived_at)).map(r => ({ value: r.id, label: r.name }))]} />{IS_FIREBASE && <p className="text-caption text-muted-foreground">Las recetas archivadas solo se conservan en tareas que ya las tenían seleccionadas.</p>}</div>}
                    <Input
                        label={t('tasks:form.title')}
                        value={formData.title}
                        onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                        required
                        placeholder={t('tasks:form.titlePlaceholder')}
                    />
                    <Textarea
                        label={t('tasks:form.description')}
                        value={formData.description}
                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                        placeholder={t('tasks:form.descriptionPlaceholder')}
                        rows={3}
                    />
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-label font-medium text-foreground mb-1.5">
                                {t('tasks:form.priority')}
                            </label>
                            <Select
                                value={formData.priority}
                                onValueChange={(value) => setFormData({ ...formData, priority: value })}
                                options={PRIORITIES}
                            />
                        </div>
                        <div>
                            <label className="block text-label font-medium text-foreground mb-1.5">
                                {t('tasks:form.frequency')}
                            </label>
                            <Select
                                value={formData.frequency}
                                onValueChange={(value) => setFormData({ ...formData, frequency: value })}
                                options={FREQUENCIES}
                            />
                        </div>
                    </div>
                    <DatePicker
                        label={t('tasks:form.dueDate')}
                        value={formData.due_date}
                        onChange={(value) => setFormData({ ...formData, due_date: value, due_time: value ? formData.due_time : '' })}
                    />
                    <Input
                        label="Hora límite (opcional)"
                        aria-label="Hora límite (opcional)"
                        type="time"
                        value={formData.due_time}
                        disabled={!formData.due_date}
                        onChange={event => setFormData({ ...formData, due_time: event.target.value })}
                    />
                    <p className="text-caption text-muted-foreground">Sin hora, la tarea vence al terminar el día indicado.</p>
                    {isParent && (
                        <div className="space-y-2">
                            <p className="text-label font-medium">Penalidad por incumplimiento</p>
                            <Select
                                value={formData.penalty_amount}
                                onValueChange={value => setFormData({ ...formData, penalty_amount: value })}
                                options={[{ value: '0', label: 'Sin penalidad' }, { value: '5', label: '5 €' }, { value: '10', label: '10 €' }]}
                            />
                            <p className="text-caption text-muted-foreground">Importe por responsable. Requiere revisión de un adulto; no se realizan cobros automáticos.</p>
                        </div>
                    )}
                    <div>
                        <label className="block text-label font-medium text-foreground mb-1.5">
                            {t('tasks:form.assignTo')}
                        </label>
                        {IS_FIREBASE && <p className="mb-2 text-caption text-muted-foreground">Máximo 3 responsables por tarea.</p>}
                        {familyMembers.length === 0 ? (
                            <p className="text-body-sm text-muted-foreground">{t('tasks:form.noMembers')}</p>
                        ) : (
                            <div className="space-y-2 rounded-input border border-border bg-surface-2/40 p-3">
                                {familyMembers.map((member) => (
                                    <label key={member.id} className="flex items-center gap-2 cursor-pointer hover:bg-nexus-background rounded px-1 py-0.5">
                                        <input
                                            type="checkbox"
                                            checked={formData.assigned_to.includes(member.id)}
                                            disabled={IS_FIREBASE && formData.assigned_to.length >= 3 && !formData.assigned_to.includes(member.id)}
                                            onChange={() => {
                                                setFormData((prev) => ({
                                                    ...prev,
                                                    assigned_to: prev.assigned_to.includes(member.id)
                                                        ? prev.assigned_to.filter((id) => id !== member.id)
                                                        : IS_FIREBASE && prev.assigned_to.length >= 3 ? prev.assigned_to : [...prev.assigned_to, member.id],
                                                }));
                                            }}
                                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                                        />
                                        <div
                                            className="w-3 h-3 rounded-full flex-shrink-0"
                                            style={{ backgroundColor: member.color }}
                                        />
                                        <span className="text-body-sm">{member.name}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="flex justify-end gap-3 pt-4">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setDialogOpen(false)}
                        >
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">
                            {editingTask ? t('common:actions.save') : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Tasks;
