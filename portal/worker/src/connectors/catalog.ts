// Connector catalog: the single source of truth for ids the portal accepts from a Hub and shows to customers.
// Mirrors web/src/data/connectors.ts (the public albena.ai catalog); a test keeps the names in step when the site file is present.
// Visibility only: the portal never holds a credential for any of these.
export const AUTH_TYPES = ["oauth_device", "oauth_local", "api_key", "local", "mcp"] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const CATEGORIES = [
  { id: "home", label: "Smart home" },
  { id: "media", label: "Media" },
  { id: "work", label: "Work & comms" },
  { id: "cloud", label: "Cloud & infrastructure" },
  { id: "identity", label: "Identity & IT" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

export interface CatalogEntry { id: string; name: string; category: CategoryId; auth: AuthType; write: boolean; description: string }

const c = (id: string, name: string, category: CategoryId, auth: AuthType, write: boolean, description: string): CatalogEntry => ({ id, name, category, auth, write, description });

export const CATALOG: readonly CatalogEntry[] = [
  c("home_assistant", "Home Assistant", "home", "api_key", true, "Devices and scenes"),
  c("philips_hue", "Philips Hue", "home", "local", true, "Lights and rooms"),
  c("wiz", "WiZ", "home", "local", true, "Smart bulbs"),
  c("google_nest", "Google Nest", "home", "oauth_local", true, "Thermostats"),
  c("smart_tv", "LG & smart TVs", "home", "local", true, "Power, input, apps"),
  c("cameras", "Cameras", "home", "local", false, "Motion and snapshots"),
  c("jellyfin", "Jellyfin", "media", "api_key", true, "Video library"),
  c("navidrome", "Navidrome", "media", "api_key", true, "Music"),
  c("immich", "Immich", "media", "api_key", true, "Photos"),
  c("youtube", "YouTube", "media", "oauth_device", true, "Playlists and videos"),
  c("google_workspace", "Google Workspace", "work", "oauth_local", true, "Mail and calendar"),
  c("microsoft_teams", "Microsoft Teams", "work", "oauth_device", true, "Chat and channels"),
  c("slack", "Slack", "work", "oauth_local", true, "Messages"),
  c("linkedin", "LinkedIn", "work", "oauth_local", true, "Posts"),
  c("meta_pages", "Meta pages", "work", "oauth_local", true, "Page posts and comments"),
  c("jira", "Jira", "work", "api_key", true, "Issues"),
  c("servicenow", "ServiceNow", "work", "api_key", true, "Incidents and changes"),
  c("github", "GitHub", "work", "oauth_device", true, "Issues and workflows"),
  c("aws", "AWS", "cloud", "api_key", true, "Cloud resources"),
  c("azure", "Microsoft Azure", "cloud", "oauth_device", true, "Cloud resources"),
  c("cloudflare", "Cloudflare", "cloud", "api_key", true, "DNS and edge"),
  c("godaddy_dns", "GoDaddy DNS", "cloud", "api_key", true, "Domains"),
  c("vmware", "VMware", "cloud", "api_key", true, "Virtual machines"),
  c("docker", "Docker", "cloud", "local", true, "Containers"),
  c("kubernetes", "Kubernetes / OpenShift", "cloud", "api_key", true, "Clusters"),
  c("nomad", "Nomad", "cloud", "api_key", true, "Jobs"),
  c("prometheus", "Prometheus", "cloud", "local", false, "Metrics"),
  c("tailscale", "Tailscale", "cloud", "api_key", true, "Private network"),
  c("adguard", "AdGuard", "cloud", "local", true, "DNS filtering"),
  c("active_directory", "Active Directory / LDAP", "identity", "local", true, "Users and groups"),
  c("authelia", "Authelia SSO", "identity", "local", false, "Single sign-on"),
  c("apple_devices", "Apple devices", "identity", "api_key", true, "App Store Connect, TestFlight"),
  c("ssh_winrm", "SSH & Windows remote management", "identity", "local", true, "Servers and PCs"),
  c("storage", "Storage", "identity", "local", true, "Files and snapshots"),
];

const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));
export const catalogEntry = (id: string): CatalogEntry | undefined => BY_ID.get(id);
