export const PROFILE_CARDS_RESOURCE_URI = 'ui://vormex/profile-cards-v9.html';
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
    body { margin: 0; padding: 0; overflow: hidden; background: transparent; color: #172033; }
    #profiles { display: flex; align-items: flex-start; gap: 12px; max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 0; scroll-behavior: smooth; scroll-snap-type: x mandatory; scrollbar-width: none; }
    #profiles::-webkit-scrollbar { display: none; }
    .card-canvas { position: relative; flex: 0 0 clamp(290px, 82vw, 380px); min-width: 0; align-self: start; padding: 0; isolation: isolate; scroll-snap-align: start; }
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
    .card { min-width: 0; overflow: hidden; display: flex; flex-direction: column; background: #fff; cursor: pointer; }
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
    .profile-dialog { position: fixed; inset: 0; width: min(540px, calc(100vw - 24px)); max-width: none; max-height: calc(100vh - 24px); margin: auto; padding: 0; overflow: visible; border: 0; background: transparent; color: inherit; }
    .profile-dialog::backdrop { background: rgba(15,23,42,.48); backdrop-filter: blur(3px); }
    .detail-card { max-height: calc(100vh - 24px); overflow: auto; border: 1px solid #cbd5e1; background: #fff; box-shadow: 0 28px 80px rgba(15,23,42,.28); }
    .detail-drag-handle { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; background: rgba(255,255,255,.96); cursor: move; touch-action: none; user-select: none; }
    .detail-drag-label { color: #64748b; font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    .detail-close { width: 30px; height: 30px; border: 0; border-radius: 50%; background: #f1f5f9; color: #0f172a; font-size: 20px; line-height: 1; cursor: pointer; }
    .detail-cover { position: relative; height: 118px; overflow: hidden; background: #e8edf5; }
    .detail-cover img { width: 100%; height: 100%; display: block; object-fit: cover; }
    .detail-body { position: relative; padding: 0 20px 20px; }
    .detail-avatar { position: relative; width: 82px; height: 82px; margin-top: -41px; overflow: hidden; display: grid; place-items: center; border: 4px solid #fff; border-radius: 50%; background: linear-gradient(135deg,#6d28d9,#2563eb); color: #fff; font-size: 24px; font-weight: 800; box-shadow: 0 6px 18px rgba(15,23,42,.18); }
    .detail-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .detail-title-row { display: flex; align-items: center; gap: 7px; margin-top: 14px; }
    .detail-title { margin: 0; color: #0f172a; font-size: 23px; line-height: 1.2; font-weight: 850; }
    .detail-text { margin: 10px 0 0; color: #475569; font-size: 13px; line-height: 1.6; }
    .detail-tags { display: flex; flex-wrap: wrap; gap: 7px 13px; margin-top: 16px; padding-top: 14px; border-top: 1px solid #eef2f7; }
    .detail-tag { color: #334155; font-size: 12px; font-weight: 700; }
    .detail-stats { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 16px; color: #64748b; font-size: 12px; }
    .detail-link { display: inline-flex; align-items: center; margin-top: 18px; padding: 9px 13px; background: #111827; color: #fff; font-size: 12px; font-weight: 750; text-decoration: none; }
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
      .detail-card { border-color: #334155; background: #111827; }
      .detail-drag-handle { border-color: #334155; background: rgba(17,24,39,.96); }
      .detail-close { background: #1e293b; color: #f8fafc; }
      .detail-avatar { border-color: #111827; }
      .detail-title { color: #f8fafc; }
      .detail-text, .detail-stats { color: #cbd5e1; }
      .detail-tags { border-color: #273449; }
      .detail-tag { color: #e2e8f0; }
      .detail-link { background: #f8fafc; color: #111827; }
    }
    @media (max-width: 420px) { .card-canvas { flex-basis: min(88vw, 340px); } }
    @media (prefers-reduced-motion: reduce) { .border-element, .marquee-track { animation: none; } }
  </style>
</head>
<body>
  <main id="profiles" aria-live="polite" aria-label="Vormex profile card carousel"><div class="empty">Loading Vormex profiles...</div></main>
  <dialog id="profile-detail" class="profile-dialog" aria-label="Expanded Vormex profile card">
    <article id="profile-detail-card" class="detail-card"></article>
  </dialog>
  <script type="module">
    const root = document.querySelector('#profiles');
    const detailDialog = document.querySelector('#profile-detail');
    const detailCard = document.querySelector('#profile-detail-card');
    const fallbackBanner = 'https://www.vormex.in/vormex-profile-cover.png';
    const backendOrigin = 'https://vormex-backend.onrender.com';
    const text = (value) => typeof value === 'string' ? value.trim() : '';
    const list = (value) => Array.isArray(value) ? value : [];

    function mediaUrl(value, fallback = '') {
      const source = text(value);
      if (!source) return fallback;
      if (/^(https?:|data:|blob:)/i.test(source)) return source;
      if (source.startsWith('//')) return 'https:' + source;
      return backendOrigin + (source.startsWith('/') ? source : '/' + source);
    }

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
      coverImage.src = mediaUrl(profile.bannerImage, fallbackBanner);
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
        image.src = mediaUrl(profile.avatar);
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
      if (text(profile.username)) {
        const link = document.createElement('button');
        link.className = 'open';
        link.type = 'button';
        link.setAttribute('aria-label', 'Show @' + profile.username + ' profile card');
        link.addEventListener('click', (event) => {
          event.stopPropagation();
          openProfileDetail(profile);
        });
        const miniAvatar = document.createElement('span');
        miniAvatar.className = 'open-avatar-wrap';
        miniAvatar.textContent = initials(profile.name);
        if (text(profile.avatar)) {
          const miniImage = document.createElement('img');
          miniImage.className = 'open-avatar';
          miniImage.src = mediaUrl(profile.avatar);
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
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'button');
      canvas.setAttribute('aria-label', 'Show ' + (text(profile.name) || text(profile.username)) + ' expanded profile card');
      canvas.addEventListener('click', () => openProfileDetail(profile));
      canvas.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openProfileDetail(profile);
        }
      });
      return canvas;
    }

    function addDetailStat(parent, label, value) {
      const count = Array.isArray(value) ? value.length : Number(value);
      if (!Number.isFinite(count) || count <= 0) return;
      addText(parent, 'detail-stat', count + ' ' + label + (count === 1 ? '' : 's'), 'span');
    }

    function openProfileDetail(profile) {
      detailCard.replaceChildren();
      detailDialog.style.transform = 'translate(0px, 0px)';

      const handle = document.createElement('header');
      handle.className = 'detail-drag-handle';
      addText(handle, 'detail-drag-label', 'Drag to move', 'span');
      const close = document.createElement('button');
      close.className = 'detail-close';
      close.type = 'button';
      close.setAttribute('aria-label', 'Close expanded profile card');
      close.textContent = '×';
      close.addEventListener('click', () => detailDialog.close());
      handle.appendChild(close);
      detailCard.appendChild(handle);

      const cover = document.createElement('div');
      cover.className = 'detail-cover';
      const coverImage = document.createElement('img');
      coverImage.src = mediaUrl(profile.bannerImage, fallbackBanner);
      coverImage.alt = '';
      coverImage.referrerPolicy = 'no-referrer';
      coverImage.addEventListener('error', () => { if (coverImage.src !== fallbackBanner) coverImage.src = fallbackBanner; });
      cover.appendChild(coverImage);
      detailCard.appendChild(cover);

      const body = document.createElement('div');
      body.className = 'detail-body';
      const avatar = document.createElement('div');
      avatar.className = 'detail-avatar';
      avatar.textContent = initials(profile.name);
      if (text(profile.avatar)) {
        const avatarImage = document.createElement('img');
        avatarImage.src = mediaUrl(profile.avatar);
        avatarImage.alt = text(profile.name) + ' profile picture';
        avatarImage.referrerPolicy = 'no-referrer';
        avatarImage.addEventListener('error', () => avatarImage.remove(), { once: true });
        avatar.appendChild(avatarImage);
      }
      body.appendChild(avatar);

      const titleRow = document.createElement('div');
      titleRow.className = 'detail-title-row';
      addText(titleRow, 'detail-title', text(profile.name) || text(profile.username) || 'Vormex member', 'h2');
      if (profile.verified) addText(titleRow, 'verified', '✓', 'span');
      body.appendChild(titleRow);
      addText(body, 'username', text(profile.username) ? '@' + profile.username : '');
      addText(body, 'headline', profile.headline, 'p');
      addText(body, 'detail-text', profile.bio, 'p');

      const tags = Array.from(new Set([...list(profile.skills), ...list(profile.interests)].map((item) => text(item)).filter(Boolean))).slice(0, 20);
      if (tags.length) {
        const tagList = document.createElement('div');
        tagList.className = 'detail-tags';
        for (const tag of tags) addText(tagList, 'detail-tag', tag, 'span');
        body.appendChild(tagList);
      }

      const stats = document.createElement('div');
      stats.className = 'detail-stats';
      if (text(profile.college)) addText(stats, 'detail-stat', profile.college, 'span');
      if (Number.isFinite(Number(profile.connectionsCount))) addText(stats, 'detail-stat', Math.max(0, Math.trunc(Number(profile.connectionsCount))).toLocaleString() + ' connections', 'span');
      addDetailStat(stats, 'experience', profile.experiences);
      addDetailStat(stats, 'project', profile.projects);
      addDetailStat(stats, 'achievement', profile.achievements);
      body.appendChild(stats);

      if (text(profile.profileUrl)) {
        const fullProfile = document.createElement('a');
        fullProfile.className = 'detail-link';
        fullProfile.href = profile.profileUrl;
        fullProfile.target = '_blank';
        fullProfile.rel = 'noopener noreferrer';
        fullProfile.textContent = 'Open full Vormex profile ↗';
        body.appendChild(fullProfile);
      }
      detailCard.appendChild(body);
      detailDialog.showModal();
      enableDetailDragging(handle);
    }

    function enableDetailDragging(handle) {
      let activePointer = null;
      let startX = 0;
      let startY = 0;
      let originX = 0;
      let originY = 0;
      handle.onpointerdown = (event) => {
        if (event.target.closest('button')) return;
        activePointer = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        const match = detailDialog.style.transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
        originX = match ? Number(match[1]) : 0;
        originY = match ? Number(match[2]) : 0;
        handle.setPointerCapture(event.pointerId);
      };
      handle.onpointermove = (event) => {
        if (event.pointerId !== activePointer) return;
        detailDialog.style.transform = 'translate(' + (originX + event.clientX - startX) + 'px, ' + (originY + event.clientY - startY) + 'px)';
      };
      handle.onpointerup = handle.onpointercancel = (event) => {
        if (event.pointerId === activePointer) activePointer = null;
      };
    }

    detailDialog.addEventListener('click', (event) => {
      if (event.target === detailDialog) detailDialog.close();
    });

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
      appInfo: { name: 'vormex-profile-cards', version: '9.0.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26'
    }).then(() => notify('ui/notifications/initialized', {})).catch(() => {});
  </script>
</body>
</html>`;
