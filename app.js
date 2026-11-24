/**
 * AndroidPanelTool Web - 1:1 Pixel-Level Alignment with Desktop Client
 * Pure client-side execution using HTML5 File APIs, JSZip, and SparkMD5.
 */

// Global Application State
const state = {
  isLoaded: false,
  sourceName: '',
  sourceType: '', // 'zip' or 'dir'
  files: {}, // filename -> { data: Uint8Array|string, isBinary: boolean, relPath: string }
  baselineFiles: {}, // baseline snapshot for diffing
  candidates: [], // multi-panel candidates if found
  selectedRowIdx: -1,

  // 1. Metadata
  metadata: {
    product_model: '',
    config_name: '', // 缺省留空
    config_screen: '', // 缺省留空
    resolution: '', // 缺省留空
    panel_model_version: 'V1.0.0'
  },
  baselineMetadata: {
    product_model: '',
    config_name: '',
    config_screen: '',
    resolution: '',
    panel_model_version: 'V1.0.0'
  },

  // 2. build.prop
  props: [], // array of { key, value, origValue, isNew, isDeleted }

  // 3. db.ini
  edid: {
    current: '1, 0, 0, 0',
    orig: '1, 0, 0, 0'
  },
  natureColor: {
    rGain: '256',
    gGain: '256',
    bGain: '240',
    rOffset: '256',
    gOffset: '256',
    bOffset: '256',
    origSample: '256, 256, 240, 256, 256, 256',
    isApplied: true
  },
  otherColorSamples: {
    cool: '256, 256, 256, 256, 256, 256',
    warm: '256, 240, 220, 256, 256, 256',
    user: '256, 256, 256, 256, 256, 256',
    tocool: '未配置',
    towarm: '未配置'
  },

  // 4. Media
  media: {
    origLogo: null,
    origAnim: null,
    logoDesc: '当前文件: 尚未载入工程 | 尺寸: -- | 状态: 未修改',
    animDesc: '当前文件: 尚未载入工程 | 尺寸: -- | 状态: 未修改',
    idBadge: '载入版控工程后将自动比对识别当前开机 Logo 与动画种类...'
  },

  // 5. singleMode.txt
  singleMode: {
    current: 'off',
    orig: 'off'
  },

  // Settings
  settings: {
    defaultVersion: 'V1.0.0',
    autoValidate: true
  }
};

// --- Console Logger ---
function logConsole(message, type = 'info') {
  const box = document.getElementById('consoleLogBox');
  if (!box) return;
  const now = new Date();
  const timeStr = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join(':');

  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  line.innerText = `[${timeStr}] ${message}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// --- Toast Notification ---
function showToast(text, duration = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.innerText = text;
  t.classList.add('show');
  setTimeout(() => {
    t.classList.remove('show');
  }, duration);
}

// --- Local Storage: Recent Projects ---
function getRecentProjects() {
  try {
    return JSON.parse(localStorage.getItem('apt_recent_projects') || '[]');
  } catch (e) {
    return [];
  }
}

function saveRecentProject(name) {
  if (!name) return;
  let list = getRecentProjects().filter(p => p !== name);
  list.unshift(name);
  if (list.length > 8) list = list.slice(0, 8);
  localStorage.setItem('apt_recent_projects', JSON.stringify(list));
  renderRecentMenu();
}

function renderRecentMenu() {
  const menu = document.getElementById('menuRecent');
  if (!menu) return;
  const list = getRecentProjects();
  if (list.length === 0) {
    menu.innerHTML = `<div class="dropdown-item-empty">暂无最近打开工程记录</div>`;
    return;
  }
  menu.innerHTML = '';
  for (const item of list) {
    const div = document.createElement('div');
    div.className = 'dropdown-item';
    div.innerHTML = `<span>📦 ${escapeHtml(item)}</span>`;
    div.addEventListener('click', () => {
      showToast(`历史记录: ${item} (请点击上方按钮重新导入该文件)`);
    });
    menu.appendChild(div);
  }
}

// --- Parsers & Serializers ---

// 1. build.prop Parser & Serializer
function parseBuildProp(text) {
  const props = [];
  const lines = (text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const k = line.substring(0, eqIdx).trim();
      const v = line.substring(eqIdx + 1).trim();
      props.push({ key: k, value: v, origValue: v, isNew: false, isDeleted: false });
    }
  }
  return props;
}

function serializeBuildProp(origText, currentProps) {
  const propMap = new Map();
  for (const p of currentProps) {
    if (!p.isDeleted) {
      propMap.set(p.key, p.value);
    }
  }

  const outputLines = [];
  const seenKeys = new Set();
  const origLines = (origText || '').split(/\r?\n/);

  for (const line of origLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      outputLines.push(line);
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const k = line.substring(0, eqIdx).trim();
      seenKeys.add(k);
      if (propMap.has(k)) {
        outputLines.push(`${k}=${propMap.get(k)}`);
      }
    } else {
      outputLines.push(line);
    }
  }

  // Append new keys
  for (const p of currentProps) {
    if (!p.isDeleted && !seenKeys.has(p.key)) {
      outputLines.push(`${p.key}=${p.value}`);
    }
  }

  return outputLines.join('\n') + '\n';
}

// 2. hht_panel_cfg.ini Parser & Serializer
function parseHhtPanelCfg(text) {
  const meta = {
    product_model: '',
    config_name: '',
    config_screen: '',
    resolution: '',
    panel_model_version: 'V1.0.0'
  };

  const lines = (text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (trimmed.startsWith('##product_model')) {
        const parts = trimmed.split('=');
        if (parts.length > 1) meta.product_model = parts[1].trim();
      }
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const k = line.substring(0, eqIdx).trim();
      const v = line.substring(eqIdx + 1).trim();
      if (k === 'config_name') meta.config_name = v;
      else if (k === 'config_screen') meta.config_screen = v;
      else if (k === 'resolution') meta.resolution = v;
      else if (k === 'panel_model_version') meta.panel_model_version = v;
    }
  }
  return meta;
}

function serializeHhtPanelCfg(origText, meta) {
  const lines = (origText || '').split(/\r?\n/);
  const updatedLines = [];
  const handledKeys = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('##product_model')) {
      updatedLines.push(`##product_model = ${meta.product_model || ''}`);
      handledKeys.add('product_model');
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1 && !trimmed.startsWith('#')) {
      const k = line.substring(0, eqIdx).trim();
      if (k === 'config_name') {
        updatedLines.push(`config_name = ${meta.config_name || ''}`);
        handledKeys.add('config_name');
      } else if (k === 'config_screen') {
        updatedLines.push(`config_screen = ${meta.config_screen || ''}`);
        handledKeys.add('config_screen');
      } else if (k === 'resolution') {
        updatedLines.push(`resolution = ${meta.resolution || ''}`);
        handledKeys.add('resolution');
      } else if (k === 'panel_model_version') {
        updatedLines.push(`panel_model_version = ${meta.panel_model_version || 'V1.0.0'}`);
        handledKeys.add('panel_model_version');
      } else {
        updatedLines.push(line);
      }
    } else {
      updatedLines.push(line);
    }
  }

  if (!handledKeys.has('product_model') && meta.product_model) {
    updatedLines.unshift(`##product_model = ${meta.product_model}`);
  }
  return updatedLines.join('\n') + '\n';
}

