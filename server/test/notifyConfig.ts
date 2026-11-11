// Levac fork: writes config/levac-notify.json for tests of PVIBot events.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Same place server/lib/fanout.ts reads it from.
export const NOTIFY_CONFIG = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/levac-notify.json`
  : path.join(__dirname, '../../config/levac-notify.json');

export function writeNotifyConfig(eventsUrl?: string) {
  mkdirSync(path.dirname(NOTIFY_CONFIG), { recursive: true });
  writeFileSync(
    NOTIFY_CONFIG,
    JSON.stringify({
      url: 'http://n8n/x',
      key: 'k',
      hermesSecret: 's',
      eventsUrl,
    })
  );
}
