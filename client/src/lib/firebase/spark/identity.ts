import { collection, doc, getDocFromServer, serverTimestamp, Timestamp } from 'firebase/firestore';
import { getFirebase } from '../config';
import {
    col, emitSparkChange, enumValue, fail, getAccount, getContext, id, list, metadata,
    object, ok, requireAdmin, text, transaction, unsupported, type Json, type SparkContext,
} from './core';

const WIDGETS = ['stats', 'agenda', 'planning', 'quick', 'notes'];
const MODULES = ['budget', 'rewards', 'meals', 'recipes', 'planning', 'integrations', 'kiosk', 'notes', 'ai'];
const dashboardDefaults = () => ({ order: [...WIDGETS], hidden: [], agendaView: 'day' });

export async function userWire(): Promise<Json> {
    const account = await getAccount();
    const { db } = getFirebase();
    const profile = await getDocFromServer(doc(db, 'users', account.uid));
    if (!profile.exists()) fail('Crea tu perfil para continuar.', 'not-found');
    const data = profile.data();
    let membership: Json | null = null;
    let family: Json | null = null;
    if (data.active_family_id) {
        const memberRef = doc(db, 'families', id(data.active_family_id), 'memberships', account.uid);
        const member = await getDocFromServer(memberRef);
        if (member.exists()) {
            try {
                const familyDoc = await getDocFromServer(doc(db, 'families', data.active_family_id));
                if (familyDoc.exists()) { membership = member.data(); family = familyDoc.data(); }
            } catch (error) {
                if ((error as { code?: string }).code !== 'permission-denied' || (await getDocFromServer(memberRef)).exists()) throw error;
            }
        }
    }
    return {
        id: account.uid, email: account.email || '', name: data.name,
        family_id: membership ? data.active_family_id : null,
        member_id: membership?.member_id ?? null,
        role: membership ? (membership.role === 'child' ? 'enfant' : 'parent') : undefined,
        is_owner: membership?.role === 'admin', currency: 'EUR', avatar_url: null,
        language: data.language, week_start_day: data.week_start_day,
        dashboard_prefs: data.dashboard_prefs, disabled_modules: family?.disabled_modules || [],
        created_at: data.created_at,
    };
}

async function bootstrap(input: Json) {
    const account = await getAccount();
    const ref = doc(getFirebase().db, 'users', account.uid);
    const name = text(input.name ?? account.displayName ?? account.email?.split('@')[0] ?? 'Mi cuenta', 'name', 100, 1);
    await transaction(async tx => {
        const current = await tx.get(ref);
        if (!current.exists()) tx.set(ref, {
            name, email: account.email || '', language: 'es', week_start_day: null,
            dashboard_prefs: dashboardDefaults(), active_family_id: null,
            created_at: serverTimestamp(), updated_at: serverTimestamp(),
        });
    });
    if (input.inviteToken) await join(text(input.inviteToken, 'inviteToken', 300, 1));
    emitSparkChange('auth');
    return ok({ user: await userWire() });
}

async function createFamily(input: Json) {
    object(input, ['name']);
    const account = await getAccount();
    const name = text(input.name, 'name', 100, 1);
    const { db } = getFirebase();
    const family = doc(collection(db, 'families'));
    const profileRef = doc(db, 'users', account.uid);
    const member = doc(collection(family, 'members'));
    const membership = doc(collection(family, 'memberships'), account.uid);
    await transaction(async tx => {
        const profile = await tx.get(profileRef);
        if (!profile.exists()) fail('Crea tu perfil antes de crear una familia.', 'not-found');
        const user = profile.data();
        if (user.active_family_id && (await tx.get(doc(db, 'families', id(user.active_family_id), 'memberships', account.uid))).exists()) {
            fail('Ya perteneces a una familia.', 'failed-precondition');
        }
        const ctx: SparkContext = { familyId: family.id, uid: account.uid, role: 'admin', memberId: member.id, displayName: user.name };
        tx.set(family, { name, timezone: 'Europe/Madrid', currency: 'EUR', admin_uid: account.uid, disabled_modules: [], ...metadata(ctx, true) });
        tx.set(membership, { role: 'admin', member_id: member.id, name: user.name, email: account.email || '', joined_at: serverTimestamp(), invite_id: null });
        tx.set(member, { name: user.name, color: '#8B5CF6', role: 'Parent', linked_user_id: account.uid, deleted_at: null, ...metadata(ctx, true) });
        tx.update(profileRef, { active_family_id: family.id, updated_at: serverTimestamp() });
    });
    emitSparkChange('auth'); emitSparkChange('family');
    return ok({ id: family.id, family_id: family.id, user: await userWire() });
}

