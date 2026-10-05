// Seed data for the static GitHub Pages demo. Everything lives in memory and is
// regenerated on every page load — nothing is persisted. Dates are computed
// relative to "now" so the demo always looks current.

import { penaltyOccurrence, type Penalty } from '../lib/penalties';

const pad = (n: number) => String(n).padStart(2, '0');
const now = new Date();
const y = now.getFullYear();
const m = now.getMonth(); // 0-based

const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const atTime = (d: Date, h: number, min = 0) =>
    `${isoDate(d)}T${pad(h)}:${pad(min)}:00`;
const dayInMonth = (day: number) => new Date(y, m, day);
const addDays = (base: Date, days: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
};

// Monday of the current week
const monday = (() => {
    const d = new Date(now);
    const diff = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
})();

export interface DemoStore {
    user: Record<string, unknown>;
    familyMembers: Record<string, unknown>[];
    shopping: Record<string, unknown>[];
    shoppingTemplates: Record<string, unknown>[];
    tasks: Record<string, unknown>[];
    penalties: Penalty[];
    appointments: Record<string, unknown>[];
    planning: Record<string, unknown>[];
    recipes: Record<string, unknown>[];
    mealPlans: Record<string, unknown>[];
    budgetEntries: Record<string, unknown>[];
    budgetRecurring: Record<string, unknown>[];
    budgetLimits: Record<string, unknown>[];
    notifications: Record<string, unknown>[];
    notes: Record<string, unknown>[];
    integrations: Record<string, unknown>[];
    rewardTransactions: Record<string, unknown>[];
    rewardSettings: Record<string, unknown>;
    rewardGoals: Record<string, unknown>[];
}

