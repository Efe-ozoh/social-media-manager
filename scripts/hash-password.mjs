// Generates the value for ALLOWED_LOGIN.
// Usage: npm run hash-password -- "your password"
//        (or pipe it: echo "your password" | npm run hash-password)
import { randomBytes, scryptSync } from "node:crypto";
import { stdin } from "node:process";

const KEY_LENGTH = 64;

function toHash(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function readStdin() {
  if (stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim() || null;
}

const fromArgs = process.argv.slice(2).join(" ").trim();
const password = fromArgs || (await readStdin());

if (!password) {
  console.error('Usage: npm run hash-password -- "your password"');
  process.exit(1);
}

console.log(toHash(password));
