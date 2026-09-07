import path from "node:path";
import { UserStore } from "../src/auth";
import { settings } from "../src/settings";
async function main() {
  const args = process.argv.slice(2);
  const name = args[args.indexOf("--username") + 1];
  if (!args.includes("--username") || !name || name.startsWith("--")) throw new Error("Usage: npm run user:add -- --username USER [--admin]");
  let password = process.env.CODEX_WEBUI_PASSWORD;
  if (!password) {
    if (process.stdin.isTTY) throw new Error("Pipe the password through stdin, or set CODEX_WEBUI_PASSWORD for this command only.");
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; if (length > 1024) throw new Error("Password too long"); chunks.push(Buffer.from(chunk)); }
    password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  const users = new UserStore(path.join(settings().dataDir, "users.json")); await users.load();
  const old = users.users.find(u => u.username.toLowerCase() === name.toLowerCase());
  const user = await users.upsert({ id: old?.id, username: name, password, admin: args.includes("--admin") });
  console.log(JSON.stringify(user)); console.log("Restart the WebUI if it is already running; CLI updates are loaded at startup.");
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