// 3. db.ini Parser & Serializer
function parseDbIni(text) {
  const lines = (text || '').split(/\r?\n/);
  let edidVal = '1, 0, 0, 0';
  let natureSample = '256, 256, 240, 256, 256, 256';
  const otherSamples = {
    cool: '未配置',
    warm: '未配置',
    user: '未配置',
    tocool: '未配置',
    towarm: '未配置'
  };

  const edidPattern = /^\s*HDMIRXEdidType\s*=\s*([^;]+);?/i;
  const naturePattern = /^\s*FacColorTemp_\w+_nature\s*=\s*([^;]+);?/i;
  const coolPattern = /FacColorTemp_\w+_cool\s*=\s*([^;]+);?/i;
  const warmPattern = /FacColorTemp_\w+_warm\s*=\s*([^;]+);?/i;
  const userPattern = /FacColorTemp_\w+_user\s*=\s*([^;]+);?/i;
  const tocoolPattern = /FacColorTemp_\w+_tocool\s*=\s*([^;]+);?/i;
  const towarmPattern = /FacColorTemp_\w+_towarm\s*=\s*([^;]+);?/i;

  for (const l of lines) {
    const mEdid = edidPattern.exec(l);
    if (mEdid) edidVal = mEdid[1].trim();

    const mNat = naturePattern.exec(l);
    if (mNat) natureSample = mNat[1].trim();

    if (otherSamples.cool === '未配置') {
      const m = coolPattern.exec(l);
      if (m) otherSamples.cool = m[1].trim();
    }
    if (otherSamples.warm === '未配置') {
      const m = warmPattern.exec(l);
      if (m) otherSamples.warm = m[1].trim();
    }
    if (otherSamples.user === '未配置') {
      const m = userPattern.exec(l);
      if (m) otherSamples.user = m[1].trim();
    }
    if (otherSamples.tocool === '未配置') {
      const m = tocoolPattern.exec(l);
      if (m) otherSamples.tocool = m[1].trim();
    }
    if (otherSamples.towarm === '未配置') {
      const m = towarmPattern.exec(l);
      if (m) otherSamples.towarm = m[1].trim();
    }
  }

  // Parse nature 6 components
  const parts = natureSample.split(',').map(s => s.trim());
  return {
    edidVal,
    natureSample,
    rGain: parts[0] || '256',
    gGain: parts[1] || '256',
    bGain: parts[2] || '240',
    rOffset: parts[3] || '256',
    gOffset: parts[4] || '256',
    bOffset: parts[5] || '256',
    otherSamples
  };
}

function updateDbIniText(origText, newEdid, newNatureVal, otherUpdates = {}) {
  const lines = (origText || '').split(/\r?\n/);
  const out = [];

  const edidPattern = /^(\s*HDMIRXEdidType\s*=\s*)([^;]+)(;?.*)$/i;
  const naturePattern = /^(\s*FacColorTemp_\w+_nature\s*=\s*)([^;]+)(;?.*)$/i;

  for (const line of lines) {
    if (edidPattern.test(line)) {
      const m = edidPattern.exec(line);
      const tail = m[3] && m[3].startsWith(';') ? m[3] : ';';
      out.push(`${m[1]}${newEdid}${tail}`);
      continue;
    }
    if (naturePattern.test(line)) {
      const m = naturePattern.exec(line);
      const tail = m[3] && m[3].startsWith(';') ? m[3] : ';';
      out.push(`${m[1]}${newNatureVal}${tail}`);
      continue;
    }

    // Check other modes
    let handledOther = false;
    for (const [modeKey, val] of Object.entries(otherUpdates)) {
      const p = new RegExp(`^(\\s*FacColorTemp_\\w+_${modeKey}\\s*=\\s*)([^;]+)(;?.*)$`, 'i');
      if (p.test(line)) {
        const m = p.exec(line);
        const tail = m[3] && m[3].startsWith(';') ? m[3] : ';';
        out.push(`${m[1]}${val}${tail}`);
        handledOther = true;
        break;
      }
    }

    if (!handledOther) {
      out.push(line);
    }
  }

  return out.join('\n') + '\n';
}

// 4. singleMode.txt Parser
function parseSingleMode(text) {
  const s = (text || '').trim().toLowerCase();
  return s.includes('on') ? 'on' : 'off';
}

// --- Import Operations (ZIP & Folder) ---

async function loadZipArrayBuffer(buffer, filename) {
  logConsole(`开始载入并解压升级包: ${filename}...`, 'info');
  showToast('正在解压并解析升级包...', 2000);

  try {
    const zip = await JSZip.loadAsync(buffer);
    state.sourceName = filename;
    state.sourceType = 'zip';
    state.files = {};
    state.candidates = [];

    // Check for nested PanelFiles.zip
    let innerZipFile = null;
    zip.forEach((relPath, fileObj) => {
      if (relPath.toLowerCase().endsWith('panelfiles.zip')) {
        innerZipFile = fileObj;
      }
    });

    let targetZip = zip;
    if (innerZipFile) {
      logConsole('检测到外层升级包，正在提取内层 PanelFiles.zip...', 'info');
      const innerBuf = await innerZipFile.async('arraybuffer');
      targetZip = await JSZip.loadAsync(innerBuf);
    }

    const promises = [];
    targetZip.forEach((relPath, fileObj) => {
      if (fileObj.dir) return;
      const baseName = relPath.split('/').pop();
      promises.push(
        (async () => {
          const isBin = /\.(img|zip|bin|png|jpg|so)$/i.test(baseName);
          if (isBin) {
            const u8 = await fileObj.async('uint8array');
            state.files[baseName] = { data: u8, isBinary: true, relPath };
          } else {
            const txt = await fileObj.async('string');
            state.files[baseName] = { data: txt, isBinary: false, relPath };
          }
        })()
      );
    });

    await Promise.all(promises);

    // Snapshot baseline
    state.baselineFiles = {};
    for (const [k, v] of Object.entries(state.files)) {
      state.baselineFiles[k] = { ...v };
    }

    state.isLoaded = true;
    saveRecentProject(filename);
    applyLoadedFilesToUI();
    logConsole(`升级包解析完成！共提取 ${Object.keys(state.files).length} 个配置文件与资源`, 'success');
    showToast('工程解析载入成功！', 2500);
  } catch (err) {
    logConsole(`解析升级包失败: ${err.message}`, 'error');
    alert(`解析升级包失败: ${err.message}`);
  }
}

async function loadDirectoryFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  logConsole(`开始从本地文件夹载入工程文件...`, 'info');
  showToast('正在读取本地目录...', 2000);

  try {
    state.files = {};
    const firstRel = fileList[0].webkitRelativePath || fileList[0].name;
    const rootName = firstRel.split('/')[0] || '本地工程目录';
    state.sourceName = rootName;
    state.sourceType = 'dir';

    const promises = [];
    for (const file of fileList) {
      const baseName = file.name;
      const isBin = /\.(img|zip|bin|png|jpg|so)$/i.test(baseName);
      promises.push(
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          if (isBin) {
            reader.readAsArrayBuffer(file);
            reader.onload = () => {
              state.files[baseName] = { data: new Uint8Array(reader.result), isBinary: true, relPath: file.webkitRelativePath };
              resolve();
            };
          } else {
            reader.readAsText(file, 'utf-8');
            reader.onload = () => {
              state.files[baseName] = { data: reader.result, isBinary: false, relPath: file.webkitRelativePath };
              resolve();
            };
          }
          reader.onerror = () => reject(reader.error);
        })
      );
    }

    await Promise.all(promises);

    state.baselineFiles = {};
    for (const [k, v] of Object.entries(state.files)) {
      state.baselineFiles[k] = { ...v };
    }

    state.isLoaded = true;
    saveRecentProject(rootName);
    applyLoadedFilesToUI();
    logConsole(`本地工程目录载入完成！共读取 ${Object.keys(state.files).length} 个文件`, 'success');
    showToast('目录工程载入成功！', 2500);
  } catch (err) {
    logConsole(`读取文件夹失败: ${err.message}`, 'error');
    alert(`读取文件夹失败: ${err.message}`);
  }
}

