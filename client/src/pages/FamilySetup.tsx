import { useState, type FormEvent } from 'react';
import { Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
import { firebaseSendEmailVerification } from '../lib/firebase/transport';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Input } from '../components/ui/Input';

export default function FamilySetup() {
    const { user, joinFamily, refreshToken, logout } = useAuth();
    const [name, setName] = useState('');
    const [invite, setInvite] = useState(() => {
        const search = new URLSearchParams(window.location.search);
        const hash = new URLSearchParams(window.location.hash.split('?')[1] || '');
        return search.get('invite') || hash.get('invite') || '';
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const submit = async (event: FormEvent, mode: 'create' | 'join') => {
        event.preventDefault();
        setSaving(true);
        setError('');
        try {
            if (mode === 'create') {
                await api.post('/api/families', { name: name.trim() });
                await refreshToken();
            } else {
                let token = invite.trim();
                if (/^https?:\/\//i.test(token)) {
                    const url = new URL(token);
                    token = url.searchParams.get('invite') || new URLSearchParams(url.hash.split('?')[1] || '').get('invite') || '';
                }
                if (!token) throw new Error('Introduce un codigo o enlace de invitacion valido.');
                await joinFamily(token);
            }
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'No se pudo configurar tu familia.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <main className="flex min-h-screen items-center justify-center bg-background p-4">
            <Card className="w-full max-w-lg" hover={false}>
                <CardHeader className="px-6 pt-8 text-center">
                    <Users className="mx-auto mb-4 h-10 w-10 text-primary" />
                    <CardTitle className="font-serif text-display">Tu espacio familiar</CardTitle>
                    <p className="text-body-sm text-muted-foreground">Hola, {user?.name}. Tu cuenta esta lista. Crea una familia o acepta una invitacion para continuar.</p>
                </CardHeader>
                <CardContent className="space-y-6 px-6 pb-8">
                    {error && <p role="alert" className="rounded-input border border-destructive/20 bg-destructive/10 p-3 text-body-sm text-destructive">{error}</p>}
                    {notice && <p role="status" className="text-body-sm text-muted-foreground">{notice}</p>}
                    <form onSubmit={event => void submit(event, 'create')} className="space-y-3">
                        <Input label="Nombre de la familia" value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={saving} />
                        <Button className="w-full" type="submit" disabled={saving || !name.trim()}>Crear familia</Button>
                    </form>
                    <form onSubmit={event => void submit(event, 'join')} className="space-y-3 border-t border-border pt-6">
                        <Input label="Codigo o enlace de invitacion" value={invite} onChange={event => setInvite(event.target.value)} required disabled={saving} />
                        <Button className="w-full" variant="secondary" type="submit" disabled={saving || !invite.trim()}>Unirme a una familia</Button>
                        <Button className="w-full" variant="ghost" type="button" disabled={saving} onClick={() => {
                            setSaving(true); setError(''); setNotice('');
                            void firebaseSendEmailVerification().then(() => setNotice('Revisa tu correo, verifica tu cuenta y vuelve a aceptar la invitacion.')).catch(failure => setError(failure.message)).finally(() => setSaving(false));
                        }}>Verificar mi correo para una invitacion dirigida</Button>
                    </form>
                    {saving && <p role="status" className="text-center text-body-sm text-muted-foreground">Esperando la confirmacion del servidor...</p>}
                    <Button className="w-full" variant="ghost" disabled={saving} onClick={() => void logout().catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo cerrar la sesion.'))}>Cerrar sesion</Button>
                </CardContent>
            </Card>
        </main>
    );
}
