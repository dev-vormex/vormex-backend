import { readImplementationFile as readFileSync } from './implementation-source';
import { join } from 'node:path';

export function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

/** Inspect the implementations now that realtime handlers have separate owners. */
export function realtimeSource(): string {
  return [
    'src/realtime/context.ts',
    'src/realtime/content-fanout.ts',
    'src/realtime/server.ts',
    'src/realtime/handlers/agent.handlers.ts',
    'src/realtime/handlers/posts.handlers.ts',
    'src/realtime/handlers/chat.handlers.ts',
    'src/realtime/handlers/groups.handlers.ts',
    'src/realtime/handlers/reels.handlers.ts',
    'src/realtime/handlers/stories.handlers.ts',
    'src/realtime/handlers/location.handlers.ts',
    'src/realtime/register-handlers.ts',
  ]
    .map(readSource)
    .join('\n');
}