// --- Apply Loaded Files to UI ---

function applyLoadedFilesToUI() {
  // 1. Metadata from hht_panel_cfg.ini
  if (state.files['hht_panel_cfg.ini']) {
    const meta = parseHhtPanelCfg(state.files['hht_panel_cfg.ini'].data);
    state.metadata = { ...meta };
    state.baselineMetadata = { ...meta };
  } else {
    state.metadata = {
      product_model: '',
      config_name: '',
      config_screen: '',
      resolution: '',
      panel_model_version: state.settings.defaultVersion || 'V1.0.0'
    };
    state.baselineMetadata = { ...state.metadata };
  }

  document.getElementById('txtProductModel').value = state.metadata.product_model;
  document.getElementById('txtConfigName').value = state.metadata.config_name;
  document.getElementById('txtConfigScreen').value = state.metadata.config_screen;
  document.getElementById('txtResolution').value = state.metadata.resolution;
  document.getElementById('txtVersion').value = state.metadata.panel_model_version;

  updateMetadataBadges();

  // 2. Props from build.prop
  if (state.files['build.prop']) {
    state.props = parseBuildProp(state.files['build.prop'].data);
    renderPropsTable();
  }

  // 3. db.ini
  if (state.files['db.ini']) {
    const parsedDb = parseDbIni(state.files['db.ini'].data);
    state.edid.current = parsedDb.edidVal;
    state.edid.orig = parsedDb.edidVal;
    document.getElementById('txtEdidType').value = parsedDb.edidVal;

    state.natureColor.origSample = parsedDb.natureSample;
    state.natureColor.rGain = parsedDb.rGain;
    state.natureColor.gGain = parsedDb.gGain;
    state.natureColor.bGain = parsedDb.bGain;
    state.natureColor.rOffset = parsedDb.rOffset;
    state.natureColor.gOffset = parsedDb.gOffset;
    state.natureColor.bOffset = parsedDb.bOffset;
    state.natureColor.isApplied = true;

    document.getElementById('lblOrigColorSample').innerText = parsedDb.natureSample;
    document.getElementById('txtRGain').value = parsedDb.rGain;
    document.getElementById('txtGGain').value = parsedDb.gGain;
    document.getElementById('txtBGain').value = parsedDb.bGain;
    document.getElementById('txtROffset').value = parsedDb.rOffset;
    document.getElementById('txtGOffset').value = parsedDb.gOffset;
    document.getElementById('txtBOffset').value = parsedDb.bOffset;

    state.otherColorSamples = parsedDb.otherSamples;
    renderOtherColorTable();
  }
  updateColorBadges();

  // 4. Media
  if (state.files['logo.img']) {
    const sz = state.files['logo.img'].data.byteLength || state.files['logo.img'].data.length;
    state.media.origLogo = state.files['logo.img'].data;
    state.media.logoDesc = `当前文件: logo.img | 尺寸: ${(sz / 1024).toFixed(1)} KB | 状态: 未修改`;
  } else {
    state.media.origLogo = null;
    state.media.logoDesc = '当前文件: 缺省未包含 logo.img | 状态: 未修改';
  }

  if (state.files['bootanimation.zip']) {
    const sz = state.files['bootanimation.zip'].data.byteLength || state.files['bootanimation.zip'].data.length;
    state.media.origAnim = state.files['bootanimation.zip'].data;
    state.media.animDesc = `当前文件: bootanimation.zip | 尺寸: ${(sz / (1024 * 1024)).toFixed(2)} MB | 状态: 未修改`;
  } else {
    state.media.origAnim = null;
    state.media.animDesc = '当前文件: 缺省未包含 bootanimation.zip | 状态: 未修改';
  }

  state.media.idBadge = `✨ 已识别开机资源规格 (${state.files['logo.img'] ? '包含Logo' : '无Logo'}, ${state.files['bootanimation.zip'] ? '包含动画' : '无动画'})`;
  document.getElementById('lblLogoStatus').innerText = state.media.logoDesc;
  document.getElementById('lblAnimStatus').innerText = state.media.animDesc;
  document.getElementById('lblMediaIdBadge').innerText = state.media.idBadge;

  // 5. singleMode.txt
  if (state.files['singleMode.txt'] || state.files['singlemode.txt']) {
    const f = state.files['singleMode.txt'] || state.files['singlemode.txt'];
    const sm = parseSingleMode(f.data);
    state.singleMode.current = sm;
    state.singleMode.orig = sm;
    document.getElementById('lblSingleModeStatus').innerText = `当前文件: singleMode.txt | 当前模式: ${sm} | 状态: 未修改`;
  } else {
    state.singleMode.current = 'off';
    state.singleMode.orig = 'off';
    document.getElementById('lblSingleModeStatus').innerText = `当前文件: 原工程未配置 (缺省 off) | 状态: 未修改`;
  }
  updateSingleModeUI();

  // 6. Path Banner
  document.getElementById('lblPathEmpty').style.display = 'none';
  document.getElementById('pathLoadedContainer').style.display = 'flex';
  document.getElementById('lblSourcePath').innerText = state.sourceName || '本地内存工程';

  // 7. Update Dashboard & Diff & Validation
  updateDashboardView();
  updateDiffReview();
  runValidation();
}

// --- Metadata Badges & Change Tracking ---

function updateMetadataBadges() {
  const pm = document.getElementById('txtProductModel').value.trim();
  const vendor = document.getElementById('txtConfigName').value.trim();
  const screen = document.getElementById('txtConfigScreen').value.trim();
  const res = document.getElementById('txtResolution').value.trim();
  const ver = document.getElementById('txtVersion').value.trim();

  state.metadata.product_model = pm;
  state.metadata.config_name = vendor;
  state.metadata.config_screen = screen;
  state.metadata.resolution = res;
  state.metadata.panel_model_version = ver;

  const badgePm = document.getElementById('badgePm');
  const badgeVendor = document.getElementById('badgeVendor');
  const badgeScreen = document.getElementById('badgeScreen');
  const badgeRes = document.getElementById('badgeRes');
  const badgeVer = document.getElementById('badgeVer');

  if (badgePm) badgePm.style.display = (pm !== state.baselineMetadata.product_model) ? 'inline' : 'none';
  if (badgeVendor) badgeVendor.style.display = (vendor !== state.baselineMetadata.config_name) ? 'inline' : 'none';
  if (badgeScreen) badgeScreen.style.display = (screen !== state.baselineMetadata.config_screen) ? 'inline' : 'none';
  if (badgeRes) badgeRes.style.display = (res !== state.baselineMetadata.resolution) ? 'inline' : 'none';
  if (badgeVer) badgeVer.style.display = (ver !== state.baselineMetadata.panel_model_version) ? 'inline' : 'none';

  // 20-digit warning icon
  const warnPm = document.getElementById('lblPmWarn');
  if (warnPm) {
    warnPm.style.display = (pm && pm.length !== 20) ? 'inline' : 'none';
  }

  updateDashboardView();
  if (state.settings.autoValidate) runValidation();
}

// --- Props Table Rendering ---

