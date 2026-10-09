export interface Entry { date: string; iso: string; slug?: string; version: string; title: string; summary: string; groups: { tag: 'New' | 'Improved' | 'Fixed'; items: string[] }[] }

// Newest first.
export const entries: Entry[] = [
  {
    date: 'October 9, 2026',
    iso: '2026-10-09',
    slug: 'trust-update',
    version: 'Trust',
    title: 'Trust: tamper-evident audit log, nightly encrypted-at-rest backups, weekly security scans, TLS 1.2+',
    summary: 'We hardened the platform behind albena.ai and re-scored our public control mapping against the evidence we hold today. This is our own assessment, not an audit or certification.',
    groups: [
      { tag: 'New', items: [
        'Tamper-evident audit log: each record is hash-chained to the previous one so changes can be detected.',
        'Nightly backups to private storage that is encrypted at rest, with SHA-256 checksums, 35-day retention and weekly verification.',
        'Weekly automated security scans of our code and live site.',
        'A live backup indicator and a refreshed control mapping on the Trust center.',
      ] },
      { tag: 'Improved', items: [
        'HTTPS only with HSTS preload and TLS 1.2 or newer, plus a strict content security policy.',
      ] },
    ],
  },
  {
    date: 'October 9, 2026',
    iso: '2026-10-09',
    slug: 'hardware-editions',
    version: 'Announcement',
    title: 'Albena Hub editions announced (Mac, NVIDIA)',
    summary: 'Albena will be available with hardware: a Hub for Mac and a Hub for NVIDIA, plus bring-your-own and estate installs.',
    groups: [
      { tag: 'New', items: [
        'Albena Hub for Mac (Apple silicon) and Albena Hub for NVIDIA RTX, announced for early access. Pricing and availability will follow.',
        'New Hardware and Pricing pages, with a waitlist that can record which edition you want.',
        'Albena Voice room satellites are planned for later.',
      ] },
    ],
  },  {
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
