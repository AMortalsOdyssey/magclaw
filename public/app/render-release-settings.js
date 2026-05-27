function releaseComponentForRender(component) {
  const fallback = component === 'daemon'
    ? { currentVersion: daemonLatestVersion(), latestVersion: daemonLatestVersion(), releases: [] }
    : component === 'computer'
      ? { currentVersion: computerLatestVersion(), latestVersion: computerLatestVersion(), releases: [] }
      : { currentVersion: MAGCLAW_WEB_PACKAGE_VERSION, latestVersion: MAGCLAW_WEB_PACKAGE_VERSION, releases: [] };
  return {
    ...fallback,
    ...(appState.releaseNotes?.[component] || {}),
  };
}

function releaseVersionLabel(version = '') {
  const clean = String(version || '').trim();
  if (!clean) return '--';
  return clean.startsWith('v') ? clean : `v${clean}`;
}

function releaseBadgeClass(key) {
  const classes = {
    new: 'new',
    bugFix: 'bug-fix',
    approval: 'approval',
    features: 'feature',
    fixes: 'fix',
    improved: 'improved',
  };
  if (classes[key]) return classes[key];
  return String(key || '')
    .replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)
    .replace(/^-/, '');
}

function renderReleaseVersionCard(release) {
  const sections = [
    ['new', 'NEW'],
    ['bugFix', 'BUG FIX'],
    ['approval', 'APPROVAL'],
    ['features', 'FEATURE'],
    ['fixes', 'FIX'],
    ['improved', 'IMPROVED'],
  ];
  return `
    <article class="release-version-card release-card">
      <header>
        <span class="release-version-pill">${escapeHtml(releaseVersionLabel(release.version))}</span>
        <div>
          <h3>${escapeHtml(release.title || 'MagClaw release')}</h3>
          <time>${escapeHtml(release.date || '')}</time>
        </div>
      </header>
      ${sections.map(([key, label]) => {
        const notes = Array.isArray(release[key]) ? release[key] : [];
        if (!notes.length) return '';
        return `
          <div class="release-note-group">
            <span class="release-badge release-${releaseBadgeClass(key)}">${escapeHtml(label)}</span>
            <div class="release-note-list">
              ${notes.map((text) => `
                <div class="release-note-row">
                  <p>${escapeHtml(text)}</p>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </article>
  `;
}

function renderReleaseNotesSettingsTab() {
  const web = releaseComponentForRender('web');
  const releases = Array.isArray(web.releases) ? web.releases : [];
  return `
    <section class="settings-release">
      <div class="release-heading">
        <div>
          <p class="eyebrow">Versioned changelog</p>
          <h3>What's New</h3>
        </div>
      </div>
      ${releases.length ? releases.map(renderReleaseVersionCard).join('') : `
        <article class="release-card">
          <h3>No releases yet</h3>
          <div class="release-note-list">
            <div class="release-note-row"><p>Release notes will appear after the Web Service publishes a version.</p></div>
          </div>
        </article>
      `}
    </section>
  `;
}
