export interface Connector { name: string; note: string }
export interface Category { id: string; label: string; blurb: string; items: Connector[] }

export const categories: Category[] = [
  { id: 'home', label: 'Smart home', blurb: 'Lights, climate, TVs and cameras.', items: [
    { name: 'Home Assistant', note: 'Devices and scenes' },
    { name: 'Philips Hue', note: 'Lights and rooms' },
    { name: 'WiZ', note: 'Smart bulbs' },
    { name: 'Google Nest', note: 'Thermostats' },
    { name: 'LG & smart TVs', note: 'Power, input, apps' },
    { name: 'Cameras', note: 'Motion and snapshots' },
  ] },
  { id: 'media', label: 'Media', blurb: 'Your library, music and photos.', items: [
    { name: 'Jellyfin', note: 'Video library' },
    { name: 'Navidrome', note: 'Music' },
    { name: 'Immich', note: 'Photos' },
    { name: 'YouTube', note: 'Playlists and videos' },
  ] },
  { id: 'work', label: 'Work & comms', blurb: 'Mail, chat, social and tickets.', items: [
    { name: 'Google Workspace', note: 'Mail and calendar' },
    { name: 'Microsoft Teams', note: 'Chat and channels' },
    { name: 'Slack', note: 'Messages' },
    { name: 'LinkedIn', note: 'Posts' },
    { name: 'Meta pages', note: 'Page posts and comments' },
    { name: 'Jira', note: 'Issues' },
    { name: 'ServiceNow', note: 'Incidents and changes' },
    { name: 'GitHub', note: 'Issues and workflows' },
  ] },
  { id: 'cloud', label: 'Cloud & infrastructure', blurb: 'Clouds, DNS, containers and networks.', items: [
    { name: 'AWS', note: 'Cloud resources' },
    { name: 'Microsoft Azure', note: 'Cloud resources' },
    { name: 'Cloudflare', note: 'DNS and edge' },
    { name: 'GoDaddy DNS', note: 'Domains' },
    { name: 'VMware', note: 'Virtual machines' },
    { name: 'Docker', note: 'Containers' },
    { name: 'Kubernetes / OpenShift', note: 'Clusters' },
    { name: 'Nomad', note: 'Jobs' },
    { name: 'Prometheus', note: 'Metrics' },
    { name: 'Tailscale', note: 'Private network' },
    { name: 'AdGuard', note: 'DNS filtering' },
  ] },
  { id: 'identity', label: 'Identity & IT', blurb: 'People, devices and access.', items: [
    { name: 'Active Directory / LDAP', note: 'Users and groups' },
    { name: 'Authelia SSO', note: 'Single sign-on' },
    { name: 'Apple devices', note: 'App Store Connect, TestFlight' },
    { name: 'SSH & Windows remote management', note: 'Servers and PCs' },
    { name: 'Storage', note: 'Files and snapshots' },
  ] },
];
