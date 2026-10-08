import { createDb } from './db.js';
import { createApp } from './app.js';
import { seed } from './seed.js';

const db = await createDb();
const { app, svc } = createApp(db);
if (process.env.SEED !== '0') await seed(db);

const timer = setInterval(() => svc.applySchedules().catch((e) => console.error('schedule apply failed', e)), 30_000);
timer.unref();
await svc.applySchedules();

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`kimidoko listening on http://localhost:${port}`));
