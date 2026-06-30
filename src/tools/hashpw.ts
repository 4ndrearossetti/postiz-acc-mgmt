// Generate a Postiz-compatible bcrypt hash for ADMIN_PASSWORD_HASH.
//   node dist/tools/hashpw.js 'your-password'
import { hashPassword } from '../hash';

const pw = process.argv[2];
if (!pw) {
  // eslint-disable-next-line no-console
  console.error("usage: node dist/tools/hashpw.js '<password>'");
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log(hashPassword(pw));
