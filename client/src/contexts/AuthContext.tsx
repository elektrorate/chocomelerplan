import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { api } from '../lib/api';
import { applyServerLanguage } from '../lib/language';
import { applyRegionalPreferences } from '../i18n/format';
import { getFirebase, getFirebaseConfigError, IS_DEMO, IS_FIREBASE } from '../lib/firebase/config';
import { FIREBASE_AUTH_REFRESH_EVENT, FIREBASE_REALTIME_EVENT, detectFirebaseOverdueTasks, firebaseError, firebaseRestoreUser, invalidateFirebaseCache, requestFirebaseAuthRefresh, setFirebaseSession, waitForFirebaseAuthOperation } from '../lib/firebase/transport';

interface User {
    id: string;
    email: string;
    name: string;
    family_id?: string | null;
    member_id?: string | null;
    dashboard_prefs?: DashboardPrefs;
    is_owner?: boolean;
    role?: string;
    currency?: string;
    avatar_url?: string | null;
    language?: string;
    /** ISO first day of the week (Monday = 1), null = automatic. */
    week_start_day?: number | null;
    /** Family-wide list of optional modules the family has hidden. */
    disabled_modules?: string[];
}

/** Dashboard widgets, in default display order (mirrors the server's list). */
export const DASHBOARD_WIDGETS = ['stats', 'agenda', 'planning', 'quick', 'notes'] as const;
export type DashboardWidget = typeof DASHBOARD_WIDGETS[number];

export interface DashboardPrefs {
    order: DashboardWidget[];
    hidden: DashboardWidget[];
    agendaView: 'day' | 'week';
}

export const DEFAULT_DASHBOARD_PREFS: DashboardPrefs = {
    order: [...DASHBOARD_WIDGETS],
    hidden: [],
    agendaView: 'day',
};

interface AuthContextType {
    user: User | null;
    loading: boolean;
    configError: string | null;
    restoreError: string | null;
    retryRestore: () => Promise<void>;
    login: (email: string, password: string) => Promise<void>;
    register: (email: string, password: string, name: string, inviteToken?: string, role?: string) => Promise<void>;
    joinFamily: (inviteToken: string) => Promise<void>;
    leaveFamily: () => Promise<void>;
    refreshToken: () => Promise<void>;
    logout: () => Promise<void>;
    isAuthenticated: boolean;
    updateCurrency: (currency: string) => Promise<void>;
    updateRegionalPreferences: (prefs: { week_start_day: number | null }) => Promise<void>;
    updateProfile: (data: { name?: string; avatar_url?: string | null }) => Promise<void>;
    /** This member's dashboard layout (null until loaded). */
    dashboardPrefs: DashboardPrefs | null;
    /** Persist this member's dashboard layout and update the context. */
    updateDashboardPrefs: (prefs: DashboardPrefs) => Promise<void>;
    /** Family-wide list of hidden optional modules (empty when nothing is hidden). */
    disabledModules: string[];
    /** True when a module is not hidden by the family. Always-on modules are always enabled. */
    isModuleEnabled: (key: string) => boolean;
    /** Persist the family's hidden-modules list (parents only) and update the context. */
    updateDisabledModules: (modules: string[]) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const AUTH_EXPIRED_EVENT = 'openfamily:auth-expired';

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [dashboardPrefs, setDashboardPrefs] = useState<DashboardPrefs | null>(null);
    const [restoreError, setRestoreError] = useState<string | null>(null);
    const [firebaseUid, setFirebaseUid] = useState<string | null>(null);
    const [retryCount, setRetryCount] = useState(0);
    const configError = getFirebaseConfigError();
    const restore = useRef<(blocking?: boolean) => Promise<void>>(async () => undefined);
    const scannedSession = useRef('');
    const acceptedUser = useRef<User | null>(null);

    const acceptUser = (next: User) => {
        if (IS_FIREBASE) {
            if (getFirebase().auth.currentUser?.uid !== next.id) return;
            setFirebaseSession(next.id, next.family_id ?? null, `${next.role || ''}:${Boolean(next.is_owner)}:${next.member_id || ''}`);
            setDashboardPrefs(next.dashboard_prefs ?? DEFAULT_DASHBOARD_PREFS);
            const key = `${next.id}:${next.family_id || ''}`;
            if (next.family_id && next.role !== 'enfant' && scannedSession.current !== key) {
                scannedSession.current = key;
                void detectFirebaseOverdueTasks(next.family_id).catch(error => {
                    window.dispatchEvent(new CustomEvent(FIREBASE_REALTIME_EVENT, { detail: { status: 'error', message: firebaseError(error).message } }));
                });
            }
        } else {
            localStorage.setItem('user', JSON.stringify(next));
        }
        setUser(next);
        acceptedUser.current = next;
        applyServerLanguage(next.language);
        applyRegionalPreferences(next.week_start_day);
    };

    const retryRestore = async () => {
        setRetryCount(count => count + 1);
        await restore.current();
    };

