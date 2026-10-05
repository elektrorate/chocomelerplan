import type { ReactElement } from 'react';
import { useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './contexts/AuthContext';
import { isNative, isServerConfigured } from './lib/serverConfig';
import Layout from './components/layout/Layout';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import Kiosk from './pages/Kiosk';
import ServerSetup from './pages/ServerSetup';
import Dashboard from './pages/Dashboard';
import ShoppingList from './pages/ShoppingList';
import Tasks from './pages/Tasks';
import Rewards from './pages/Rewards';
import Calendar from './pages/Calendar';
import Planning from './pages/Planning';
import Recipes from './pages/Recipes';
import MealPlanning from './pages/MealPlanning';
import Budget from './pages/Budget';
import Family from './pages/Family';
import Settings from './pages/Settings';
import Join from './pages/Join';
import FamilySetup from './pages/FamilySetup';
import { IS_DEMO, IS_FIREBASE } from './lib/firebase/config';
import { Button } from './components/ui/Button';

function App() {
    const { user, isAuthenticated, loading, isModuleEnabled, configError, restoreError, retryRestore, logout } = useAuth();
    const { t } = useTranslation('common');
    const location = useLocation();
    const navigate = useNavigate();

    // For an optional module: render its element only when enabled, otherwise
    // redirect to the dashboard so a bookmarked/typed URL never shows a hidden page.
    const moduleRoute = (key: string, element: ReactElement) =>
        isModuleEnabled(key) ? element : <Navigate to="/" replace />;

    const [serverReady, setServerReady] = useState(isServerConfigured());
    const [sessionActionError, setSessionActionError] = useState('');

    if (configError) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-background p-6">
                <section className="w-full max-w-lg space-y-4 rounded-card border border-border bg-card p-6">
                    <h1 className="font-serif text-heading">Firebase no esta configurado</h1>
                    <p role="alert" className="break-words text-body-sm text-destructive">{configError}</p>
                    <p className="text-body-sm text-muted-foreground">Configura las variables publicas del proyecto y reinicia el frontend. No incluyas claves administrativas en VITE_*.</p>
                    <p className="text-body-sm text-muted-foreground">Usa un proyecto Spark sin facturacion, con correo/contrasena y Firestore habilitados.</p>
                    <Button onClick={() => window.location.reload()}>Reintentar</Button>
                </section>
            </main>
        );
    }

    // Native app, first launch: ask which self-hosted server to connect to.
    if (!IS_FIREBASE && !IS_DEMO && isNative() && !serverReady) {
        return <ServerSetup onConfigured={() => setServerReady(true)} />;
    }

    // Email action links must also work while an existing profile is restoring.
    if (location.pathname === '/reset-password') {
        return <ResetPassword onDone={() => navigate('/', { replace: true })} />;
    }

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-3">
                    <div className="spinner-brand" />
                    <p className="text-caption text-muted-foreground">{t('states.loading')}</p>
                </div>
            </div>
        );
    }

    if (restoreError) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-background p-6">
                <section className="w-full max-w-lg space-y-4 rounded-card border border-border bg-card p-6">
                    <h1 className="font-serif text-heading">No se pudo restaurar tu perfil</h1>
                    <p role="alert" className="text-body-sm text-destructive">{sessionActionError || restoreError}</p>
                    <p className="text-body-sm text-muted-foreground">Tu cuenta no se ha cerrado. Comprueba la conexion y reintenta antes de acceder a los datos familiares.</p>
                    <div className="flex flex-wrap gap-3">
                        <Button onClick={() => { setSessionActionError(''); void retryRestore(); }}>Reintentar</Button>
                        <Button variant="secondary" onClick={() => void logout().catch(error => setSessionActionError(error.message))}>Cerrar sesion</Button>
                    </div>
                </section>
            </main>
        );
    }

    if (!isAuthenticated) {
        return <Login />;
    }

    if (IS_FIREBASE && user && !user.family_id) return <FamilySetup />;

    // Kiosk is a full-screen, chrome-less display — render it outside the Layout.
    if (location.pathname === '/kiosk') {
        return isModuleEnabled('kiosk') ? <Kiosk /> : <Navigate to="/" replace />;
    }

    return (
        <Layout>
            <Routes>
                <Route path="/" element={<Navigate to={isModuleEnabled('planning') ? '/planning' : '/dashboard'} replace />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/shopping" element={<ShoppingList />} />
                <Route path="/tasks" element={<Tasks />} />
                <Route path="/rewards" element={moduleRoute('rewards', <Rewards />)} />
                <Route path="/calendar" element={<Calendar />} />
                <Route path="/planning" element={moduleRoute('planning', <Planning />)} />
                <Route path="/recipes" element={moduleRoute('recipes', <Recipes />)} />
                <Route path="/meal-planning" element={moduleRoute('meals', <MealPlanning />)} />
                <Route path="/budget" element={moduleRoute('budget', <Budget />)} />
                <Route path="/family" element={<Family />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/join" element={<Join />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </Layout>
    );
}

export default App;