function renderPropsTable(filterKeyword = '') {
  const tbody = document.getElementById('propsTableBody');
  tbody.innerHTML = '';

  const kw = filterKeyword.toLowerCase().trim();
  const visibleProps = state.props.filter(p => !p.isDeleted);

  // Check duplicate keys
  const keyCounts = {};
  for (const p of visibleProps) {
    keyCounts[p.key] = (keyCounts[p.key] || 0) + 1;
  }
  const duplicates = Object.keys(keyCounts).filter(k => keyCounts[k] > 1);
  const dupWarn = document.getElementById('lblDuplicateWarn');
  if (dupWarn) {
    dupWarn.innerText = duplicates.length > 0 ? `⚠️ 存在重复属性键: ${duplicates.join(', ')}` : '';
  }

  let modCount = 0;
  let addCount = 0;
  let displayedCount = 0;

  visibleProps.forEach((p, idx) => {
    const isModified = p.value !== p.origValue;
    if (isModified && !p.isNew) modCount++;
    if (p.isNew) addCount++;

    if (kw && !p.key.toLowerCase().includes(kw) && !p.value.toLowerCase().includes(kw)) {
      return;
    }
    displayedCount++;

    const tr = document.createElement('tr');
    tr.dataset.idx = idx;
    if (state.selectedRowIdx === idx) tr.classList.add('selected');

    tr.addEventListener('click', () => {
      state.selectedRowIdx = idx;
      renderPropsTable(document.getElementById('txtPropSearch').value);
    });

    const isChannel = (p.key === 'persist.hht.channel.identify');

    tr.innerHTML = `
      <td style="width: 48px; text-align: center; color: #64748b;">${idx + 1}</td>
      <td class="key-cell">
        <span>${escapeHtml(p.key)}</span>
        ${isChannel ? '<span class="badge-tag-channel">安卓平台标识码</span>' : ''}
      </td>
      <td>
        <input type="text" class="input-prop-val ${p.isNew ? 'prop-new' : (isModified ? 'prop-modified' : '')}"
          value="${escapeHtml(p.value)}" data-idx="${idx}" title="${isModified ? `【已修改】原始值: ${escapeHtml(p.origValue)}` : ''}" />
      </td>
    `;
    tbody.appendChild(tr);
  });

  const statsLbl = document.getElementById('lblChangeStats');
  if (statsLbl) {
    if (modCount > 0 || addCount > 0) {
      statsLbl.innerText = `(已修改 ${modCount} 项, 新增 ${addCount} 项)`;
      statsLbl.style.color = '#f59e0b';
    } else {
      statsLbl.innerText = '';
    }
  }

  const countLbl = document.getElementById('lblPropsCount');
  if (countLbl) {
    countLbl.innerText = `显示 ${displayedCount} / 共 ${visibleProps.length} 项属性`;
  }

  // Bind input listeners
  tbody.querySelectorAll('.input-prop-val').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      visibleProps[idx].value = e.target.value;
      renderPropsTable(document.getElementById('txtPropSearch').value);
      updateDiffReview();
      if (state.settings.autoValidate) runValidation();
    });
  });
}

// --- Color & EDID Logic ---

function updateColorBadges() {
  const edidMod = (state.edid.current !== state.edid.orig);
  document.getElementById('badgeEdid').style.display = edidMod ? 'inline' : 'none';

  const curNature = [
    state.natureColor.rGain, state.natureColor.gGain, state.natureColor.bGain,
    state.natureColor.rOffset, state.natureColor.gOffset, state.natureColor.bOffset
  ].join(', ');

  const natureMod = (curNature !== state.natureColor.origSample);
  document.getElementById('badgeColor').style.display = natureMod ? 'inline' : 'none';

  const unapplied = !state.natureColor.isApplied && natureMod;
  document.getElementById('lblUnappliedWarn').style.display = unapplied ? 'inline' : 'none';
}

function renderOtherColorTable() {
  const tbody = document.getElementById('otherColorTableBody');
  if (!tbody) return;
  tbody.querySelectorAll('tr').forEach(tr => {
    const mode = tr.dataset.mode;
    if (mode && state.otherColorSamples[mode]) {
      const cell = tr.querySelector('.other-val-cell');
      if (cell) cell.innerText = state.otherColorSamples[mode];
    }
  });
}

// --- SingleMode UI ---

function updateSingleModeUI() {
  const isMod = (state.singleMode.current !== state.singleMode.orig);
  document.getElementById('badgeSingleMode').style.display = isMod ? 'inline' : 'none';

  const statusText = isMod
    ? `当前文件: singleMode.txt | 当前模式: ${state.singleMode.current} | 状态: 已修改 (原值: ${state.singleMode.orig})`
    : `当前文件: singleMode.txt | 当前模式: ${state.singleMode.current} | 状态: 未修改`;
  document.getElementById('lblSingleModeStatus').innerText = statusText;

  const radioOn = document.getElementById('radioSmOn');
  const radioOff = document.getElementById('radioSmOff');
  const cardOn = document.getElementById('labelRadioOn');
  const cardOff = document.getElementById('labelRadioOff');

  if (state.singleMode.current === 'on') {
    radioOn.checked = true;
    cardOn.classList.add('active');
    cardOff.classList.remove('active');
  } else {
    radioOff.checked = true;
    cardOff.classList.add('active');
    cardOn.classList.remove('active');
  }
}

// --- Diff Review Collection ---

function collectModifications() {
  const mods = [];
  if (!state.isLoaded) return mods;

  // 1. Metadata
  const pmMod = state.metadata.product_model !== state.baselineMetadata.product_model;
  mods.push({
    category: '基础版控信息',
    field: '版控识别码 (product_model)',
    old: state.baselineMetadata.product_model || '(缺省留空)',
    new: state.metadata.product_model || '(缺省留空)',
    current: state.metadata.product_model || '(缺省留空)',
    is_critical: true,
    modified: pmMod
  });

  const panelMod = (state.metadata.config_name !== state.baselineMetadata.config_name) ||
                   (state.metadata.config_screen !== state.baselineMetadata.config_screen);
  const oldPanel = `${state.baselineMetadata.config_name || '缺省'}-${state.baselineMetadata.config_screen || '缺省'}`;
  const newPanel = `${state.metadata.config_name || '缺省'}-${state.metadata.config_screen || '缺省'}`;
  mods.push({
    category: '基础版控信息',
    field: '屏厂与屏型号',
    old: oldPanel,
    new: newPanel,
    current: newPanel,
    is_critical: true,
    modified: panelMod
  });

  const resMod = state.metadata.resolution !== state.baselineMetadata.resolution;
  mods.push({
    category: '基础版控信息',
    field: '物理分辨率 (resolution)',
    old: state.baselineMetadata.resolution || '(缺省留空/4K)',
    new: state.metadata.resolution || '(缺省留空/4K)',
    current: state.metadata.resolution || '(缺省留空/4K)',
    is_critical: false,
    modified: resMod
  });

  // 2. build.prop
  for (const p of state.props) {
    if (p.isDeleted) continue;
    const isCrit = p.key.toLowerCase().includes('channel') || p.key.toLowerCase().includes('identify');
    if (p.isNew) {
      mods.push({
        category: '系统属性 (build.prop)',
        field: p.key,
        old: '(新增项)',
        new: p.value,
        current: p.value,
        is_critical: isCrit,
        modified: true
      });
    } else if (p.value !== p.origValue) {
      mods.push({
        category: '系统属性 (build.prop)',
        field: p.key,
        old: p.origValue,
        new: p.value,
        current: p.value,
        is_critical: isCrit,
        modified: true
      });
    }
  }

  // 3. EDID
  const edidMod = (state.edid.current !== state.edid.orig);
  mods.push({
    category: '画质与 EDID (db.ini)',
    field: 'HDMIRXEdidType',
    old: state.edid.orig,
    new: state.edid.current,
    current: state.edid.current,
    is_critical: true,
    modified: edidMod
  });

  // 4. Color Nature
  const curNature = [
    state.natureColor.rGain, state.natureColor.gGain, state.natureColor.bGain,
    state.natureColor.rOffset, state.natureColor.gOffset, state.natureColor.bOffset
  ].join(', ');
  const natureMod = (curNature !== state.natureColor.origSample);
  mods.push({
    category: '画质与 EDID (db.ini)',
    field: '核心自然色温 (FacColorTemp_*_nature)',
    old: state.natureColor.origSample,
    new: curNature,
    current: curNature,
    is_critical: false,
    modified: natureMod
  });

  // 5. SingleMode
  const smMod = (state.singleMode.current !== state.singleMode.orig);
  mods.push({
    category: '分屏设置 (singleMode.txt)',
    field: '分屏模式开关',
    old: state.singleMode.orig,
    new: state.singleMode.current,
    current: state.singleMode.current,
    is_critical: false,
    modified: smMod
  });

  return mods;
}