function invitation(token: string) {
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) fail('La invitacion no es valida.');
    return { familyId: id(parts[0]), inviteId: parts[1], ref: doc(getFirebase().db, 'families', parts[0], 'invitations', parts[1]) };
}

function availableInvite(data: Json | undefined) {
    if (!data || data.used_by || data.used_at || !(data.expires_at instanceof Timestamp) || data.expires_at.toMillis() <= Date.now()) {
        fail('La invitacion no es valida, ha caducado o ya se ha utilizado.', 'failed-precondition');
    }
    enumValue(data.role, ['adult', 'child'] as const, 'role');
}

async function createInvite(ctx: SparkContext, input: Json) {
    requireAdmin(ctx);
    object(input, ['role', 'member_id', 'inviteeEmail', 'email']);
    const role = enumValue(input.role === 'parent' ? 'adult' : input.role === 'enfant' ? 'child' : input.role, ['adult', 'child'] as const, 'role');
    const memberId = input.member_id ? id(input.member_id) : null;
    const emailValue = input.email ?? input.inviteeEmail;
    const email = emailValue ? text(emailValue, 'email', 254, 3).toLowerCase() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('El correo de invitacion no es valido.');
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const randomId = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const ref = doc(col(ctx, 'invitations'), randomId);
    await transaction(async tx => {
        const [profile, membership, existing, member] = await Promise.all([
            tx.get(doc(getFirebase().db, 'users', ctx.uid)), tx.get(doc(col(ctx, 'memberships'), ctx.uid)), tx.get(ref),
            memberId ? tx.get(doc(col(ctx, 'members'), memberId)) : Promise.resolve(null),
        ]);
        if (membership.data()?.role !== 'admin') fail('Solo el administrador puede invitar.', 'permission-denied');
        if (existing.exists()) fail('El codigo ya existe. Reintenta.', 'already-exists');
        if (memberId && (!member?.exists() || member.data().deleted_at || member.data().linked_user_id)) fail('El perfil no esta disponible para vincularlo.');
        tx.set(ref, {
            role, member_id: memberId, email, expires_at: Timestamp.fromMillis(Date.now() + 7 * 86400_000),
            used_by: null, used_at: null, created_by: ctx.uid, created_at: serverTimestamp(), owner_name: profile.data()!.name,
        });
    });
    const token = `${ctx.familyId}.${randomId}`;
    emitSparkChange('family');
    return ok({ token, invite_url: new URL(`/join?invite=${encodeURIComponent(token)}`, window.location.origin).href, email_sent: null });
}

async function join(token: string) {
    const account = await getAccount();
    await account.reload();
    await account.getIdToken(true);
    const { familyId, inviteId, ref } = invitation(token);
    const { db } = getFirebase();
    const userRef = doc(db, 'users', account.uid);
    const membershipRef = doc(db, 'families', familyId, 'memberships', account.uid);
    const generatedMemberId = crypto.randomUUID();
    await transaction(async tx => {
        const [user, invite, membership] = await Promise.all([tx.get(userRef), tx.get(ref), tx.get(membershipRef)]);
        if (!user.exists()) fail('Crea tu perfil antes de aceptar la invitacion.', 'not-found');
        const profile = user.data();
        if (profile.active_family_id && profile.active_family_id !== familyId &&
            (await tx.get(doc(db, 'families', id(profile.active_family_id), 'memberships', account.uid))).exists()) {
            fail('Sal de tu familia actual antes de aceptar otra invitacion.', 'failed-precondition');
        }
        const data = invite.data();
        if (data?.used_by === account.uid && membership.exists() && profile.active_family_id === familyId) return;
        availableInvite(data);
        if (membership.exists()) fail('Ya perteneces a esta familia.', 'failed-precondition');
        if (data!.email && (!account.emailVerified || account.email?.toLowerCase() !== data!.email)) fail('Verifica el correo al que se dirige esta invitacion.', 'permission-denied');
        const memberId = data!.member_id ? id(data!.member_id) : generatedMemberId;
        const memberRef = doc(db, 'families', familyId, 'members', memberId);
        const ctx: SparkContext = { uid: account.uid, familyId, role: data!.role, memberId, displayName: profile.name };
        tx.set(membershipRef, { role: data!.role, member_id: memberId, name: profile.name, email: account.email || '', joined_at: serverTimestamp(), invite_id: inviteId });
        // Invitees cannot read family profiles yet; rules validate the existing profile and bidirectional link atomically.
        if (data!.member_id) tx.update(memberRef, { linked_user_id: account.uid, ...metadata(ctx) });
        else tx.set(memberRef, { name: profile.name, color: '#8B5CF6', role: data!.role === 'child' ? 'Enfant' : 'Parent', linked_user_id: account.uid, deleted_at: null, ...metadata(ctx, true) });
        tx.update(ref, { used_by: account.uid, used_at: serverTimestamp() });
        tx.update(userRef, { active_family_id: familyId, updated_at: serverTimestamp() });
    });
    emitSparkChange('auth'); emitSparkChange('family');
    return ok({ user: await userWire() });
}

