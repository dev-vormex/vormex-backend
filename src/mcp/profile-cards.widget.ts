export const PROFILE_CARDS_RESOURCE_URI = 'ui://vormex/profile-cards-v1.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const PROFILE_CARDS_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Vormex public profiles</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; background: transparent; color: #172033; }
    #profiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
    .card { min-width: 0; padding: 16px; border: 1px solid #e2e8f0; border-radius: 18px; background: #fff; box-shadow: 0 8px 24px rgba(15, 23, 42, .06); }
    .top { display: flex; align-items: center; gap: 12px; }
    .avatar-wrap { width: 64px; height: 64px; flex: 0 0 64px; border-radius: 50%; overflow: hidden; background: linear-gradient(135deg, #6d28d9, #2563eb); color: #fff; display: grid; place-items: center; font-size: 20px; font-weight: 800; }
    .avatar { width: 100%; height: 100%; object-fit: cover; display: block; }
    .identity { min-width: 0; }
    .name { margin: 0; color: #0f172a; font-size: 17px; line-height: 1.25; font-weight: 750; overflow-wrap: anywhere; }
    .username { margin-top: 3px; color: #64748b; font-size: 13px; overflow-wrap: anywhere; }
    .verified { color: #2563eb; margin-left: 4px; }
    .headline { margin: 12px 0 0; color: #334155; font-size: 14px; line-height: 1.45; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .chip { max-width: 100%; padding: 5px 8px; border-radius: 999px; background: #eef2ff; color: #4338ca; font-size: 12px; overflow-wrap: anywhere; }
    .reason { margin: 12px 0 0; color: #475569; font-size: 13px; line-height: 1.45; }
    .meta { margin-top: 10px; color: #64748b; font-size: 12px; }
    .open { display: inline-flex; margin-top: 14px; padding: 8px 11px; border-radius: 10px; background: #111827; color: #fff; font-size: 13px; font-weight: 700; text-decoration: none; }
    .empty { padding: 18px; border: 1px dashed #cbd5e1; border-radius: 16px; color: #64748b; text-align: center; }
    @media (prefers-color-scheme: dark) {
      body { color: #e2e8f0; }
      .card { background: #111827; border-color: #334155; box-shadow: none; }
      .name { color: #f8fafc; }
      .username, .meta { color: #94a3b8; }
      .headline { color: #cbd5e1; }
      .reason { color: #b6c2d2; }
      .chip { background: #312e81; color: #e0e7ff; }
      .open { background: #f8fafc; color: #111827; }
    }
  </style>
</head>
<body>
  <main id="profiles" aria-live="polite"><div class="empty">Loading Vormex profiles...</div></main>
  <script type="module">
    const root = document.querySelector('#profiles');
    const text = (value) => typeof value === 'string' ? value.trim() : '';
    const list = (value) => Array.isArray(value) ? value : [];

    function initials(name) {
      return text(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'V';
    }

    function addText(parent, className, value, tag = 'div') {
      if (!text(value)) return null;
      const node = document.createElement(tag);
      node.className = className;
      node.textContent = value;
      parent.appendChild(node);
      return node;
    }

    function profileCard(profile) {
      const card = document.createElement('article');
      card.className = 'card';
      const top = document.createElement('div');
      top.className = 'top';
      const avatarWrap = document.createElement('div');
      avatarWrap.className = 'avatar-wrap';
      avatarWrap.textContent = initials(profile.name);
      if (text(profile.avatar)) {
        const image = document.createElement('img');
        image.className = 'avatar';
        image.src = profile.avatar;
        image.alt = text(profile.name) ? profile.name + ' profile picture' : 'Vormex profile picture';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true });
        avatarWrap.appendChild(image);
      }
      top.appendChild(avatarWrap);
      const identity = document.createElement('div');
      identity.className = 'identity';
      const heading = document.createElement('h3');
      heading.className = 'name';
      heading.textContent = text(profile.name) || text(profile.username) || 'Vormex member';
      if (profile.verified) {
        const verified = document.createElement('span');
        verified.className = 'verified';
        verified.textContent = '✓';
        verified.title = 'Verified Vormex member';
        heading.appendChild(verified);
      }
      identity.appendChild(heading);
      addText(identity, 'username', text(profile.username) ? '@' + profile.username : '');
      top.appendChild(identity);
      card.appendChild(top);
      addText(card, 'headline', profile.headline, 'p');

      const skills = list(profile.skills).filter((item) => text(item)).slice(0, 6);
      if (skills.length) {
        const chips = document.createElement('div');
        chips.className = 'chips';
        for (const skill of skills) addText(chips, 'chip', skill);
        card.appendChild(chips);
      }
      const reason = list(profile.matchReasons).find((item) => text(item));
      if (reason) addText(card, 'reason', reason, 'p');
      const details = [];
      if (text(profile.location)) details.push(profile.location);
      if (text(profile.college)) details.push(profile.college);
      if (profile.openToOpportunities) details.push('Open to opportunities');
      if (details.length) addText(card, 'meta', details.join(' · '));
      if (text(profile.profileUrl)) {
        const link = document.createElement('a');
        link.className = 'open';
        link.href = profile.profileUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'View Vormex profile ↗';
        card.appendChild(link);
      }
      return card;
    }

    function profilesFrom(result) {
      const data = result?.structuredContent || result || {};
      if (data.profile) return [data.profile];
      if (Array.isArray(data.profiles) && data.profiles.length) {
        const summaries = new Map(list(data.people).map((person) => [person.username, person]));
        return data.profiles.map((profile) => ({ ...summaries.get(profile.username), ...profile }));
      }
      return list(data.people);
    }

    function render(result) {
      const profiles = profilesFrom(result).filter(Boolean);
      root.replaceChildren();
      if (!profiles.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No eligible public Vormex profiles matched this request.';
        root.appendChild(empty);
        return;
      }
      for (const profile of profiles) root.appendChild(profileCard(profile));
    }

    if (window.openai?.toolOutput) render(window.openai.toolOutput);

    let rpcId = 0;
    const pending = new Map();
    const notify = (method, params) => window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++rpcId;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== '2.0') return;
      if (typeof message.id === 'number') {
        const operation = pending.get(message.id);
        if (!operation) return;
        pending.delete(message.id);
        return message.error ? operation.reject(message.error) : operation.resolve(message.result);
      }
      if (message.method === 'ui/notifications/tool-result') render(message.params);
    }, { passive: true });
    request('ui/initialize', {
      appInfo: { name: 'vormex-profile-cards', version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26'
    }).then(() => notify('ui/notifications/initialized', {})).catch(() => {});
  </script>
</body>
</html>`;
