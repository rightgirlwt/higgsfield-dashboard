import { createDb } from './index';
import { migrate } from './migrations';

(async () => {
  const db = await createDb();
  const n = await migrate(db);
  console.log(`Applied ${n} migration(s).`);
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