async function removeMembership(ctx: SparkContext, targetUid: string) {
    if (targetUid !== ctx.uid) requireAdmin(ctx);
    const ref = doc(col(ctx, 'memberships'), targetUid);
    await transaction(async tx => {
        const member = await tx.get(ref);
        if (!member.exists()) return;
        const data = member.data();
        if (data.role === 'admin') fail('Transfiere la administracion antes de salir.', 'failed-precondition');
        const profileRef = data.member_id ? doc(col(ctx, 'members'), id(data.member_id)) : null;
        const profile = profileRef ? await tx.get(profileRef) : null;
        if (targetUid === ctx.uid) await tx.get(doc(getFirebase().db, 'users', ctx.uid));
        tx.delete(ref);
        if (profileRef && profile?.data()?.linked_user_id === targetUid) tx.update(profileRef, { linked_user_id: null, ...metadata(ctx) });
        if (targetUid === ctx.uid) tx.update(doc(getFirebase().db, 'users', ctx.uid), { active_family_id: null, updated_at: serverTimestamp() });
    });
    emitSparkChange('family');
    if (targetUid === ctx.uid) emitSparkChange('auth');
    return ok(targetUid === ctx.uid ? { user: await userWire() } : { id: targetUid });
}

function dashboardPrefs(input: unknown) {
    const prefs = object(input, ['order', 'hidden', 'agendaView']);
    for (const key of ['order', 'hidden']) {
        if (!Array.isArray(prefs[key]) || prefs[key].some((item: unknown) => !WIDGETS.includes(item as string)) || new Set(prefs[key]).size !== prefs[key].length) fail('La configuracion del panel no es valida.');
    }
    if (prefs.order.length !== WIDGETS.length) fail('El orden del panel debe incluir todos los widgets.');
    enumValue(prefs.agendaView, ['day', 'week'], 'agendaView');
    return prefs;
}

