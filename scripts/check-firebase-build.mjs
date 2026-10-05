const env = process.env;
const errors = [];
if (env.VITE_DEMO) errors.push('Vercel must not define VITE_DEMO, even as false.');
if (env.VITE_DATA_BACKEND && env.VITE_DATA_BACKEND !== 'firebase') errors.push('Vercel requires the Firebase backend.');
if (env.VITE_FIREBASE_USE_EMULATORS === 'true') errors.push('Emulators are local-only.');
for (const key of ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID']) {
  if (!env[key]?.trim()) errors.push(`Missing public configuration: ${key}`);
}
if (env.VITE_FIREBASE_PROJECT_ID?.startsWith('demo-')) errors.push('A real Spark project is required for Vercel.');
if (env.VERCEL_ENV) {
  if (!env.FIREBASE_PRODUCTION_PROJECT_ID) errors.push('Define FIREBASE_PRODUCTION_PROJECT_ID to enforce environment separation.');
  else if (env.VERCEL_ENV === 'production' && env.VITE_FIREBASE_PROJECT_ID !== env.FIREBASE_PRODUCTION_PROJECT_ID) errors.push('Production project ID mismatch.');
  else if (env.VERCEL_ENV !== 'production' && env.VITE_FIREBASE_PROJECT_ID === env.FIREBASE_PRODUCTION_PROJECT_ID) errors.push('Preview/development must not write to production.');
}
if (errors.length) {
  console.error(`Firebase build rejected:\n${errors.map(error => `- ${error}`).join('\n')}`);
  process.exit(1);
}
console.log('Firebase Spark public configuration and environment isolation validated. No cloud services activated.');
