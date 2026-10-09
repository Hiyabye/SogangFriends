// Node >=22.18: native TypeScript stripping; no separate command definitions to drift.
import { COMMANDS } from '../src/discord.ts';

const args = process.argv.slice(2);
const global = args.length === 1 && args[0] === '--global';
const guild = args.length === 2 && args[0] === '--guild' ? args[1] : undefined;
const application = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_TOKEN;
if ((!global && !guild) || (guild && !/^\d+$/.test(guild)) || !application || !/^\d+$/.test(application) || !token) {
  console.error('Usage: DISCORD_APPLICATION_ID=... DISCORD_TOKEN=... npm run register -- --guild GUILD_ID | --global');
  console.error('This replaces all commands in the selected scope. Prefer a test guild. Never put tokens in version control.');
  process.exitCode = 1;
} else {
  const path = guild ? `/applications/${application}/guilds/${guild}/commands` : `/applications/${application}/commands`;
  try {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      method: 'PUT', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(COMMANDS), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { console.error(`Command registration failed (HTTP ${response.status}); no automatic retry.`); process.exitCode = 1; }
    else console.log(`Registered ${COMMANDS.length} commands in ${guild ? 'guild scope' : 'global scope'}.`);
  } catch {
    console.error('Registration result is unconfirmed. Check Discord command state before retrying; no automatic retry performed.');
    process.exitCode = 1;
  }
}
