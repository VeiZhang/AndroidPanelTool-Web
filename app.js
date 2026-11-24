/**
 * AndroidPanelTool Web Application Logic
 * Pure client-side execution using HTML5 File APIs, JSZip, and SparkMD5.
 */

// Global State
const state = {
  sourceName: '',
  sourceType: '', // 'zip' or 'dir'
  files: {}, // filename -> { data: Uint8Array|string, isBinary: boolean }
  baselineFiles: {}, // snapshot for diff comparison
  metadata: {
    product_model: '',
    config_name: 'AUO',
    config_screen: '',
    resolution: '4K',
    panel_model_version: 'V1.0.0'
  },
  props: [], // array of { key, value, origValue, isNew, isDeleted }
  dbIniText: '',
  edidMode: 'auto',
  edidText: 'auto',
  colorRgb: { r: 128, g: 128, b: 128 },
  singleMode: 'off',
  media: {
    logoDesc: '未导入',
    animDesc: '未导入'
  }
};

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
    config_name: 'AUO',
    config_screen: '',
    resolution: '4K',
    panel_model_version: 'V1.0.0'
  };

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('##') || !trimmed.includes('=')) continue;
    const [kPart, vPart] = trimmed.substring(2).split('=', 2);
    const k = (kPart || '').trim().toLowerCase();
    const v = (vPart || '').trim();

    if (k === 'product_model') meta.product_model = v;
    else if (k === 'panel_model_version') meta.panel_model_version = v;
    else if (k === 'resolution') meta.resolution = v;
    else if (k === 'panel_name') {
      let pname = v;
      if (pname.toUpperCase().endsWith('-4K')) {
        meta.resolution = '4K';
        pname = pname.substring(0, pname.length - 3);
      } else if (pname.toUpperCase().endsWith('-2K')) {
        meta.resolution = '2K';
        pname = pname.substring(0, pname.length - 3);
      }
      if (pname.includes('-')) {
        const [vendor, screen] = pname.split('-');
        meta.config_name = vendor;
        meta.config_screen = screen;
      } else {
        meta.config_name = pname;
      }
    }
  }
  return meta;
}

function serializeHhtPanelCfg(origText, meta) {
  const pName = `${meta.config_name}-${meta.config_screen || 'PANEL'}-${meta.resolution}`;
  const lines = (origText || '').split(/\r?\n/);
  const updatedLines = [];
  const handledKeys = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('##') && trimmed.includes('=')) {
      const k = trimmed.substring(2).split('=')[0].trim().toLowerCase();
      if (k === 'product_model') {
        updatedLines.push(`##product_model = ${meta.product_model}`);
        handledKeys.add('product_model');
      } else if (k === 'panel_name') {
        updatedLines.push(`##panel_name = ${pName}`);
        handledKeys.add('panel_name');
      } else if (k === 'panel_model_version') {
        updatedLines.push(`##panel_model_version = ${meta.panel_model_version}`);
        handledKeys.add('panel_model_version');
      } else {
        updatedLines.push(line);
      }
    } else {
      updatedLines.push(line);
    }
  }

  if (!handledKeys.has('product_model')) {
    updatedLines.unshift(`##product_model = ${meta.product_model}`);
  }
  return updatedLines.join('\n') + '\n';
}

function parseSingleMode(text) {
  const s = (text || '').trim().toLowerCase();
  return s.includes('on') ? 'on' : 'off';
}

// --- ZIP Operations ---

async function loadZipArrayBuffer(buffer, filename) {
  showToast('正在解压并解析升级包...', 2000);
  const zip = await JSZip.loadAsync(buffer);
  state.sourceName = filename;
  state.sourceType = 'zip';
  state.files = {};

  // Check if this is an outer zip containing PanelFiles.zip
  let innerZipFile = null;
  zip.forEach((relPath, fileObj) => {
    if (relPath.toLowerCase().endsWith('panelfiles.zip')) {
      innerZipFile = fileObj;
    }
  });

  let targetZip = zip;
  if (innerZipFile) {
    const innerBuf = await innerZipFile.async('arraybuffer');
    targetZip = await JSZip.loadAsync(innerBuf);
  }

  // Read files from target zip
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

  // Snapshot baseline for diff
  state.baselineFiles = {};
  for (const [k, v] of Object.entries(state.files)) {
    state.baselineFiles[k] = { ...v };
  }

  applyLoadedFilesToUI();
  showToast('工程解析载入成功！', 3000);
}

