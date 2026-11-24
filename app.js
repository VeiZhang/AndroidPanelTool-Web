/**
 * AndroidPanelTool Web - Pure Client-side Application Logic
 * UI aligned with Qt6 PySide6 Desktop Client
 */

// Global Application State
const state = {
  isLoaded: false,
  sourceName: '',
  sourceType: '', // 'zip' or 'dir'
  files: {}, // filename -> { data: Uint8Array|string, isBinary: boolean, relPath: string }
  baselineFiles: {}, // baseline snapshot for diffing
  metadata: {
    product_model: '',
    config_name: '', // 缺省为空
    config_screen: '', // 缺省为空
    resolution: '', // 缺省为空
    panel_model_version: 'V1.0.0'
  },
  baselineMetadata: {
    product_model: '',
    config_name: '',
    config_screen: '',
    resolution: '',
    panel_model_version: 'V1.0.0'
  },
  props: [], // array of { key, value, origValue, isNew, isDeleted }
  dbIniText: '',
  edidMode: 'auto',
  edidText: '',
  colorRgb: { r: 128, g: 128, b: 128 },
  singleMode: 'off',
  media: {
    logoDesc: '缺省',
    animDesc: '缺省'
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

// --- Parsers & Serializers ---

function parseBuildProp(text) {
  const props = [];
  const lines = text.split(/\r?\n/);
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

  // Append newly added keys
  for (const p of currentProps) {
    if (!p.isDeleted && !seenKeys.has(p.key)) {
      outputLines.push(`${p.key}=${p.value}`);
    }
  }

  return outputLines.join('\n') + '\n';
}

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
      // Check for ##product_model = xxx
      if (trimmed.startsWith('##product_model')) {
        const parts = trimmed.split('=');
        if (parts.length > 1) {
          meta.product_model = parts[1].trim();
        }
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

function parseSingleMode(text) {
  const s = (text || '').trim().toLowerCase();
  return s.includes('on') ? 'on' : 'off';
}

function parseDbIniColor(text) {
  let r = 128, g = 128, b = 128;
  const lines = (text || '').split(/\r?\n/);
  for (const l of lines) {
    const mR = l.match(/R_Gain\s*=\s*(\d+)/i);
    if (mR) r = parseInt(mR[1], 10);
    const mG = l.match(/G_Gain\s*=\s*(\d+)/i);
    if (mG) g = parseInt(mG[1], 10);
    const mB = l.match(/B_Gain\s*=\s*(\d+)/i);
    if (mB) b = parseInt(mB[1], 10);
  }
  return { r, g, b };
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
  // 1. Metadata from hht_panel_cfg.ini (缺省保持留空)
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
      panel_model_version: 'V1.0.0'
    };
    state.baselineMetadata = { ...state.metadata };
  }

  // Update inputs
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

  // 3. db.ini Color
  if (state.files['db.ini']) {
    state.colorRgb = parseDbIniColor(state.files['db.ini'].data);
    applyColorToUI();
  }

  // 4. singleMode.txt
  if (state.files['singleMode.txt'] || state.files['singlemode.txt']) {
    const f = state.files['singleMode.txt'] || state.files['singlemode.txt'];
    state.singleMode = parseSingleMode(f.data);
  } else {
    state.singleMode = 'off';
  }
  document.getElementById('radioSmOn').checked = state.singleMode === 'on';
  document.getElementById('radioSmOff').checked = state.singleMode === 'off';

  // 5. Media
  if (state.files['logo.img']) {
    const sz = state.files['logo.img'].data.byteLength || state.files['logo.img'].data.length;
    state.media.logoDesc = `鸿合定制开机镜像 (${(sz / 1024).toFixed(1)} KB)`;
  } else {
    state.media.logoDesc = '缺省';
  }
  if (state.files['bootanimation.zip']) {
    const sz = state.files['bootanimation.zip'].data.byteLength || state.files['bootanimation.zip'].data.length;
    state.media.animDesc = `开机动画包 (${(sz / (1024 * 1024)).toFixed(2)} MB)`;
  } else {
    state.media.animDesc = '缺省';
  }
  document.getElementById('lblLogoDesc').innerText = state.media.logoDesc;
  document.getElementById('lblAnimDesc').innerText = state.media.animDesc;

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

  // Toggle modified badges
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
  runValidation();
}

// --- Props Table Rendering ---

function renderPropsTable(filterKeyword = '') {
  const tbody = document.getElementById('propsTableBody');
  tbody.innerHTML = '';

  const kw = filterKeyword.toLowerCase().trim();
  const criticalKeys = ['persist.hht.channel.identify', 'ro.product.model', 'ro.build.display.id'];

  let displayedCount = 0;
  state.props.forEach((p, idx) => {
    if (p.isDeleted) return;
    if (kw && !p.key.toLowerCase().includes(kw) && !p.value.toLowerCase().includes(kw)) {
      return;
    }

    displayedCount++;
    const isCritical = criticalKeys.includes(p.key.toLowerCase());
    const isModified = p.value !== p.origValue;

    const tr = document.createElement('tr');
    if (isCritical) tr.classList.add('critical-row');

    tr.innerHTML = `
      <td style="width: 48px; text-align: center; color: #64748b;">${idx + 1}</td>
      <td class="key-cell">
        ${escapeHtml(p.key)}
        ${isCritical ? '<span style="color:#ef4444; font-size:11px; margin-left:4px;">[核心核对]</span>' : ''}
        ${p.isNew ? '<span style="color:#10b981; font-size:11px; margin-left:4px;">[新增]</span>' : ''}
        ${isModified && !p.isNew ? '<span style="color:#f59e0b; font-size:11px; margin-left:4px;">•已修改</span>' : ''}
      </td>
      <td>
        <input type="text" class="input-prop-val" value="${escapeHtml(p.value)}" data-idx="${idx}" />
      </td>
      <td style="width: 80px; text-align: center;">
        <button class="btn btn-secondary btn-del-prop" style="padding: 2px 6px; font-size: 11px; color:#f87171;" data-idx="${idx}">删除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  const countLbl = document.getElementById('lblPropsCount');
  if (countLbl) {
    countLbl.innerText = `显示 ${displayedCount} / 共 ${state.props.filter(p => !p.isDeleted).length} 项属性`;
  }

  // Bind input listeners
  tbody.querySelectorAll('.input-prop-val').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      state.props[idx].value = e.target.value;
      updateDiffReview();
      runValidation();
    });
  });

  tbody.querySelectorAll('.btn-del-prop').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      state.props[idx].isDeleted = true;
      renderPropsTable(document.getElementById('txtPropSearch').value);
      updateDiffReview();
      runValidation();
    });
  });
}

// --- Color & EDID ---

function applyColorToUI() {
  document.getElementById('rangeR').value = state.colorRgb.r;
  document.getElementById('rangeG').value = state.colorRgb.g;
  document.getElementById('rangeB').value = state.colorRgb.b;
  document.getElementById('valR').innerText = state.colorRgb.r;
  document.getElementById('valG').innerText = state.colorRgb.g;
  document.getElementById('valB').innerText = state.colorRgb.b;
  document.getElementById('colorSwatch').style.backgroundColor = `rgb(${state.colorRgb.r}, ${state.colorRgb.g}, ${state.colorRgb.b})`;
  document.getElementById('lblColorHex').innerText = `RGB(${state.colorRgb.r}, ${state.colorRgb.g}, ${state.colorRgb.b})`;
}

// --- Diff Review Collection ---

function collectModifications() {
  const mods = [];
  if (!state.isLoaded) return mods;

  // 1. Metadata
  if (state.metadata.product_model !== state.baselineMetadata.product_model) {
    mods.push({
      category: '版控识别码',
      field: 'product_model',
      old: state.baselineMetadata.product_model || '(缺省留空)',
      new: state.metadata.product_model || '(缺省留空)',
      isCritical: true
    });
  }
  if (state.metadata.config_name !== state.baselineMetadata.config_name || state.metadata.config_screen !== state.baselineMetadata.config_screen) {
    mods.push({
      category: '屏厂型号',
      field: 'panel_name',
      old: `${state.baselineMetadata.config_name || '缺省'}-${state.baselineMetadata.config_screen || '缺省'}`,
      new: `${state.metadata.config_name || '缺省'}-${state.metadata.config_screen || '缺省'}`,
      isCritical: true
    });
  }
  if (state.metadata.resolution !== state.baselineMetadata.resolution) {
    mods.push({
      category: '分辨率',
      field: 'resolution',
      old: state.baselineMetadata.resolution || '(缺省留空)',
      new: state.metadata.resolution || '(缺省留空)',
      isCritical: false
    });
  }

  // 2. Props
  for (const p of state.props) {
    if (p.isNew && !p.isDeleted) {
      mods.push({ category: '系统属性', field: p.key, old: '(新增项)', new: p.value, isCritical: false });
    } else if (p.isDeleted) {
      mods.push({ category: '系统属性', field: p.key, old: p.origValue, new: '(已删除)', isCritical: false });
    } else if (p.value !== p.origValue) {
      const isCrit = p.key.toLowerCase().includes('identify') || p.key.toLowerCase().includes('channel');
      mods.push({ category: '系统属性', field: p.key, old: p.origValue, new: p.value, isCritical: isCrit });
    }
  }

  // 3. SingleMode
  const origSm = state.baselineFiles['singleMode.txt'] ? parseSingleMode(state.baselineFiles['singleMode.txt'].data) : 'off';
  if (state.singleMode !== origSm) {
    mods.push({ category: '分屏模式', field: 'singleMode', old: origSm, new: state.singleMode, isCritical: false });
  }

  return mods;
}

function updateDiffReview() {
  const mods = collectModifications();
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
          ${m.isCritical ? '<span style="color:#ef4444; font-size:11px; margin-left:6px;">⚠️ [产线核心核对项]</span>' : ''}
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
  document.getElementById('dashPm').innerText = state.metadata.product_model || '(缺省留空)';
  document.getElementById('dashVendor').innerText = state.metadata.config_name || '(缺省留空)';
  document.getElementById('dashScreen').innerText = state.metadata.config_screen || '(缺省留空)';
  document.getElementById('dashRes').innerText = state.metadata.resolution || '(缺省留空/4K)';
  document.getElementById('dashVer').innerText = state.metadata.panel_model_version || 'V1.0.0';

  const chProp = state.props.find(p => p.key === 'persist.hht.channel.identify' && !p.isDeleted);
  document.getElementById('dashChannel').innerText = chProp ? chProp.value : '(未配置)';

  const modelProp = state.props.find(p => p.key === 'ro.product.model' && !p.isDeleted);
  document.getElementById('dashModel').innerText = modelProp ? modelProp.value : '(未配置)';

  document.getElementById('dashPropsCount').innerText = `${state.props.filter(p => !p.isDeleted).length} 项`;
  document.getElementById('dashRgb').innerText = `R:${state.colorRgb.r} G:${state.colorRgb.g} B:${state.colorRgb.b}`;
  document.getElementById('dashEdid').innerText = state.edidMode === 'auto' ? '自动匹配时序' : '自定义时序';
  document.getElementById('dashLogo').innerText = state.media.logoDesc;
  document.getElementById('dashAnim').innerText = state.media.animDesc;
  document.getElementById('dashSingleMode').innerText = `${state.singleMode} (${state.singleMode === 'on' ? '开启' : '关闭'})`;
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

    // 6. 变更项统计
    const mods = collectModifications();
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

  // 3. singleMode.txt
  state.files['singleMode.txt'] = { data: `${state.singleMode}\n`, isBinary: false, relPath: 'singleMode.txt' };

  // 4. Update baselines for saved state
  state.baselineMetadata = { ...state.metadata };
  for (const p of state.props) {
    p.origValue = p.value;
    p.isNew = false;
  }
  state.props = state.props.filter(p => !p.isDeleted);

  updateMetadataBadges();
  renderPropsTable();
  updateDiffReview();
  runValidation();

  logConsole('内存写回完成！所有配置文件已持久化至浏览器临时缓存区。', 'success');
  showToast('已成功写回内存配置文件！', 2500);
}

// --- Packaging & MD5 Download ---

async function doPackageAndDownload() {
  if (!state.isLoaded) {
    alert('尚未载入任何工程，请先导入 ZIP 或选择工程目录！');
    return;
  }

  logConsole('开始执行标准产线发版打包流程...', 'info');
  showToast('正在构建内层 PanelFiles.zip 并计算 MD5...', 3500);

  // 1. First save memory state
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

// --- Safety Notice Dialog Logic ---

function showPackagingNoticeDialog() {
  const pm = state.metadata.product_model || '(缺省留空)';
  const vendor = state.metadata.config_name || '缺省';
  const screen = state.metadata.config_screen || '缺省';
  document.getElementById('noticePm').innerText = pm;
  document.getElementById('noticePanel').innerText = `${vendor}-${screen}`;
  document.getElementById('noticeRgb').innerText = `RGB(${state.colorRgb.r}, ${state.colorRgb.g}, ${state.colorRgb.b})`;

  const mods = collectModifications();
  const container = document.getElementById('noticeDiffContainer');
  if (mods.length === 0) {
    container.innerHTML = `<div style="color: #64748b; text-align: center; padding: 15px;">本次未修改任何配置，将基于原始固件基准打包。</div>`;
  } else {
    let html = '';
    for (const m of mods) {
      html += `
        <div style="font-size:12px; margin-bottom:6px; border-bottom:1px solid #1f2937; padding-bottom:4px;">
          <strong style="color:#fbbf24;">[${m.category}] ${escapeHtml(m.field)}:</strong>
          <span style="color:#f87171; text-decoration:line-through; margin: 0 4px;">${escapeHtml(m.old)}</span>
          ➔
          <span style="color:#4ade80; font-weight:bold; margin-left:4px;">${escapeHtml(m.new)}</span>
        </div>
      `;
    }
    container.innerHTML = html;
  }

  document.getElementById('modalNotice').style.display = 'flex';
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
    showToast('已复制原版控包路径到剪贴板！');
    logConsole(`复制路径: ${p}`, 'info');
  });

  document.getElementById('btnCopyWorkspace').addEventListener('click', () => {
    const p = document.getElementById('lblWorkspacePath').innerText;
    navigator.clipboard.writeText(p);
    showToast('已复制工作目录信息到剪贴板！');
  });

  // 7. Props search and add
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
    runValidation();
  });

  // 8. Color sliders
  ['rangeR', 'rangeG', 'rangeB'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      state.colorRgb.r = parseInt(document.getElementById('rangeR').value, 10);
      state.colorRgb.g = parseInt(document.getElementById('rangeG').value, 10);
      state.colorRgb.b = parseInt(document.getElementById('rangeB').value, 10);
      applyColorToUI();
      updateDashboardView();
      runValidation();
    });
  });

  // 9. SingleMode radio
  document.getElementById('radioSmOff').addEventListener('change', (e) => {
    if (e.target.checked) {
      state.singleMode = 'off';
      updateDiffReview();
      updateDashboardView();
    }
  });
  document.getElementById('radioSmOn').addEventListener('change', (e) => {
    if (e.target.checked) {
      state.singleMode = 'on';
      updateDiffReview();
      updateDashboardView();
    }
  });

  // 10. Replace Media
  const fileInputLogo = document.getElementById('fileInputLogo');
  document.getElementById('btnReplaceLogo').addEventListener('click', () => fileInputLogo.click());
  fileInputLogo.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.files['logo.img'] = { data: new Uint8Array(reader.result), isBinary: true, relPath: 'logo.img' };
      state.media.logoDesc = `已替换为自定义镜像 (${(file.size / 1024).toFixed(1)} KB)`;
      document.getElementById('lblLogoDesc').innerText = state.media.logoDesc;
      logConsole(`已替换开机 Logo: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, 'warn');
      showToast('Logo 替换成功');
    };
    reader.readAsArrayBuffer(file);
  });

  const fileInputAnim = document.getElementById('fileInputAnim');
  document.getElementById('btnReplaceAnim').addEventListener('click', () => fileInputAnim.click());
  fileInputAnim.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.files['bootanimation.zip'] = { data: new Uint8Array(reader.result), isBinary: true, relPath: 'bootanimation.zip' };
      state.media.animDesc = `已替换为自定义动画包 (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
      document.getElementById('lblAnimDesc').innerText = state.media.animDesc;
      logConsole(`已替换开机动画包: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`, 'warn');
      showToast('开机动画替换成功');
    };
    reader.readAsArrayBuffer(file);
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

  // 12. Reset Project
  document.getElementById('btnResetProject').addEventListener('click', () => {
    if (!confirm('确定要重置当前工程并清空所有未保存的修改吗？')) return;
    state.isLoaded = false;
    state.sourceName = '';
    state.files = {};
    state.baselineFiles = {};
    state.metadata = {
      product_model: '',
      config_name: '',
      config_screen: '',
      resolution: '',
      panel_model_version: 'V1.0.0'
    };
    state.baselineMetadata = { ...state.metadata };
    state.props = [];

    document.getElementById('txtProductModel').value = '';
    document.getElementById('txtConfigName').value = '';
    document.getElementById('txtConfigScreen').value = '';
    document.getElementById('txtResolution').value = '';
    document.getElementById('txtVersion').value = 'V1.0.0';

    updateMetadataBadges();
    renderPropsTable();

    document.getElementById('lblPathEmpty').style.display = 'block';
    document.getElementById('pathLoadedContainer').style.display = 'none';

    updateDashboardView();
    updateDiffReview();
    runValidation();
    logConsole('工程已重置为初始空白状态', 'info');
    showToast('工程已重置');
  });

  document.getElementById('btnRefreshDiff').addEventListener('click', () => {
    updateDiffReview();
    showToast('Diff 清单已刷新');
  });

  // Initial validation
  runValidation();
});
