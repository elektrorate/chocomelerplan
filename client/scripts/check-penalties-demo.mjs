import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Run from the repository root: node client/scripts/check-penalties-demo.mjs
const baseURL = new URL(process.env.DEMO_URL || 'http://127.0.0.1:6512');
baseURL.hash = '/';
const channel = process.env.PLAYWRIGHT_CHANNEL || 'msedge';
const recipe = 'Espaguetis a la bolo\u00f1esa'; // Demo recipe r1.
const planning = 'Planificaci\u00f3n semanal';
const reviewName = 'Por revisar';
const pendingName = 'Pendientes de pago';
const historyName = 'Historial';
const errors = [];
let checks = 0;

function pass(message) {
  assert.deepEqual(errors, [], 'Unexpected browser errors');
  checks += 1;
  console.log(`PASS ${String(checks).padStart(2, '0')}: ${message}`);
}

async function hasText(locator, pattern) {
  await locator.filter({ hasText: pattern }).waitFor({ state: 'visible' });
  assert.match(await locator.innerText(), pattern);
}

function section(page, name) {
  return page.getByRole('region', { name, exact: true });
}

function card(page, scope, title) {
  return scope.locator('.card-nexus').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });
}

async function navigate(page, name, mobile) {
  if (mobile) {
    await page.getByRole('button', { name: 'Abrir men\u00fa', exact: true }).click();
  }
  await page.locator('aside').getByRole('link', { name, exact: true }).click();
  await page.locator('main').getByRole('heading', { name, exact: true }).waitFor();
  if (name === 'Penalidades') {
    await page.getByRole('button', { name: 'Actualizar', exact: true }).waitFor();
  } else if (name === 'Cocinar y tareas') {
    await page.getByRole('button', { name: 'Nueva tarea de cocina', exact: true }).waitFor();
  }
}

async function select(page, dialog, current, next) {
  await dialog.getByRole('combobox').filter({ hasText: current }).click();
  await page.getByRole('option', { name: next, exact: true }).click();
  await dialog.getByRole('combobox').filter({ hasText: next }).waitFor();
}

async function counts(page, review, pending, history) {
  await page.waitForFunction(({ review, pending, history }) => {
    return [['penalties-review', review], ['penalties-pending', pending], ['penalties-history', history]]
      .every(([id, count]) => document.getElementById(id)?.parentElement?.lastElementChild?.textContent === String(count));
  }, { review, pending, history });
  for (const [name, count] of [[reviewName, review], [pendingName, pending], [historyName, history]]) {
    const headings = await section(page, name).locator('h3').allTextContents();
    // The pending section also contains the summary heading.
    assert.equal(headings.length, count + (name === pendingName ? 1 : 0), `${name} card count`);
    assert.equal(new Set(headings).size, headings.length, `${name} duplicate entries`);
  }
}

async function totals(page, alex, mia) {
  const pending = section(page, pendingName);
  for (const [name, amount] of [['Alex', alex], ['Mia', mia]]) {
    const row = pending.getByRole('listitem').filter({ hasText: name });
    await hasText(row, new RegExp(`${amount},00\\s*\u20ac`));
  }
  const summary = card(page, pending, 'Total pendiente');
  await hasText(summary.locator('p'), new RegExp(`^${alex + mia},00\\s*\u20ac$`));
}

async function noOldText(page) {
  assert.doesNotMatch(await page.locator('main').innerText(),
    /\b(puntos?|points?|objetivos?|goals?|recompensas?|rewards?|dinero|money|argent)\b/i,
    'Legacy points/goals/money UI must not appear');
}

async function noOverflow(page, label, dialog = false) {
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  const sizes = await page.evaluate(() => {
    const root = document.documentElement;
    const modal = document.querySelector('[role="dialog"]');
    return {
      viewport: root.clientWidth,
      document: root.scrollWidth,
      body: document.body.scrollWidth,
      main: document.querySelector('main')?.getBoundingClientRect().toJSON(),
      dialog: modal ? {
        width: modal.clientWidth,
        scroll: modal.scrollWidth,
        rect: modal.getBoundingClientRect().toJSON(),
      } : null,
    };
  });
  assert.ok(sizes.document <= sizes.viewport + 1 && sizes.body <= sizes.viewport + 1,
    `${label}: horizontal page overflow ${JSON.stringify(sizes)}`);
  assert.ok(sizes.main.left >= -1 && sizes.main.right <= sizes.viewport + 1,
    `${label}: main exceeds viewport ${JSON.stringify(sizes)}`);
  if (dialog) {
    assert.ok(sizes.dialog, `${label}: missing dialog`);
    assert.ok(sizes.dialog.scroll <= sizes.dialog.width + 1
      && sizes.dialog.rect.left >= -1 && sizes.dialog.rect.right <= sizes.viewport + 1,
    `${label}: horizontal dialog overflow ${JSON.stringify(sizes)}`);
  }
}

