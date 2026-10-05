import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChefHat, Clock, Square } from 'lucide-react';
import { api } from '../../lib/api';
import { useWebSocketUpdates } from '../../hooks/useWebSocketUpdates';

interface Task {
    id: string; title: string; category?: string; recipe_id?: string; is_completed: boolean;
    due_date?: string; assigned_to_members?: Array<{ id: string; name: string }>;
}
interface Recipe { id: string; name: string; prep_time?: number; cook_time?: number }

export default function CookingTasks() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [recipes, setRecipes] = useState<Recipe[]>([]);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const load = async () => {
        try {
            const [t, r] = await Promise.all([
                api.get<{ success: boolean; data: Task[] }>('/api/tasks'),
                api.get<{ success: boolean; data: Recipe[] }>('/api/recipes'),
            ]);
            if (t.success) setTasks([...t.data]);
            if (r.success) setRecipes([...r.data]);
            setError('');
        } catch { setError('No se pudieron cargar las tareas de cocina.'); }
        finally { setLoading(false); }
    };
    useEffect(() => { void load(); }, []);
    useWebSocketUpdates('tasks', () => { void load(); });
    const pending = tasks.filter(t => !t.is_completed && (t.category === 'cooking' || t.recipe_id))
        .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
    const complete = async (id: string) => {
        try { await api.put(`/api/tasks/${id}`, { is_completed: true }); await load(); }
        catch { setError('No se pudo completar la tarea. Inténtalo de nuevo.'); }
    };
    return <section className="kitchen-panel rounded-3xl border border-border bg-background p-6 sm:p-10 space-y-8 shadow-surface">
        <div className="flex flex-wrap items-end justify-between gap-6 pb-8 border-b border-border">
            <div><p className="w-fit rounded-full border border-border bg-card px-3 py-1 text-primary text-xs font-semibold uppercase tracking-wider flex items-center gap-2"><ChefHat className="h-4 w-4" /> Nuestra cocina</p>
                <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-medium tracking-tight mt-4">¿Qué cocinamos hoy?</h2>
                <p className="text-muted-foreground mt-3">Las tareas de cocinar y sus recetas, siempre a mano.</p></div>
            <Link to="/tasks" className="btn-nexus btn-primary px-6 py-3.5 text-sm">Organizar tareas de cocina</Link>
        </div>
        {error && <p role="alert" className="text-danger">{error}</p>}
        {loading ? <p>Cargando cocina…</p> : pending.length === 0 ? <p className="text-muted-foreground">Todo listo. Añade una tarea de cocinar y elige su receta.</p> :
            <div className="grid gap-6 md:grid-cols-2">{pending.map(task => {
                const recipe = recipes.find(r => r.id === task.recipe_id);
                return <article key={task.id} className="cooking-card rounded-2xl border border-border bg-card p-6 sm:p-7 space-y-5 shadow-surface">
                    <div className="flex gap-3.5 items-start"><span className="rounded-xl bg-primary-soft p-2.5 shrink-0"><ChefHat className="h-5 w-5 text-primary" /></span><div><h3 className="font-bold text-lg leading-snug">{task.title}</h3>
                        <p className="text-sm text-muted-foreground mt-2"><span className="rounded bg-surface-2 px-2 py-0.5 text-foreground text-xs font-semibold">{task.assigned_to_members?.map(m => m.name).join(', ') || 'Sin asignar'}</span>{task.due_date ? ` · ${new Intl.DateTimeFormat('es-ES', {day:'2-digit', month:'short', year:'numeric'}).format(new Date(`${task.due_date.slice(0,10)}T12:00:00`))}` : ''}</p></div></div>
                    {recipe && <p className="flex items-center gap-2 text-sm bg-background px-3.5 py-2.5 rounded-xl border border-border"><Clock className="h-4 w-4 shrink-0 text-muted-foreground" /><span><strong>{(recipe.prep_time || 0) + (recipe.cook_time || 0)} min</strong> · {recipe.name}</span></p>}
                    <div className="flex flex-wrap gap-4 items-center justify-between border-t border-border pt-5">{recipe && <Link className="text-primary font-semibold underline underline-offset-4 text-sm" to={`/recipes?recipe=${encodeURIComponent(recipe.id)}`}>Abrir receta ↗</Link>}
                        <button onClick={() => void complete(task.id)} className="inline-flex items-center gap-2 text-sm font-medium"><Square className="h-4 w-4" /> Marcar como cocinada</button></div>
                </article>;
            })}</div>}
        <p className="text-sm font-medium flex gap-2.5 items-center"><span className="h-2 w-2 rounded-full bg-primary" />{pending.length} tareas de cocina pendientes</p>
    </section>;
}
