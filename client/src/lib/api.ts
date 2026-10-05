// The API base URL is resolved at request time by `apiBase()`:
//  - web: same-origin in prod ('' ), localhost:3001 in dev (see serverConfig);
//  - native (Capacitor): the server URL the user configured on the device.
import { apiBase } from './serverConfig';
import { IS_DEMO, IS_FIREBASE } from './firebase/config';
import { firebaseForgotPassword, firebaseRegister, firebaseRequest, firebaseResetPassword, firebaseRestoreUser, firebaseSignIn, firebaseSignOut } from './firebase/transport';

const AUTH_EXPIRED_EVENT = 'openfamily:auth-expired';

class ApiClient {
    private token: string | null = null;

    constructor() {
        if (!IS_FIREBASE) this.token = localStorage.getItem('token');
    }

    setToken(token: string | null) {
        if (IS_FIREBASE) return;
        this.token = token;
        if (token) {
            localStorage.setItem('token', token);
        } else {
            localStorage.removeItem('token');
        }
    }

    getToken(): string | null {
        if (IS_FIREBASE) return null;
        return this.token;
    }

    private async request<T>(
        endpoint: string,
        options: RequestInit = {}
    ): Promise<T> {
        // Static GitHub Pages demo: serve everything from the in-browser mock.
        if (IS_DEMO) {
            const { mockRequest } = await import('../demo/mockApi');
            const method = (options.method as string) || 'GET';
            const body = options.body ? JSON.parse(options.body as string) : undefined;
            return mockRequest<T>(method, endpoint, body);
        }

        if (IS_FIREBASE) {
            const method = options.method || 'GET';
            const body = options.body ? JSON.parse(options.body as string) : undefined;
            if (method === 'POST' && endpoint === '/api/auth/password/forgot') {
                await firebaseForgotPassword(body.email);
                return { success: true, data: {} } as T;
            }
            if (method === 'POST' && endpoint === '/api/auth/password/reset') {
                await firebaseResetPassword(body.oobCode, body.password);
                return { success: true, data: {} } as T;
            }
            return firebaseRequest<T>(method, endpoint, body);
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        const response = await fetch(`${apiBase()}${endpoint}`, {
            ...options,
            headers: {
                ...headers,
                ...(options.headers as Record<string, string>),
            },
        });

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await response.json() : null;

        if (!response.ok) {
            if (response.status === 401) {
                this.setToken(null);
                localStorage.removeItem('user');
                window.dispatchEvent(
                    new CustomEvent(AUTH_EXPIRED_EVENT, {
                        detail: data?.error || data?.message || 'Unauthorized',
                    })
                );
            }

            const fallbackMessage = `HTTP ${response.status}`;
            throw new Error(data?.error || data?.message || fallbackMessage);
        }

        return data as T;
    }

    async get<T>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, { method: 'GET' });
    }

    /**
     * Fetches binary content (images…) with the auth header.
     * Not supported by the static demo mock — throws so callers fall back.
     */
    async getBlob(endpoint: string): Promise<Blob> {
        if (IS_FIREBASE) throw Object.assign(new Error('Firebase Spark no admite descargas de archivos de un servidor externo ni almacenamiento de archivos.'), { code: 'unimplemented' });
        if (IS_DEMO) throw new Error('Binary endpoints are not available in demo mode');

        const headers: Record<string, string> = {};
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

        const response = await fetch(`${apiBase()}${endpoint}`, { headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
    }

    async post<T>(endpoint: string, body: any): Promise<T> {
        return this.request<T>(endpoint, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }

    /** Sends a file's text as the raw body (an .ics calendar, for instance). */
    async postText<T>(endpoint: string, text: string, contentType: string): Promise<T> {
        if (IS_FIREBASE) throw Object.assign(new Error('La importacion de archivos de texto no esta disponible en Firebase Spark.'), { code: 'unimplemented' });
        if (IS_DEMO) throw new Error('DEMO_UNAVAILABLE');
        return this.request<T>(endpoint, {
            method: 'POST',
            body: text,
            headers: { 'Content-Type': contentType },
        });
    }

    async put<T>(endpoint: string, body: any): Promise<T> {
        return this.request<T>(endpoint, {
            method: 'PUT',
            body: JSON.stringify(body),
        });
    }

    async delete<T>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, { method: 'DELETE' });
    }

    // Authentication methods
    async login(email: string, password: string) {
        if (IS_FIREBASE) return firebaseSignIn(email, password);
        const response = await this.post<any>(
            '/api/auth/login',
            { email, password }
        );

        if (response.success && response.data) {
            this.setToken(response.data.token);
            return { success: true, ...response.data };
        }
        return response;
    }

    async register(email: string, password: string, name: string, inviteToken?: string, role?: string) {
        if (IS_FIREBASE) return firebaseRegister(email, password, name, inviteToken);
        const body: Record<string, string> = { email, password, name, role: role ?? 'parent' };
        if (inviteToken) body.inviteToken = inviteToken;

        const response = await this.post<any>(
            '/api/auth/register',
            body
        );

        if (response.success && response.data) {
            this.setToken(response.data.token);
            return { success: true, ...response.data };
        }
        return response;
    }

    async joinFamily(inviteToken: string) {
        const response = await this.post<any>('/api/invites/join', { token: inviteToken });
        if (response.success && response.data) {
            if (!IS_FIREBASE) this.setToken(response.data.token);
            return { success: true, ...response.data };
        }
        return response;
    }

    async leaveFamily() {
        const response = await this.delete<any>('/api/invites/leave');
        if (response.success && response.data) {
            if (!IS_FIREBASE) this.setToken(response.data.token);
            return { success: true, ...response.data };
        }
        return response;
    }

    async refreshToken() {
        if (IS_FIREBASE) {
            const response = await firebaseRestoreUser();
            return { success: true, ...response.data };
        }
        const response = await this.post<any>('/api/auth/refresh', {});
        if (response.success && response.data) {
            this.setToken(response.data.token);
            return { success: true, ...response.data };
        }
        return response;
    }

    async logout(): Promise<void> {
        if (IS_FIREBASE) return firebaseSignOut();
        this.setToken(null);
    }
}

export const api = new ApiClient();
