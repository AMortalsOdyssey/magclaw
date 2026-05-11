function readAvatarFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read avatar file.'));
    reader.readAsDataURL(file);
  });
}

function loadAvatarImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load avatar image.'));
    image.src = src;
  });
}

function avatarCropBaseSize(width, height) {
  const safeWidth = Math.max(1, Number(width) || AVATAR_CROP_VIEW_SIZE);
  const safeHeight = Math.max(1, Number(height) || AVATAR_CROP_VIEW_SIZE);
  const scale = Math.max(AVATAR_CROP_VIEW_SIZE / safeWidth, AVATAR_CROP_VIEW_SIZE / safeHeight);
  return {
    baseWidth: safeWidth * scale,
    baseHeight: safeHeight * scale,
  };
}

function clampAvatarCropScale(scale) {
  return Math.min(4, Math.max(1, Number(scale) || 1));
}

function clampAvatarCropOffset(state = avatarCropState) {
  if (!state) return null;
  const scale = clampAvatarCropScale(state.scale);
  const displayWidth = (state.baseWidth || AVATAR_CROP_VIEW_SIZE) * scale;
  const displayHeight = (state.baseHeight || AVATAR_CROP_VIEW_SIZE) * scale;
  const maxX = Math.max(0, (displayWidth - AVATAR_CROP_VIEW_SIZE) / 2);
  const maxY = Math.max(0, (displayHeight - AVATAR_CROP_VIEW_SIZE) / 2);
  state.scale = scale;
  state.offsetX = Math.min(maxX, Math.max(-maxX, Number(state.offsetX) || 0));
  state.offsetY = Math.min(maxY, Math.max(-maxY, Number(state.offsetY) || 0));
  return state;
}

function updateAvatarCropPreview() {
  const image = document.querySelector('.avatar-crop-image');
  if (!image || !avatarCropState) return;
  clampAvatarCropOffset();
  image.style.width = `${avatarCropState.baseWidth}px`;
  image.style.height = `${avatarCropState.baseHeight}px`;
  image.style.setProperty('--avatar-crop-x', `${avatarCropState.offsetX}px`);
  image.style.setProperty('--avatar-crop-y', `${avatarCropState.offsetY}px`);
  image.style.setProperty('--avatar-crop-scale', String(avatarCropState.scale));
}

async function openAvatarCropModal({ agentId, humanId, source, target = 'agent-detail' }) {
  const image = await loadAvatarImage(source);
  const { baseWidth, baseHeight } = avatarCropBaseSize(image.naturalWidth, image.naturalHeight);
  avatarCropState = clampAvatarCropOffset({
    agentId,
    humanId,
    target,
    source,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    baseWidth,
    baseHeight,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });
  modal = 'avatar-crop';
  renderShellOrModal();
}

async function drawCroppedAvatarToDataUrl(state = avatarCropState) {
  if (!state?.source) throw new Error('No avatar crop is active.');
  const image = await loadAvatarImage(state.source);
  clampAvatarCropOffset(state);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_CROP_SIZE;
  canvas.height = AVATAR_CROP_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not crop avatar.');

  const displayWidth = state.baseWidth * state.scale;
  const displayHeight = state.baseHeight * state.scale;
  const stageCenter = AVATAR_CROP_STAGE_SIZE / 2;
  const cropLeft = (AVATAR_CROP_STAGE_SIZE - AVATAR_CROP_VIEW_SIZE) / 2;
  const cropTop = (AVATAR_CROP_STAGE_SIZE - AVATAR_CROP_VIEW_SIZE) / 2;
  const imageLeft = stageCenter + state.offsetX - (displayWidth / 2);
  const imageTop = stageCenter + state.offsetY - (displayHeight / 2);
  const sx = ((cropLeft - imageLeft) / displayWidth) * image.naturalWidth;
  const sy = ((cropTop - imageTop) / displayHeight) * image.naturalHeight;
  const sw = (AVATAR_CROP_VIEW_SIZE / displayWidth) * image.naturalWidth;
  const sh = (AVATAR_CROP_VIEW_SIZE / displayHeight) * image.naturalHeight;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, AVATAR_CROP_SIZE, AVATAR_CROP_SIZE);
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, AVATAR_CROP_SIZE, AVATAR_CROP_SIZE);
  return canvas.toDataURL('image/png');
}

