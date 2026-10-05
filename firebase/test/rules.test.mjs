import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// An explicit local emulator is mandatory: never fall back to a cloud project.
const hostSetting = process.env.FIRESTORE_EMULATOR_HOST;
if (!hostSetting || !/^(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/.test(hostSetting)) {
  throw new Error('Set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080. Cloud/non-loopback tests are refused.');
}
const separator = hostSetting.lastIndexOf(':');
const host = hostSetting.slice(0, separator).replace(/^\[|\]$/g, '');
const port = Number(hostSetting.slice(separator + 1));
assert.ok(port > 0 && port <= 65535);
// Optional external installation keeps dependency/package ownership with the main agent.
const require = createRequire(process.env.RULES_TEST_DEPENDENCIES
  ? resolve(process.env.RULES_TEST_DEPENDENCIES, 'package.json') : import.meta.url);
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, limit,
  writeBatch, runTransaction, serverTimestamp, Timestamp, setLogLevel, collectionGroup,
} = require('firebase/firestore');
setLogLevel('silent');
assert.equal(require('@firebase/rules-unit-testing/package.json').version, '5.0.2');
assert.equal(require('firebase/package.json').version, '12.19.0');

const PROJECT = 'demo-chocomelerplan';
const F = 'familyA';
const P = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const Q = '33333333-3333-4333-8333-333333333333';
const NEW = '44444444-4444-4444-8444-444444444444';
const INV = 'a'.repeat(40);
const OLD = Timestamp.fromDate(new Date('2025-01-01T00:00:00Z'));
const DUE = Timestamp.fromDate(new Date('2025-01-01T22:59:59.999Z'));
let env;
let admin, adult, child, outsider, other, guest;
const path = (c, id, f = F) => `families/${f}/${c}/${id}`;
const ref = (db, c, id, f = F) => doc(db, path(c, id, f));
const nowStamp = () => ({ created_by: 'admin', created_at: serverTimestamp(), updated_by: 'admin', updated_at: serverTimestamp() });
const edit = (user = 'admin') => ({ updated_by: user, updated_at: serverTimestamp() });
const seedStamp = (user = 'admin') => ({ created_by: user, created_at: OLD, updated_by: user, updated_at: OLD });
const account = (user, extra = {}) => ({ name: user, email: `${user}@test.invalid`, language: 'es', week_start_day: 1, dashboard_prefs: {}, active_family_id: null, created_at: OLD, updated_at: OLD, ...extra });
const membership = (user, role, p, extra = {}) => ({ role, member_id: p, name: user, email: `${user}@test.invalid`, joined_at: OLD, invite_id: null, ...extra });
const profile = (name, linked = null, extra = {}) => ({ name, color: '#123456', role: 'adult', linked_user_id: linked, deleted_at: null, ...seedStamp(), ...extra });
const task = (extra = {}) => ({ title: 'Clean kitchen', description: '', category: 'home', priority: 'medium', assigned_to: [C], due_date: '2025-01-01', due_at: DUE, frequency: 'none', occurrence_id: 'occurrence-one', penalty_generated: false, is_completed: false, recipe_id: null, penalty_amount_cents: 500, completed_by: null, completed_at: null, deleted_at: null, ...seedStamp(), ...extra });
const key = (t = 'taskA', p = C, occurrence = 'occurrence-one') => `${t}_${occurrence}_${p}`;
const penalty = (t = 'taskA', p = C, overrides = {}) => ({ task_id: t, occurrence_id: 'occurrence-one', member_id: p, task_title: 'Clean kitchen', member_name: p === C ? 'Child' : p === P ? 'Admin' : 'Other', member_color: '#123456', due_date: '2025-01-01', due_at: DUE, amount_cents: 500, status: 'review', generated_at: serverTimestamp(), generated_by: 'admin', reviewed_at: null, reviewed_by: null, reviewed_by_name: null, reason: '', paid_at: null, paid_by: null, paid_by_name: null, payment_reason: '', ...overrides });
const invitation = (extra = {}) => ({ role: 'child', member_id: null, email: null, expires_at: Timestamp.fromMillis(Date.now() + 3600000), used_by: null, used_at: null, created_by: 'admin', created_at: OLD, owner_name: 'admin', ...extra });

async function seed(entries) {
  await env.withSecurityRulesDisabled(async context => {
    const batch = writeBatch(context.firestore());
    for (const [p, data] of Object.entries(entries)) batch.set(doc(context.firestore(), p), data);
    await batch.commit();
  });
}
async function propose(db = admin, user = 'admin', t = 'taskA', assigned = [C], patch = {}) {
  // Three-assignee generation exercises both per-write (10) and transaction (20) access limits.
  return runTransaction(db, async tx => {
    const taskRef = ref(db, 'tasks', t);
    await tx.get(taskRef);
    tx.update(taskRef, { penalty_generated: true, ...edit(user), ...patch });
    for (const p of assigned) tx.set(ref(db, 'penalties', key(t, p)), penalty(t, p, { generated_by: user }));
  });
}
async function review(db = admin, status = 'pending', extra = {}, totalExtra = {}, audit = false) {
  return runTransaction(db, async tx => {
    const p = ref(db, 'penalties', key());
    const total = ref(db, 'penaltyTotals', C);
    await tx.get(p);
    const oldTotal = await tx.get(total);
    tx.update(p, { status, reviewed_by: 'admin', reviewed_by_name: 'admin', reviewed_at: serverTimestamp(), reason: '', ...extra });
    if (status === 'pending') tx.set(total, { amount_cents: (oldTotal.exists() ? oldTotal.data().amount_cents : 0) + 500, last_penalty_id: key(), updated_at: serverTimestamp(), ...totalExtra });
    if (audit) tx.set(ref(db, 'auditEvents', 'auditA'), { actor_uid: 'admin', action: `penalty.${status}`, entity_id: key(), created_at: serverTimestamp() });
  });
}
async function pay(extra = {}, totalExtra = {}) {
  return runTransaction(admin, async tx => {
    const p = ref(admin, 'penalties', key());
    const total = ref(admin, 'penaltyTotals', C);
    await tx.get(p);
    const oldTotal = await tx.get(total);
    tx.update(p, { status: 'paid', paid_by: 'admin', paid_by_name: 'admin', paid_at: serverTimestamp(), payment_reason: '', ...extra });
    tx.set(total, { amount_cents: (oldTotal.exists() ? oldTotal.data().amount_cents : 0) - 500, last_penalty_id: key(), updated_at: serverTimestamp(), ...totalExtra });
  });
}
async function redeem(extra = {}, invite = INV, options = {}) {
  const user = options.user || 'outsider';
  const db = options.db || outsider;
  const p = options.profile === undefined ? NEW : options.profile;
  return runTransaction(db, async tx => {
    await tx.get(ref(db, 'invitations', invite));
    tx.update(ref(db, 'invitations', invite), { used_by: user, used_at: serverTimestamp(), ...options.invitePatch });
    tx.set(ref(db, 'memberships', user), membership(user, 'child', p, { joined_at: serverTimestamp(), invite_id: invite, ...extra }));
    if (p != null && !options.omitProfile) tx.set(ref(db, 'members', p), profile(user, user, { created_by: user, created_at: serverTimestamp(), ...edit(user) }));
  });
}

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port, rules: await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8') } });
  const auth = (u) => env.authenticatedContext(u, { email: `${u}@test.invalid`, email_verified: true }).firestore();
  admin = auth('admin'); adult = auth('adult'); child = auth('child'); outsider = auth('outsider'); other = auth('other'); guest = env.unauthenticatedContext().firestore();
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await seed({
    'users/admin': account('admin'), 'users/adult': account('adult'), 'users/child': account('child'), 'users/outsider': account('outsider'), 'users/other': account('other'),
    [`families/${F}`]: { name: 'Family A', timezone: 'Europe/Madrid', currency: 'EUR', admin_uid: 'admin', disabled_modules: [], ...seedStamp() },
    'families/familyB': { name: 'Family B', timezone: 'Europe/Madrid', currency: 'EUR', admin_uid: 'other', disabled_modules: [], ...seedStamp('other') },
    [path('memberships', 'admin')]: membership('admin', 'admin', P), [path('memberships', 'adult')]: membership('adult', 'adult', null), [path('memberships', 'child')]: membership('child', 'child', C),
    [path('memberships', 'other', 'familyB')]: membership('other', 'admin', Q),
    [path('members', P)]: profile('Admin', 'admin'), [path('members', C)]: profile('Child', 'child', { role: 'child' }), [path('members', Q)]: profile('Other'),
    [path('tasks', 'taskA')]: task(), [path('invitations', INV)]: invitation(),
  });
});