export function createSeed(): DemoStore {
    const dad = { id: 'm-dad', name: 'Alex', role: 'Parent', color: '#2563EB', birthdate: '1986-04-12', monthly_income: 2600 };
    const mom = { id: 'm-mom', name: 'Sam', role: 'Parent', color: '#DB2777', birthdate: '1988-09-03', monthly_income: 2100 };
    const kid1 = { id: 'm-kid1', name: 'Mia', role: 'Enfant', color: '#16A34A', birthdate: `${y - 9}-02-18`, allergies: ['Cacahuetes'] };
    const kid2 = { id: 'm-kid2', name: 'Noah', role: 'Enfant', color: '#F97316', birthdate: `${y - 6}-11-27` };

    return {
        user: {
            id: 'demo-user',
            email: 'demo@openfamily.app',
            name: 'Familia de ejemplo',
            language: 'es',
            currency: 'EUR',
            is_owner: true,
            role: 'parent',
            avatar_url: null,
            // Nothing hidden by default → the demo shows every module.
            disabled_modules: [],
        },
        familyMembers: [dad, mom, kid1, kid2],
        shopping: [
            { id: 's1', name: 'Leche', category: 'Alimentation', quantity: 2, unit: 'L', price: 1.2, is_checked: false },
            { id: 's2', name: 'Pan', category: 'Alimentation', quantity: 1, price: 1.5, is_checked: false },
            { id: 's3', name: 'Manzanas', category: 'Alimentation', quantity: 6, price: 0.4, is_checked: false },
            { id: 's4', name: 'Pasta', category: 'Alimentation', quantity: 3, price: 0.9, is_checked: true },
            { id: 's5', name: 'Pañales', category: 'Bebe', quantity: 1, price: 12.9, is_checked: false },
            { id: 's6', name: 'Lavavajillas', category: 'Menage', quantity: 1, price: 2.3, is_checked: false },
            { id: 's7', name: 'Pasta de dientes', category: 'Sante', quantity: 2, price: 2.1, is_checked: false },
        ],
        shoppingTemplates: [
            {
                id: 't1', name: 'Compra semanal básica', items: [
                    { name: 'Leche', category: 'Alimentation', quantity: 2, unit: 'L' },
                    { name: 'Pan', category: 'Alimentation', quantity: 1 },
                    { name: 'Huevos', category: 'Alimentation', quantity: 12 },
                ],
            },
        ],
        tasks: [
            { id: 'cook1', title: 'Cocinar la cena: espaguetis boloñesa', category: 'cooking', recipe_id: 'r1', description: 'Preparar la cena para toda la familia.', is_completed: false, due_date: isoDate(now), frequency: 'Une fois', priority: 'Haute', assigned_to: ['m-dad'], assigned_to_members: [dad], created_at: atTime(now, 9), penalty_amount: 10, points: 0 },
            { id: 'cook2', title: 'Preparar la ensalada del almuerzo', category: 'cooking', recipe_id: 'r3', is_completed: false, due_date: isoDate(now), frequency: 'Une fois', priority: 'Haute', assigned_to: ['m-mom'], assigned_to_members: [mom], created_at: atTime(now, 9), points: 0 },
            { id: 'tk1', title: 'Sacar la basura', is_completed: false, frequency: 'Hebdomadaire', priority: 'Moyenne', assigned_to: ['m-kid1'], assigned_to_members: [kid1], due_date: atTime(addDays(now, 1), 18), created_at: atTime(now, 9), points: 5, pending_approval: false },
            { id: 'tk2', title: 'Deberes de matemáticas', is_completed: false, frequency: 'Quotidien', priority: 'Haute', assigned_to: ['m-kid1'], assigned_to_members: [kid1], due_date: atTime(now, 17), created_at: atTime(now, 9), points: 10, pending_approval: false },
            { id: 'tk3', title: 'Regar las plantas', is_completed: true, frequency: 'Une fois', priority: 'Basse', assigned_to: ['m-mom'], assigned_to_members: [mom], completed_at: atTime(now, 8), created_at: atTime(addDays(now, -1), 9), points: 0, pending_approval: false },
            { id: 'tk4', title: 'Pedir cita con el dentista', is_completed: false, frequency: 'Une fois', priority: 'Moyenne', assigned_to: ['m-dad'], assigned_to_members: [dad], created_at: atTime(now, 10), points: 0, pending_approval: false },
            { id: 'tk5', title: 'Ordenar la habitación', is_completed: true, frequency: 'Hebdomadaire', priority: 'Moyenne', assigned_to: ['m-kid2'], assigned_to_members: [kid2], completed_at: atTime(now, 10, 30), created_at: atTime(addDays(now, -1), 9), points: 0, pending_approval: false },
            { id: 'late5', title: 'Recoger la mesa de ayer', category: 'general', is_completed: false, due_date: isoDate(addDays(now, -1)), assigned_to: [kid1.id], penalty_amount: 5, created_at: atTime(addDays(now, -2), 9) },
            { id: 'late10', title: 'Preparar la ensalada de ayer', category: 'cooking', recipe_id: 'r3', is_completed: false, due_date: atTime(addDays(now, -1), 13), assigned_to: [dad.id], penalty_amount: 10, created_at: atTime(addDays(now, -2), 9) },
            { id: 'confirmed5', title: 'Guardar la compra', category: 'general', is_completed: false, due_date: isoDate(addDays(now, -2)), assigned_to: [kid1.id], penalty_amount: 5, created_at: atTime(addDays(now, -3), 9) },
            { id: 'confirmed10', title: 'Limpiar la cocina', category: 'general', is_completed: true, completed_at: atTime(addDays(now, -1), 10), due_date: isoDate(addDays(now, -2)), assigned_to: [dad.id], penalty_amount: 10, created_at: atTime(addDays(now, -3), 9) },
        ],
        penalties: [
            { id: 'pen5', occurrence_key: penaltyOccurrence('confirmed5', kid1.id, isoDate(addDays(now, -2))), task_id: 'confirmed5', task_title: 'Guardar la compra', member_id: kid1.id, member_name: kid1.name, member_color: kid1.color, due_date: isoDate(addDays(now, -2)), amount: 5, status: 'pending', reviewed_at: atTime(addDays(now, -1), 9), reviewed_by: 'Sam', reason: 'La compra quedó sin guardar al terminar el día.' },
            { id: 'pen10', occurrence_key: penaltyOccurrence('confirmed10', dad.id, isoDate(addDays(now, -2))), task_id: 'confirmed10', task_title: 'Limpiar la cocina', member_id: dad.id, member_name: dad.name, member_color: dad.color, due_date: isoDate(addDays(now, -2)), amount: 10, status: 'pending', reviewed_at: atTime(addDays(now, -1), 9), reviewed_by: 'Sam', reason: 'Se completó tarde; la penalidad confirmada se conserva.' },
            { id: 'pen-paid', occurrence_key: penaltyOccurrence('past-paid', kid2.id, isoDate(addDays(now, -5))), task_id: 'past-paid', task_title: 'Recoger los juguetes', member_id: kid2.id, member_name: kid2.name, member_color: kid2.color, due_date: isoDate(addDays(now, -5)), amount: 5, status: 'paid', reviewed_at: atTime(addDays(now, -4), 9), reviewed_by: 'Alex', reason: 'Incumplimiento revisado en familia.', paid_at: atTime(addDays(now, -3), 18), paid_by: 'Sam', payment_reason: 'Pago recibido y registrado manualmente.' },
            { id: 'pen-forgiven', occurrence_key: penaltyOccurrence('past-forgiven', mom.id, isoDate(addDays(now, -4))), task_id: 'past-forgiven', task_title: 'Preparar la cena del jueves', member_id: mom.id, member_name: mom.name, member_color: mom.color, due_date: isoDate(addDays(now, -4)), amount: 10, status: 'forgiven', reviewed_at: atTime(addDays(now, -3), 9), reviewed_by: 'Alex', reason: 'Una cita médica impidió completar la tarea.' },
        ],
        appointments: [
            { id: 'a1', title: 'Dentista — Mia', start_time: atTime(dayInMonth(now.getDate()), 15), end_time: atTime(dayInMonth(now.getDate()), 16), location: 'Clínica dental', family_member_ids: ['m-kid1'], family_members_data: [kid1], reminder_30min: true, reminder_1hour: false, reminder_minutes: [30] },
            { id: 'a2', title: 'Entrenamiento de fútbol', start_time: atTime(addDays(now, 2), 18), end_time: atTime(addDays(now, 2), 19, 30), location: 'Estadio', family_member_ids: ['m-kid2'], family_members_data: [kid2], reminder_30min: false, reminder_1hour: true, reminder_minutes: [60, 1440] },
            { id: 'a3', title: 'Cena familiar', start_time: atTime(addDays(now, 5), 20), location: 'Casa', family_member_ids: ['m-dad', 'm-mom', 'm-kid1', 'm-kid2'], family_members_data: [dad, mom, kid1, kid2], reminder_30min: false, reminder_1hour: false, reminder_minutes: [] },
        ],
        planning: [
            { id: 'p1', family_member_id: 'm-dad', family_member_name: 'Alex', family_member_color: '#2563EB', family_member_role: 'Parent', schedule_type: 'work', title: 'Trabajo', day_of_week: 1, start_time: '09:00', end_time: '17:30' },
            { id: 'p2', family_member_id: 'm-dad', family_member_name: 'Alex', family_member_color: '#2563EB', family_member_role: 'Parent', schedule_type: 'work', title: 'Trabajo', day_of_week: 2, start_time: '09:00', end_time: '17:30' },
            { id: 'p3', family_member_id: 'm-kid1', family_member_name: 'Mia', family_member_color: '#16A34A', family_member_role: 'Enfant', schedule_type: 'school', title: 'Colegio', day_of_week: 1, start_time: '08:30', end_time: '16:30' },
            { id: 'p4', family_member_id: 'm-kid1', family_member_name: 'Mia', family_member_color: '#16A34A', family_member_role: 'Enfant', schedule_type: 'school', title: 'Colegio', day_of_week: 2, start_time: '08:30', end_time: '16:30' },
            { id: 'p5', family_member_id: 'm-kid2', family_member_name: 'Noah', family_member_color: '#F97316', family_member_role: 'Enfant', schedule_type: 'activity', title: 'Fútbol', day_of_week: 3, start_time: '18:00', end_time: '19:30' },
            // Both children: shows an activity with several participants.
            { id: 'p6', family_member_ids: ['m-kid1', 'm-kid2'], family_member_id: 'm-kid1', family_member_name: 'Mia', family_member_color: '#16A34A', family_member_role: 'Enfant', schedule_type: 'activity', title: 'Natación', day_of_week: 6, start_time: '10:00', end_time: '11:00' },
        ],
        recipes: [
            { id: 'r1', name: 'Espaguetis a la boloñesa', category: 'Plat', description: 'Un clásico que gusta a toda la familia.', ingredients: ['400 g de espaguetis', '500 g de carne picada de ternera', '1 cebolla', '2 latas de tomate troceado', 'Aceite de oliva', 'Sal y pimienta'], instructions: ['Dora la carne y la cebolla.', 'Añade el tomate y cocina a fuego lento durante 20 minutos.', 'Cuece los espaguetis.', 'Mezcla y sirve.'], prep_time: 15, cook_time: 30, servings: 4, difficulty: 'Facile', tags: ['rápida', 'familiar'] },
            { id: 'r2', name: 'Tarta de manzana', category: 'Dessert', description: 'Una tarta casera para disfrutar en familia.', ingredients: ['6 manzanas', '200 g de harina', '100 g de mantequilla', '100 g de azúcar', '1 huevo'], instructions: ['Prepara la masa.', 'Corta las manzanas en láminas.', 'Monta la tarta y hornea a 180 °C durante 40 minutos.'], prep_time: 30, cook_time: 40, servings: 6, difficulty: 'Moyen', tags: ['postre'] },
            { id: 'r3', name: 'Ensalada de la huerta', category: 'Entrée', description: 'Fresca y ligera.', ingredients: ['Lechuga', 'Tomates', 'Pepino', 'Aceite de oliva', 'Vinagre'], instructions: ['Trocea las verduras.', 'Aliña y mezcla.'], prep_time: 10, cook_time: 0, servings: 4, difficulty: 'Facile', tags: ['vegetariana', 'saludable'] },
        ],
        mealPlans: [
            { id: 'mp1', date: isoDate(now), meal_type: 'Petit-déjeuner', custom_meal: 'Tortitas con fruta' },
            { id: 'mp2', date: isoDate(now), meal_type: 'Déjeuner', recipe_id: 'r3', recipe: { id: 'r3', name: 'Ensalada de la huerta' } },
            { id: 'mp3', date: isoDate(now), meal_type: 'Dîner', recipe_id: 'r1', recipe: { id: 'r1', name: 'Espaguetis a la boloñesa' } },
            { id: 'mp4', date: isoDate(monday), meal_type: 'Dîner', custom_meal: 'Pizza casera' },
            { id: 'mp5', date: isoDate(addDays(monday, 4)), meal_type: 'Dîner', recipe_id: 'r3', recipe: { id: 'r3', name: 'Ensalada de la huerta' } },
            { id: 'mp6', date: isoDate(addDays(monday, 5)), meal_type: 'Snack', recipe_id: 'r2', recipe: { id: 'r2', name: 'Tarta de manzana' } },
        ],
        budgetEntries: [
            { id: 'b1', category: 'Alimentation', amount: 84.3, description: 'Compra semanal', date: isoDate(dayInMonth(3)), is_expense: true },
            { id: 'b2', category: 'Transport', amount: 60, description: 'Combustible', date: isoDate(dayInMonth(6)), is_expense: true },
            { id: 'b3', category: 'Loisirs', amount: 32, description: 'Cine', date: isoDate(dayInMonth(9)), is_expense: true },
            { id: 'b4', category: 'Enfants', amount: 45, description: 'Material escolar', date: isoDate(dayInMonth(11)), is_expense: true },
            { id: 'b5', category: 'Autre', amount: 1500, description: 'Paga extra', date: isoDate(dayInMonth(1)), is_expense: false },
        ],
        budgetRecurring: [
            { id: 'rc1', label: 'Alquiler', amount: 950, category: 'Logement', debit_day: 5, is_active: true, is_pointed: true },
            { id: 'rc2', label: 'Electricidad', amount: 110, category: 'Logement', debit_day: 10, is_active: true, is_pointed: false },
            { id: 'rc3', label: 'Internet', amount: 39.9, category: 'Abonnements', debit_day: 15, is_active: true, is_pointed: false },
            { id: 'rc4', label: 'Seguro', amount: 75, category: 'Assurance', debit_day: 8, is_active: true, is_pointed: true },
        ],
        budgetLimits: [
            { id: 'l1', category: 'Alimentation', monthly_limit: 400, month: m + 1, year: y },
            { id: 'l2', category: 'Loisirs', monthly_limit: 100, month: m + 1, year: y },
        ],
        notifications: [
            { id: 'n1', title: 'Recordatorio', message: 'Cita de Mia con el dentista a las 15:00', type: 'appointment', is_read: false, related_id: 'a1', created_at: atTime(now, 8) },
            { id: 'n2', title: 'Tarea pendiente', message: 'Los deberes de matemáticas son para hoy', type: 'task', is_read: false, related_id: 'tk2', created_at: atTime(now, 7, 30) },
            { id: 'n3', title: 'Aviso de presupuesto', message: 'Los gastos de ocio han alcanzado el 80 % del límite mensual', type: 'budget', is_read: true, related_id: null, created_at: atTime(addDays(now, -1), 19) },
        ],
        // Fridge post-its (no expiry so they always show in the demo)
        notes: [
            { id: 'fn1', author_name: 'Alex', content: 'Los abuelos llegan el sábado al mediodía', color: 'yellow', expires_at: null, created_at: atTime(now, 8, 5) },
            { id: 'fn2', author_name: 'Sam', content: 'Recordad la bolsa de piscina para el miércoles 🏊', color: 'pink', expires_at: null, created_at: atTime(addDays(now, -1), 18, 40) },
        ],
        integrations: [],
        // Pocket-money ledger: Mia has a streak going, Noah just started.
        rewardTransactions: [
            // Birthday bonus weeks ago: brings Mia's balance to 100 pts (20 €) so her
            // savings-goal bar sits at ~67% of the 30 € target below.
            { id: 'rt0', member_id: 'm-kid1', task_id: null, points: 90, type: 'adjust', note: 'Dinero de cumpleaños 🎂', created_at: atTime(addDays(now, -12), 11) },
            { id: 'rt1', member_id: 'm-kid1', task_id: 'tk1', points: 5, type: 'earn', note: 'Sacar la basura', created_at: atTime(addDays(now, -3), 18, 15) },
            { id: 'rt2', member_id: 'm-kid1', task_id: 'tk2', points: 10, type: 'earn', note: 'Deberes de matemáticas', created_at: atTime(addDays(now, -2), 17, 40) },
            { id: 'rt3', member_id: 'm-kid1', task_id: 'tk2', points: 10, type: 'earn', note: 'Deberes de matemáticas', created_at: atTime(addDays(now, -1), 17, 5) },
            { id: 'rt4', member_id: 'm-kid1', task_id: null, points: 5, type: 'adjust', note: 'Ayudó a llevar la compra', created_at: atTime(addDays(now, -1), 19) },
            { id: 'rt5', member_id: 'm-kid1', task_id: null, points: -20, type: 'redeem', note: 'Paga — cómic', created_at: atTime(addDays(now, -1), 19, 30) },
            { id: 'rt6', member_id: 'm-kid2', task_id: null, points: 5, type: 'earn', note: 'Poner la mesa', created_at: atTime(addDays(now, -2), 19) },
        ],
        rewardSettings: { points_value: 0.2 },
        // Savings goal: Mia is saving for a video game (100 pts × 0.2 € = 20 € of 30 €).
        rewardGoals: [
            { id: 'g1', member_id: 'm-kid1', title: 'Videojuego', emoji: '🎮', target_amount: 30, status: 'active', created_at: atTime(addDays(now, -14), 10), achieved_at: null },
        ],
    };
}