    useEffect(() => {
        if (!IS_FIREBASE) return;
        if (configError) { setLoading(false); return; }
        let active = true;
        let sequence = 0;
        let unsubscribe = () => {};
        const refresh = async (blocking = true) => {
            const ticket = ++sequence;
            if (active) {
                if (blocking) { setLoading(true); setUser(null); setDashboardPrefs(null); }
                setRestoreError(null);
            }
            try {
                const { auth, ready } = getFirebase();
                await ready;
                await auth.authStateReady();
                const uid = auth.currentUser?.uid;
                await waitForFirebaseAuthOperation();
                if (!active || ticket !== sequence || auth.currentUser?.uid !== uid) return;
                if (!uid) return;
                const response = await firebaseRestoreUser();
                if (active && ticket === sequence && auth.currentUser?.uid === uid) acceptUser(response.data.user);
            } catch (error) {
                if (active && ticket === sequence) {
                    invalidateFirebaseCache();
                    setUser(null);
                    setRestoreError(firebaseError(error).message);
                }
            } finally {
                if (active && ticket === sequence) setLoading(false);
            }
        };
        restore.current = refresh;
        const onRefresh = (event: Event) => { void refresh((event as CustomEvent).detail?.blocking !== false); };
        window.addEventListener(FIREBASE_AUTH_REFRESH_EVENT, onRefresh);
        void (async () => {
            try {
                const { auth, ready } = getFirebase();
                await ready;
                await auth.authStateReady();
                if (!active) return;
                unsubscribe = onAuthStateChanged(auth, account => {
                    acceptedUser.current = null;
                    scannedSession.current = '';
                    setFirebaseSession(account?.uid ?? null, null);
                    setFirebaseUid(account?.uid ?? null);
                    void refresh();
                }, error => {
                    if (active) { setRestoreError(firebaseError(error).message); setLoading(false); }
                });
            } catch (error) {
                if (active) { setRestoreError(firebaseError(error).message); setLoading(false); }
            }
        })();
        return () => {
            active = false;
            sequence++;
            unsubscribe();
            window.removeEventListener(FIREBASE_AUTH_REFRESH_EVENT, onRefresh);
        };
    }, [configError]);

    useEffect(() => {
        if (!IS_FIREBASE || !firebaseUid || configError) return;
        let initial = true;
        let previous = '';
        let previousFamily: unknown;
        let active = true;
        const unsubscribe = onSnapshot(doc(getFirebase().db, 'users', firebaseUid), { includeMetadataChanges: true }, snapshot => {
            if (!active || getFirebase().auth.currentUser?.uid !== firebaseUid) return;
            if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
            const next = JSON.stringify(snapshot.data());
            const family = snapshot.data()?.active_family_id;
            if (initial && snapshot.exists()) {
                if (acceptedUser.current?.id === firebaseUid && (acceptedUser.current.family_id ?? null) !== (family ?? null)) requestFirebaseAuthRefresh();
                else void restore.current(false);
            } else if (!initial && next !== previous) {
                if (family !== previousFamily) requestFirebaseAuthRefresh();
                else { invalidateFirebaseCache('auth'); void restore.current(false); }
            }
            initial = false;
            previous = next;
            previousFamily = family;
        }, error => {
            if (!active || getFirebase().auth.currentUser?.uid !== firebaseUid) return;
            invalidateFirebaseCache();
            setUser(null);
            setRestoreError(firebaseError(error).message);
            setLoading(false);
        });
        return () => { active = false; unsubscribe(); };
    }, [firebaseUid, retryCount, configError]);