test('membership gates reads across two families; unauthenticated/unknown paths deny', async () => {
  await assertSucceeds(getDoc(doc(admin, `families/${F}`)));
  await assertSucceeds(getDoc(ref(child, 'tasks', 'taskA')));
  for (const db of [guest, outsider, other]) await assertFails(getDoc(ref(db, 'tasks', 'taskA')));
  await assertFails(getDoc(doc(admin, 'families/familyB')));
  await assertFails(getDoc(doc(guest, 'users/admin')));
  await assertFails(getDoc(doc(adult, 'users/admin')));
  await assertFails(setDoc(ref(admin, 'unknown', 'test'), { anything: true }));
  await assertFails(getDoc(ref(admin, 'unknown', 'test')));
  await assertFails(getDocs(collection(admin, 'families')));
  await assertFails(getDocs(query(collectionGroup(admin, 'tasks'), limit(200))));
});
test('all family list queries require limit <= 200, including memberships', async () => {
  for (const c of ['tasks', 'members', 'memberships', 'penalties', 'penaltyTotals', 'recipes', 'mealPlans', 'shoppingItems', 'planningEntries']) {
    await assertSucceeds(getDocs(query(collection(child, `families/${F}/${c}`), limit(200))));
    await assertFails(getDocs(collection(admin, `families/${F}/${c}`)));
    await assertFails(getDocs(query(collection(admin, `families/${F}/${c}`), limit(201))));
  }
});
test('own account preferences work; role/family_ids and another family are rejected', async () => {
  await assertSucceeds(updateDoc(doc(child, 'users/child'), { name: 'New name', dashboard_prefs: { hidden: ['stats'], order: ['stats', 'agenda', 'planning', 'quick', 'notes'], agendaView: 'week' }, updated_at: serverTimestamp() }));
  for (const patch of [{ role: 'admin' }, { family_ids: [F] }, { active_family_id: 'familyB' }, { email: 'fake@test.invalid' }, { dashboard_prefs: { is_admin: true } }, { updated_at: OLD }]) {
    await assertFails(updateDoc(doc(child, 'users/child'), { updated_at: serverTimestamp(), ...patch }));
  }
  await assertSucceeds(updateDoc(doc(child, 'users/child'), { active_family_id: F, updated_at: serverTimestamp() }));
  await assertFails(deleteDoc(doc(child, 'users/child')));
});
test('new own account has only approved fields and server timestamps', async () => {
  const db = env.authenticatedContext('newUser', { email: 'newUser@test.invalid' }).firestore();
  await assertFails(setDoc(doc(db, 'users/newUser'), account('newUser')));
  await assertFails(setDoc(doc(db, 'users/newUser'), account('newUser', { created_at: serverTimestamp(), updated_at: serverTimestamp(), role: 'admin' })));
  await assertSucceeds(setDoc(doc(db, 'users/newUser'), account('newUser', { created_at: serverTimestamp(), updated_at: serverTimestamp() })));
});
test('family + initial admin + linked profile + active family creation transaction', async () => {
  const f = 'newFamily';
  await assertSucceeds(runTransaction(outsider, async tx => {
    await tx.get(doc(outsider, 'users/outsider'));
    tx.set(doc(outsider, `families/${f}`), { name: 'New', timezone: 'Europe/Madrid', currency: 'EUR', admin_uid: 'outsider', disabled_modules: [], created_by: 'outsider', created_at: serverTimestamp(), ...edit('outsider') });
    tx.set(ref(outsider, 'memberships', 'outsider', f), membership('outsider', 'admin', NEW, { joined_at: serverTimestamp() }));
    tx.set(ref(outsider, 'members', NEW, f), profile('outsider', 'outsider', { role: 'admin', created_by: 'outsider', created_at: serverTimestamp(), ...edit('outsider') }));
    tx.update(doc(outsider, 'users/outsider'), { active_family_id: f, updated_at: serverTimestamp() });
  }));
  await assertFails(setDoc(doc(outsider, 'families/badFamily'), { name: 'Fake', timezone: 'Europe/Madrid', currency: 'EUR', admin_uid: 'outsider', disabled_modules: [], created_by: 'outsider', created_at: serverTimestamp(), ...edit('outsider') }));
  await assertFails(setDoc(ref(outsider, 'memberships', 'outsider'), membership('outsider', 'admin', null, { joined_at: serverTimestamp() })));
});
test('adult basic family edit allowed; admin transfer requires both role changes atomically', async () => {
  await assertSucceeds(updateDoc(doc(adult, `families/${F}`), { name: 'Renamed', disabled_modules: ['budget'], ...edit('adult') }));
  await assertFails(updateDoc(doc(adult, `families/${F}`), { admin_uid: 'adult', ...edit('adult') }));
  await assertFails(updateDoc(doc(admin, `families/${F}`), { admin_uid: 'adult', ...edit() }));
  await assertFails(updateDoc(ref(child, 'memberships', 'child'), { role: 'admin' }));
  await assertFails(updateDoc(ref(admin, 'memberships', 'child'), { role: 'admin' }));
  const batch = writeBatch(admin);
  batch.update(doc(admin, `families/${F}`), { admin_uid: 'adult', ...edit() });
  batch.update(ref(admin, 'memberships', 'admin'), { role: 'adult' });
  batch.update(ref(admin, 'memberships', 'adult'), { role: 'admin' });
  await assertSucceeds(batch.commit());
  await assertFails(updateDoc(ref(admin, 'memberships', 'child'), { role: 'adult' }));
});
test('invitations are authenticated known-token gets; only admin bounded listing/creation', async () => {
  await assertSucceeds(getDoc(ref(outsider, 'invitations', INV)));
  await assertFails(getDoc(ref(guest, 'invitations', INV)));
  await assertFails(getDocs(query(collection(outsider, `families/${F}/invitations`), limit(200))));
  await assertFails(getDocs(query(collection(adult, `families/${F}/invitations`), limit(200))));
  await assertSucceeds(getDocs(query(collection(admin, `families/${F}/invitations`), limit(200))));
  const d = invitation({ created_at: serverTimestamp() });
  await assertSucceeds(setDoc(ref(admin, 'invitations', 'b'.repeat(40)), d));
  await assertFails(setDoc(ref(admin, 'invitations', 'short'), d));
  await assertFails(setDoc(ref(adult, 'invitations', 'c'.repeat(40)), d));
  await assertFails(setDoc(ref(admin, 'invitations', 'd'.repeat(40)), { ...d, expires_at: Timestamp.fromMillis(Date.now() + 8 * 86400000) }));
  await assertFails(setDoc(ref(admin, 'invitations', 'e'.repeat(40)), { ...d, role: 'admin' }));
});
test('invite redemption atomically consumes token, creates own membership and linked profile', async () => {
  await assertSucceeds(redeem());
  assert.equal((await getDoc(ref(admin, 'invitations', INV))).data().used_by, 'outsider');
  assert.equal((await getDoc(ref(outsider, 'memberships', 'outsider'))).data().role, 'child');
  await assertFails(redeem());
  await assertFails(deleteDoc(ref(admin, 'invitations', INV)));
});
test('invite expiration, role forgery, extra membership fields and missing link deny', async () => {
  await assertFails(redeem({ role: 'admin' }));
  await assertFails(redeem({ role: 'adult' }));
  await assertFails(redeem({ is_owner: true }));
  await assertFails(redeem({}, INV, { omitProfile: true }));
  await assertFails(redeem({}, INV, { invitePatch: { used_at: OLD } }));
  await seed({ [path('invitations', INV)]: invitation({ expires_at: OLD }) });
  await assertFails(redeem());
});
test('bound email requires matching verified token; null profile membership is permitted', async () => {
  await seed({ [path('invitations', INV)]: invitation({ email: 'outsider@test.invalid' }) });
  const unverified = env.authenticatedContext('outsider', { email: 'outsider@test.invalid', email_verified: false }).firestore();
  const wrong = env.authenticatedContext('outsider', { email: 'wrong@test.invalid', email_verified: true }).firestore();
  await assertFails(redeem({}, INV, { db: unverified, profile: null }));
  await assertFails(redeem({}, INV, { db: wrong, profile: null }));
  await assertSucceeds(redeem({}, INV, { profile: null }));
});
test('cannot consume invite without membership, steal another UID, or reuse consumed token', async () => {
  await assertFails(updateDoc(ref(outsider, 'invitations', INV), { used_by: 'outsider', used_at: serverTimestamp() }));
  await assertFails(redeem({}, INV, { user: 'other' }));
  await seed({ [path('invitations', INV)]: invitation({ used_by: 'other', used_at: OLD }) });
  await assertFails(redeem());
});
test('profiles cannot elevate accounts; link/relink requires admin and bidirectional uniqueness', async () => {
  await assertSucceeds(setDoc(ref(adult, 'members', NEW), profile('Offline admin', null, { role: 'admin', created_by: 'adult', created_at: serverTimestamp(), ...edit('adult') })));
  await assertFails(updateDoc(ref(adult, 'members', NEW), { linked_user_id: 'adult', ...edit('adult') }));
  await assertFails(updateDoc(ref(admin, 'members', NEW), { linked_user_id: 'admin', ...edit() }));
  const batch = writeBatch(admin);
  batch.update(ref(admin, 'members', NEW), { linked_user_id: 'adult', ...edit() });
  batch.update(ref(admin, 'memberships', 'adult'), { member_id: NEW });
  await assertSucceeds(batch.commit());
  await assertFails(updateDoc(ref(admin, 'members', NEW), { deleted_at: serverTimestamp(), ...edit() }));
  await assertFails(deleteDoc(ref(admin, 'members', NEW)));
  await assertFails(setDoc(ref(admin, 'members', 'bad_id'), profile('Bad', null, nowStamp())));
});
test('private health/income is adult-only and never accepted in public profile', async () => {
  await assertSucceeds(setDoc(ref(adult, 'privateProfiles', C), { notes: 'private', monthly_income_cents: 100000, created_by: 'adult', created_at: serverTimestamp(), ...edit('adult') }));
  await assertSucceeds(getDoc(ref(admin, 'privateProfiles', C)));
  await assertFails(getDoc(ref(child, 'privateProfiles', C)));
  await assertFails(getDocs(query(collection(child, `families/${F}/privateProfiles`), limit(200))));
  await assertFails(updateDoc(ref(admin, 'members', C), { medical_notes: 'public leak', ...edit() }));
});