function avatarUploadContext(input) {
  const target = input?.dataset?.avatarUploadTarget
    || input?.dataset?.target
    || (input?.classList?.contains('human-avatar-upload') ? 'human-detail' : '')
    || (input?.classList?.contains('agent-avatar-upload') ? 'agent-detail' : '')
    || (input?.id === 'profile-avatar-file' ? 'profile' : '')
    || (input?.id === 'cloud-auth-avatar-file' ? 'cloud-auth' : '')
    || (input?.id === 'server-avatar-file' ? 'server-profile' : '');
  const context = { target };
  if (target === 'agent-create') {
    saveAgentFormState();
    return context;
  }
  if (target === 'agent-detail') {
    context.agentId = input?.dataset?.id || selectedAgentId;
    return context;
  }
  if (target === 'human-detail') {
    context.humanId = input?.dataset?.id || selectedHumanId;
    return context;
  }
  if (target === 'profile') {
    context.humanId = document.getElementById('profile-form')?.dataset?.humanId || currentAccountHuman()?.id || '';
    return context;
  }
  if (target === 'cloud-auth' || target === 'server-profile') return context;
  return context;
}

function avatarUploadNeedsIdentity(context) {
  return (context.target === 'agent-detail' && !context.agentId)
    || (context.target === 'human-detail' && !context.humanId);
}

async function uploadAvatarFromInput(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > AGENT_AVATAR_UPLOAD_MAX_BYTES) {
    toast('Avatar must be 10 MB or smaller');
    input.value = '';
    return;
  }
  const context = avatarUploadContext(input);
  if (!context.target || avatarUploadNeedsIdentity(context)) {
    input.value = '';
    return;
  }
  const avatar = await readAvatarFileAsDataUrl(file);
  input.value = '';
  await openAvatarCropModal({ ...context, source: avatar });
}

async function uploadAgentAvatar(input) {
  if (input?.dataset) {
    input.dataset.avatarUploadTarget = input.dataset.avatarUploadTarget || input.dataset.target || 'agent-detail';
  }
  await uploadAvatarFromInput(input);
}

async function uploadHumanAvatar(input) {
  if (input?.dataset) {
    input.dataset.avatarUploadTarget = input.dataset.avatarUploadTarget || 'human-detail';
  }
  await uploadAvatarFromInput(input);
}

async function applyCroppedAvatar(crop, avatar) {
  if (crop?.target === 'agent-detail' && crop.agentId) {
    await api(`/api/agents/${encodeURIComponent(crop.agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ avatar }),
    });
    toast('Avatar updated');
    return;
  }
  if (crop?.target === 'human-detail' && crop.humanId) {
    await api(`/api/humans/${encodeURIComponent(crop.humanId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ avatar }),
    });
    toast('Avatar updated');
    return;
  }
  if (crop?.target === 'profile') {
    setProfileAvatarInput(avatar);
    toast('Avatar selected');
    return;
  }
  if (crop?.target === 'agent-create') {
    agentFormState.avatar = avatar;
    toast('Avatar selected');
    return;
  }
  if (crop?.target === 'cloud-auth') {
    cloudAuthAvatar = avatar;
    toast('Avatar selected');
    return;
  }
  if (crop?.target === 'server-profile') {
    const input = document.querySelector('[data-server-avatar-input]');
    if (input) input.value = avatar;
    const preview = document.querySelector('.server-profile-avatar');
    if (preview) preview.innerHTML = `<img class="server-profile-avatar-img" src="${escapeHtml(avatar)}" alt="">`;
    toast('Server avatar selected');
  }
}

function avatarCropReturnModal(crop) {
  return crop?.target === 'agent-create' ? 'agent' : null;
}

async function confirmAvatarCropSelection() {
  const crop = avatarCropState;
  const avatar = await drawCroppedAvatarToDataUrl(crop);
  await applyCroppedAvatar(crop, avatar);
  avatarCropState = null;
  modal = avatarCropReturnModal(crop);
  render();
  if (crop?.target === 'agent-detail' || crop?.target === 'human-detail') {
    await refreshStateOrAuthGate().catch(() => {});
  }
}

function setProfileAvatarInput(value) {
  const avatar = String(value || '').trim();
  const input = document.getElementById('profile-avatar-input');
  if (input) input.value = avatar;
  const preview = document.querySelector('#profile-form .settings-account-avatar');
  captureProfileFormDraft();
  if (!preview) return;
  if (avatar) {
    preview.innerHTML = `<img src="${escapeHtml(avatar)}" class="settings-account-avatar-inner avatar-img" alt="">`;
    return;
  }
  const name = document.querySelector('#profile-form input[name="displayName"]')?.value
    || byId(appState.humans, appState.cloud?.auth?.currentMember?.humanId)?.name
    || 'You';
  preview.textContent = String(name).trim().slice(0, 1).toUpperCase() || 'Y';
}

function openAvatarPicker({ target = 'agent-create', agentId = '', humanId = '', selectedAvatar = '', returnModal = null } = {}) {
  avatarPickerState = {
    target,
    agentId,
    humanId,
    selectedAvatar: selectedAvatar || '',
    returnModal,
  };
  modal = 'avatar-picker';
  render();
}
