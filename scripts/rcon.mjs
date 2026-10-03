import rconClient from 'rcon-client';
import { pathToFileURL } from 'node:url';

export async function connectRcon() {
  return rconClient.Rcon.connect({ host: '127.0.0.1', port: 25575, password: 'local-mcrl-only', timeout: 10000 });
}

export async function sendCommands(commands) {
  const client = await connectRcon();
  try {
    const responses = [];
    for (const command of commands) responses.push({ command, response: await client.send(command) });
    return responses;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const commands = process.argv.slice(2);
  if (!commands.length) throw new Error('Usage: node scripts/rcon.mjs "command" ["command"]');
  for (const result of await sendCommands(commands)) console.log(JSON.stringify(result));
}