export async function handleIdentity(method: string, path: string, _q: Json, input: Json): Promise<any | undefined> {
    if (path === '/auth/bootstrap' && method === 'POST') return bootstrap(object(input, ['name', 'inviteToken']));
    if ((path === '/auth/me' && method === 'GET') || (path === '/auth/refresh' && method === 'POST')) return ok({ user: await userWire() });
    if (path === '/families' && method === 'POST') return createFamily(input);
    const preview = /^\/invites\/info\/([^/]+)$/.exec(path);
    if (preview && method === 'GET') {
        await getAccount();
        const invite = await getDocFromServer(invitation(preview[1]).ref);
        availableInvite(invite.data());
        return ok({ ownerName: invite.data()!.owner_name, expiresAt: invite.data()!.expires_at });
    }
    if (path === '/invites/join' && method === 'POST') { object(input, ['token']); return join(text(input.token, 'token', 300, 1)); }
    if (path === '/invites/requests' || path.startsWith('/invites/requests/')) {
        if (method === 'GET') return { ...ok(path === '/invites/requests/mine' ? null : []), available: false, message: 'Spark no envia solicitudes por correo; utiliza un enlace de invitacion.' };
        return unsupported('Firebase Spark no envia solicitudes por correo. Utiliza un enlace de invitacion.');
    }
    if (path === '/auth/dashboard-prefs' && method === 'GET') return ok((await userWire()).dashboard_prefs);
    if (['/auth/profile', '/auth/language', '/auth/regional-preferences', '/auth/dashboard-prefs', '/auth/currency'].includes(path) && method === 'PUT') {
        const account = await getAccount();
        let patch: Json;
        if (path === '/auth/profile') {
            if ('avatar_url' in input) return unsupported('Firebase Spark no admite fotos de perfil ni subidas de archivos.');
            object(input, ['name']); patch = { name: text(input.name, 'name', 100, 1) };
        } else if (path === '/auth/language') {
            object(input, ['language']); patch = { language: enumValue(input.language, ['es', 'en', 'fr', 'pt', 'ru', 'zh'], 'language') };
        } else if (path === '/auth/regional-preferences') {
            object(input, ['week_start_day']);
            if (input.week_start_day !== null && (!Number.isInteger(input.week_start_day) || input.week_start_day < 1 || input.week_start_day > 7)) fail('El inicio de semana no es valido.');
            patch = { week_start_day: input.week_start_day };
        } else if (path === '/auth/dashboard-prefs') patch = { dashboard_prefs: dashboardPrefs(input) };
        else {
            object(input, ['currency']);
            if (input.currency !== 'EUR') return unsupported('La moneda de Firebase Spark es EUR.');
            return ok({ user: await userWire() });
        }
        const ref = doc(getFirebase().db, 'users', account.uid);
        await transaction(async tx => { if (!(await tx.get(ref)).exists()) fail('El perfil no existe.', 'not-found'); tx.update(ref, { ...patch, updated_at: serverTimestamp() }); });
        emitSparkChange('auth');
        return ok(path === '/auth/dashboard-prefs' ? patch.dashboard_prefs : { user: await userWire() });
    }
    if (path === '/auth/modules' || path === '/invites' || path.startsWith('/invites/') || /\/link$/.test(path)) {
        const ctx = await getContext();
        if (path === '/auth/modules') {
            if (method === 'GET') return ok({ disabled_modules: (await getDocFromServer(doc(getFirebase().db, 'families', ctx.familyId))).data()!.disabled_modules });
            if (method === 'PUT') {
                requireAdmin(ctx); object(input, ['disabled_modules']);
                if (!Array.isArray(input.disabled_modules) || input.disabled_modules.some((key: unknown) => !MODULES.includes(key as string)) || new Set(input.disabled_modules).size !== input.disabled_modules.length) fail('La lista de modulos no es valida.');
                const ref = doc(getFirebase().db, 'families', ctx.familyId);
                await transaction(async tx => { await tx.get(ref); tx.update(ref, { disabled_modules: input.disabled_modules, ...metadata(ctx) }); });
                emitSparkChange('family'); emitSparkChange('auth');
                return ok({ disabled_modules: input.disabled_modules });
            }
        }
        if (path === '/invites' && method === 'POST') return createInvite(ctx, input);
        if (path === '/invites' && method === 'GET') { requireAdmin(ctx); return ok(await list(ctx, 'invitations')); }
        if (path === '/invites/members' && method === 'GET') return ok((await list(ctx, 'memberships')).map(member => ({ id: member.id, name: member.name, email: member.email, is_owner: member.role === 'admin', role: member.role === 'child' ? 'enfant' : 'parent' })));
        if (path === '/invites/leave' && method === 'DELETE') return removeMembership(ctx, ctx.uid);
        const memberRoute = /^\/invites\/members\/([^/]+)(\/role)?$/.exec(path);
        if (memberRoute && method === 'DELETE' && !memberRoute[2]) return removeMembership(ctx, id(memberRoute[1]));
        if (memberRoute?.[2] && method === 'PUT') {
            requireAdmin(ctx); object(input, ['role']);
            const role = enumValue(input.role === 'parent' ? 'adult' : input.role === 'enfant' ? 'child' : input.role, ['adult', 'child'] as const, 'role');
            const ref = doc(col(ctx, 'memberships'), id(memberRoute[1]));
            await transaction(async tx => {
                const member = await tx.get(ref);
                if (!member.exists()) fail('La cuenta ya no pertenece a la familia.', 'not-found');
                if (member.data().role === 'admin') fail('Utiliza la transferencia de administracion.', 'failed-precondition');
                tx.update(ref, { role });
            });
            emitSparkChange('family');
            return ok({ user: await userWire() });
        }
        if (path === '/invites/transfer-ownership' && method === 'POST') {
            requireAdmin(ctx); object(input, ['newOwnerId']); const target = id(input.newOwnerId);
            if (target === ctx.uid) fail('La cuenta ya administra la familia.');
            const family = doc(getFirebase().db, 'families', ctx.familyId);
            const own = doc(col(ctx, 'memberships'), ctx.uid); const other = doc(col(ctx, 'memberships'), target);
            await transaction(async tx => {
                const [familyDoc, ownMember, otherMember] = await Promise.all([tx.get(family), tx.get(own), tx.get(other)]);
                if (familyDoc.data()?.admin_uid !== ctx.uid || ownMember.data()?.role !== 'admin' || !otherMember.exists() || otherMember.data().role !== 'adult') fail('La transferencia requiere otra cuenta adulta.', 'failed-precondition');
                tx.update(family, { admin_uid: target, ...metadata(ctx) }); tx.update(own, { role: 'adult' }); tx.update(other, { role: 'admin' });
            });
            emitSparkChange('family'); emitSparkChange('auth'); return ok({ user: await userWire() });
        }
        if (/\/link$/.test(path)) return unsupported('Para vincular un perfil a una cuenta, crea una invitacion dirigida a ese perfil.');
        return unsupported('Esta operacion de invitaciones no esta disponible en Spark.');
    }
    if (path.startsWith('/auth/') || path.startsWith('/families')) return unsupported();
    return undefined;
}
