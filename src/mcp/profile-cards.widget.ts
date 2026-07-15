export const PROFILE_CARDS_RESOURCE_URI = 'ui://vormex/profile-cards-v7.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const PROFILE_CARDS_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Vormex public profiles</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    @property --glow-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 8px; background: transparent; color: #172033; }
    .carousel-toolbar { display: flex; justify-content: flex-end; gap: 6px; min-height: 34px; margin-bottom: 8px; }
    .carousel-toolbar[hidden] { display: none; }
    .carousel-control { width: 34px; height: 34px; border: 1px solid #d7dee9; border-radius: 50%; background: #fff; color: #172033; display: grid; place-items: center; font: 700 20px/1 system-ui, sans-serif; cursor: pointer; }
    .carousel-control:hover { border-color: #94a3b8; background: #f8fafc; }
    .carousel-control:disabled { cursor: default; opacity: .35; }
    #profiles { display: flex; align-items: flex-start; gap: 14px; max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 2px 2px 8px; scroll-behavior: smooth; scroll-snap-type: x mandatory; scrollbar-width: thin; scrollbar-color: #cbd5e1 transparent; }
    .card-canvas { position: relative; flex: 0 0 clamp(290px, 82vw, 380px); min-width: 0; align-self: start; padding: 1px; isolation: isolate; scroll-snap-align: start; }
    .card-backdrop { position: absolute; inset: -18px; z-index: -2; opacity: 0; filter: blur(24px); background: conic-gradient(from var(--glow-angle), transparent 0 16%, rgba(59,130,246,.28), transparent 35% 62%, rgba(139,92,246,.22), transparent 82%); transition: opacity .3s ease; animation: card-glow 7s linear infinite; pointer-events: none; }
    .card-canvas:hover .card-backdrop, .card-canvas:focus-within .card-backdrop { opacity: 1; }
    .glow-card { position: relative; min-width: 0; height: auto; padding: 1px; overflow: hidden; background: #cbd5e1; box-shadow: 0 16px 45px rgba(15,23,42,.08); }
    .card-content { position: relative; z-index: 1; height: auto; }
    .border-element { position: absolute; z-index: 2; display: block; pointer-events: none; opacity: .78; }
    .border-top, .border-bottom { left: -35%; width: 34%; height: 1px; background: linear-gradient(90deg, transparent, #fff, #60a5fa, transparent); animation: border-horizontal 5.5s linear infinite; }
    .border-top { top: 0; } .border-bottom { bottom: 0; animation-delay: -2.75s; }
    .border-left, .border-right { top: -35%; width: 1px; height: 34%; background: linear-gradient(180deg, transparent, #fff, #8b5cf6, transparent); animation: border-vertical 5.5s linear infinite; }
    .border-left { left: 0; animation-delay: -1.4s; } .border-right { right: 0; animation-delay: -4.1s; }
    @keyframes card-glow { to { --glow-angle: 360deg; } }
    @keyframes border-horizontal { to { transform: translateX(500%); } }
    @keyframes border-vertical { to { transform: translateY(500%); } }
    .card { min-width: 0; overflow: hidden; display: flex; flex-direction: column; background: #fff; }
    .cover { position: relative; height: 92px; flex: 0 0 92px; overflow: hidden; background: #e8edf5; }
    .cover-image { width: 100%; height: 100%; object-fit: cover; display: block; }
    .vormex-logo { position: absolute; top: 12px; right: 16px; width: 40px; height: 40px; object-fit: contain; }
    .content { min-height: 0; flex: 1; display: flex; flex-direction: column; padding: 0 16px 16px; }
    .avatar-wrap { position: relative; width: 68px; height: 68px; flex: 0 0 68px; margin-top: -34px; border: 4px solid #fff; border-radius: 50%; overflow: hidden; background: linear-gradient(135deg, #6d28d9, #2563eb); color: #fff; display: grid; place-items: center; font-size: 20px; font-weight: 800; box-shadow: 0 5px 14px rgba(15, 23, 42, .16); }
    .avatar { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
    .identity { margin-top: 13px; min-width: 0; }
    .name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .name { margin: 0; color: #0f172a; font-size: 18px; line-height: 1.25; font-weight: 800; overflow-wrap: anywhere; }
    .verified { flex: 0 0 auto; display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: #2563eb; color: #fff; font-size: 11px; font-weight: 900; }
    .username { margin-top: 4px; color: #64748b; font-size: 12px; overflow-wrap: anywhere; }
    .headline { margin: 12px 0 0; color: #334155; font-size: 13px; line-height: 1.5; font-weight: 650; }
    .about { margin: 7px 0 0; color: #64748b; font-size: 12px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .marquee { margin-top: 16px; overflow: hidden; white-space: nowrap; color: #475569; mask-image: linear-gradient(to right, transparent, #000 7%, #000 93%, transparent); -webkit-mask-image: linear-gradient(to right, transparent, #000 7%, #000 93%, transparent); }
    .marquee-track { display: flex; width: max-content; animation: profile-marquee 22s linear infinite; }
    .marquee:hover .marquee-track { animation-play-state: paused; }
    .marquee-group { display: flex; align-items: center; flex-shrink: 0; }
    .marquee-item { display: inline-flex; align-items: center; color: inherit; font-size: 12px; font-weight: 650; }
    .marquee-item::after { content: "·"; margin: 0 12px; opacity: .35; }
    @keyframes profile-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
    .footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-top: 18px; padding-top: 12px; border-top: 1px solid #eef2f7; }
    .meta { min-width: 0; color: #475569; font-size: 11px; line-height: 1.5; }
    .meta-line { overflow-wrap: anywhere; }
    .availability { color: #059669; }
    .connections { margin-top: 5px; color: #64748b; font-weight: 650; }
    .open { display: inline-flex; flex: 0 1 auto; min-width: 0; max-width: 58%; align-items: center; gap: 6px; padding: 4px 10px 4px 4px; border-radius: 999px; background: #111827; color: #fff; font-size: 11px; font-weight: 750; text-decoration: none; }
    .open-avatar-wrap { position: relative; display: grid; flex: 0 0 26px; width: 26px; height: 26px; place-items: center; overflow: hidden; border: 1px solid rgba(255,255,255,.2); border-radius: 50%; background: #334155; color: #fff; font-size: 9px; font-weight: 800; }
    .open-avatar { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .open-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { flex: 1 0 100%; padding: 18px; border: 1px dashed #cbd5e1; border-radius: 16px; color: #64748b; text-align: center; }
    @media (prefers-color-scheme: dark) {
      body { color: #e2e8f0; }
      .glow-card { background: #334155; box-shadow: none; }
      .card { background: #111827; }
      .avatar-wrap { border-color: #111827; }
      .name { color: #f8fafc; }
      .username, .about, .connections { color: #94a3b8; }
      .headline, .meta { color: #cbd5e1; }
      .marquee { color: #cbd5e1; }
      .footer { border-color: #273449; }
      .open { background: #f8fafc; color: #111827; }
      .carousel-control { border-color: #334155; background: #111827; color: #f8fafc; }
      .carousel-control:hover { border-color: #64748b; background: #1e293b; }
    }
    @media (max-width: 420px) { body { padding: 6px; } .card-canvas { flex-basis: min(88vw, 340px); } }
    @media (prefers-reduced-motion: reduce) { .card-backdrop, .border-element, .marquee-track { animation: none; } }
  </style>
</head>
<body>
  <div id="carousel-controls" class="carousel-toolbar" hidden>
    <button id="carousel-previous" class="carousel-control" type="button" aria-label="Show previous Vormex profiles">&#8249;</button>
    <button id="carousel-next" class="carousel-control" type="button" aria-label="Show next Vormex profiles">&#8250;</button>
  </div>
  <main id="profiles" aria-live="polite" aria-label="Vormex profile card carousel"><div class="empty">Loading Vormex profiles...</div></main>
  <script type="module">
    const root = document.querySelector('#profiles');
    const controls = document.querySelector('#carousel-controls');
    const previousButton = document.querySelector('#carousel-previous');
    const nextButton = document.querySelector('#carousel-next');
    const fallbackBanner = 'https://www.vormex.in/vormex-profile-cover.png';
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

    function addMarquee(card, values) {
      const items = Array.from(new Set(list(values).map((item) => text(item)).filter(Boolean))).slice(0, 16);
      if (!items.length) return;
      const marquee = document.createElement('div');
      marquee.className = 'marquee';
      marquee.setAttribute('aria-label', 'Skills and interests: ' + items.join(', '));
      const track = document.createElement('div');
      track.className = 'marquee-track';
      track.setAttribute('aria-hidden', 'true');
      for (let groupIndex = 0; groupIndex < 2; groupIndex += 1) {
        const group = document.createElement('div');
        group.className = 'marquee-group';
        for (const item of items) addText(group, 'marquee-item', item, 'span');
        track.appendChild(group);
      }
      marquee.appendChild(track);
      card.appendChild(marquee);
    }

    function profileCard(profile) {
      const card = document.createElement('article');
      card.className = 'card';

      const cover = document.createElement('div');
      cover.className = 'cover';
      const coverImage = document.createElement('img');
      coverImage.className = 'cover-image';
      coverImage.src = text(profile.bannerImage) || fallbackBanner;
      coverImage.alt = '';
      coverImage.referrerPolicy = 'no-referrer';
      coverImage.addEventListener('error', () => {
        if (coverImage.src !== fallbackBanner) coverImage.src = fallbackBanner;
      });
      cover.appendChild(coverImage);
      card.appendChild(cover);

      const content = document.createElement('div');
      content.className = 'content';
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
      content.appendChild(avatarWrap);
      const vormexLogo = document.createElement('img');
      vormexLogo.className = 'vormex-logo';
      vormexLogo.src = 'https://www.vormex.in/logo.png';
      vormexLogo.alt = 'Vormex';
      content.appendChild(vormexLogo);

      const identity = document.createElement('div');
      identity.className = 'identity';
      const nameRow = document.createElement('div');
      nameRow.className = 'name-row';
      addText(nameRow, 'name', text(profile.name) || text(profile.username) || 'Vormex member', 'h3');
      if (profile.verified) {
        const verified = document.createElement('span');
        verified.className = 'verified';
        verified.textContent = '✓';
        verified.title = 'Verified Vormex member';
        nameRow.appendChild(verified);
      }
      identity.appendChild(nameRow);
      addText(identity, 'username', text(profile.username) ? '@' + profile.username : '');
      content.appendChild(identity);

      addText(content, 'headline', profile.headline, 'p');
      addText(content, 'about', profile.bio, 'p');
      addMarquee(content, [...list(profile.skills), ...list(profile.interests)]);

      const footer = document.createElement('div');
      footer.className = 'footer';
      const meta = document.createElement('div');
      meta.className = 'meta';
      addText(meta, 'meta-line', profile.college || profile.location || '');
      if (profile.openToOpportunities) addText(meta, 'meta-line availability', '● Open to opportunities');
      if (Number.isFinite(Number(profile.connectionsCount))) {
        const count = Math.max(0, Math.trunc(Number(profile.connectionsCount)));
        addText(meta, 'meta-line connections', count.toLocaleString() + ' connections');
      }
      footer.appendChild(meta);
      if (text(profile.profileUrl)) {
        const link = document.createElement('a');
        link.className = 'open';
        link.href = profile.profileUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', 'Open @' + profile.username + ' on Vormex');
        const miniAvatar = document.createElement('span');
        miniAvatar.className = 'open-avatar-wrap';
        miniAvatar.textContent = initials(profile.name);
        if (text(profile.avatar)) {
          const miniImage = document.createElement('img');
          miniImage.className = 'open-avatar';
          miniImage.src = profile.avatar;
          miniImage.alt = '';
          miniImage.referrerPolicy = 'no-referrer';
          miniImage.addEventListener('error', () => miniImage.remove(), { once: true });
          miniAvatar.appendChild(miniImage);
        }
        link.appendChild(miniAvatar);
        addText(link, 'open-label', '@' + profile.username, 'span');
        footer.appendChild(link);
      }
      content.appendChild(footer);
      card.appendChild(content);

      const canvas = document.createElement('div');
      canvas.className = 'card-canvas';
      const backdrop = document.createElement('div');
      backdrop.className = 'card-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      canvas.appendChild(backdrop);
      const glowCard = document.createElement('div');
      glowCard.className = 'glow-card';
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const border = document.createElement('span');
        border.className = 'border-element border-' + side;
        border.setAttribute('aria-hidden', 'true');
        glowCard.appendChild(border);
      }
      const cardContent = document.createElement('div');
      cardContent.className = 'card-content';
      cardContent.appendChild(card);
      glowCard.appendChild(cardContent);
      canvas.appendChild(glowCard);
      return canvas;
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
        controls.hidden = true;
        return;
      }
      for (const profile of profiles) root.appendChild(profileCard(profile));
      requestAnimationFrame(updateCarouselControls);
    }

    function updateCarouselControls() {
      const hasOverflow = root.scrollWidth > root.clientWidth + 2;
      controls.hidden = !hasOverflow;
      previousButton.disabled = root.scrollLeft <= 2;
      nextButton.disabled = root.scrollLeft + root.clientWidth >= root.scrollWidth - 2;
    }

    function scrollCarousel(direction) {
      const card = root.querySelector('.card-canvas');
      const distance = card ? card.getBoundingClientRect().width + 14 : Math.max(280, root.clientWidth * .8);
      root.scrollBy({ left: direction * distance, behavior: 'smooth' });
    }

    previousButton.addEventListener('click', () => scrollCarousel(-1));
    nextButton.addEventListener('click', () => scrollCarousel(1));
    root.addEventListener('scroll', updateCarouselControls, { passive: true });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateCarouselControls).observe(root);

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
      appInfo: { name: 'vormex-profile-cards', version: '7.0.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26'
    }).then(() => notify('ui/notifications/initialized', {})).catch(() => {});
  </script>
</body>
</html>`;