test('Madrid exact epochs: winter/summer and date-only spring/fall boundary', async () => {
  const cases = [
    ['2026-01-10', '2026-01-10T22:59:59.999Z'], ['2026-07-10', '2026-07-10T21:59:59.999Z'],
    ['2026-03-28', '2026-03-28T22:59:59.999Z'], ['2026-03-29', '2026-03-29T21:59:59.999Z'],
    ['2026-10-24', '2026-10-24T21:59:59.999Z'], ['2026-10-25', '2026-10-25T22:59:59.999Z'],
    ['2026-03-29T01:59', '2026-03-29T00:59:00Z'], ['2026-03-29T03:00', '2026-03-29T01:00:00Z'],
    ['2026-10-25T02:30', '2026-10-25T00:30:00Z'], ['2026-10-25T03:00', '2026-10-25T02:00:00Z'],
    ['2026-10-04T12:00', '2026-10-04T10:00:00Z'], ['2028-02-29T12:00', '2028-02-29T11:00:00Z'],
  ];
  for (const [i, [date, epoch]] of cases.entries()) {
    await assertSucceeds(setDoc(ref(admin, 'tasks', `date${i}`), task({ due_date: date, due_at: Timestamp.fromDate(new Date(epoch)), ...nowStamp() })));
    await assertFails(setDoc(ref(admin, 'tasks', `badDate${i}`), task({ due_date: date, due_at: Timestamp.fromMillis(Date.parse(epoch) + 3600000), ...nowStamp() })));
  }
});
test('Madrid rejects nonexistent/second ambiguous hour, invalid dates and seconds', async () => {
  for (const [date, epoch] of [
    ['2026-03-29T02:30', '2026-03-29T01:30:00Z'], ['2026-10-25T02:30', '2026-10-25T01:30:00Z'],
    ['2026-02-30', '2026-03-02T22:59:59.999Z'], ['2026-01-01T12:00:30', '2026-01-01T11:00:30Z'],
    ['2026-1-01', '2026-01-01T22:59:59.999Z'], ['2026-01-01T24:00', '2026-01-01T23:00:00Z'],
  ]) await assertFails(setDoc(ref(admin, 'tasks', 'invalid'), task({ due_date: date, due_at: Timestamp.fromDate(new Date(epoch)), ...nowStamp() })));
  await assertFails(setDoc(ref(admin, 'tasks', 'noDue'), task({ due_date: null, ...nowStamp() })));
  await assertSucceeds(setDoc(ref(admin, 'tasks', 'noDue'), task({ due_date: null, due_at: null, ...nowStamp() })));
});
test('new tasks bound IDs, active assignments, money, immutable creation, and no points', async () => {
  await assertSucceeds(setDoc(ref(admin, 'tasks', 'newTask'), task({ ...nowStamp() })));
  for (const patch of [{ assigned_to: [C, P, Q, NEW] }, { assigned_to: [C, C] }, { assigned_to: [NEW] }, { penalty_amount_cents: 501 }, { points: 10 }, { occurrence_id: 'bad_id' }, { penalty_generated: true }, { is_completed: true, completed_by: 'admin', completed_at: serverTimestamp() }]) {
    await assertFails(setDoc(ref(admin, 'tasks', 'badTask'), task({ ...nowStamp(), ...patch })));
  }
  await assertFails(setDoc(ref(child, 'tasks', 'childTask'), task({ created_by: 'child', created_at: serverTimestamp(), ...edit('child') })));
  await assertFails(updateDoc(ref(admin, 'tasks', 'taskA'), { created_at: serverTimestamp(), ...edit() }));
});
test('child can complete own non-economic task, cannot complete others or modify amount/title', async () => {
  await seed({ [path('tasks', 'taskA')]: task({ penalty_amount_cents: 0 }), [path('tasks', 'otherTask')]: task({ penalty_amount_cents: 0, assigned_to: [P] }) });
  await assertFails(updateDoc(ref(child, 'tasks', 'otherTask'), { is_completed: true, completed_by: 'child', completed_at: serverTimestamp(), ...edit('child') }));
  await assertFails(updateDoc(ref(child, 'tasks', 'taskA'), { penalty_amount_cents: 1000, ...edit('child') }));
  await assertFails(updateDoc(ref(child, 'tasks', 'taskA'), { title: 'Hacked', ...edit('child') }));
  await assertFails(updateDoc(ref(child, 'tasks', 'taskA'), { is_completed: true, completed_by: 'admin', completed_at: serverTimestamp(), ...edit('child') }));
  await assertSucceeds(updateDoc(ref(child, 'tasks', 'taskA'), { is_completed: true, completed_by: 'child', completed_at: serverTimestamp(), ...edit('child') }));
  await assertFails(updateDoc(ref(child, 'tasks', 'taskA'), { is_completed: false, completed_by: null, completed_at: null, ...edit('child') }));
});
test('overdue completion/edit/archive cannot evade original economic snapshot; delete always denies', async () => {
  for (const patch of [{ title: 'Changed' }, { assigned_to: [] }, { due_date: null, due_at: null }, { penalty_amount_cents: 0 }, { deleted_at: serverTimestamp() }, { is_completed: true, completed_by: 'admin', completed_at: serverTimestamp() }]) {
    await assertFails(updateDoc(ref(admin, 'tasks', 'taskA'), { ...patch, ...edit() }));
  }
  await assertFails(deleteDoc(ref(admin, 'tasks', 'taskA')));
  await assertSucceeds(propose(admin, 'admin', 'taskA', [C], { title: 'Changed', penalty_amount_cents: 0, deleted_at: serverTimestamp() }));
  assert.equal((await getDoc(ref(admin, 'penalties', key()))).data().task_title, 'Clean kitchen');
  await assertFails(updateDoc(ref(admin, 'penalties', key()), { task_title: 'Rewrite' }));
  await assertFails(deleteDoc(ref(admin, 'penalties', key())));
});
test('child late completion generates snapshot atomically; unrelated child cannot propose', async () => {
  await assertFails(updateDoc(ref(child, 'tasks', 'taskA'), { is_completed: true, completed_by: 'child', completed_at: serverTimestamp(), ...edit('child') }));
  await assertSucceeds(propose(child, 'child', 'taskA', [C], { is_completed: true, completed_by: 'child', completed_at: serverTimestamp() }));
  await seed({ [path('tasks', 'unassignedChild')]: task({ assigned_to: [P] }) });
  await assertFails(propose(child, 'child', 'unassignedChild', [P]));
});
test('three-assignee generation transaction succeeds within document-access limits', async () => {
  await seed({ [path('tasks', 'taskA')]: task({ assigned_to: [C, P, Q] }) });
  await assertSucceeds(propose(admin, 'admin', 'taskA', [C, P, Q]));
  for (const p of [C, P, Q]) await assertSucceeds(getDoc(ref(admin, 'penalties', key('taskA', p))));
});
test('cannot falsely freeze penalties or partially generate three-assignee occurrence', async () => {
  await assertFails(updateDoc(ref(admin, 'tasks', 'taskA'), { penalty_generated: true, ...edit() }));
  await seed({ [path('tasks', 'taskA')]: task({ assigned_to: [C, P, Q] }) });
  await assertFails(propose(admin, 'admin', 'taskA', [C, P]));
  await seed({ [path('tasks', 'taskA')]: task({ penalty_amount_cents: 0 }) });
  await assertFails(updateDoc(ref(admin, 'tasks', 'taskA'), { penalty_generated: true, ...edit() }));
  await assertSucceeds(updateDoc(ref(admin, 'tasks', 'taskA'), { title: 'Free task', ...edit() }));
});
test('proposal amount/key/snapshots/timestamps/status are unforgeable', async () => {
  const mutations = [{ amount_cents: 1000 }, { task_title: 'Fake' }, { member_name: 'Fake' }, { due_at: OLD }, { generated_at: OLD }, { generated_by: 'adult' }, { status: 'pending' }, { reason: 'fake' }, { reviewed_by: 'admin' }, { extra: true }];
  for (const patch of mutations) {
    const batch = writeBatch(admin);
    batch.update(ref(admin, 'tasks', 'taskA'), { penalty_generated: true, ...edit() });
    batch.set(ref(admin, 'penalties', key()), penalty('taskA', C, patch));
    await assertFails(batch.commit());
  }
  const batch = writeBatch(admin);
  batch.update(ref(admin, 'tasks', 'taskA'), { penalty_generated: true, ...edit() });
  batch.set(ref(admin, 'penalties', 'forged-key'), penalty());
  await assertFails(batch.commit());
  await assertFails(setDoc(ref(admin, 'penalties', key()), penalty()));
});
test('completed/future/deleted/no-assignee/zero-amount tasks cannot produce penalties', async () => {
  for (const patch of [{ is_completed: true, completed_by: 'admin', completed_at: OLD }, { due_date: '2099-01-01', due_at: Timestamp.fromDate(new Date('2099-01-01T22:59:59.999Z')) }, { deleted_at: OLD }, { assigned_to: [] }, { penalty_amount_cents: 0 }]) {
    await seed({ [path('tasks', 'taskA')]: task(patch) });
    await assertFails(propose());
  }
});
test('generation is once per occurrence; new occurrence requires completed dated recurrence', async () => {
  await assertSucceeds(propose());
  await assertFails(propose());
  await assertFails(updateDoc(ref(admin, 'tasks', 'taskA'), { penalty_generated: false, ...edit() }));
  await assertFails(updateDoc(ref(admin, 'tasks', 'taskA'), { occurrence_id: 'next', penalty_generated: false, ...edit() }));
  await assertSucceeds(updateDoc(ref(admin, 'tasks', 'taskA'), { is_completed: true, completed_by: 'admin', completed_at: serverTimestamp(), frequency: 'weekly', ...edit() }));
  await assertFails(updateDoc(ref(admin, 'tasks', 'taskA'), { occurrence_id: 'next', penalty_generated: false, is_completed: false, completed_by: null, completed_at: null, ...edit() }));
  await assertSucceeds(updateDoc(ref(admin, 'tasks', 'taskA'), { occurrence_id: 'next', penalty_generated: false, is_completed: false, completed_by: null, completed_at: null, due_date: '2025-01-08', due_at: Timestamp.fromDate(new Date('2025-01-08T22:59:59.999Z')), ...edit() }));
  assert.equal((await getDoc(ref(admin, 'penalties', key()))).data().occurrence_id, 'occurrence-one');
});
test('confirm plus total plus audit, then manual pay plus total is atomic', async () => {
  await assertSucceeds(propose());
  await assertSucceeds(review(admin, 'pending', {}, {}, true));
  assert.equal((await getDoc(ref(admin, 'penaltyTotals', C))).data().amount_cents, 500);
  await assertSucceeds(pay());
  assert.equal((await getDoc(ref(admin, 'penaltyTotals', C))).data().amount_cents, 0);
  await assertFails(pay());
  await assertFails(updateDoc(ref(admin, 'penaltyTotals', C), { amount_cents: 500, last_penalty_id: key(), updated_at: serverTimestamp() }));
});
test('review forgery, missing/incorrect total, invalid transitions and child decisions deny', async () => {
  await assertSucceeds(propose());
  await assertFails(updateDoc(ref(admin, 'penalties', key()), { status: 'pending', reviewed_by: 'admin', reviewed_by_name: 'admin', reviewed_at: serverTimestamp() }));
  for (const patch of [{ reviewed_by: 'adult' }, { reviewed_by_name: 'Fake' }, { reviewed_at: OLD }, { amount_cents: 1000 }, { reason: 'x'.repeat(501) }]) await assertFails(review(admin, 'pending', patch));
  await assertFails(review(admin, 'pending', {}, { amount_cents: 1000 }));
  await assertFails(review(child));
  await assertFails(updateDoc(ref(admin, 'penalties', key()), { status: 'paid', paid_by: 'admin', paid_by_name: 'admin', paid_at: serverTimestamp() }));
  await assertSucceeds(review());
  await assertFails(review());
  await assertFails(updateDoc(ref(admin, 'penalties', key()), { status: 'forgiven' }));
});
test('forgiveness allows optional empty reason, no total delta, immutable history', async () => {
  await assertSucceeds(propose());
  await assertSucceeds(review(admin, 'forgiven', {}, {}, true));
  assert.equal((await getDoc(ref(admin, 'penaltyTotals', C))).exists(), false);
  await assertFails(updateDoc(ref(admin, 'penalties', key()), { reason: 'rewrite' }));
  await assertFails(pay());
  await assertFails(setDoc(ref(admin, 'penaltyTotals', C), { amount_cents: 500, last_penalty_id: key(), updated_at: serverTimestamp() }));
});
test('payment identity/time/reason and total delta cannot be forged', async () => {
  await assertSucceeds(propose());
  await assertSucceeds(review());
  for (const patch of [{ paid_by: 'adult' }, { paid_by_name: 'Fake' }, { paid_at: OLD }, { payment_reason: 'x'.repeat(501) }, { reviewed_at: serverTimestamp() }]) await assertFails(pay(patch));
  await assertFails(pay({}, { amount_cents: 500 }));
  await assertFails(pay({}, { amount_cents: -1 }));
  await assertFails(pay({}, { last_penalty_id: 'notThisPenalty' }));
  await assertFails(pay({}, { updated_at: OLD }));
  await assertSucceeds(pay());
});
test('totals cannot be forged, cross-membered, replayed, or deleted', async () => {
  await assertSucceeds(propose());
  await assertFails(setDoc(ref(admin, 'penaltyTotals', C), { amount_cents: 100000, last_penalty_id: key(), updated_at: serverTimestamp() }));
  const batch = writeBatch(admin);
  batch.update(ref(admin, 'penalties', key()), { status: 'pending', reviewed_by: 'admin', reviewed_by_name: 'admin', reviewed_at: serverTimestamp() });
  batch.set(ref(admin, 'penaltyTotals', P), { amount_cents: 500, last_penalty_id: key(), updated_at: serverTimestamp() });
  await assertFails(batch.commit());
  await assertSucceeds(review());
  await assertFails(updateDoc(ref(admin, 'penaltyTotals', C), { amount_cents: 1000, updated_at: serverTimestamp() }));
  await assertFails(deleteDoc(ref(admin, 'penaltyTotals', C)));
});
test('audit is adult read, append-only and proven in same economic transaction, never replay', async () => {
  await assertSucceeds(propose());
  const data = { actor_uid: 'admin', action: 'penalty.pending', entity_id: key(), created_at: serverTimestamp() };
  await assertFails(setDoc(ref(admin, 'auditEvents', 'forged'), data));
  await assertSucceeds(review(admin, 'pending', {}, {}, true));
  await assertSucceeds(getDoc(ref(adult, 'auditEvents', 'auditA')));
  await assertFails(getDoc(ref(child, 'auditEvents', 'auditA')));
  await assertFails(setDoc(ref(admin, 'auditEvents', 'replay'), data));
  await assertFails(updateDoc(ref(admin, 'auditEvents', 'auditA'), { action: 'penalty.paid' }));
  await assertFails(deleteDoc(ref(admin, 'auditEvents', 'auditA')));
});

