# chocomelerplan en Firebase Spark

## Restriccion obligatoria

SOLO Firebase Authentication (correo/contrasena) y Cloud Firestore Standard.
No vincular facturacion, cambiar a Blaze, usar Cloud Functions, Cloud Storage,
Cloud Scheduler, backups gestionados, TTL, PITR o servicios de pago. El frontend
mantiene sus recursos estaticos y no admite subida de fotos. Vercel aloja la SPA.
La propuesta inicial de Functions se ha retirado antes de instalar o desplegar
sus dependencias. No hay ningun despliegue ni activacion de servicios cloud.

## Inspeccion

React 19, Vite 7, TypeScript, Tailwind, PWA y monorepo npm client/server/shared.
No se encontraron AGENTS.md. Se preserva trabajo previo de marca, estilos,
espanol, cocina, recetas, comidas y demo. El backend original se conserva.
Sus endpoints no implementan las nuevas penalidades ni campos de cocina.
Las comidas SQL usan upsert que puede sobrescribir almuerzo/cena: Firestore
usa documentos independientes, nunca fusiona ni reemplaza por fecha/tipo.
No se encontro .env activo ni una base PostgreSQL local; no se presupone que
esto descarte datos reales externos.

## Esquema Spark propuesto antes de implementar

Campos snake_case mantienen el contrato de la SPA. La capa de datos convierte
Timestamp -> ISO e importes enteros en centimos -> euros para presentacion.
La pertenencia SIEMPRE se verifica en memberships por las reglas, no en campos
de usuario editables, en localStorage o en un rol enviado por el navegador.

| Ruta | Campos principales |
| --- | --- |
| users/{uid} | name, email, language, week_start_day, dashboard_prefs, active_family_id, created_at. Solo dueno; familia activa exige membership. |
| families/{familyId} | name, timezone=Europe/Madrid, currency=EUR, admin_uid, disabled_modules, created_at, created_by. |
| families/{id}/memberships/{uid} | role=admin/adult/child, member_id opcional, name/email, joined_at, invite_id opcional. Permisos de CUENTAS. |
| families/{id}/members/{id} | name, color, role descriptivo, linked_user_id opcional, deleted_at, created_by/at. PERFILES, incluso sin cuenta. |
| families/{id}/privateProfiles/{id} | Salud, contactos e ingresos de perfiles: lectura/escritura solo adultos. |
| families/{id}/invitations/{randomId} | role=adult/child, member_id opcional, expires_at, used_by/used_at, created_by/at, owner_name. Una sola redencion atomica. |
| families/{id}/tasks/{id} | title, description, category, assigned_to[], due_date local, due_at Timestamp, frequency, occurrence_id, penalty_generated, is_completed, recipe_id, penalty_amount_cents=0/500/1000, created_by/at, completed_by/at, updated_by/at, deleted_at. |
| families/{id}/recipes/{id} | name, ingredients[], instructions[], prep_time, cook_time, category, tags, deleted_at, created_by/at, updated_by/at. Sin subida de imagenes. |
| families/{id}/planningEntries/{id} | family_member_ids[], day_of_week ISO, specific_date, start_time/end_time HH:mm, excluded_dates[], title, schedule_type, created_by/at, updated_by/at. |
| families/{id}/mealPlans/{id} | date YYYY-MM-DD, meal_type=breakfast/combined, recipe_id/custom_meal, notes, created_by/at, updated_by/at. Multiples registros por celda. |
| families/{id}/penalties/{taskId_occurrenceId_memberId} | task_id, occurrence_id, member_id, task_title/member_name/member_color/due_date/due_at instantaneas, amount_cents=500/1000, status=review/pending/forgiven/paid, generated_at/by, reviewed_at/by/name, reason, paid_at/by/name, payment_reason. |
| families/{id}/penaltyTotals/{memberId} | amount_cents pendiente entero, last_penalty_id, updated_at. Actualizacion atomica validada contra la transicion economica. |
| families/{id}/shoppingItems/{id} | name, category, quantity, unit, price_cents, is_checked, created_by/at, updated_by/at. |
| families/{id}/calendarEvents/{id} | title, start_time/end_time locales, family_member_ids, notas, created_by/at, updated_by/at. |
| families/{id}/budgetEntries/{id} | amount_cents entero, date local, category, is_expense, description, created_by/at, updated_by/at. Solo adultos. |
| families/{id}/notes/{id} | content, color, author_uid/name, expires_at, created_by/at. |
| families/{id}/auditEvents/{id} | actor_uid, action, entity_id, created_at. Solo append; validacion contra la operacion referenciada. |

Configuracion de categorias, plantillas y limites se documenta con sus modulos.
Las reglas deniegan por defecto campos/colecciones no reconocidos. No hay
escrituras privilegiadas fuera de las reglas ni SDK administrativo en la app.

## Familias e invitaciones

