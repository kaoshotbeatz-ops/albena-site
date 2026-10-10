# Connectors

Connectors are how Albena reaches the other things you use: your lights, your calendar, Slack, GitHub, cloud accounts and more. The full list is on the **Connectors** page of the portal.

## What the portal sees

For each connector on your Hub, the portal shows only:

- the connector name (or a short label you gave to your own MCP or REST connection)
- its state: **Connected**, **Needs attention** or **Off**
- its access level: **Read** (Albena can look) or **Write** (Albena can propose changes, and you approve them)
- roughly how long ago it was last used, in whole hours

That is all. The portal never receives passwords, tokens, API keys, OAuth codes, web addresses, host names, IP addresses or e-mail addresses for your connectors. Labels that look like an address are rejected on the Hub's side and are never stored. Your Hub's credentials stay on your Hub.

Staff who help you with support can see the same read-only list. They cannot change a connector, and each view is logged.

## How to connect today

Connecting happens on your Hub:

1. Open Albena on your Hub.
2. Choose the connector and follow the prompts. Most use a sign-in on the provider's own page, or a key you paste into the Hub, not into the portal.
3. Within a few minutes the connector appears here with its state.

A "Connect" button in the portal is planned for a later phase. It will keep the same rule: credentials go straight to your Hub, never through the portal.

## What the states mean

- **Connected**: the Hub reached the service on its last check.
- **Needs attention**: the sign-in expired or the service did not answer. Open your Hub and reconnect it.
- **Off**: set up, but turned off.
- **Not set up**: this Hub has not reported this connector.

If a Hub is offline, the page shows what it last reported.

See also [Privacy](privacy.md) and [Security](security.md).
