import 'dotenv/config';
import crypto from 'node:crypto';
import { sql } from './client.js';
import { hash } from '../lib/auth.js';

/* One-off admin credential reset (there is no password-reset flow yet, and
   seed.js deliberately leaves an existing admin alone).

   ADMIN_EMAIL=admin@marketedge.com ADMIN_PASSWORD='NewSecret!123' npm run reset-admin

   Updates the existing user's password (and re-activates the account), or
   creates the admin user when the email is missing. */

const email = (process.env.ADMIN_EMAIL || 'admin@marketedge.com').toLowerCase();
const pw = process.env.ADMIN_PASSWORD;
if (!pw || pw.length < 8) {
  console.error('Set ADMIN_PASSWORD (min 8 characters).');
  process.exit(1);
}

const [existing] = await sql`select id from users where email = ${email}`;
const passwordHash = await hash(pw);
if (existing) {
  await sql`update users set password_hash = ${passwordHash}, role = 'admin', status = 'active' where id = ${existing.id}`;
  console.log(`[reset-admin] password updated for ${email}`);
} else {
  await sql`insert into users (email, password_hash, first_name, last_name, role, referral_code)
    values (${email}, ${passwordHash}, 'Platform', 'Admin', 'admin',
            ${crypto.randomBytes(4).toString('hex').toUpperCase()})`;
  console.log(`[reset-admin] admin created: ${email}`);
}
await sql.end();