function updateDiffReview() {
  const allItems = collectModifications();
  const mods = allItems.filter(m => m.modified);
  const container = document.getElementById('diffContainer');
  if (!container) return;

  if (mods.length === 0) {
    container.innerHTML = `<div style="color: #64748b; padding: 30px; text-align: center;">当前尚未发现任何修改项（配置与原始基准一致）。</div>`;
    return;
  }

  let html = `<div style="margin-bottom: 10px; font-weight: bold; color: #38bdf8;">本次共检测到 ${mods.length} 处变动项：</div>`;
  for (const m of mods) {
    html += `
      <div class="diff-card">
        <div style="font-weight: bold; color: #fbbf24; margin-bottom: 4px;">
          [${m.category}] ${escapeHtml(m.field)}
          ${m.is_critical ? '<span style="color:#ef4444; font-size:11px; margin-left:6px;">⚠️ [产线核心核对项]</span>' : ''}
        </div>
        <div class="diff-item">
          <span class="diff-old">${escapeHtml(m.old)}</span>
          <span class="diff-arrow">➔</span>
          <span class="diff-new">${escapeHtml(m.new)}</span>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
}

// --- Dashboard View Update ---

function updateDashboardView() {
  const pBox = document.getElementById('dashPropsSummary');
  if (pBox) {
    if (!state.isLoaded) {
      pBox.innerText = '当前未载入属性';
    } else {
      const pm = state.metadata.product_model || '(缺省留空)';
      const vendor = state.metadata.config_name || '缺省';
      const screen = state.metadata.config_screen || '缺省';
      const ch = state.props.find(p => p.key === 'persist.hht.channel.identify' && !p.isDeleted);
      pBox.innerText =
        `版控识别码: ${pm}\n` +
        `面板驱动: ${vendor}-${screen}\n` +
        `安卓平台标识码: ${ch ? ch.value : '(未配置)'}\n` +
        `系统属性总计: ${state.props.filter(p => !p.isDeleted).length} 项`;
    }
  }

  const cBox = document.getElementById('dashColorSummary');
  if (cBox) {
    if (!state.isLoaded) {
      cBox.innerText = '当前未载入 db.ini';
    } else {
      cBox.innerText =
        `EDID 模式: ${state.edid.current}\n` +
        `自然色温增益 (_nature): ${state.natureColor.rGain}, ${state.natureColor.gGain}, ${state.natureColor.bGain}\n` +
        `自然色温偏移: ${state.natureColor.rOffset}, ${state.natureColor.gOffset}, ${state.natureColor.bOffset}`;
    }
  }

  const mBox = document.getElementById('dashMediaSummary');
  if (mBox) {
    if (!state.isLoaded) {
      mBox.innerText = '当前未载入媒体与分屏配置';
    } else {
      mBox.innerText =
        `开机画面: ${state.media.logoDesc}\n` +
        `开机动画: ${state.media.animDesc}\n` +
        `分屏设置 (singleMode.txt): ${state.singleMode.current} (${state.singleMode.current === 'on' ? '开启' : '关闭'})`;
    }
  }
}

// --- Validation Dock Logic ---

function runValidation() {
  const list = document.getElementById('validationList');
  if (!list) return;
  list.innerHTML = '';

  const results = [];

  if (!state.isLoaded) {
    results.push({ type: 'info', icon: 'ℹ️', text: '尚未载入工程，请在上方导入 ZIP 升级包或工程目录' });
  } else {
    // 1. 工程载入状态
    results.push({ type: 'pass', icon: '✅', text: `工程解析正常 (共载入 ${Object.keys(state.files).length} 个文件与配置项)` });

    // 2. 版控识别码校验
    const pm = state.metadata.product_model;
    if (!pm) {
      results.push({ type: 'warn', icon: '⚠️', text: '版控识别码为空：请确认是否符合特定机型免识别码发版要求' });
    } else if (pm.length !== 20) {
      results.push({ type: 'warn', icon: '⚠️', text: `版控识别码非标准 20 位（当前 ${pm.length} 位），请确认 BOM 表` });
    } else {
      results.push({ type: 'pass', icon: '✅', text: `版控识别码格式合规 (标准 20 位)` });
    }

    // 3. 屏厂与型号
    if (!state.metadata.config_name && !state.metadata.config_screen) {
      results.push({ type: 'info', icon: 'ℹ️', text: '屏厂与型号缺省留空（将由系统主板驱动按默认面板加载）' });
    } else {
      results.push({ type: 'pass', icon: '✅', text: `面板驱动匹配: ${state.metadata.config_name || '缺省'}-${state.metadata.config_screen || '缺省'}` });
    }

    // 4. 分辨率
    if (!state.metadata.resolution) {
      results.push({ type: 'info', icon: 'ℹ️', text: '分辨率缺省留空（系统将自适应当前液晶模组 EDID 最佳分辨率）' });
    } else {
      results.push({ type: 'pass', icon: '✅', text: `指定屏幕物理分辨率: ${state.metadata.resolution}` });
    }

    // 5. 核心系统属性校验
    const chProp = state.props.find(p => p.key === 'persist.hht.channel.identify' && !p.isDeleted);
    if (!chProp || !chProp.value) {
      results.push({ type: 'warn', icon: '⚠️', text: '未检测到 persist.hht.channel.identify 属性，可能影响产线通道识别' });
    } else {
      results.push({ type: 'pass', icon: '✅', text: `通道识别标识正常: ${chProp.value}` });
    }

    // 6. 色温同步检查
    if (!state.natureColor.isApplied) {
      results.push({ type: 'error', icon: '❌', text: '色温已修改但未点击【一键批量同步应用】，保存或打包不会生效！' });
    }

    // 7. 变更项统计
    const allItems = collectModifications();
    const mods = allItems.filter(m => m.modified);
    if (mods.length > 0) {
      results.push({ type: 'warn', icon: '📝', text: `当前累计 ${mods.length} 项未持久化变更，发版前请在右侧或须知中仔细核对` });
    }
  }

  // Render to DOM
  for (const r of results) {
    const li = document.createElement('li');
    li.className = `val-item val-${r.type}`;
    li.innerHTML = `<span class="val-icon">${r.icon}</span><span class="val-text">${escapeHtml(r.text)}</span>`;
    list.appendChild(li);
  }
}

// --- Save to In-Memory Workspace ---

function saveToMemory() {
  if (!state.isLoaded) {
    alert('尚未载入任何工程，请先导入 ZIP 或选择工程目录！');
    return;
  }

  logConsole('正在将当前界面配置写回内存工作区...', 'info');

  // 1. hht_panel_cfg.ini
  const origHht = state.files['hht_panel_cfg.ini'] ? state.files['hht_panel_cfg.ini'].data : '';
  const newHht = serializeHhtPanelCfg(origHht, state.metadata);
  state.files['hht_panel_cfg.ini'] = { data: newHht, isBinary: false, relPath: 'hht_panel_cfg.ini' };

  // 2. build.prop
  const origProp = state.files['build.prop'] ? state.files['build.prop'].data : '';
  const newProp = serializeBuildProp(origProp, state.props);
  state.files['build.prop'] = { data: newProp, isBinary: false, relPath: 'build.prop' };

  // 3. db.ini
  if (state.files['db.ini']) {
    const curNature = [
      state.natureColor.rGain, state.natureColor.gGain, state.natureColor.bGain,
      state.natureColor.rOffset, state.natureColor.gOffset, state.natureColor.bOffset
    ].join(', ');
    const newDb = updateDbIniText(state.files['db.ini'].data, state.edid.current, curNature);
    state.files['db.ini'] = { data: newDb, isBinary: false, relPath: 'db.ini' };
  }

  // 4. singleMode.txt
  state.files['singleMode.txt'] = { data: `${state.singleMode.current}\n`, isBinary: false, relPath: 'singleMode.txt' };

  // 5. Update baselines
  state.baselineMetadata = { ...state.metadata };
  for (const p of state.props) {
    p.origValue = p.value;
    p.isNew = false;
  }
  state.props = state.props.filter(p => !p.isDeleted);
  state.edid.orig = state.edid.current;
  state.natureColor.origSample = [
    state.natureColor.rGain, state.natureColor.gGain, state.natureColor.bGain,
    state.natureColor.rOffset, state.natureColor.gOffset, state.natureColor.bOffset
  ].join(', ');
  state.natureColor.isApplied = true;
  state.singleMode.orig = state.singleMode.current;

  updateMetadataBadges();
  renderPropsTable();
  updateColorBadges();
  updateSingleModeUI();
  updateDiffReview();
  runValidation();

  logConsole('内存写回完成！所有配置文件已持久化至浏览器临时工作区。', 'success');
  showToast('已成功写回各配置文件！', 2500);
}

// --- Packaging & MD5 Download ---

async function doPackageAndDownload() {
  if (!state.isLoaded) {
    alert('尚未载入任何工程，请先导入 ZIP 或选择工程目录！');
    return;
  }

  logConsole('开始执行标准产线发版打包流程...', 'info');
  showToast('正在重新构建 PanelFiles.zip 并生成 MD5...', 3500);

  // 1. Save memory state
  saveToMemory();

  // 2. Create inner ZIP: PanelFiles
  const innerZip = new JSZip();
  for (const [name, fileObj] of Object.entries(state.files)) {
    innerZip.file(name, fileObj.data);
  }

  const innerBuf = await innerZip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  // Calculate MD5 of inner ZIP
  const spark = new SparkMD5.ArrayBuffer();
  spark.append(innerBuf);
  const innerMd5 = spark.end().toLowerCase();

  const now = new Date();
  const timeTag = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');

  const pm = state.metadata.product_model || 'DEFAULT';
  const ver = state.metadata.panel_model_version || 'V1.0.0';
  const innerZipName = `PanelFiles_${pm}_${timeTag}_${ver}.zip`;
  const md5FileName = `${innerZipName}.md5`;

  // 3. Create outer ZIP
  const outerZip = new JSZip();
  outerZip.file(innerZipName, innerBuf);
  outerZip.file(md5FileName, `${innerMd5}  ${innerZipName}\n`);

  const outerBuf = await outerZip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  const outerZipName = `Upgrade_${pm}_${timeTag}.zip`;

  // 4. Trigger download
  const blobUrl = URL.createObjectURL(outerBuf);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = outerZipName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);

  logConsole(`🎉 打包完成！生成外层升级包: ${outerZipName}`, 'success');
  logConsole(`内层文件: ${innerZipName}`, 'info');
  logConsole(`标准 MD5 校验和: ${innerMd5}`, 'warn');
  showToast(`打包成功！已触发浏览器下载`, 3500);
}

// --- Packaging Notice Dialog (Dual-Column Checklist) ---

let currentNoticeFilterMod = false;

function showPackagingNoticeDialog() {
  const allRows = collectModifications();
  const modCount = allRows.filter(r => r.modified).length;
  const unchangedCount = allRows.length - modCount;
  const critCount = allRows.filter(r => r.modified && r.is_critical).length;

  // Header badges
  const badgeCrit = document.getElementById('badgeCritMod');
  if (badgeCrit) {
    if (critCount > 0) {
      badgeCrit.innerText = `⚠️ ${critCount} 项关键改动`;
      badgeCrit.style.display = 'inline-block';
    } else {
      badgeCrit.style.display = 'none';
    }
  }

  const badgeMod = document.getElementById('badgeModCount');
  if (badgeMod) {
    if (modCount > 0) {
      badgeMod.innerText = `已修改 ${modCount} 项`;
      badgeMod.className = 'badge-mod';
    } else {
      badgeMod.innerText = '无改动';
      badgeMod.className = 'badge-unchanged';
    }
  }

  const badgeUnchanged = document.getElementById('badgeUnchangedCount');
  if (badgeUnchanged) {
    badgeUnchanged.innerText = `沿用原包 ${unchangedCount} 项`;
  }

  const btnAll = document.getElementById('btnFilterAll');
  const btnMod = document.getElementById('btnFilterMod');
  if (btnAll) btnAll.innerText = `全部 (${allRows.length})`;
  if (btnMod) btnMod.innerText = `仅看已修改 (${modCount})`;

  currentNoticeFilterMod = false;
  if (btnAll) btnAll.classList.add('active');
  if (btnMod) btnMod.classList.remove('active');

  renderNoticeTable(allRows);
  document.getElementById('modalNotice').style.display = 'flex';
}

function renderNoticeTable(allRows) {
  const tbody = document.getElementById('noticeTableBody');
  tbody.innerHTML = '';

  const displayRows = currentNoticeFilterMod ? allRows.filter(r => r.modified) : allRows;

  if (displayRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #64748b; padding: 40px 0;">ℹ️ 本次载入后未修改任何参数（将按当前原包配置直接验证并打包）。</td></tr>`;
    return;
  }

  for (const r of displayRows) {
    const tr = document.createElement('tr');
    if (r.modified && r.is_critical) {
      tr.style.backgroundColor = '#251e14';
    } else if (r.modified) {
      tr.style.backgroundColor = 'rgba(245, 158, 11, 0.08)';
    }

    const statusBadge = r.modified
      ? '<span style="color:#f59e0b; font-weight:bold;">已修改</span>'
      : '<span style="color:#64748b;">未修改</span>';

    const valHtml = r.modified
      ? `<span style="color:#f87171; text-decoration:line-through; margin-right:6px;">${escapeHtml(r.old)}</span>➔<span style="color:#4ade80; font-weight:bold; margin-left:6px;">${escapeHtml(r.new)}</span>`
      : `<span style="color:#cbd5e1;">${escapeHtml(r.current)}</span>`;

    tr.innerHTML = `
      <td style="font-weight: bold; color: #93c5fd; white-space: nowrap;">${escapeHtml(r.category)}</td>
      <td style="font-family: monospace; font-size: 13.5px; word-break: break-word;">${escapeHtml(r.field)}</td>
      <td style="text-align: center; white-space: nowrap;">${statusBadge}</td>
      <td style="font-family: monospace; font-size: 13.5px; word-break: break-word;">${valHtml}</td>
    `;
    tbody.appendChild(tr);
  }
}