function applyLoadedFilesToUI() {
  // 1. Metadata from hht_panel_cfg.ini
  if (state.files['hht_panel_cfg.ini']) {
    const meta = parseHhtPanelCfg(state.files['hht_panel_cfg.ini'].data);
    state.metadata = meta;
    document.getElementById('txtProductModel').value = meta.product_model || '';
    document.getElementById('selConfigName').value = meta.config_name || 'AUO';
    document.getElementById('txtConfigScreen').value = meta.config_screen || '';
    document.getElementById('selResolution').value = meta.resolution || '4K';
    document.getElementById('txtVersion').value = meta.panel_model_version || 'V1.0.0';
  }

  // 2. Props from build.prop
  if (state.files['build.prop']) {
    state.props = parseBuildProp(state.files['build.prop'].data);
    renderPropsTable();
  }

  // 3. SingleMode.txt
  if (state.files['singleMode.txt'] || state.files['singlemode.txt']) {
    const f = state.files['singleMode.txt'] || state.files['singlemode.txt'];
    state.singleMode = parseSingleMode(f.data);
    document.getElementById('radioSmOn').checked = state.singleMode === 'on';
    document.getElementById('radioSmOff').checked = state.singleMode === 'off';
  }

  // 4. Media descriptions
  if (state.files['logo.img']) {
    const sz = state.files['logo.img'].data.byteLength || state.files['logo.img'].data.length;
    state.media.logoDesc = `鸿合定制开机镜像 (${(sz / 1024).toFixed(1)} KB)`;
  } else {
    state.media.logoDesc = '缺省';
  }
  if (state.files['bootanimation.zip']) {
    const sz = state.files['bootanimation.zip'].data.byteLength || state.files['bootanimation.zip'].data.length;
    state.media.animDesc = `开机动画资源包 (${(sz / (1024 * 1024)).toFixed(2)} MB)`;
  } else {
    state.media.animDesc = '缺省';
  }

  document.getElementById('lblLogoDesc').innerText = state.media.logoDesc;
  document.getElementById('lblAnimDesc').innerText = state.media.animDesc;

  // Path banner
  document.getElementById('lblSourcePath').innerText = state.sourceName || '本地内存工程';
  document.getElementById('pathBanner').style.display = 'flex';

  updateDiffReview();
}

// --- Render Table ---

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
      <td style="width: 40px; text-align: center; color: #64748b;">${idx + 1}</td>
      <td class="key-cell">
        ${p.key}
        ${isCritical ? '<span style="color:#ef4444; font-size:11px; margin-left:4px;">[核心核对]</span>' : ''}
        ${p.isNew ? '<span style="color:#10b981; font-size:11px; margin-left:4px;">[新增]</span>' : ''}
      </td>
      <td>
        <input type="text" class="val-cell-input" data-idx="${idx}" value="${escapeHtml(p.value)}" />
      </td>
      <td style="width: 80px; text-align: center;">
        <button class="btn btn-secondary btn-del-prop" data-idx="${idx}" style="padding: 2px 8px; font-size: 11.5px; color:#ef4444;">删除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('lblPropsCount').innerText = `共 ${state.props.filter(p => !p.isDeleted).length} 项属性 (显示 ${displayedCount} 项)`;

  // Attach input events
  tbody.querySelectorAll('.val-cell-input').forEach(input => {
    input.addEventListener('input', e => {
      const i = parseInt(e.target.dataset.idx, 10);
      state.props[i].value = e.target.value;
      updateDiffReview();
    });
  });

  tbody.querySelectorAll('.btn-del-prop').forEach(btn => {
    btn.addEventListener('click', e => {
      const i = parseInt(e.target.dataset.idx, 10);
      state.props[i].isDeleted = true;
      renderPropsTable(document.getElementById('txtPropSearch').value);
      updateDiffReview();
    });
  });
}

