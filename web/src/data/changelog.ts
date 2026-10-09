export interface Entry { date: string; iso: string; version: string; title: string; summary: string; groups: { tag: 'New' | 'Improved' | 'Fixed'; items: string[] }[] }

// Newest first.
export const entries: Entry[] = [
  {
    date: 'October 9, 2026',
    iso: '2026-10-09',
    version: 'Early access',
    title: 'Albena early access and the new albena.ai',
    summary: 'Albena opens to early access, and albena.ai is rebuilt around what she does, how she works and what you can verify about her.',
    groups: [
      { tag: 'New', items: [
        'Early-access waitlist, with invitations in small groups.',
        'Connectors for smart home, media, work tools, cloud and IT, plus bring-your-own for any REST API or MCP server.',
        'Approval model: reads are instant, changes need your approval, high-risk actions need a change record and PIN, with a full audit log.',
        'Trust center with security practices, control-framework status and a public control mapping.',
        'Support center with searchable FAQ and a contact form.',
        'Roadmap board and this changelog.',
      ] },
      { tag: 'Improved', items: [
        'The site is now fully self-hosted for fonts and scripts, with a strict content security policy.',
        'Accessibility pass against WCAG 2.2 AA, including reduced-motion support.',
      ] },
    ],
  },
];
