/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_API_URL: string;
    readonly VITE_WS_URL: string;
    readonly VITE_DEMO?: string;
    readonly VITE_DATA_BACKEND?: 'firebase' | 'legacy';
    readonly VITE_FIREBASE_API_KEY?: string;
    readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
    readonly VITE_FIREBASE_PROJECT_ID?: string;
    readonly VITE_FIREBASE_APP_ID?: string;
    readonly VITE_FIREBASE_USE_EMULATORS?: string;
    readonly VITE_REGISTRATION_ENABLED?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