Crear familia y primer admin es una transaccion: created_by=auth.uid, familia
antes inexistente y membership inicial concordante. El rol de perfil no da
privilegios. Una invitacion porta familyId y un ID criptograficamente aleatorio;
no se permite listar invitaciones a usuarios externos. Obtener una invitacion
exige autenticacion y conocer el enlace. Caduca como maximo en siete dias.
Redimir consume la invitacion y crea membership con exactamente su rol en una
transaccion getAfter; request.time del servidor valida vencimiento y uso unico.
No se permite autoascender, reutilizar un token ni unirse con un ID de familia
sin invitacion. La primera version mantiene una familia activa por cuenta.
La vinculación cuenta/perfil requiere validacion bidireccional en transaccion.

## Penalidades, fechas y permisos

Solo tareas incompletas, con responsable, vencimiento e importe 500/1000 generan
propuesta. Se detectan AL ABRIR la app y al abrir Penalidades; no hay trabajo en
segundo plano ni deteccion si todos los dispositivos estan cerrados. Un adulto
confirma/perdona y registra pago manualmente, sin cobro automatico.
Clave determinista con IDs sin guion bajo; generacion en transaccion. Instantanea
inmutable. Cambios del plazo/responsable/importe no alteran propuestas anteriores
ni generan otra penalidad para la misma ocurrencia. Propuestas obsoletas se
perdonan explicitamente. Antes de completar/editar/eliminar una tarea vencida se
conserva la propuesta de su estado anterior. Nueva ocurrencia = occurrence_id
nuevo, solo tras completar una tarea recurrente. Las reglas verifican esto.

Transiciones permitidas: review -> pending/forgiven; pending -> paid. El revisor,
pagador y sus timestamps coinciden con la cuenta y request.time. Nadie puede
escribir un importe distinto del configurado, cobrar dos veces o borrar historial.
Los totales cambian atomicamente solo por confirmar (+importe) o pagar (-importe).

Fechas sin hora son YYYY-MM-DD, no UTC. Horas semanales son HH:mm locales.
El vencimiento se interpreta en Europe/Madrid; sin hora vence 23:59:59.999.
Las reglas validan la conversion de zona, incluidos cambios DST. Se rechazan
horas inexistentes en marzo y se usa la primera ocurrencia en horas ambiguas
de octubre. Auditoria/revision/pago usan timestamps de servidor.
La primera version admite como maximo tres responsables por tarea para respetar
los limites get/getAfter de reglas; la demo mantiene su comportamiento existente.

## Cuotas y consultas

Spark Firestore: una base gratuita por proyecto, 1 GiB almacenado, 50.000 lecturas,
20.000 escrituras y 20.000 eliminaciones por dia; 10 GiB de salida por mes.
Contadores diarios se restablecen alrededor de medianoche hora del Pacifico.
Al superar cuotas NO se factura sobreconsumo: operaciones pueden bloquearse
hasta el restablecimiento. No es almacenamiento ilimitado. Las lecturas de
reglas dependientes y los listeners tambien consumen cuota.
La capa de datos comparte consultas/cache en memoria, limita resultados,
filtra por rango de fechas cuando procede y cancela listeners sin suscriptores.
No consulta repetidamente toda la familia ni sondea cada 30 segundos en Spark.
Los totales persistidos evitan releer todo el historial para calcular deuda.

## Configuracion real y entornos

Crear proyecto Spark sin Analytics opcional, habilitar correo/contrasena y una
Firestore Standard en modo produccion. Registrar app web y obtener apiKey,
authDomain, projectId, appId PUBLICOS. Guardar localmente en .env.local ignorado,
nunca credenciales administrativas. La consola permite pegar reglas sin CLI.
Proyectos distintos para pruebas y produccion. Emuladores solo para pruebas,
ID ficticio demo-chocomelerplan: NO sustituyen la base persistente real.
Vercel Preview no puede apuntar al projectId de produccion; validar en build.
No se inventara un projectId/config de produccion ni se publicara sin autorizacion.
Firebase Authentication: autorizar el dominio Vercel y dominio personalizado
para acciones de correo. localhost no se incluye por defecto en proyectos
creados desde abril de 2025: usarlo solo en proyecto de pruebas si se necesita.

## Exclusiones Spark

Sin fotos subidas/Storage, Functions, Scheduler, cobros, recordatorios enviados
por servidor, push automatizado, SMTP propio, IA con secretos, integraciones,
feeds/sincronizacion ICS, TTL, backups/PITR gestionados o importacion privilegiada
desde el navegador. No simular exito para una funcion excluida: explicar limite.
No destruir backend PostgreSQL; mantenerlo para rollback y exportacion.

## Migracion de datos reales