test('public modules strict typed contracts; budget/helper data is adult-only', async () => {
  const examples = {
    recipes: { name: 'Soup', ingredients: ['water'], instructions: ['boil'], prep_time: 5, cook_time: 10, category: 'main', tags: [], deleted_at: null },
    planningEntries: { family_member_ids: [C], day_of_week: 1, specific_date: null, start_time: '09:00', end_time: '10:00', excluded_dates: [], title: 'School', schedule_type: 'school' },
    mealPlans: { date: '2026-10-04', meal_type: 'combined', recipe_id: null, custom_meal: 'Soup', notes: '' },
    shoppingItems: { name: 'Milk', category: 'dairy', quantity: 1, unit: 'l', price_cents: 100, is_checked: false },
    calendarEvents: { title: 'School', start_time: '2026-10-04T09:00', end_time: '2026-10-04T10:00', family_member_ids: [C], notes: '' },
    notes: { content: 'Hello', color: 'yellow', author_uid: 'admin', author_name: 'admin', expires_at: null },
    budgetEntries: { amount_cents: 500, date: '2026-10-04', category: 'food', is_expense: true, description: '' },
    shoppingTemplates: { name: 'Weekly', items: [{ name: 'Milk', category: 'dairy', quantity: 1, unit: 'l' }] },
    budgetLimits: { category: 'food', monthly_limit_cents: 10000, month: 10, year: 2026 },
    budgetRecurring: { label: 'Rent', category: 'home', amount_cents: 10000, is_expense: true, start_date: '2026-10-01', recurrence_frequency: 'monthly', recurrence_interval: 1, recurrence_until: null, is_active: true },
    kakeiboMonths: { month: 10, year: 2026, savings_goal_cents: 10000, notes: '' },
  };
  for (const [c, data] of Object.entries(examples)) {
    await assertSucceeds(setDoc(ref(admin, c, 'example'), { ...data, ...nowStamp() }));
    await assertFails(updateDoc(ref(admin, c, 'example'), { injected: true, ...edit() }));
    await assertFails(updateDoc(ref(admin, c, 'example'), { created_by: 'adult', ...edit() }));
    await assertFails(setDoc(ref(child, c, 'childWrite'), { ...data, created_by: 'child', created_at: serverTimestamp(), ...edit('child') }));
    if (c.startsWith('budget') || c === 'kakeiboMonths') await assertFails(getDoc(ref(child, c, 'example')));
    else await assertSucceeds(getDoc(ref(child, c, 'example')));
  }
  await assertFails(updateDoc(ref(admin, 'mealPlans', 'example'), { meal_type: 'snack', ...edit() }));
  await assertFails(updateDoc(ref(admin, 'budgetEntries', 'example'), { amount_cents: 1.5, ...edit() }));
  await assertFails(updateDoc(ref(admin, 'notes', 'example'), { author_uid: 'child', ...edit() }));
  await assertFails(updateDoc(ref(admin, 'recipes', 'example'), { image_url: 'http://not-https.invalid/a', ...edit() }));
  await assertFails(updateDoc(ref(admin, 'recipes', 'example'), { ingredients: [{ invalid: 'map' }], ...edit() }));
  await assertFails(deleteDoc(ref(admin, 'recipes', 'example')));
});
test('archived references can stay unchanged but no new active links; profile archive preserves history', async () => {
  await seed({ [path('members', Q)]: profile('Other', null, { deleted_at: OLD }), [path('tasks', 'archivedRef')]: task({ penalty_amount_cents: 0, assigned_to: [Q] }) });
  await assertSucceeds(updateDoc(ref(admin, 'tasks', 'archivedRef'), { title: 'Keep history', ...edit() }));
  await assertFails(setDoc(ref(admin, 'tasks', 'newArchivedRef'), task({ assigned_to: [Q], ...nowStamp() })));
  await assertFails(deleteDoc(ref(admin, 'members', Q)));
});
test('category settings are bounded/typed; notifications are own-read only, no fabricated delivery', async () => {
  await assertSucceeds(setDoc(ref(admin, 'settings', 'categories'), { recipe: ['main'], shopping: ['food'], budget: ['food'], ...nowStamp() }));
  await assertFails(setDoc(ref(admin, 'settings', 'arbitrary'), { ...nowStamp() }));
  await assertFails(updateDoc(ref(admin, 'settings', 'categories'), { recipe: [1], ...edit() }));
  await seed({ 'users/child/notifications/old': { title: 'Imported history', is_read: false } });
  await assertSucceeds(getDoc(doc(child, 'users/child/notifications/old')));
  await assertFails(getDoc(doc(admin, 'users/child/notifications/old')));
  await assertFails(setDoc(doc(child, 'users/child/notifications/fake'), { title: 'Pretend push' }));
});