function hidePackagingNoticeDialog() {
  document.getElementById('modalNotice').style.display = 'none';
}

// --- Helper Functions ---

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Event Listeners Setup ---

document.addEventListener('DOMContentLoaded', () => {
  renderRecentMenu();

  // 1. File Inputs & Import Buttons
  const fileInputZip = document.getElementById('fileInputZip');
  const btnOpenZip = document.getElementById('btnOpenZip');
  btnOpenZip.addEventListener('click', () => fileInputZip.click());
  fileInputZip.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => loadZipArrayBuffer(evt.target.result, file.name);
    reader.readAsArrayBuffer(file);
    fileInputZip.value = '';
  });

  const fileInputDir = document.getElementById('fileInputDir');
  const btnOpenFolder = document.getElementById('btnOpenFolder');
  btnOpenFolder.addEventListener('click', () => fileInputDir.click());
  fileInputDir.addEventListener('change', (e) => {
    loadDirectoryFiles(e.target.files);
    fileInputDir.value = '';
  });

  // 2. Drag & Drop onto entire window
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const f = files[0];
      if (f.name.toLowerCase().endsWith('.zip')) {
        const reader = new FileReader();
        reader.onload = (evt) => loadZipArrayBuffer(evt.target.result, f.name);
        reader.readAsArrayBuffer(f);
      } else {
        loadDirectoryFiles(files);
      }
    }
  });

  // 3. View Switcher Toggle
  const btnViewTabs = document.getElementById('btnViewTabs');
  const btnViewDash = document.getElementById('btnViewDash');
  const viewTabs = document.getElementById('viewTabsContainer');
  const viewDash = document.getElementById('viewDashContainer');

  btnViewTabs.addEventListener('click', () => {
    btnViewTabs.classList.add('active');
    btnViewDash.classList.remove('active');
    viewTabs.style.display = 'flex';
    viewDash.style.display = 'none';
  });

  btnViewDash.addEventListener('click', () => {
    btnViewDash.classList.add('active');
    btnViewTabs.classList.remove('active');
    viewTabs.style.display = 'none';
    viewDash.style.display = 'block';
    updateDashboardView();
  });

  // 4. Tab Navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.dataset.tab;
      const targetContent = document.getElementById(targetId);
      if (targetContent) targetContent.classList.add('active');
      if (targetId === 'tabDiff') updateDiffReview();
    });
  });

  // 5. Metadata inputs change tracking
  ['txtProductModel', 'txtConfigName', 'txtConfigScreen', 'txtResolution', 'txtVersion'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateMetadataBadges);
      el.addEventListener('change', updateMetadataBadges);
    }
  });

  // 6. Copy Path Buttons
  document.getElementById('btnCopySource').addEventListener('click', () => {
    const p = document.getElementById('lblSourcePath').innerText;
    navigator.clipboard.writeText(p);
    showToast('已复制原版控包标识到剪贴板！');
    logConsole(`复制路径: ${p}`, 'info');
  });

  document.getElementById('btnCopyWorkspace').addEventListener('click', () => {
    const p = document.getElementById('lblWorkspacePath').innerText;
    navigator.clipboard.writeText(p);
    showToast('已复制工作目录信息到剪贴板！');
  });

  // 7. Props: Search, Add, Delete
  const txtSearch = document.getElementById('txtPropSearch');
  txtSearch.addEventListener('input', (e) => {
    renderPropsTable(e.target.value);
  });

  document.getElementById('btnAddProp').addEventListener('click', () => {
    if (!state.isLoaded) {
      alert('尚未载入工程，请先导入 ZIP 或选择工程目录！');
      return;
    }
    const k = prompt('请输入新属性名 (例: persist.sys.demo.key):');
    if (!k || !k.trim()) return;
    const v = prompt(`请输入属性 [${k.trim()}] 的值:`) || '';
    state.props.unshift({ key: k.trim(), value: v.trim(), origValue: '', isNew: true, isDeleted: false });
    renderPropsTable(txtSearch.value);
    updateDiffReview();
    if (state.settings.autoValidate) runValidation();
  });

  document.getElementById('btnDeleteProp').addEventListener('click', () => {
    if (state.selectedRowIdx < 0 || state.selectedRowIdx >= state.props.length) {
      alert('请先在表格中点击选中要删除的属性行！');
      return;
    }
    const prop = state.props[state.selectedRowIdx];
    if (confirm(`确定要删除属性 [${prop.key}] 吗？`)) {
      prop.isDeleted = true;
      state.selectedRowIdx = -1;
      renderPropsTable(txtSearch.value);
      updateDiffReview();
      if (state.settings.autoValidate) runValidation();
    }
  });

  // 8. Tab 2 Color & EDID: Auto EDID & Batch Apply
  document.getElementById('txtEdidType').addEventListener('input', (e) => {
    state.edid.current = e.target.value.trim();
    updateColorBadges();
    updateDiffReview();
    if (state.settings.autoValidate) runValidation();
  });

  document.getElementById('btnAutoEdid').addEventListener('click', () => {
    const raw = state.edid.current || '1, 0, 0, 0';
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    let newEdid = '1, 2, 2, 0';
    if (parts.length >= 4) {
      newEdid = `${parts[0]}, 2, 2, ${parts[3]}`;
    } else if (parts.length === 3 || parts.length === 2 || parts.length === 1) {
      newEdid = `${parts[0]}, 2, 2, 0`;
    }
    state.edid.current = newEdid;
    document.getElementById('txtEdidType').value = newEdid;
    updateColorBadges();
    updateDiffReview();
    logConsole(`已执行 EDID Auto 规则: ${newEdid}`, 'success');
    showToast('已更新为 EDID Auto (x, 2, 2, x)');
    if (state.settings.autoValidate) runValidation();
  });

  ['txtRGain', 'txtGGain', 'txtBGain', 'txtROffset', 'txtGOffset', 'txtBOffset'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      state.natureColor.rGain = document.getElementById('txtRGain').value.trim();
      state.natureColor.gGain = document.getElementById('txtGGain').value.trim();
      state.natureColor.bGain = document.getElementById('txtBGain').value.trim();
      state.natureColor.rOffset = document.getElementById('txtROffset').value.trim();
      state.natureColor.gOffset = document.getElementById('txtGOffset').value.trim();
      state.natureColor.bOffset = document.getElementById('txtBOffset').value.trim();
      state.natureColor.isApplied = false;
      updateColorBadges();
      updateDiffReview();
      if (state.settings.autoValidate) runValidation();
    });
  });

  document.getElementById('btnBatchApplyNature').addEventListener('click', () => {
    state.natureColor.isApplied = true;
    updateColorBadges();
    updateDiffReview();
    logConsole('已一键同步应用核心自然色温至所有通道规则 (_nature)', 'success');
    showToast('已同步应用至所有 _nature 规则');
    if (state.settings.autoValidate) runValidation();
  });

  document.getElementById('chkUnlockOther').addEventListener('change', (e) => {
    const unlocked = e.target.checked;
    document.getElementById('btnBatchApplyOther').disabled = !unlocked;
    document.querySelectorAll('#otherColorTable .badge-lock').forEach(span => {
      span.innerText = unlocked ? '🔓 可编辑' : '🔒 只读锁定';
      span.style.color = unlocked ? '#38bdf8' : '#94a3b8';
    });
  });

  // 9. Tab 3 Media: Suite & Presets
  document.getElementById('selMediaSuite').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;
    document.getElementById('selLogoPreset').value = val;
    document.getElementById('selAnimPreset').value = val;
    state.media.logoDesc = `当前文件: logo.img | 预设: ${val} | 状态: 已选择预设套件`;
    state.media.animDesc = `当前文件: bootanimation.zip | 预设: ${val} | 状态: 已选择预设套件`;
    document.getElementById('lblLogoStatus').innerText = state.media.logoDesc;
    document.getElementById('lblAnimStatus').innerText = state.media.animDesc;
    logConsole(`已选择并同步开机套件方案: ${val}`, 'warn');
    showToast(`已套用预设方案: ${val}`);
  });

  const fileInputLogo = document.getElementById('fileInputLogo');
  document.getElementById('btnReplaceLogo').addEventListener('click', () => fileInputLogo.click());
  fileInputLogo.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.files['logo.img'] = { data: new Uint8Array(reader.result), isBinary: true, relPath: 'logo.img' };
      state.media.logoDesc = `当前文件: ${file.name} | 尺寸: ${(file.size / 1024).toFixed(1)} KB | 状态: 已自定义替换`;
      document.getElementById('lblLogoStatus').innerText = state.media.logoDesc;
      logConsole(`已替换开机 Logo: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, 'warn');
      showToast('Logo 替换成功');
    };
    reader.readAsArrayBuffer(file);
  });

  document.getElementById('btnResetLogo').addEventListener('click', () => {
    if (state.media.origLogo) {
      state.files['logo.img'] = { data: state.media.origLogo, isBinary: true, relPath: 'logo.img' };
      const sz = state.media.origLogo.byteLength || state.media.origLogo.length;
      state.media.logoDesc = `当前文件: 原生包文件 | 尺寸: ${(sz / 1024).toFixed(1)} KB | 状态: 未修改`;
    } else {
      delete state.files['logo.img'];
      state.media.logoDesc = '当前文件: 原生未包含 | 状态: 未修改';
    }
    document.getElementById('lblLogoStatus').innerText = state.media.logoDesc;
    document.getElementById('selLogoPreset').value = '';
    showToast('已恢复原包 Logo');
  });

  const fileInputAnim = document.getElementById('fileInputAnim');
  document.getElementById('btnReplaceAnim').addEventListener('click', () => fileInputAnim.click());
  fileInputAnim.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.files['bootanimation.zip'] = { data: new Uint8Array(reader.result), isBinary: true, relPath: 'bootanimation.zip' };
      state.media.animDesc = `当前文件: ${file.name} | 尺寸: ${(file.size / (1024 * 1024)).toFixed(2)} MB | 状态: 已自定义替换`;
      document.getElementById('lblAnimStatus').innerText = state.media.animDesc;
      logConsole(`已替换开机动画包: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`, 'warn');
      showToast('开机动画替换成功');
    };
    reader.readAsArrayBuffer(file);
  });

  document.getElementById('btnResetAnim').addEventListener('click', () => {
    if (state.media.origAnim) {
      state.files['bootanimation.zip'] = { data: state.media.origAnim, isBinary: true, relPath: 'bootanimation.zip' };
      const sz = state.media.origAnim.byteLength || state.media.origAnim.length;
      state.media.animDesc = `当前文件: 原生包文件 | 尺寸: ${(sz / (1024 * 1024)).toFixed(2)} MB | 状态: 未修改`;
    } else {
      delete state.files['bootanimation.zip'];
      state.media.animDesc = '当前文件: 原生未包含 | 状态: 未修改';
    }
    document.getElementById('lblAnimStatus').innerText = state.media.animDesc;
    document.getElementById('selAnimPreset').value = '';
    showToast('已恢复原包开机动画');
  });

  // 10. Tab 4 SingleMode
  document.getElementById('radioSmOn').addEventListener('change', (e) => {
    if (e.target.checked) {
      state.singleMode.current = 'on';
      updateSingleModeUI();
      updateDiffReview();
      updateDashboardView();
      if (state.settings.autoValidate) runValidation();
    }
  });

  document.getElementById('radioSmOff').addEventListener('change', (e) => {
    if (e.target.checked) {
      state.singleMode.current = 'off';
      updateSingleModeUI();
      updateDiffReview();
      updateDashboardView();
      if (state.settings.autoValidate) runValidation();
    }
  });

  document.getElementById('btnResetSingleMode').addEventListener('click', () => {
    state.singleMode.current = state.singleMode.orig;
    updateSingleModeUI();
    updateDiffReview();
    updateDashboardView();
    showToast('已恢复原包分屏设置');
    if (state.settings.autoValidate) runValidation();
  });

  // 11. Dock Actions: Validate, Save, Package, Clear Log
  document.getElementById('btnValidate').addEventListener('click', () => {
    runValidation();
    logConsole('手动执行全模块规范性与合规性校验完成', 'info');
    showToast('校验完成');
  });

  document.getElementById('btnSaveMemory').addEventListener('click', saveToMemory);

  document.getElementById('btnPackage').addEventListener('click', () => {
    showPackagingNoticeDialog();
  });

  document.getElementById('btnPackagingNotice').addEventListener('click', showPackagingNoticeDialog);
  document.getElementById('btnCloseNotice').addEventListener('click', hidePackagingNoticeDialog);
  document.getElementById('btnCancelNotice').addEventListener('click', hidePackagingNoticeDialog);
  document.getElementById('btnConfirmNoticeAndPackage').addEventListener('click', () => {
    hidePackagingNoticeDialog();
    doPackageAndDownload();
  });

  document.getElementById('btnClearLog').addEventListener('click', () => {
    document.getElementById('consoleLogBox').innerHTML = '';
  });

  // Filter in notice dialog: 全部 / 仅看已修改
  document.getElementById('btnFilterAll').addEventListener('click', () => {
    currentNoticeFilterMod = false;
    document.getElementById('btnFilterAll').classList.add('active');
    document.getElementById('btnFilterMod').classList.remove('active');
    renderNoticeTable(collectModifications());
  });

  document.getElementById('btnFilterMod').addEventListener('click', () => {
    currentNoticeFilterMod = true;
    document.getElementById('btnFilterMod').classList.add('active');
    document.getElementById('btnFilterAll').classList.remove('active');
    renderNoticeTable(collectModifications());
  });

  document.getElementById('btnCopyAllNotice').addEventListener('click', () => {
    const allRows = collectModifications();
    const lines = [
      '========================================',
      '📦 产线发版打包前修改核对与安全须知',
      '========================================',
      '【红线警示】:',
      '1. 机器一定要对上：核对标签编号与项目一致',
      '2. 确认修改并内测：与项目明确修改点，自测完最好让研发内测',
      '',
      '【产线发版 5 大核心核对清单】:',
      '1. 版控码 & 屏参配置',
      '2. EDID 配置',
      '3. 开机 Logo & 动画',
      '4. 色温色坐标',
      '5. panel.bin (98寸特殊)',
      '',
      '【本次工程核对清单】:'
    ];
    for (const r of allRows) {
      lines.push(`[${r.category}] ${r.field}: ${r.modified ? `${r.old} -> ${r.new} (已修改)` : `${r.current} (未修改)`}`);
    }
    navigator.clipboard.writeText(lines.join('\n'));
    showToast('已复制全部须知内容到剪贴板！');
  });

  // 12. Settings Modal
  const modalSettings = document.getElementById('modalSettings');
  document.getElementById('btnOpenSettings').addEventListener('click', () => {
    modalSettings.style.display = 'flex';
  });
  document.getElementById('btnCloseSettings').addEventListener('click', () => {
    modalSettings.style.display = 'none';
  });
  document.getElementById('btnSaveSettings').addEventListener('click', () => {
    state.settings.defaultVersion = document.getElementById('settingDefaultVersion').value.trim() || 'V1.0.0';
    state.settings.autoValidate = document.getElementById('settingAutoValidate').checked;
    modalSettings.style.display = 'none';
    showToast('偏好设置已保存');
  });
  document.getElementById('btnClearHistory').addEventListener('click', () => {
    localStorage.removeItem('apt_recent_projects');
    renderRecentMenu();
    showToast('历史工程记录已清空');
  });

  document.getElementById('btnRefreshDiff').addEventListener('click', () => {
    updateDiffReview();
    showToast('Diff 清单已刷新');
  });

  // Initial validation
  runValidation();
});