Antes: pg_dump completo, ensayo de restauracion, exportacion solo lectura,
conteos y referencias validados. Mapear UUID de cuentas a UIDs reales de Auth
explicitamente; conservar IDs de perfiles/tareas/recetas. Convertir dinero a
centimos enteros y almuerzo/cena a combined conservando AMBOS documentos/IDs.
Archivar Snack sin mostrarlo. La exportacion portable no sustituye pg_dump.
No importar semilla demo ni cuentas/roles/invitaciones desde JSON de cliente.
Ensayar en staging, reconciliar conteos/sumas/referencias y autorizar cada
importacion. No se ha identificado ni importado una base real.

## Fuentes oficiales (2026-10-04)

- https://firebase.google.com/docs/web/setup
- https://firebase.google.com/docs/auth/web/password-auth
- https://firebase.google.com/docs/firestore/quotas
- https://firebase.google.com/docs/firestore/security/rules-conditions
- https://firebase.google.com/docs/firestore/security/rules-fields
- https://firebase.google.com/docs/firestore/security/rules-query
- https://firebase.google.com/docs/firestore/query-data/listen
- https://firebase.google.com/docs/firestore/security/test-rules-emulator
- https://firebase.google.com/docs/emulator-suite/connect_firestore
- https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- https://firebase.google.com/pricing
- https://vercel.com/docs/frameworks/frontend/vite

## Verificaciones y pendientes

Verificado el 2026-10-05, sin confundir mocks/emuladores con persistencia cloud:

- Configuracion publica local de pruebas en client/.env.local, ignorada por Git,
  para el proyecto chocomelerplaner. Demo y emuladores desactivados en este entorno.
- npm run build:shared y npm run build:client completados. Se ajusto el limite
  de precache PWA a 3 MiB porque el bundle con Firebase supera el valor de 2 MiB.
- 47 pruebas de reglas aprobadas en emuladores locales con puertos separados.
- Con autorizacion del usuario, se publicaron SOLO reglas e indices Firestore en
  chocomelerplaner. Base (default), Standard, eur3, freeTier=true.
- Se verifico que las reglas publicadas coinciden con el archivo local y que
  existen los 15 indices remotos. Su disponibilidad final debe comprobarse en
  la consola; no se verifico el estado READY de todos los indices.
- Pantalla de acceso local verificada en navegador sin errores JavaScript.
  No se crearon cuentas ni datos durante estas comprobaciones.

- El usuario registro su cuenta/familia y creo una receta en el proyecto real
  de pruebas. Confirmo que permanecia tras recargar y volver a iniciar sesion;
  sus capturas de Firestore muestran la familia y el documento de receta.
- Produccion europea: chocomelerplan-produccion-eu, base (default), Standard,
  eur3, freeTier=true. Configuracion local en client/.env.production.local,
  ignorada por Git; desarrollo mantiene el proyecto de pruebas separado.
- Con autorizacion del usuario, se publicaron SOLO reglas e indices en el
  proyecto europeo. Se verifico el hash de las reglas activas y las definiciones
  de los 15 indices; todos estaban READY el 2026-10-05 a las 07:02:13 UTC.
- Se repitio la compilacion del cliente con la configuracion europea. El guard
  de Vercel acepta Production europea y Preview de pruebas, y rechaza Preview
  con el proyecto de produccion. No se han configurado esos entornos en Vercel.
- Antes del primer push, se verificaron npm ci y npm run build:vercel desde una
  copia limpia de los archivos preparados para el commit, sin archivos .env
  reales. La configuracion publica se proporciono solo al proceso de build.
- La auditoria de produccion detecto dos avisos de @grpc/grpc-js; se fijo la
  version 1.14.5 mediante overrides, sin degradar Firebase. La auditoria volvio
  a pasar y se repitieron las 47 pruebas de reglas con esa dependencia.
- Las 6 pruebas unitarias/de API demo de penalidades pasaron. No equivalen al
  smoke de navegador pendiente descrito debajo.

Pendiente: acceso y autorizacion Vercel, despliegue de la web, autorizacion de su
dominio en Firebase Auth y verificacion del flujo real en produccion. No se han
importado datos ni desplegado la web en Vercel. El proyecto anterior con base en
Estados Unidos se conserva sin publicar las reglas de esta aplicacion alli.

## Pendientes detectados antes de publicar el repositorio

- Notificaciones y exportacion: la capa Spark consulta notificaciones bajo la
  familia, pero las reglas solo admiten lecturas bajo users/{uid}/notifications.
  Esos flujos requieren corregir la ruta y el contrato antes de declararlos
  operativos; no abrir las reglas familiares para resolver el error.
- El smoke client/scripts/check-penalties-demo.mjs espera DemoBanner, que el
  layout actual no renderiza. Actualizar esa comprobacion antes de usarla como
  evidencia de que la demo funciona.
- Los workflows de releases, Docker, Pages y aplicaciones nativas conservan
  destinos/nombres upstream. No publicar tags ni ejecutar esos despliegues sin
  adaptarlos; no son necesarios para Vercel.
- Vercel debe usar la raiz del repositorio, Node 24.x y variables de entorno
  explicitas. Los archivos .env.local y .env.production.local no se versionan.