test('existing-profile invitation allows only its atomic link, not profile edits or a different profile', async () => {
  await seed({ [path('invitations', INV)]: invitation({ member_id: Q }) });
  const link = async (p = Q, patch = {}) => {
    const batch = writeBatch(outsider);
    batch.update(ref(outsider, 'invitations', INV), { used_by: 'outsider', used_at: serverTimestamp() });
    batch.set(ref(outsider, 'memberships', 'outsider'), membership('outsider', 'child', p, { joined_at: serverTimestamp(), invite_id: INV }));
    batch.update(ref(outsider, 'members', p), { linked_user_id: 'outsider', ...edit('outsider'), ...patch });
    return batch.commit();
  };
  await assertSucceeds(getDoc(ref(outsider, 'memberships', 'outsider')));
  await assertFails(getDoc(ref(outsider, 'members', Q)));
  await assertFails(link(Q, { name: 'Stolen name' }));
  await assertFails(link(C));
  await assertSucceeds(link());
  assert.equal((await getDoc(ref(admin, 'members', Q))).data().name, 'Other');
  assert.equal((await getDoc(ref(outsider, 'memberships', 'outsider'))).data().member_id, Q);
});
test('child leave/admin removal must unlink atomically; administrator cannot be deleted', async () => {
  await assertFails(deleteDoc(ref(child, 'memberships', 'child')));
  await assertFails(updateDoc(ref(child, 'members', C), { linked_user_id: null, ...edit('child') }));
  await assertFails(deleteDoc(ref(admin, 'memberships', 'admin')));
  await assertSucceeds(runTransaction(child, async tx => {
    await tx.get(ref(child, 'memberships', 'child'));
    await tx.get(ref(child, 'members', C));
    tx.delete(ref(child, 'memberships', 'child'));
    tx.update(ref(child, 'members', C), { linked_user_id: null, ...edit('child') });
    tx.update(doc(child, 'users/child'), { active_family_id: null, updated_at: serverTimestamp() });
  }));
  await assertFails(getDoc(ref(child, 'tasks', 'taskA')));
  assert.equal((await getDoc(ref(admin, 'members', C))).data().linked_user_id, null);
});
test('admin relink requires clearing old link; role descriptions never change account authority', async () => {
  const bad = writeBatch(admin);
  bad.update(ref(admin, 'memberships', 'child'), { member_id: Q });
  bad.update(ref(admin, 'members', Q), { linked_user_id: 'child', ...edit() });
  await assertFails(bad.commit());
  const batch = writeBatch(admin);
  batch.update(ref(admin, 'memberships', 'child'), { member_id: Q });
  batch.update(ref(admin, 'members', C), { linked_user_id: null, ...edit() });
  batch.update(ref(admin, 'members', Q), { linked_user_id: 'child', role: 'Administrator', ...edit() });
  await assertSucceeds(batch.commit());
  await assertFails(updateDoc(doc(child, `families/${F}`), { name: 'Elevated', ...edit('child') }));
  await assertFails(updateDoc(ref(child, 'members', Q), { role: 'admin', ...edit('child') }));
});
test('SDK-sized three-responsible transaction preserves proposals before a heavy deadline/assignment edit', async () => {
  await seed({ [path('tasks', 'taskA')]: task({ assigned_to: [C, P, Q] }), [path('members', NEW)]: profile('New') });
  await assertSucceeds(runTransaction(admin, async tx => {
    await tx.get(ref(admin, 'tasks', 'taskA'));
    for (const p of [C, P, Q]) {
      await tx.get(ref(admin, 'members', p));
      await tx.get(ref(admin, 'penalties', key('taskA', p)));
    }
    tx.update(ref(admin, 'tasks', 'taskA'), { penalty_generated: true, ...edit() });
    for (const p of [C, P, Q]) tx.set(ref(admin, 'penalties', key('taskA', p)), penalty('taskA', p));
  }));
  await assertSucceeds(updateDoc(ref(admin, 'tasks', 'taskA'), { assigned_to: [NEW, P, Q], due_date: '2026-10-25T02:30', due_at: Timestamp.fromDate(new Date('2026-10-25T00:30:00Z')), penalty_amount_cents: 1000, title: 'New task details', ...edit() }));
  for (const p of [C, P, Q]) {
    const snapshot = (await getDoc(ref(admin, 'penalties', key('taskA', p)))).data();
    assert.equal(snapshot.amount_cents, 500);
    assert.equal(snapshot.due_date, '2025-01-01');
  }
});
test('concurrent confirmations cannot race/replay or double the total', async () => {
  await assertSucceeds(propose());
  const results = await Promise.allSettled([review(), review()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'permission-denied').length, 1);
  assert.equal((await getDoc(ref(admin, 'penaltyTotals', C))).data().amount_cents, 500);
});
test('existing total accumulates different proposals and payments subtract only their own amount', async () => {
  await assertSucceeds(propose());
  await assertSucceeds(review());
  await seed({ [path('tasks', 'taskB')]: task({ penalty_amount_cents: 1000 }) });
  const batch = writeBatch(admin);
  batch.update(ref(admin, 'tasks', 'taskB'), { penalty_generated: true, ...edit() });
  batch.set(ref(admin, 'penalties', key('taskB')), penalty('taskB', C, { amount_cents: 1000 }));
  await assertSucceeds(batch.commit());
  const confirm = writeBatch(admin);
  confirm.update(ref(admin, 'penalties', key('taskB')), { status: 'pending', reviewed_by: 'admin', reviewed_by_name: 'admin', reviewed_at: serverTimestamp() });
  confirm.set(ref(admin, 'penaltyTotals', C), { amount_cents: 1500, last_penalty_id: key('taskB'), updated_at: serverTimestamp() });
  await assertSucceeds(confirm.commit());
  await assertSucceeds(pay());
  assert.equal((await getDoc(ref(admin, 'penaltyTotals', C))).data().amount_cents, 1000);
});
test('SDK nullable module defaults and canonical calendar seconds satisfy rules', async () => {
  await assertSucceeds(setDoc(ref(admin, 'recipes', 'nullableRecipe'), { name: 'Soup', category: 'main', description: null, ingredients: ['water'], instructions: ['boil'], prep_time: null, cook_time: null, servings: null, difficulty: null, tags: [], deleted_at: null, ...nowStamp() }));
  await assertSucceeds(setDoc(ref(admin, 'shoppingItems', 'nullableShopping'), { name: 'Milk', category: 'dairy', quantity: null, unit: null, price_cents: null, notes: null, is_checked: false, ...nowStamp() }));
  await assertSucceeds(setDoc(ref(admin, 'calendarEvents', 'canonicalCalendar'), { title: 'School', description: null, start_time: '2026-10-04T09:00:00.000', end_time: null, location: null, family_member_ids: [C], notes: null, color: '#DC4A60', is_all_day: false, reminder_minutes: [30, 60], recurrence_frequency: 'none', recurrence_interval: 1, recurrence_until: null, ...nowStamp() }));
  await assertSucceeds(setDoc(ref(admin, 'members', NEW), profile('Offline', null, { role: 'Autre', ...nowStamp() })));
  await assertSucceeds(setDoc(ref(admin, 'privateProfiles', NEW), { birthdate: '1980-03-01', allergies: [], medications: [], emergency_contact_name: null, emergency_contact_phone: null, notes: null, monthly_income_cents: 0, ...nowStamp() }));
});
test('maximum recipe arrays are typed throughout, including last items', async () => {
  const recipe = { name: 'Long recipe', category: 'main', ingredients: Array(20).fill('water'), instructions: Array(10).fill('boil'), tags: [], prep_time: null, cook_time: null, deleted_at: null, ...nowStamp() };
  await assertSucceeds(setDoc(ref(admin, 'recipes', 'maxRecipe'), recipe));
  await assertSucceeds(setDoc(ref(admin, 'recipes', 'fullyPopulatedMaxRecipe'), { ...recipe, description: 'Description', prep_time: 10, cook_time: 20, servings: 4, difficulty: 'Facile', image_url: 'https://example.invalid/static-recipe.png' }));
  await assertSucceeds(setDoc(ref(admin, 'recipes', 'maxWithTags'), { ...recipe, ingredients: Array(5).fill('water'), instructions: Array(5).fill('boil'), tags: Array(20).fill('tag') }));
  await assertFails(setDoc(ref(admin, 'recipes', 'badLastIngredient'), { ...recipe, ingredients: [...Array(19).fill('water'), { injected: true }] }));
  await assertFails(setDoc(ref(admin, 'recipes', 'tooManyIngredients'), { ...recipe, ingredients: Array(21).fill('water') }));
  await assertFails(setDoc(ref(admin, 'recipes', 'tooManyCombined'), { ...recipe, tags: ['extra'] }));
});
test('maximum shopping template arrays are typed throughout, including last items', async () => {
  const items = Array(5).fill({ name: 'Milk', category: 'dairy', quantity: 1, unit: 'l', price_cents: 100, notes: 'text', is_checked: false });
  await assertSucceeds(setDoc(ref(admin, 'shoppingTemplates', 'maxTemplate'), { name: 'Maximum template', items, ...nowStamp() }));
  await assertFails(setDoc(ref(admin, 'shoppingTemplates', 'badLastItem'), { name: 'Bad template', items: [...items.slice(0, 4), { name: 'Milk', category: 'dairy', quantity: 'not a number', unit: null }], ...nowStamp() }));
  await assertFails(setDoc(ref(admin, 'shoppingTemplates', 'tooManyItems'), { name: 'Too big', items: [...items, items[0]], ...nowStamp() }));
});
test('private kakeibo settings whitelist keys and pillar values, deny child access', async () => {
  await assertSucceeds(setDoc(ref(admin, 'settings', 'kakeibo'), { mapping: { food: 'survival', leisure: 'wants' }, ...nowStamp() }));
  await assertSucceeds(getDoc(ref(adult, 'settings', 'kakeibo')));
  await assertFails(getDoc(ref(child, 'settings', 'kakeibo')));
  await assertFails(getDocs(query(collection(child, `families/${F}/settings`), limit(200))));
  await assertFails(updateDoc(ref(admin, 'settings', 'kakeibo'), { mapping: { food: 'admin' }, ...edit() }));
});
test('largest private profile/category/calendar contracts remain within expression budget', async () => {
  await assertSucceeds(setDoc(ref(admin, 'privateProfiles', C), { birthdate: '2010-01-01', allergies: Array(20).fill('a'), medications: Array(20).fill('b'), emergency_contact_name: 'Contact', emergency_contact_phone: '123', notes: 'Private', monthly_income_cents: 1000, ...nowStamp() }));
  await assertSucceeds(setDoc(ref(admin, 'settings', 'categories'), { recipe: Array(20).fill('recipe'), shopping: Array(10).fill('shopping'), budget: Array(10).fill('budget'), ...nowStamp() }));
  await assertFails(updateDoc(ref(admin, 'settings', 'categories'), { budget: Array(20).fill('budget'), ...edit() }));
  const calendar = { title: 'All participants', description: 'Description', start_time: '2026-10-04T09:00:00.000', end_time: '2026-10-04T10:00:00.000', location: 'Madrid', family_member_ids: [C, P, Q], notes: 'Notes', color: '#DC4A60', is_all_day: false, reminder_minutes: [0, 5, 10, 15, 20, 25, 30, 35, 60, 120], recurrence_frequency: 'none', recurrence_interval: 1, recurrence_until: null, ...nowStamp() };
  await assertSucceeds(setDoc(ref(admin, 'calendarEvents', 'maxCalendar'), calendar));
  await assertFails(setDoc(ref(admin, 'calendarEvents', 'badLastReminder'), { ...calendar, reminder_minutes: [...calendar.reminder_minutes.slice(0, 9), 'not an integer'] }));
});
test('planning exclusions validate every date and archived profiles/recipes cannot be rewritten', async () => {
  const planning = { family_member_ids: [C, P, Q], day_of_week: 1, specific_date: null, start_time: '22:00', end_time: '06:00', excluded_dates: Array(20).fill('2028-02-29'), title: 'Night shift', schedule_type: 'work', location: null, notes: null, ...nowStamp() };
  await assertSucceeds(setDoc(ref(admin, 'planningEntries', 'maxPlanning'), planning));
  await assertFails(setDoc(ref(admin, 'planningEntries', 'badExcludedDate'), { ...planning, excluded_dates: ['2026-02-29'] }));
  await seed({ [path('recipes', 'archivedRecipe')]: { name: 'Old recipe', ingredients: ['water'], instructions: ['boil'], prep_time: null, cook_time: null, category: 'main', tags: [], deleted_at: OLD, ...seedStamp() }, [path('members', Q)]: profile('Archived', null, { deleted_at: OLD }) });
  await assertFails(updateDoc(ref(admin, 'recipes', 'archivedRecipe'), { name: 'Rewritten', ...edit() }));
  await assertFails(updateDoc(ref(admin, 'members', Q), { name: 'Rewritten', ...edit() }));
});
test('an old deterministic proposal cannot freeze a reused occurrence without fresh proposals', async () => {
  await assertSucceeds(propose());
  // Simulate a restored legacy occurrence with its old proposal still present.
  await seed({ [path('tasks', 'taskA')]: task() });
  await assertFails(updateDoc(ref(admin, 'tasks', 'taskA'), { penalty_generated: true, ...edit() }));
  await assertFails(updateDoc(ref(admin, 'tasks', 'taskA'), { is_completed: true, completed_by: 'admin', completed_at: serverTimestamp(), penalty_generated: true, ...edit() }));
});
test('next occurrence must keep active responsibilities, even if the old list is unchanged', async () => {
  await seed({ [path('members', Q)]: profile('Archived', null, { deleted_at: OLD }), [path('tasks', 'archivedRecurring')]: task({ assigned_to: [Q], frequency: 'weekly', is_completed: true, completed_by: 'admin', completed_at: OLD, penalty_amount_cents: 0 }) });
  await assertFails(updateDoc(ref(admin, 'tasks', 'archivedRecurring'), { occurrence_id: 'next', is_completed: false, completed_by: null, completed_at: null, due_date: '2025-01-08', due_at: Timestamp.fromDate(new Date('2025-01-08T22:59:59.999Z')), ...edit() }));
});