async function action(page, entry, button, reason, submitName = button, mobile = false) {
  const entryTitle = await entry.getByRole('heading', { level: 3 }).innerText();
  const trigger = entry.getByRole('button', { name: button, exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: submitName, exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('heading', { level: 3 }).innerText(),
    entryTitle, 'Dialog selected the correct entry');
  await dialog.getByRole('textbox', { name: /Motivo .*\(opcional\)/ }).fill(reason);
  const submit = dialog.getByRole('button', { name: submitName, exact: true });
  await submit.scrollIntoViewIfNeeded();
  if (mobile) {
    await noOverflow(page, `${page.viewportSize().width}px ${submitName}`, true);
    const box = await submit.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height + 1,
      'Dialog action scrolls fully into the viewport');
  }
  assert.equal(await submit.isEnabled(), true, 'Action is accessible and enabled');
  await submit.click();
  await dialog.waitFor({ state: 'hidden' });
}

async function datedHistory(entry, paid = false) {
  await hasText(entry.locator('p').filter({ hasText: /^Revisada el / }),
    /^Revisada el \d{1,2} .+ \d{4}, \d{1,2}:\d{2}$/);
  await hasText(entry, /Revisada por: \S+/);
  if (paid) {
    await hasText(entry.locator('p').filter({ hasText: /^Pagada el / }),
      /^Pagada el \d{1,2} .+ \d{4}, \d{1,2}:\d{2}$/);
    await hasText(entry, /Pago registrado por: \S+/);
  }
  assert.doesNotMatch(await entry.innerText(), /Fecha no v\u00e1lida|Sin fecha indicada/);
}

async function seed(page) {
  await counts(page, 2, 2, 2);
  await totals(page, 10, 5);
  await hasText(card(page, section(page, reviewName), 'Recoger la mesa de ayer'), /5,00\s*\u20ac/);
  await hasText(card(page, section(page, reviewName), 'Preparar la ensalada de ayer'), /10,00\s*\u20ac/);
}

