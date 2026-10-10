# SEO and AEO keyword map

Method: no paid tools. Keywords come from (1) product facts on the site, (2) competitor framing in `docs/competitive.md`, (3) the phrasing people use when asking AI answer engines. Volume and difficulty are not measured; treat priority as editorial judgment and re-check with Search Console data after four to six weeks (see `docs/seo-runbook.md`).

Last updated 2026-10-09.

## Primary keywords -> page

| Primary keyword (intent) | Page | Notes |
|---|---|---|
| private home AI assistant | `/` | Title and H2 "What does a private home AI assistant do?" |
| local AI assistant that runs on Mac | `/hardware`, `/faq` | Hub for Mac, Bring Your Own on Apple silicon |
| self-hosted AI assistant NVIDIA | `/hardware`, `/faq` | Hub for NVIDIA, RTX, Linux |
| AI assistant that controls Home Assistant | `/connectors`, `/faq` | Home Assistant is a named connector |
| personal AI with approvals / human in the loop | `/how-it-works`, `/features` | Approval gate, PIN, change record, audit log |
| alternative to Alexa privacy local | `/compare`, `/faq` | Neutral; names what Albena does not replace |
| on-device AI assistant for estates / small business | `/pricing`, `/hardware` | Pro / Estate install, NVIDIA multi-user |
| Albena vs Aldena / Home Assistant Assist | `/compare` | Branded comparison queries |
| Albena pricing / Albena Hub | `/pricing`, `/hardware` | No prices; PreOrder availability only |

## Secondary keywords

local-first AI, voice assistant that works offline, AI home hub, Mac mini AI assistant, RTX home AI server, MCP server connector for assistant, REST API connector, smart home AI Hue WiZ Nest, AI audit log rollback, memory you can delete, no cloud voice assistant, household permission tiers, SOC 2 aligned (never "certified"), Apple on-device intelligence assistant.

## User questions -> where answered

Answer-first versions live in `web/src/data/faq.ts` (single source for `/faq`, FAQPage schema and `llms-full.txt`).

| Question | Page / anchor |
|---|---|
| What is a private home AI assistant? | `/faq#basics` |
| Can I run an AI assistant locally on a Mac? | `/faq#hardware` |
| Can I self-host an AI assistant on NVIDIA? | `/faq#hardware` |
| Does it work with Home Assistant? | `/faq#home`, `/connectors` |
| How is it different from Home Assistant Assist? | `/compare`, `/faq#home` |
| Does it ask before acting? | `/faq#control`, `/how-it-works` |
| Is it a privacy alternative to Alexa? | `/compare`, `/faq#compare` |
| How is it different from ChatGPT/Claude/Gemini? | `/compare` |
| Does it need internet? | `/faq#hardware` |
| How much does it cost / when can I buy? | `/pricing`, `/faq#plans` |
| Is it certified? | `/trust`, `/faq#plans` |
| Can it run an estate or small business? | `/pricing`, `/faq#plans` |

## Page targets (title <= 60 incl. suffix, description <= 155)

Enforced by `web/scripts/seo-check.mjs` in CI. See each page's `<Base title=... description=...>`.

## Guardrails

No invented prices, ratings, reviews, certifications or social profiles. Statements about other products must cite a public source on `/compare` and carry a verification date.