// --- Collect Diffs ---

function collectModifications() {
  const mods = [];

  // 1. Metadata
  const origMeta = state.files['hht_panel_cfg.ini'] ? parseHhtPanelCfg(state.baselineFiles['hht_panel_cfg.ini'].data) : null;
  if (origMeta) {
    if (state.metadata.product_model !== origMeta.product_model) {
      mods.push({
        category: '版控识别码',
        field: 'product_model',
        old: origMeta.product_model,
        new: state.metadata.product_model,
        isCritical: true
      });
    }
    if (state.metadata.config_name !== origMeta.config_name || state.metadata.config_screen !== origMeta.config_screen) {
      mods.push({
        category: '屏厂型号',
        field: 'panel_name',
        old: `${origMeta.config_name}-${origMeta.config_screen}`,
        new: `${state.metadata.config_name}-${state.metadata.config_screen}`,
        isCritical: false
      });
    }
    if (state.metadata.resolution !== origMeta.resolution) {
      mods.push({
        category: '分辨率',
        field: 'resolution',
        old: origMeta.resolution,
        new: state.metadata.resolution,
        isCritical: false
      });
    }
  }

  // 2. Props
  for (const p of state.props) {
    if (p.isNew && !p.isDeleted) {
      mods.push({ category: '系统属性', field: p.key, old: '(新增)', new: p.value, isCritical: false });
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
    container.innerHTML = `<div style="color: #64748b; padding: 20px; text-align: center;">当前尚未发现与原始升级包有任何修改项（配置保持原样）。</div>`;
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

// --- Packaging & Downloading ---

async function doPackageAndDownload() {
  showToast('正在重新构建 PanelFiles.zip 并生成 MD5...', 3000);

  // 1. Serialize updated text files into zip
  const panelZip = new JSZip();

  // hht_panel_cfg.ini
  const origHht = state.files['hht_panel_cfg.ini'] ? state.files['hht_panel_cfg.ini'].data : '';
  const newHht = serializeHhtPanelCfg(origHht, state.metadata);
  panelZip.file('hht_panel_cfg.ini', newHht);

  // build.prop
  const origProp = state.files['build.prop'] ? state.files['build.prop'].data : '';
  const newProp = serializeBuildProp(origProp, state.props);
  panelZip.file('build.prop', newProp);

  // singleMode.txt
  panelZip.file('singleMode.txt', `${state.singleMode}\n`);

  // db.ini
  if (state.files['db.ini']) {
    panelZip.file('db.ini', state.files['db.ini'].data);
  }

  // Media binaries
  if (state.files['logo.img']) {
    panelZip.file('logo.img', state.files['logo.img'].data);
  }
  if (state.files['bootanimation.zip']) {
    panelZip.file('bootanimation.zip', state.files['bootanimation.zip'].data);
  }

  // Generate PanelFiles.zip buffer
  const panelZipBuffer = await panelZip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  // Calculate MD5 of PanelFiles.zip
  const spark = new SparkMD5.ArrayBuffer();
  spark.append(panelZipBuffer);
  const md5Hash = spark.end().toLowerCase();

  // 2. Build Outer ZIP Package
  const outerZip = new JSZip();
  outerZip.file('PanelFiles.zip', panelZipBuffer);
  outerZip.file('PanelFiles.md5', md5Hash);

  const finalZipBuffer = await outerZip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  // Trigger download
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const pName = state.metadata.product_model || 'Android_PanelConfig';
  const outFileName = `${pName}_${timestamp}.zip`;

  const link = document.createElement('a');
  link.href = URL.createObjectURL(finalZipBuffer);
  link.download = outFileName;
  link.click();

  showToast(`✅ 产线升级包已成功打包下载: ${outFileName}`, 5000);
}

// --- UI Helpers ---

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg, duration = 3000) {
  let toast = document.getElementById('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      background: #064e3b; color: #ecfdf5; border: 1px solid #10b981;
      border-radius: 6px; padding: 10px 18px; font-weight: bold; font-size: 13.5px;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5); transition: opacity 0.3s;
    `;
    document.body.appendChild(toast);
  }
  toast.innerText = msg;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, duration);
}

// --- Event Listeners Initialization ---

document.addEventListener('DOMContentLoaded', () => {
  // 1. Tab Navigation
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.dataset.tab;
      document.getElementById(targetId).classList.add('active');

      if (targetId === 'tabDiff') {
        updateDiffReview();
      }
    });
  });

  // 2. ZIP File Input
  const fileInput = document.getElementById('fileInputZip');
  document.getElementById('btnImportZip').addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    await loadZipArrayBuffer(buf, file.name);
    fileInput.value = '';
  });

  // 3. Search Prop Filter
  document.getElementById('txtPropSearch').addEventListener('input', e => {
    renderPropsTable(e.target.value);
  });

  // 4. Metadata Inputs
  ['txtProductModel', 'selConfigName', 'txtConfigScreen', 'selResolution', 'txtVersion'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      state.metadata.product_model = document.getElementById('txtProductModel').value.trim();
      state.metadata.config_name = document.getElementById('selConfigName').value;
      state.metadata.config_screen = document.getElementById('txtConfigScreen').value.trim();
      state.metadata.resolution = document.getElementById('selResolution').value;
      state.metadata.panel_model_version = document.getElementById('txtVersion').value.trim();
      updateDiffReview();
    });
  });

  // 5. Single Mode Radios
  document.getElementById('radioSmOn').addEventListener('change', () => {
    state.singleMode = 'on';
    updateDiffReview();
  });
  document.getElementById('radioSmOff').addEventListener('change', () => {
    state.singleMode = 'off';
    updateDiffReview();
  });

  // 6. Packaging & Safety Notice Modal
  const modalNotice = document.getElementById('modalNotice');
  document.getElementById('btnPackagingNotice').addEventListener('click', () => {
    modalNotice.classList.add('open');
  });
  document.getElementById('btnCloseNotice').addEventListener('click', () => {
    modalNotice.classList.remove('open');
  });

  // 7. Packaging Confirm Modal
  const modalConfirm = document.getElementById('modalConfirmPackage');
  document.getElementById('btnPackage').addEventListener('click', () => {
    const mods = collectModifications();
    const listContainer = document.getElementById('confirmModList');

    if (mods.length === 0) {
      listContainer.innerHTML = '<div style="color:#10b981;">本次未检测到任何参数修改，将原样打包为标准固件包。</div>';
    } else {
      let h = '<div style="margin-bottom:8px; font-weight:bold;">本次发版包含以下配置变更：</div>';
      for (const m of mods) {
        h += `<div style="padding:4px 0; border-bottom:1px solid #1f2937;">• <b>${m.category} - ${escapeHtml(m.field)}</b>: <span style="color:#ef4444;">${escapeHtml(m.old)}</span> ➔ <span style="color:#10b981;">${escapeHtml(m.new)}</span></div>`;
      }
      listContainer.innerHTML = h;
    }

    modalConfirm.classList.add('open');
  });

  document.getElementById('btnCancelConfirm').addEventListener('click', () => {
    modalConfirm.classList.remove('open');
  });

  document.getElementById('btnExecutePackage').addEventListener('click', async () => {
    modalConfirm.classList.remove('open');
    await doPackageAndDownload();
  });

  // 8. Add Prop Button
  document.getElementById('btnAddProp').addEventListener('click', () => {
    const k = prompt('请输入新属性键名 (Key):', 'persist.vendor.');
    if (!k || !k.trim()) return;
    const v = prompt(`请输入 [${k.trim()}] 的属性值 (Value):`, '');
    if (v === null) return;
    state.props.unshift({ key: k.trim(), value: v.trim(), origValue: '', isNew: true, isDeleted: false });
    renderPropsTable(document.getElementById('txtPropSearch').value);
    updateDiffReview();
    showToast(`已新增属性: ${k.trim()}`);
  });

  // 9. Window Drag and Drop support
  window.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.toLowerCase().endsWith('.zip')) {
        const buf = await file.arrayBuffer();
        await loadZipArrayBuffer(buf, file.name);
      } else {
        showToast('请拖入 .zip 格式的屏参升级包文件');
      }
    }
  });
});
