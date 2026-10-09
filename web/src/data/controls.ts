import raw from './controls.json';

export type ControlStatus = 'implemented' | 'partial' | 'planned';
export interface Control { id: string; family: string; title: string; framework: string[]; status: ControlStatus; evidence: string }

const STATUSES: ControlStatus[] = ['implemented', 'partial', 'planned'];

// Validate at build time so a bad data drop fails loudly instead of rendering wrong claims.
export const controls: Control[] = (raw as unknown[]).map((r, i) => {
  const c = r as Control;
  if (!c || typeof c.id !== 'string' || typeof c.family !== 'string' || typeof c.title !== 'string'
    || !Array.isArray(c.framework) || !STATUSES.includes(c.status) || typeof c.evidence !== 'string') {
    throw new Error(`controls.json: entry ${i} does not match {id, family, title, framework[], status, evidence}`);
  }
  return c;
});

export const statusLabel: Record<ControlStatus, string> = { implemented: 'Implemented', partial: 'Partial', planned: 'Planned' };