async function runFlow(browser, mobile) {
  const label = mobile ? 'Mobile 390x844' : 'Desktop 1440x1000';
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'es-ES',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(`${label} pageerror: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`${label} console.error: ${message.text()} ${JSON.stringify(message.location())}`);
    }
  });
  try {
    await page.goto(baseURL.href, { waitUntil: 'domcontentloaded' });
    await page.locator('main').getByRole('heading', { name: planning, exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '#/planning');
    await page.getByText('Modo demo: los cambios no se guardan y se restablecen al recargar.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Restablecer', exact: true }).waitFor();
    pass(`${label}: fresh / opens weekly planning with visible reset notice`);

    await navigate(page, 'Penalidades', mobile);
    await seed(page);
    await noOldText(page);
    if (mobile) {
      await noOverflow(page, label);
      await page.getByRole('button', { name: 'Abrir men\u00fa', exact: true }).click();
      const menuLink = page.locator('aside').getByRole('link', { name: 'Penalidades', exact: true });
      await menuLink.waitFor();
      assert.equal(await menuLink.locator('svg.lucide-scale').count(), 1, 'Penalty menu has scale icon');
      await menuLink.click();
    }
    pass(`${label}: seed has 2 review, 2 pending, 2 history, total 15 EUR${mobile ? '; menu label/icon and no overflow' : ''}`);

    const title = 'Prueba penalidad cocina';
    const amended = `${title} editada`;
    const yesterday = await page.evaluate(() => {
      const date = new Date();
      date.setDate(date.getDate() - 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    await navigate(page, 'Cocinar y tareas', mobile);
    await page.getByRole('button', { name: 'Nueva tarea de cocina', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Nueva tarea', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('combobox').filter({ hasText: /^Cocinar$/ }).count(), 1);
    await select(page, dialog, 'Seleccionar receta', recipe);
    await dialog.getByRole('textbox', { name: 'T\u00edtulo', exact: true }).fill(title);
    await dialog.locator('input[type="date"]').fill(yesterday);
    await select(page, dialog, 'Sin penalidad', '5 \u20ac');
    await dialog.getByRole('checkbox', { name: 'Alex', exact: true }).check();
    await hasText(dialog, /Sin hora, la tarea vence al terminar el d\u00eda indicado\./);
    if (mobile) await noOverflow(page, `${label} cooking form`, true);
    await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    let task = card(page, page.locator('main'), title);
    await task.waitFor();
    const recipeLink = task.getByRole('link', { name: `Ver receta: ${recipe}`, exact: true });
    await recipeLink.waitFor();
    assert.match(await recipeLink.getAttribute('href'), /recipe=r1$/);
    await hasText(task, /Penalidad: 5 \u20ac/);
    await task.getByText('Alex', { exact: true }).waitFor();
    const displayedDate = await task.getByText(/^Vence:/).innerText();
    assert.match(displayedDate, new RegExp(`^Vence: ${yesterday.slice(8)} .+ ${yesterday.slice(0, 4)}$`));
    await noOldText(page);
    pass(`${label}: created default cooking task with r1, Alex, yesterday and 5 EUR`);

    await task.getByRole('button', { name: `Editar: ${title}`, exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Editar tarea', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.locator('input[type="date"]').inputValue(), yesterday);
    assert.equal(await dialog.locator('input[type="time"]').inputValue(), '');
    assert.equal(await dialog.getByRole('checkbox', { name: 'Alex', exact: true }).isChecked(), true);
    await dialog.getByRole('combobox').filter({ hasText: recipe }).waitFor();
    await dialog.getByRole('textbox', { name: 'T\u00edtulo', exact: true }).fill(amended);
    await select(page, dialog, '5 \u20ac', '10 \u20ac');
    await dialog.getByRole('button', { name: 'Guardar', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    task = card(page, page.locator('main'), amended);
    await task.waitFor();
    await hasText(task, /Penalidad: 10 \u20ac/);
    await task.getByRole('link', { name: `Ver receta: ${recipe}`, exact: true }).waitFor();
    await task.getByText('Alex', { exact: true }).waitFor();
    assert.equal(await task.getByText(/^Vence:/).innerText(), displayedDate);
    pass(`${label}: amended title/10 EUR preserve recipe, responsible and date-only deadline`);

    await navigate(page, 'Penalidades', mobile);
    await counts(page, 3, 2, 2);
    const reviewReason = 'Confirmada durante la prueba de cocina.';
    await action(page, card(page, section(page, reviewName), amended), 'Confirmar penalidad', reviewReason, 'Confirmar penalidad', mobile);
    await counts(page, 2, 3, 2);
    let confirmed = card(page, section(page, pendingName), amended);
    await hasText(confirmed, /10,00\s*\u20ac/);
    await hasText(confirmed, /Responsable: Alex/);
    await hasText(confirmed, /fin del d\u00eda, 23:59/);
    await hasText(confirmed, /Confirmada durante la prueba de cocina\./);
    await datedHistory(confirmed);
    const snapshot = await confirmed.innerText();
    await navigate(page, 'Cocinar y tareas', mobile);
    await page.getByRole('button', { name: `Completar: ${amended}`, exact: true }).click();
    await page.getByRole('button', { name: `Marcar pendiente: ${amended}`, exact: true }).waitFor();
    await navigate(page, 'Penalidades', mobile);
    await counts(page, 2, 3, 2);
    confirmed = card(page, section(page, pendingName), amended);
    assert.equal(await confirmed.innerText(), snapshot, 'Completion must not mutate confirmed snapshot');
    pass(`${label}: confirmation reason/date/end-of-day shown; completed task retains identical penalty snapshot`);

    await action(page, card(page, section(page, reviewName), 'Recoger la mesa de ayer'), 'Perdonar',
      'Perdonada por ayudar con la cena.', 'Perdonar penalidad', mobile);
    await counts(page, 1, 3, 3);
    const forgiven = card(page, section(page, historyName), 'Recoger la mesa de ayer');
    await hasText(forgiven, /Perdonada/);
    await hasText(forgiven, /5,00\s*\u20ac/);
    await hasText(forgiven, /Perdonada por ayudar con la cena\./);
    await datedHistory(forgiven);
    assert.equal(await card(page, section(page, reviewName), 'Recoger la mesa de ayer').count(), 0);
    await action(page, card(page, section(page, reviewName), 'Preparar la ensalada de ayer'),
      'Confirmar penalidad', '', 'Confirmar penalidad', mobile);
    await counts(page, 0, 4, 3);
    await hasText(card(page, section(page, pendingName), 'Preparar la ensalada de ayer'), /Motivo: Sin motivo indicado/);
    await totals(page, 30, 5);
    pass(`${label}: seeded 5 EUR forgiven into history; seeded 10 EUR confirmed without optional reason; Alex 30/Mia 5`);

    const paymentReason = 'Pago manual recibido durante la prueba.';
    await action(page, confirmed, 'Marcar como pagada', paymentReason, 'Marcar como pagada', mobile);
    await counts(page, 0, 3, 4);
    const paid = card(page, section(page, historyName), amended);
    await hasText(paid, /Pagada/);
    await hasText(paid, /Motivo: Confirmada durante la prueba de cocina\./);
    await hasText(paid, /Motivo del pago: Pago manual recibido durante la prueba\./);
    await datedHistory(paid, true);
    await totals(page, 20, 5);
    assert.equal(await card(page, section(page, pendingName), amended).count(), 0);
    pass(`${label}: newly confirmed task paid; history retains both reasons/dates; Alex 20/Mia 5`);

    const beforeRefresh = await page.locator('main section').allTextContents();
    for (let i = 0; i < 3; i += 1) {
      await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
      await page.getByRole('button', { name: 'Actualizar', exact: true }).waitFor();
      await counts(page, 0, 3, 4);
      assert.deepEqual(await page.locator('main section').allTextContents(), beforeRefresh);
    }
    await noOldText(page);
    if (mobile) await noOverflow(page, label);
    pass(`${label}: three refreshes preserve entries/totals without duplicates or legacy UI`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Actualizar', exact: true }).waitFor();
    await seed(page);
    assert.equal(await page.locator('main').getByRole('heading', { name: amended, exact: true }).count(), 0);
    await navigate(page, 'Cocinar y tareas', mobile);
    assert.equal(await card(page, page.locator('main'), amended).count(), 0);
    await page.evaluate(() => { location.hash = '/'; });
    await page.locator('main').getByRole('heading', { name: planning, exact: true }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('main').getByRole('heading', { name: planning, exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '#/planning');
    pass(`${label}: reload restores 2/2/2 and 15 EUR, removes created task and preserves default planning`);

    if (mobile) {
      await navigate(page, 'Penalidades', true);
      await action(page, card(page, section(page, pendingName), 'Limpiar la cocina'),
        'Marcar como pagada', 'Pago desde el movil.', 'Marcar como pagada', true);
      await counts(page, 2, 1, 3);
      const seededPaid = card(page, section(page, historyName), 'Limpiar la cocina');
      await hasText(seededPaid, /Se complet\u00f3 tarde; la penalidad confirmada se conserva\./);
      await hasText(seededPaid, /Motivo del pago: Pago desde el movil\./);
      await hasText(seededPaid, /fin del d\u00eda, 23:59/);
      await datedHistory(seededPaid, true);
      await noOverflow(page, label);
      pass('Mobile 390x844: seeded pending payment dialog, scrolling/button access, history and end-of-day text');

      await page.setViewportSize({ width: 320, height: 844 });
      await noOverflow(page, 'Mobile 320x844 penalties');
      await action(page, card(page, section(page, pendingName), 'Guardar la compra'),
        'Marcar como pagada', 'Pago desde 320px.', 'Marcar como pagada', true);
      await counts(page, 2, 0, 4);
      await hasText(card(page, section(page, historyName), 'Guardar la compra'), /Motivo del pago: Pago desde 320px\./);
      await noOverflow(page, 'Mobile 320x844 after payment');
      await noOldText(page);
      pass('Mobile 320x844: no page/dialog horizontal overflow; seeded payment action remains accessible');
    }
  } finally {
    await context.close();
  }
}

let browser;
try {
  console.log(`Penalties demo smoke: ${baseURL.href} (Chromium channel: ${channel})`);
  browser = await chromium.launch({ headless: true, channel });
  await runFlow(browser, false);
  await runFlow(browser, true);
  assert.deepEqual(errors, [], 'Unexpected browser errors');
  console.log(`PASS: ${checks} smoke checks; no page errors or console errors; no artifacts written.`);
} catch (error) {
  console.error('FAIL: penalties demo smoke verification');
  console.error(error.stack || error);
  for (const browserError of errors) console.error(browserError);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
