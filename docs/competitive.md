*Data checked October 9, 2026. Albena details are based on the product brief and current site source, including [home](web/src/pages/index.astro), [architecture](web/src/pages/how-it-works.astro), [connectors](web/src/pages/connectors.astro), [privacy](web/src/pages/privacy.astro), and [roadmap](web/src/pages/roadmap.astro).*

## 1. Positioning statement

Albena is the owner-controlled personal AI for people who want one natural, voice-first assistant across their home, work, media, devices, and private infrastructure without turning their life into another cloud workspace. She runs on hardware you own, prefers local models and Apple on-device intelligence, asks before sending or changing anything, applies stronger PIN-and-change-record controls to risky actions, and keeps memory visible and deletable. Where Aldena organizes cloud AI workers around client delivery and the largest assistants optimize for broad convenience inside their own ecosystems, Albena’s category is different: a personal operating layer for your whole digital life, with cloud intelligence available only when you permit it.

## 2. Comparison

“Big cloud assistants” below means the broad category represented by products such as ChatGPT, Claude, Gemini, and Copilot. Exact capabilities vary by product, plan, region, and administrator settings.

| Dimension | Albena | Aldena | Big cloud assistants |
|---|---|---|---|
| **Primary job** | Personal and household assistant spanning home, media, work, and owned infrastructure | Cloud AI workforce for founders and agencies, organized into project/client rooms | General conversation, research, content creation, and work productivity |
| **Privacy and locality** | Local-first on the owner’s hardware; cloud models are optional and policy-controlled | Cloud service; each room has isolated compute, credentials, integrations, and memory | Primarily provider-hosted. Apple is an important adjacent exception, combining on-device processing with Private Cloud Compute. [Apple privacy](https://www.apple.com/privacy/features/) |
| **Voice** | Core identity: “Hey Albena,” designed for across-the-room conversation | Primarily a visual project/workforce interface; public materials do not present ambient voice as a core feature | Often polished voice experiences, particularly on phones and provider-supported devices. [ChatGPT Voice](https://help.openai.com/en/articles/20001274/) |
| **Smart home** | Broad first-party focus: Home Assistant, Hue, WiZ, Nest, TVs, cameras, and household routines | Not positioned for household or smart-home control | Varies. Alexa, Siri, and Gemini have native ecosystem reach; general chat assistants are less unified. Home Assistant Assist is the strongest local specialist and can run entirely on owned hardware. [Home Assistant Assist](https://www.home-assistant.io/voice_control/) |
| **Work connectors** | Broad cross-vendor set including Google Workspace, Teams, Slack, Jira, ServiceNow, GitHub, LinkedIn, and Meta | Ten public account connectors, including GitHub, Bitbucket, Gmail, Drive, Jira, Linear, Notion, Sentry, Slack, and Vercel. [Aldena integrations](https://aldena.ai/integrations) | Frequently strong inside the vendor’s own ecosystem; cross-vendor breadth and write support vary. Microsoft, for example, publishes more than 100 Copilot connectors. [Microsoft overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview-copilot-connector) |
| **Approvals and audit** | Every state-changing action requires approval; risky actions add a PIN, change record, validation, rollback information, and full audit trail | Per-tool allow, ask, or deny policies; work can pause for review, and agents do not merge their own pull requests. [Aldena approval gates](https://aldena.ai/features/human-in-the-loop) | Product-dependent. Consumer assistants generally expose less uniform, cross-system change governance; enterprise offerings may provide substantial administrative and compliance controls |
| **Memory control** | Owner can inspect and delete personal memory; stored locally first | Private per-agent memory plus shared room memory; entries are visible and correctable. [Aldena memory](https://aldena.ai/features/agent-memory) | Improving but variable. ChatGPT lets users review and delete memories, although saved memories and original chats are managed separately. [ChatGPT memory](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) |
| **Customization** | Local/cloud model routing, owner hardware, configurable connectors, REST/MCP extension, household permissions | Selectable models, agent roles, hierarchy, room tools, technologies, skills, and remote MCP servers | Usually custom instructions, projects, agents, extensions, or vendor marketplaces; self-hosted runtime control is limited |
| **Multi-agent** | Capable of governed specialist agents, but the public site does not yet make an Albena team, roster, or delegation view legible | A major strength: 11 named roles and a live hierarchical org chart with visible delegation. [Roster](https://aldena.ai/agent), [org chart](https://aldena.ai/features/org-chart) | Increasingly available, particularly in enterprise agent builders, but often separate from the core personal-assistant experience |
| **Pricing model** | Not yet published; early-access waitlist. This is a current commercial weakness | Starter $99 and Business $249 per active member/month after a card-required 14-day trial; model and server usage use prepaid credits, with a 10% top-up fee. [Aldena pricing](https://aldena.ai/pricing) | Commonly free plus subscription tiers; business plans may add per-seat or usage charges |
| **Lock-in and portability** | Potentially low if Albena publishes export, backup, connector, and model-portability guarantees; those guarantees need to be explicit | Rooms are built around Aldena-hosted orchestration and servers, although models and external tools are selectable | Typically tied to provider accounts, hosted memory, proprietary experiences, and ecosystem-specific connectors |
| **Compliance posture** | Strong control design and a public trust center, but current roadmap says control evidence is incomplete and a formal third-party audit is not yet scheduled | Publishes privacy and isolation practices; says customer content is not used for model training. [Aldena privacy](https://aldena.ai/privacy) | Enterprise leaders have the strongest mature certifications, legal packages, admin controls, and procurement readiness |
| **Offline operation** | Meaningful local operation is a core promise; connector-dependent actions still require their services and network | No meaningful offline proposition; work runs in cloud rooms and uses hosted models/services | Generally network-dependent. Apple supports substantial on-device processing, while Home Assistant Assist supports fully local voice pipelines. [Apple](https://www.apple.com/privacy/features/), [Home Assistant](https://www.home-assistant.io/voice_control/voice_remote_local_assistant) |

Albena’s strongest white space is the intersection of **local personal AI + natural voice + home and work reach + change governance**. Its present weaknesses are commercial and presentational: early-access status, unpublished pricing, incomplete independent assurance, an unfinished native-app story, and no visible multi-agent experience comparable to Aldena’s roster and live org chart.

## 3. Top 10 product and site improvements

| # | Improvement | Effort | Concrete result |
|---:|---|:---:|---|
| 1 | **Publish `/compare` and category-specific comparison pages** | S | Launch `/compare`, `/compare/aldena`, `/compare/chatgpt`, `/compare/home-assistant`, and `/compare/apple-intelligence`. Use dated, linked facts and a visible “last verified” field. |
| 2 | **Publish simple, honest pricing** | M | Offer a predictable base subscription, a household tier, and a self-hosted/bring-your-own-model option. Show hardware, optional cloud-model, and connector costs separately. Avoid surprise token billing. |
| 3 | **Turn the homepage mockup into a live, safe demo** | M | Let visitors try a sandbox household: ask by voice, inspect a proposed action, approve it, and open its audit entry. Provide a prerecorded fallback when microphone access is declined. |
| 4 | **Make “Albena Team” a visible product surface** | L | Present named specialists such as Home, Calendar, Media, Research, Estate, and Security under Albena’s direction. Show delegation and provenance without pretending they are employees. This closes Aldena’s clearest presentation advantage. |
| 5 | **Ship an owner-visible privacy and routing console** | M | For every request, show which device/model handled it, what data was used, whether anything left the home, estimated cloud cost, and the policy responsible for that decision. |
| 6 | **Publish an Albena model and voice leaderboard** | M | Benchmark local and optional cloud models on Albena-specific jobs: wake-word accuracy, latency, home-control reliability, tool-call success, privacy class, hardware requirement, and cost. Do not reuse generic benchmark scores as product proof. |
| 7 | **Productize memory governance** | M | Add search, source attribution, edit/delete, expiration, export, “never remember this,” household visibility boundaries, and a memory activity history. Include one-click encrypted backup and restore. |
| 8 | **Complete the mobile approval loop** | L | Prioritize the roadmap’s iPhone and Mac apps, with signed action cards, biometric/PIN approval, clear diff/impact, timeout, denial reason, completion evidence, and rollback status. |
| 9 | **Convert the trust center from claims to evidence** | L | Publish control owners, implementation state, evidence dates, retention tables, subprocessor/model-routing disclosures, security contact, vulnerability policy, backup/restore tests, and an independent assessment roadmap. Do not imply certification before it exists. |
| 10 | **Create a connector proof catalog** | M | Give every connector a page showing available reads/writes, required permissions, local versus cloud data flow, approval level, last verification date, screenshots, and tested recipes. Add a public connector status page and a clear REST/MCP developer guide. |

The highest-leverage sequence is **compare page → pricing → interactive approval demo → connector proof pages → routing transparency**. Those five changes would make Albena’s existing differentiation understandable before the larger product work lands.

## 4. Proposed `/compare` page copy

```markdown
---
title: "Compare Albena"
description: "See how Albena’s local-first personal AI approach compares with cloud assistants, AI workforce platforms, and smart-home voice assistants."
---

# One assistant. Your home, your work, your rules.

Most AI products begin in one of three places:

- a cloud chat window;
- a workplace full of AI agents; or
- a voice controller for one device ecosystem.

Albena begins with you.

She is personal AI designed to run on hardware you own, use local models and
Apple on-device intelligence where they fit, and reach the cloud only under
the policy you choose. She can help across your home, media, work, devices,
and private systems without treating every request as permission to act.

[Join early access](/waitlist) [See how Albena works](/how-it-works)

## The short version

| | Albena | Cloud assistants | AI workforce platforms | Smart-home assistants |
|---|---|---|---|---|
| Runs on your hardware | Yes, local-first | Usually no | Usually no | Sometimes |
| Natural voice | Core experience | Common | Not usually the focus | Core experience |
| Home and media control | Broad focus | Ecosystem-dependent | Not their focus | Strong |
| Work and IT connectors | Broad, cross-vendor | Varies by product | Strong for business workflows | Limited |
| Approval before changes | Yes | Varies | Often configurable | Varies |
| Risky-action change record | Yes | Not generally a consumer feature | Product-dependent | Not generally |
| Memory you can inspect and delete | Yes | Increasingly available | Often workspace- or agent-scoped | Varies |
| Offline capability | Yes, for supported local functions | Limited | Limited | Available in some local systems |
| Bring your own REST or MCP connector | Yes | Product-dependent | Available in some platforms | Usually developer-oriented |

Capabilities change quickly. This page describes public product information
available on October 9, 2026. Follow the source links for current details.

## Albena and Aldena solve different problems

The names are similar. The products are not.

Aldena describes itself as an AI workforce for founders and agencies. Its
agents work in isolated project rooms with their own server, connectors, and
memory. Customers can arrange 11 predefined roles into a visible reporting
hierarchy, apply per-tool approval policies, and pay per active member plus
prepaid model and server usage.

Albena is a personal assistant for an individual, household, or owner-operated
business. Her center of gravity is natural voice, local execution, smart-home
and media control, personal memory, and governed access to the many systems
one person relies on.

Choose Aldena when the job is staffing cloud project rooms with specialized
software-delivery agents.

Choose Albena when the job is giving one trusted assistant governed reach
across your real life and the systems you own.

Sources:
[Aldena product](https://aldena.ai/),
[agent roster](https://aldena.ai/agent),
[isolated rooms](https://aldena.ai/features/isolated-rooms),
[approval controls](https://aldena.ai/features/human-in-the-loop),
[pricing](https://aldena.ai/pricing).

## Albena and the large cloud assistants

ChatGPT, Claude, Gemini, and Copilot offer powerful models, polished
applications, and rapidly expanding integrations. They are often the best
choice when you want immediate access to frontier cloud intelligence or need
deep integration with one provider’s productivity ecosystem.

Albena does not need to pretend those models are weak. When your policy permits
it, a cloud model can be one of the tools she uses.

The difference is who controls the operating layer. Albena is designed to:

- handle suitable requests on your own hardware;
- tell you when a request needs the cloud;
- minimize what leaves your environment;
- keep personal memory visible and deletable;
- ask before sending, changing, purchasing, unlocking, publishing, or
  administering anything; and
- record what was proposed, approved, executed, and verified.

Cloud assistants have important privacy controls of their own. For example,
ChatGPT documents memory-management controls, and Apple combines on-device
processing with Private Cloud Compute. Albena’s distinction is bringing local
models, optional cloud models, personal systems, and explicit change governance
into one owner-controlled assistant.

Sources:
[ChatGPT memory controls](https://help.openai.com/en/articles/8590148-memory-in-chatgpt),
[ChatGPT Voice](https://help.openai.com/en/articles/20001274/),
[Apple Intelligence privacy](https://www.apple.com/privacy/features/),
[Microsoft Copilot connectors](https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/overview).

## Albena and Home Assistant Assist

Home Assistant Assist is an excellent choice for private smart-home voice
control. It can run a fully local speech pipeline, supports owned voice
hardware, and can connect to local or cloud conversation models.

Albena is broader by design. Home Assistant can be one of her most important
connectors, while Albena also coordinates calendars, mail, collaboration
tools, media libraries, source control, cloud platforms, identity systems, and
personal memory under the same approval and audit model.

Choose Assist when your primary goal is an open, local voice interface for
Home Assistant.

Choose Albena when you want the home to be one part of a wider personal
assistant.

Sources:
[Home Assistant Assist](https://www.home-assistant.io/voice_control/),
[fully local voice setup](https://www.home-assistant.io/voice_control/voice_remote_local_assistant).

## What Albena can connect

Albena’s current connector set spans:

- **Home:** Home Assistant, Hue, WiZ, Nest, TVs, and cameras
- **Media:** Jellyfin, Navidrome, Immich, and YouTube
- **Work:** Google Workspace, Teams, Slack, Jira, ServiceNow, GitHub,
  LinkedIn, and Meta
- **Cloud and IT:** AWS, Azure, Cloudflare, VMware, Docker, Kubernetes,
  Tailscale, AdGuard, AD/LDAP, SSO, and Apple devices
- **Your systems:** bring a REST API or MCP server

A connector does not mean unlimited permission. Each integration should show
what Albena may read, what she may propose, and which actions require approval.

[Browse connectors](/connectors)

## Approval is part of the architecture

Albena separates understanding from authority.

1. You ask naturally.
2. Albena gathers the information she is allowed to read.
3. If no state will change, she answers.
4. If an action would change something, she shows you the proposed action.
5. You approve or decline it.
6. High-risk actions also require a change record and PIN.
7. Albena records the result, validation evidence, and rollback information.

Approval is for the specific action in front of you. It is not a blank cheque
for future changes.

[See the approval architecture](/how-it-works)
[Review our controls](/trust/controls)

## Memory should be inspectable

Albena may remember the people, preferences, routines, and decisions that make
her useful. You can inspect that memory, correct it, delete one item, or remove
it all.

Nightly learning follows the same rule: Albena may propose an improvement, but
the owner decides whether it becomes a change.

[Read the privacy policy](/privacy)

## Where Albena is still growing

Albena is in early access. We are still completing:

- native iPhone and Mac experiences;
- mobile notifications and approvals;
- published pricing;
- additional first-party connectors;
- complete control evidence; and
- independent security and accessibility assessments.

We publish those gaps because trust requires more than a polished demo.

[See the roadmap](/roadmap)
[Read the changelog](/changelog)

## Which assistant is right for you?

Choose a large cloud assistant if you want immediate frontier-model access and
its provider ecosystem matters more than local operation.

Choose an AI workforce platform if you want multiple cloud agents organized
around business projects and delivery roles.

Choose a smart-home assistant if voice control of household devices is the
main job.

Choose Albena if you want one personal assistant across home and work, running
locally where possible, reaching the cloud only when permitted, and asking
before anything changes.

## Meet Albena

Your AI. Your systems. Your approval.

[Join the early-access waitlist](/waitlist)
```

This positioning avoids claiming that Albena has better models than the model providers or better home automation than Home Assistant. It makes the defensible claim: Albena unifies those capabilities under an unusually strong owner-control model.