    useEffect(() => {
        if (IS_FIREBASE) return;
        let mounted = true;

        const clearSession = () => {
            api.logout();
            localStorage.removeItem('user');
            if (mounted) {
                setUser(null);
            }
        };

        const onAuthExpired = () => {
            clearSession();
        };

        window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);

        const bootstrapSession = async () => {
            const token = api.getToken();
            // In the static demo there is no real auth: load the seeded user directly.
            if (!token && !IS_DEMO) {
                if (mounted) {
                    setLoading(false);
                }
                return;
            }

            try {
                const response = await api.get<{ success: boolean; data: { user: User } }>('/api/auth/me');
                if (!mounted) {
                    return;
                }

                if (response.success && response.data?.user) {
                    setUser(response.data.user);
                    localStorage.setItem('user', JSON.stringify(response.data.user));
                    // Once per session load: reconcile UI language with the account.
                    applyServerLanguage(response.data.user.language);
                    applyRegionalPreferences(response.data.user.week_start_day);
                } else {
                    clearSession();
                }
            } catch (error) {
                console.error('Failed to restore session:', error);
                clearSession();
            } finally {
                if (mounted) {
                    setLoading(false);
                }
            }
        };

        void bootstrapSession();

        return () => {
            mounted = false;
            window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
        };
    }, []);

    const login = async (email: string, password: string) => {
        const response = await api.login(email, password);
        if (IS_FIREBASE) { await restore.current(); return; }
        if (response.success && response.user) {
            setUser(response.user);
            // Also store in localStorage for persistence
            localStorage.setItem('user', JSON.stringify(response.user));
            // Once per login: reconcile UI language with the account.
            applyServerLanguage(response.user.language);
            applyRegionalPreferences(response.user.week_start_day);
        }
    };

    const register = async (email: string, password: string, name: string, inviteToken?: string, role?: string) => {
        const response = await api.register(email, password, name, inviteToken, role);
        if (IS_FIREBASE) { await restore.current(); return; }
        if (response.success && response.user) {
            setUser(response.user);
            localStorage.setItem('user', JSON.stringify(response.user));
            applyServerLanguage(response.user.language);
            applyRegionalPreferences(response.user.week_start_day);
        }
    };

    const joinFamily = async (inviteToken: string) => {
        const response = await api.joinFamily(inviteToken);
        if (IS_FIREBASE) { await restore.current(); return; }
        if (response.success && response.user) {
            acceptUser(response.user);
        }
    };

    const leaveFamily = async () => {
        const response = await api.leaveFamily();
        if (IS_FIREBASE) { await restore.current(); return; }
        if (response.success && response.user) {
            acceptUser(response.user);
        }
    };

    const refreshToken = async () => {
        if (IS_FIREBASE) { await restore.current(); return; }
        const response = await api.refreshToken();
        if (response.success && response.user) {
            setUser(response.user);
            localStorage.setItem('user', JSON.stringify(response.user));
        }
    };

    const logout = async () => {
        try {
            await api.logout();
        } catch (error) {
            if (IS_FIREBASE) { setUser(null); setRestoreError(firebaseError(error).message); }
            throw error;
        }
        setUser(null);
        setRestoreError(null);
        setDashboardPrefs(null);
        applyRegionalPreferences(null);
        localStorage.removeItem('user');
    };

    const updateCurrency = async (currency: string) => {
        const response = await api.put<{ success: boolean; data: { user: User } }>('/api/auth/currency', { currency });
        if (response.success && response.data?.user) {
            acceptUser(response.data.user);
        }
    };

    const updateRegionalPreferences = async (prefs: { week_start_day: number | null }) => {
        const response = await api.put<{ success: boolean; data: { user: User } }>(
            '/api/auth/regional-preferences',
            prefs
        );
        if (response.success && response.data?.user) {
            acceptUser(response.data.user);
        }
    };

    const updateProfile = async (data: { name?: string; avatar_url?: string | null }) => {
        const response = await api.put<{ success: boolean; data: { user: User } }>('/api/auth/profile', data);
        if (response.success && response.data?.user) {
            acceptUser(response.data.user);
        }
    };

    // Dashboard layout belongs to the logged-in member; (re)load it whenever the
    // session changes. Failure is non-blocking: the dashboard falls back to the
    // default arrangement.
    useEffect(() => {
        if (IS_FIREBASE) return;
        if (!user) {
            setDashboardPrefs(null);
            return;
        }

        let active = true;
        api.get<{ success: boolean; data: DashboardPrefs }>('/api/auth/dashboard-prefs')
            .then((res) => {
                if (active && res.success && res.data) setDashboardPrefs(res.data);
            })
            .catch(() => {
                if (active) setDashboardPrefs(DEFAULT_DASHBOARD_PREFS);
            });

        return () => { active = false; };
    }, [user?.id]);

    const updateDashboardPrefs = async (prefs: DashboardPrefs) => {
        // Optimistic: the dashboard reorders instantly, the server confirms.
        setDashboardPrefs(prefs);
        const response = await api.put<{ success: boolean; data: DashboardPrefs }>(
            '/api/auth/dashboard-prefs',
            prefs
        );
        if (response.success && response.data) {
            setDashboardPrefs(response.data);
        }
    };

    const disabledModules = user?.disabled_modules ?? [];

    const isModuleEnabled = (key: string) => !disabledModules.includes(key);

    const updateDisabledModules = async (modules: string[]) => {
        const response = await api.put<{ success: boolean; data: { disabled_modules: string[] } }>(
            '/api/auth/modules',
            { disabled_modules: modules }
        );
        if (IS_FIREBASE) { await restore.current(); return; }
        if (response.success && response.data) {
            setUser((prev) => {
                if (!prev) return prev;
                const next = { ...prev, disabled_modules: response.data.disabled_modules };
                localStorage.setItem('user', JSON.stringify(next));
                return next;
            });
        }
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                loading,
                configError,
                restoreError,
                retryRestore,
                login,
                register,
                joinFamily,
                leaveFamily,
                refreshToken,
                logout,
                isAuthenticated: IS_FIREBASE ? !!firebaseUid : !!user,
                updateCurrency,
                updateRegionalPreferences,
                updateProfile,
                dashboardPrefs,
                updateDashboardPrefs,
                disabledModules,
                isModuleEnabled,
                updateDisabledModules,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
