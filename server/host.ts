import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION, PORT, ROOT } from './env.ts';
import { computerStatus } from './computer/e2b.ts';

/**
 * The two machines behind BLOBS, reported side by side for the Integrations
 * page:
 *
 *   host     — where BLOBS itself runs. The deploy script (scripts/daytona.ts)
 *              leaves a .daytona.json beside the app, so the app can name its
 *              sandbox and public URL without holding a Daytona API key.
 *   computer — the E2B machine BLOBS drives through its tools.
 *
 * The host is only ever reported as the machine answering this request. There
 * is no pretending to know more about the sandbox than its own process can see.
 */

const DAYTONA_STATE = path.join(ROOT, '.daytona.json');
const DAYTONA_DASHBOARD = 'https://app.daytona.io/dashboard/sandboxes';
const E2B_DASHBOARD = 'https://e2b.dev/dashboard';

export type MachineState = 'running' | 'local' | 'connected' | 'disabled' | 'disconnected';

export interface MachineLink {
  label: string;
  url: string;
}

export interface MachineStatus {
  key: 'host' | 'computer';
  name: string;
  provider: string;
  state: MachineState;
  id: string | null;
  detail: string;
  links: MachineLink[];
}

interface DaytonaState {
  sandboxId?: string;
  url?: string;
  updatedAt?: string;
}

function readDaytonaState(): DaytonaState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(DAYTONA_STATE, 'utf8')) as DaytonaState;
    return parsed.sandboxId ? parsed : null;
  } catch {
    return null;
  }
}

function hostMachine(): MachineStatus {
  const deployed = readDaytonaState();
  const links: MachineLink[] = [];
  if (deployed?.url) links.push({ label: 'Open public URL', url: deployed.url });
  links.push({ label: 'Daytona sandboxes', url: DAYTONA_DASHBOARD });

  if (deployed) {
    const when = deployed.updatedAt ? new Date(deployed.updatedAt) : null;
    const deployedNote = when && !Number.isNaN(when.getTime())
      ? ` Last deployed ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
      : '';
    return {
      key: 'host',
      name: 'Host machine',
      provider: 'Daytona',
      state: 'running',
      id: deployed.sandboxId ?? null,
      detail:
        `Serving BLOBS ${APP_VERSION} on port ${PORT} from a Daytona sandbox. Idle auto-stop is disabled, and the ` +
        `sandbox disk holds the database, workspace and encrypted integration keys.${deployedNote}`,
      links,
    };
  }

  return {
    key: 'host',
    name: 'Host machine',
    provider: 'Daytona',
    state: 'local',
    id: null,
    detail:
      `BLOBS ${APP_VERSION} is running on this machine, not on the Daytona deploy script. Run ` +
      'npm run deploy:daytona to move it to a sandbox that does not idle-stop; the app then reports that sandbox here.',
    links,
  };
}

async function computerMachine(): Promise<MachineStatus> {
  const computer = await computerStatus();
  const state: MachineState = computer.configured
    ? 'connected'
    : computer.hasKey
      ? 'disabled'
      : 'disconnected';

  return {
    key: 'computer',
    name: 'AI computer',
    provider: 'E2B',
    state,
    id: computer.sandboxId ?? computer.desktopId ?? null,
    detail: computer.detail,
    links: [{ label: 'E2B dashboard', url: E2B_DASHBOARD }],
  };
}

export async function machinesStatus(): Promise<{ items: MachineStatus[] }> {
  return { items: [hostMachine(), await computerMachine()] };
}
