# albena.ai — public product site (brief from Claude, lead)
Public, unauthenticated marketing page. Topic: Albena (she/her), a personal home/estate AI assistant. Wake phrase "Hey Albena".
Goal: tell visitors who Albena is, what she does today, what's coming, and collect waitlist interest.

## Style
Linear.app-inspired: dark background, subtle purple/indigo gradient glow, crisp sans (Inter), tight type, thin borders, soft card grid, small motion on scroll. Light mode support. Mobile-first, no horizontal scroll.

## Sections
1. Hero: "Meet Albena." + one-line value prop + "Join the waitlist" CTA + mock voice/HUD visual (pure CSS/SVG, no real screenshots).
2. What she does: voice ("Hey Albena"), home & devices, calendar/mail/briefings, memory that learns you, privacy-first local AI.
3. How it works: on-device + local models first, cloud only when needed; you approve every action.
4. Roadmap / What's coming: Now / Next / Later cards (native Albena apps for iPhone/Mac, multi-home estates, more integrations).
5. Privacy promise.
6. Waitlist form (mailto: or static placeholder; no backend yet) + footer © Omar Huertas LLC.

## Hard rules
- NO internal hostnames, IPs, server names (ai5080, dbaomarhuertasllc subdomains, ports), tool names, keys, or infra details. Public-safe only.
- Static: index.html + styles.css + main.js, no build step, no external scripts except Google Fonts.
- Commit to branch feat/site in this repo. Do not deploy.
