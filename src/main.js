import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { parseBlob } from 'music-metadata';
import JSZip from 'jszip';
import { parseUserTrackList } from './tracklist-parser.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const SUPPORTED_INPUTS = new Set(['wav', 'flac', 'mp3', 'ape']);
const CORE_BASES = [
  // Vite must use the ESM build. The UMD build can fail with
  // `failed to import ffmpeg-core.js` inside the module worker.
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
  // Fallback CDN in case jsDelivr is unavailable on the user's network.
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm',
];

const state = {
  tracks: [],
  selectedId: null,
  nextId: 1,
  ffmpeg: null,
  engineReady: false,
  busy: false,
  activeAudioUrl: null,
  activeAudioIsPreview: false,
  lastLogs: [],
  splitMode: 'list',
  splitSegments: [],
  cueData: null,
  page: 'home',
  jobs: [],
  taskNextId: 1,
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function formatTime(seconds, decimals = false) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const base = hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  if (!decimals) return base;
  return `${base}.${String(Math.round((seconds % 1) * 1000)).padStart(3, '0')}`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function showToast(message, type = 'info') {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast visible ${type}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3600);
}

function getSelectedTrack() {
  return state.tracks.find((track) => track.id === state.selectedId) || null;
}

function updateButtons() {
  const selected = !!getSelectedTrack();
  $('trimExportBtn').disabled = !selected || state.busy;
  $('mergeExportBtn').disabled = state.tracks.length === 0 || state.busy;
  $('clearAllBtn').disabled = state.tracks.length === 0 || state.busy;
  $('fileInput').disabled = state.busy;
  $('waveformBtn').disabled = !selected || state.busy;
  $('convertPreviewBtn').disabled = !selected || state.busy;
  $('resetTrimBtn').disabled = !selected || state.busy;
  $('startInput').disabled = !selected || state.busy;
  $('endInput').disabled = !selected || state.busy;
  $('previewSplitBtn').disabled = !selected || state.busy;
  $('exportSplitBtn').disabled = !selected || state.splitSegments.length === 0 || state.busy;
  $('cueFileInput').disabled = state.busy;
  $('cueImportBtn').disabled = state.busy;
  $('applyCueCurrentBtn').disabled = !selected || !state.cueData || state.busy;
  $('clearCueBtn').disabled = !state.cueData || state.busy;
  $('convertBatchBtn').disabled = state.tracks.length === 0 || state.busy;
}

function updateTrackCount() {
  $('trackCount').textContent = String(state.tracks.length);
  updateButtons();
}

function renderTracks() {
  const list = $('trackList');
  if (state.tracks.length === 0) {
    list.innerHTML = '<div class="empty-list"><div class="empty-symbol">♫</div><strong>还没有添加音频</strong><p>添加一个或多个文件后，即可开始编辑。</p></div>';
    updateTrackCount();
    refreshStudioUI();
    return;
  }

  list.innerHTML = state.tracks.map((track, index) => {
    const selected = track.id === state.selectedId;
    const cut = track.duration > 0 && (track.trimStart > 0 || track.trimEnd < track.duration - 0.01);
    const ext = track.ext.toUpperCase();
    return `<article class="track-card ${selected ? 'selected' : ''}" data-track-id="${track.id}" tabindex="0" aria-label="选择 ${escapeHtml(track.name)}">
      <div class="track-type type-${track.ext}">${escapeHtml(ext)}</div>
      <div class="track-main"><div class="track-name" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</div><div class="track-sub"><span>${formatTime(track.duration)}</span><span class="meta-dot">·</span><span>${formatSize(track.size)}</span>${cut ? '<span class="cut-chip">已设裁剪</span>' : ''}</div></div>
      <div class="track-actions"><button class="icon-button" data-action="up" data-id="${track.id}" title="上移" aria-label="上移" ${index === 0 || state.busy ? 'disabled' : ''}>↑</button><button class="icon-button" data-action="down" data-id="${track.id}" title="下移" aria-label="下移" ${index === state.tracks.length - 1 || state.busy ? 'disabled' : ''}>↓</button><button class="icon-button remove-button" data-action="remove" data-id="${track.id}" title="移除" aria-label="移除" ${state.busy ? 'disabled' : ''}>×</button></div>
    </article>`;
  }).join('');
  updateTrackCount();
  refreshStudioUI();
}

function updateTrimVisual() {
  const track = getSelectedTrack();
  if (!track || !track.duration || !$('waveImage').src || $('waveImage').hidden) {
    $('trimOverlay').hidden = true;
    return;
  }
  const start = Math.max(0, Math.min(track.duration, track.trimStart));
  const end = Math.max(start, Math.min(track.duration, track.trimEnd));
  $('trimOverlay').style.left = `${(start / track.duration) * 100}%`;
  $('trimOverlay').style.width = `${((end - start) / track.duration) * 100}%`;
  $('trimOverlay').hidden = false;
}

function updateDurationLabels(track) {
  $('durationLabel').textContent = `总时长 ${formatTime(track.duration)}`;
  $('endTimeLabel').textContent = formatTime(track.duration);
  $('midTimeLabel').textContent = formatTime(track.duration / 2);
  $('selectionDuration').textContent = formatTime(Math.max(0, track.trimEnd - track.trimStart), true);
}


function updateSplitSource(track = getSelectedTrack()) {
  if (!track) {
    $('splitSourceName').textContent = '请先从左侧选择一段音频';
    $('splitSourceDuration').textContent = '总时长 —';
    return;
  }
  $('splitSourceName').textContent = track.name;
  $('splitSourceDuration').textContent = `总时长 ${formatTime(track.duration)}`;
}

function renderSplitSegments() {
  const list = $('splitSegmentList');
  $('splitPartCount').textContent = `${state.splitSegments.length} 段`;
  if (!state.splitSegments.length) {
    list.innerHTML = '<div class="split-empty"><span>⌁</span><strong>等待生成预览</strong><p>选择音频并设置分段秒数后，点击“生成分段预览”。</p></div>';
  } else {
    list.innerHTML = state.splitSegments.map((segment, index) => `
      <div class="split-segment-row">
        <div class="split-segment-index">${escapeHtml(String(segment.number || String(index + 1).padStart(2, '0')))}</div>
        <div class="split-segment-times"><strong>${formatTime(segment.start, true)} — ${formatTime(segment.end, true)}</strong><small>${segment.title ? `曲目 ${escapeHtml(String(segment.number || String(index + 1).padStart(2, '0')))} · ${escapeHtml(segment.title)}` : `第 ${index + 1} 段`} · ${formatTime(segment.duration, true)}</small></div>
        <div class="split-segment-duration">${(segment.duration).toFixed(2)} s</div>
      </div>`).join('');
  }
  const note = $('trackListNotice');
  const firstSong = state.splitSegments.find((segment) => segment.fromList && segment.number !== '00');
  if (state.splitMode === 'list' && firstSong && firstSong.start > 0) {
    const formatted = formatTime(firstSong.start);
    note.hidden = false;
    note.textContent = $('includeIntroCheck').checked
      ? `已将 00:00–${formatted} 保留为“00 - 片头（未命名）”；后面的歌曲按照清单断点正常切分。`
      : `开头 00:00–${formatted} 未包含在曲目清单中，默认不导出。如果希望保留，请勾选“保留首曲之前的片头”。`;
  } else {
    note.hidden = true;
    note.textContent = '';
  }
  updateButtons();
}

function cueBasename(path) {
  return String(path || '').replace(/\\/g, '/').split('/').pop().trim();
}

function cueUnquote(value) {
  const input = String(value || '').trim();
  const quoted = input.match(/^"((?:[^"]|"")*)"/);
  if (quoted) return quoted[1].replace(/""/g, '"').replace(/\\"/g, '"');
  return input.split(/\s+/)[0] || '';
}

function cueTimeToFrames(value) {
  const match = String(value || '').trim().match(/^(\d+):([0-5]\d):([0-7]\d)$/);
  if (!match) throw new Error(`无法识别 CUE 时间码“${value}”，应为 mm:ss:ff。`);
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const frames = Number(match[3]);
  if (frames >= 75) throw new Error(`CUE 帧数必须小于 75：${value}`);
  return (minutes * 60 + seconds) * 75 + frames;
}

async function readCueText(file) {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, '');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return utf8;
  }
}

function parseCueText(text, cueFileName) {
  let albumTitle = '';
  let albumPerformer = '';
  let currentFile = '';
  let currentTrack = null;
  const tracks = [];
  const fileRefs = new Set();

  for (const rawLine of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;

    let match = line.match(/^FILE\s+(.+?)\s+([A-Z0-9]+)\s*$/i);
    if (match) {
      currentFile = cueUnquote(match[1]);
      if (currentFile) fileRefs.add(currentFile);
      continue;
    }

    match = line.match(/^TRACK\s+(\d+)\s+([A-Z0-9]+)\s*$/i);
    if (match) {
      currentTrack = {
        number: String(match[1]).padStart(2, '0'),
        type: match[2].toUpperCase(),
        fileName: currentFile,
        title: '',
        performer: '',
        index00: null,
        index01: null,
      };
      tracks.push(currentTrack);
      continue;
    }

    match = line.match(/^TITLE\s+(.+)$/i);
    if (match) {
      const title = cueUnquote(match[1]);
      if (currentTrack) currentTrack.title = title;
      else albumTitle = title;
      continue;
    }

    match = line.match(/^PERFORMER\s+(.+)$/i);
    if (match) {
      const performer = cueUnquote(match[1]);
      if (currentTrack) currentTrack.performer = performer;
      else albumPerformer = performer;
      continue;
    }

    match = line.match(/^INDEX\s+(00|01)\s+(\d{2}:\d{2}:\d{2})\s*$/i);
    if (match && currentTrack) {
      const frames = cueTimeToFrames(match[2]);
      if (match[1] === '00') currentTrack.index00 = frames;
      if (match[1] === '01') currentTrack.index01 = frames;
    }
  }

  const audioTracks = tracks.filter((track) => track.type === 'AUDIO');
  if (!audioTracks.length) throw new Error('CUE 文件中没有找到 AUDIO 曲目。');
  if (!fileRefs.size || audioTracks.some((track) => !track.fileName)) {
    throw new Error('这个 CUE 文件缺少 FILE 音频文件声明，无法自动匹配整轨音频。');
  }
  if (fileRefs.size > 1) {
    throw new Error('当前版本支持“单个整轨音频 + CUE 断点”模式；此 CUE 引用了多个音频文件，请先使用对应的整轨 CUE 文件。');
  }
  if (audioTracks.some((track) => track.index01 === null)) {
    throw new Error('CUE 中有曲目缺少 INDEX 01 起始时间，无法准确分轨。');
  }
  audioTracks.sort((a, b) => Number(a.number) - Number(b.number));
  for (let i = 1; i < audioTracks.length; i += 1) {
    if (audioTracks[i].index01 <= audioTracks[i - 1].index01) {
      throw new Error('CUE 曲目的 INDEX 01 时间没有严格递增，请检查 CUE 文件。');
    }
  }

  return {
    cueFileName,
    fileName: [...fileRefs][0],
    albumTitle,
    performer: albumPerformer,
    tracks: audioTracks,
    sourceTrackId: null,
  };
}

function buildCueSegments(track, cueData) {
  if (!track || !cueData) throw new Error('请先导入 CUE 文件并选择对应的整轨音频。');
  if (!Number.isFinite(track.duration) || track.duration <= 0) {
    throw new Error('当前音频的总时长尚未读取成功，暂时无法应用 CUE 断点。');
  }

  const cueTracks = cueData.tracks;
  const starts = cueTracks.map((cueTrack) => cueTrack.index01 / 75);
  const duration = track.duration;
  if (starts[0] >= duration) throw new Error('CUE 第一首歌的起始时间超出音频总时长。');
  if (starts.some((start) => start >= duration)) {
    throw new Error('CUE 中至少有一个曲目起始时间超出音频总时长，请确认 CUE 与音频匹配。');
  }

  return cueTracks.map((cueTrack, index) => {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : duration;
    if (end <= start) throw new Error(`CUE 第 ${cueTrack.number} 首的起止时间无效。`);
    return {
      start,
      end,
      duration: end - start,
      number: cueTrack.number,
      title: cueTrack.title || `Track ${cueTrack.number}`,
      performer: cueTrack.performer || cueData.performer || '',
      album: cueData.albumTitle || '',
      fromCue: true,
    };
  });
}

function findCueSourceTrack() {
  if (!state.cueData) return null;
  const targetName = cueBasename(state.cueData.fileName).toLocaleLowerCase();
  const exact = state.tracks.find((track) => track.name.toLocaleLowerCase() === targetName);
  if (exact) return { track: exact, exact: true };
  if (state.tracks.length === 1) return { track: state.tracks[0], exact: false };
  return null;
}

function activateCueForTrack(track, exactMatch = true, notify = true) {
  if (!track || !state.cueData) return;
  state.cueData.sourceTrackId = track.id;
  if (state.selectedId !== track.id) selectTrack(track.id);
  setSplitMode('cue');
  const expected = cueBasename(state.cueData.fileName);
  $('cueStatus').textContent = `${state.cueData.cueFileName} · ${state.cueData.tracks.length} 首曲目 · 音频：${track.name}`;
  $('cueSummary').hidden = false;
  $('cueSummary').innerHTML = `<span class="cue-summary-chip">${state.cueData.tracks.length} 首曲目</span><span class="cue-summary-chip">音频：${escapeHtml(track.name)}</span><span class="cue-summary-chip">CUE 文件：${escapeHtml(expected)}</span>`;
  if (notify) {
    showToast(exactMatch
      ? `已读取 CUE，识别到 ${state.splitSegments.length} 首曲目。`
      : `CUE 已读取，并应用到当前唯一音频；请确认它对应“${expected}”。`,
    exactMatch ? 'success' : 'info');
  }
}

function setSplitMode(mode) {
  state.splitMode = ['points', 'list', 'cue'].includes(mode) ? mode : 'duration';
  document.querySelectorAll('[data-split-mode]').forEach((button) => {
    const active = button.dataset.splitMode === state.splitMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('durationMode').hidden = state.splitMode !== 'duration';
  $('pointsMode').hidden = state.splitMode !== 'points';
  $('trackListMode').hidden = state.splitMode !== 'list';
  $('cueMode').hidden = state.splitMode !== 'cue';
  if (state.splitMode === 'cue') {
    const track = getSelectedTrack();
    if (state.cueData && track && state.cueData.sourceTrackId === track.id) {
      try {
        state.splitSegments = buildCueSegments(track, state.cueData);
        $('cueModeHelp').textContent = `已读取 ${state.splitSegments.length} 首曲目；断点按 CUE 的 INDEX 01 时间码生成。`;
      } catch (error) {
        state.splitSegments = [];
        $('cueModeHelp').textContent = error.message || '无法将此 CUE 应用于当前音频。';
      }
    } else {
      state.splitSegments = [];
      $('cueModeHelp').textContent = state.cueData
        ? '请先选择与 CUE 文件对应的整轨音频，或重新导入匹配的音频文件。'
        : '先点击“导入 CUE 文件”，再选择与其对应的整轨音频。';
    }
  } else {
    state.splitSegments = [];
  }
  renderSplitSegments();
}

function buildSplitSegments() {
  const track = getSelectedTrack();
  if (!track) {
    showToast('请先在左侧选择要分轨的音频。', 'error');
    return;
  }
  if (!Number.isFinite(track.duration) || track.duration <= 0) {
    showToast('暂时无法读取这段音频的总时长，请检查文件是否可解码。', 'error');
    return;
  }

  if (state.splitMode === 'cue') {
    if (!state.cueData) {
      showToast('请先导入一个 CUE 文件。', 'error');
      return;
    }
    if (state.cueData.sourceTrackId !== track.id) {
      showToast('当前 CUE 未应用到这段音频，请重新导入对应音频或重新选择 CUE。', 'error');
      return;
    }
    try {
      state.splitSegments = buildCueSegments(track, state.cueData);
      renderSplitSegments();
      showToast(`已根据 CUE 断点生成 ${state.splitSegments.length} 首曲目的预览。`, 'success');
    } catch (error) {
      showToast(error.message || '无法根据 CUE 生成分段。', 'error');
    }
    return;
  }

  if (state.splitMode === 'list') {
    try {
      state.splitSegments = parseUserTrackList($('trackListInput').value, Number(track.duration), { includeIntro: $('includeIntroCheck').checked });
      renderSplitSegments();
      showToast(`已识别 ${state.splitSegments.length} 首曲目，请检查起止时间后导出。`, 'success');
    } catch (error) {
      state.splitSegments = [];
      renderSplitSegments();
      showToast(error.message || '曲目清单解析失败，请检查每行的歌曲名和时间。', 'error');
    }
    return;
  }

  const total = Number(track.duration);
  let boundaries = [0, total];
  if (state.splitMode === 'duration') {
    const partSeconds = Number($('splitDurationInput').value);
    if (!Number.isFinite(partSeconds) || partSeconds <= 0) {
      showToast('每段时长必须是大于 0 的秒数。', 'error');
      return;
    }
    boundaries = [0];
    for (let point = partSeconds; point < total - 0.0005; point += partSeconds) {
      boundaries.push(Number(point.toFixed(3)));
      if (boundaries.length > 10000) {
        showToast('分段数量过多，请增大每段时长。', 'error');
        return;
      }
    }
    boundaries.push(Number(total.toFixed(3)));
  } else {
    const raw = $('splitPointsInput').value.trim();
    if (!raw) {
      showToast('请输入至少一个自定义分割点，例如：240, 510。', 'error');
      return;
    }
    const tokens = raw.split(/[,;，；\s]+/).filter(Boolean);
    const points = tokens.map(Number);
    if (points.some((point) => !Number.isFinite(point))) {
      showToast('分割点中有无法识别的内容，请只输入秒数。', 'error');
      return;
    }
    if (points.some((point) => point <= 0 || point >= total)) {
      showToast(`分割点必须大于 0 且小于总时长 ${total.toFixed(3)} 秒。`, 'error');
      return;
    }
    const uniquePoints = [...new Set(points.map((point) => Number(point.toFixed(3))))].sort((a, b) => a - b);
    boundaries = [0, ...uniquePoints, Number(total.toFixed(3))];
  }

  const segments = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = Number(boundaries[index].toFixed(3));
    const end = Number(boundaries[index + 1].toFixed(3));
    if (end - start < 0.001) continue;
    segments.push({ start, end, duration: Number((end - start).toFixed(3)) });
  }
  if (!segments.length) {
    showToast('没有生成有效分段，请检查时间设置。', 'error');
    return;
  }
  state.splitSegments = segments;
  renderSplitSegments();
  showToast(`已生成 ${segments.length} 个分段预览，请确认起止时间。`, 'success');
}

function setAudioSource(track) {
  if (state.activeAudioUrl && !state.activeAudioIsPreview) {
    URL.revokeObjectURL(state.activeAudioUrl);
  }
  state.activeAudioUrl = null;
  state.activeAudioIsPreview = false;
  $('audioPlayer').pause();
  if (!track) {
    $('audioPlayer').removeAttribute('src');
    $('audioPlayer').load();
    return;
  }
  if (track.previewUrl) {
    state.activeAudioUrl = track.previewUrl;
    state.activeAudioIsPreview = true;
  } else {
    state.activeAudioUrl = URL.createObjectURL(track.file);
  }
  $('audioPlayer').src = state.activeAudioUrl;
  $('audioPlayer').load();
}

function selectTrack(id) {
  const track = state.tracks.find((item) => item.id === id);
  if (!track) return;
  state.selectedId = id;
  $('noSelection').hidden = true;
  $('editorContent').hidden = false;
  $('selectedName').textContent = track.name;
  $('selectedMeta').textContent = `${track.ext.toUpperCase()} · ${formatSize(track.size)} · ${formatTime(track.duration)}`;
  $('selectedFileIcon').textContent = track.ext.toUpperCase();
  $('selectedFileIcon').className = `selected-file-icon type-${track.ext}`;
  $('startInput').value = String(track.trimStart.toFixed(2));
  $('endInput').value = String(track.trimEnd.toFixed(2));
  $('startInput').max = String(track.duration || 999999);
  $('endInput').max = String(track.duration || 999999);
  $('waveImage').hidden = !track.waveformUrl;
  $('wavePlaceholder').hidden = !!track.waveformUrl;
  if (track.waveformUrl) $('waveImage').src = track.waveformUrl;
  updateDurationLabels(track);
  setAudioSource(track);
  state.splitSegments = [];
  updateSplitSource(track);
  renderSplitSegments();
  renderTracks();
  updateTrimVisual();
}

async function browserDuration(file) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(url);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => { const d = audio.duration; cleanup(); resolve(Number.isFinite(d) && d > 0 ? d : 0); };
    audio.onerror = () => { cleanup(); resolve(0); };
    audio.src = url;
  });
}

async function addFiles(fileList) {
  if (state.busy) return;
  const files = Array.from(fileList || []);
  const accepted = files.filter((file) => {
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    return SUPPORTED_INPUTS.has(ext);
  });
  const rejected = files.length - accepted.length;
  if (!accepted.length) {
    if (files.length) showToast('未发现支持的音频文件，请选择 WAV、FLAC、MP3 或 APE。', 'error');
    return;
  }
  if (rejected) showToast(`${rejected} 个文件格式不支持，已跳过。`, 'info');

  $('dropZone').classList.add('is-loading');
  for (const file of accepted) {
    const ext = file.name.split('.').pop().toLowerCase();
    let duration = 0;
    try {
      const metadata = await parseBlob(file);
      if (Number.isFinite(metadata.format.duration) && metadata.format.duration > 0) duration = metadata.format.duration;
    } catch (error) {
      console.warn('读取音频元数据失败：', file.name, error);
    }
    if (!duration) duration = await browserDuration(file);
    const id = state.nextId++;
    state.tracks.push({
      id, file, name: file.name, ext, size: file.size,
      duration, trimStart: 0, trimEnd: duration || 0,
      ffName: `input_${id}.${ext}`, ffReady: false,
      waveformUrl: null, previewUrl: null,
    });
  }
  $('dropZone').classList.remove('is-loading');
  renderTracks();
  if (!state.selectedId && state.tracks.length) selectTrack(state.tracks[0].id);
  if (state.cueData) {
    const match = findCueSourceTrack();
    if (match) activateCueForTrack(match.track, match.exact, false);
  }
  showToast(`已添加 ${accepted.length} 个音频文件。`, 'success');
  $('fileInput').value = '';
  refreshStudioUI();
}

function createFFmpegInstance() {
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    state.lastLogs.push(message);
    if (state.lastLogs.length > 100) state.lastLogs.shift();
  });
  ffmpeg.on('progress', ({ progress }) => {
    if (!state.busy || !Number.isFinite(progress)) return;
    const percent = Math.max(0, Math.min(99, Math.round(progress * 100)));
    $('progressBar').style.width = `${percent}%`;
    $('progressPercent').textContent = `${percent}%`;
  });
  return ffmpeg;
}

async function ensureEngine() {
  if (state.engineReady) return;
  $('engineStatus').textContent = '正在加载音频引擎…';
  $('engineSubStatus').textContent = '首次加载需要下载 FFmpeg WebAssembly 组件（约 32 MB）';
  $('engineDot').classList.add('loading');

  const errors = [];
  for (const baseURL of CORE_BASES) {
    // Use a fresh worker for each attempt; a failed import can leave the old
    // worker in a failed state and make a CDN fallback ineffective.
    const ffmpeg = createFFmpegInstance();
    state.ffmpeg = ffmpeg;
    try {
      const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
      await ffmpeg.load({ coreURL, wasmURL });
      state.engineReady = true;
      $('engineDot').classList.remove('loading');
      $('engineDot').classList.add('ready');
      $('engineStatus').textContent = '音频引擎已就绪';
      $('engineSubStatus').textContent = 'FFmpeg WebAssembly · 浏览器本地运行';
      return;
    } catch (error) {
      errors.push(`${baseURL}: ${error?.message || error}`);
      try { ffmpeg.terminate(); } catch (_) {}
      if (state.ffmpeg === ffmpeg) state.ffmpeg = null;
    }
  }

  $('engineDot').classList.remove('loading');
  $('engineStatus').textContent = '音频引擎加载失败';
  $('engineSubStatus').textContent = '请检查网络连接，或允许访问 jsDelivr / unpkg';
  throw new Error(`FFmpeg 组件加载失败。已尝试 ESM 构建及备用 CDN。详情：${errors.join('；')}`);
}

async function ensureTrackFile(track) {
  if (!track.ffReady) {
    await state.ffmpeg.writeFile(track.ffName, await fetchFile(track.file));
    track.ffReady = true;
  }
}

function beginProgress(label) {
  state.busy = true;
  const job = { id: state.taskNextId++, label, status: 'processing', time: new Date(), detail: '' };
  state.jobs.unshift(job);
  state.jobs = state.jobs.slice(0, 30);
  renderTaskHistory();
  $('progressArea').hidden = false;
  $('progressLabel').textContent = label;
  $('progressPercent').textContent = '0%';
  $('progressBar').style.width = '0%';
  updateButtons();
  renderTracks();
}

function endProgress() {
  state.busy = false;
  $('progressArea').hidden = true;
  $('progressBar').style.width = '100%';
  updateButtons();
  renderTracks();
}

async function withTask(label, task) {
  if (state.busy) return;
  beginProgress(label);
  const job = state.jobs[0];
  try {
    await ensureEngine();
    await task();
    job.status = 'done';
    job.detail = '处理完成，浏览器已开始下载。';
  } catch (error) {
    job.status = 'failed';
    job.detail = error?.message || '处理失败';
    console.error(error, state.lastLogs.slice(-12));
    showToast(job.detail, 'error');
  } finally {
    endProgress();
    renderTaskHistory();
    refreshStudioUI();
  }
}

function outputSettings(format) {
  const sampleRate = $('sampleRateSelect').value;
  const bitrate = $('bitrateSelect').value;
  if (format === 'mp3') return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-ar', sampleRate, '-id3v2_version', '3'];
  if (format === 'flac') return ['-c:a', 'flac', '-compression_level', '8', '-ar', sampleRate];
  return ['-c:a', 'pcm_s16le', '-ar', sampleRate];
}

function outputMime(format) {
  if (format === 'mp3') return 'audio/mpeg';
  if (format === 'flac') return 'audio/flac';
  return 'audio/wav';
}

function downloadOutput(data, format, name) {
  const blob = new Blob([data], { type: outputMime(format) });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function safeOutputBase(value) {
  return value.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 90) || 'audio';
}

function safeFilenamePart(value) {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || 'Untitled';
}

async function exportSelectedTrim() {
  const track = getSelectedTrack();
  if (!track) return;
  const start = Number(track.trimStart);
  const end = Number(track.trimEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    showToast('裁剪区间无效，请检查开始和结束时间。', 'error');
    return;
  }
  if (track.duration > 0 && end > track.duration + 0.05) {
    showToast('结束时间不能超过音频总时长。', 'error');
    return;
  }
  const format = $('formatSelect').value;
  const outName = `sonora_trim_${Date.now()}.${format}`;
  await withTask('正在裁剪并导出…', async () => {
    await ensureTrackFile(track);
    const args = ['-hide_banner', '-y', '-i', track.ffName, '-ss', start.toFixed(3), '-t', (end - start).toFixed(3), '-vn'];
    if ($('normalizeCheck').checked) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    args.push(...outputSettings(format), outName);
    const code = await state.ffmpeg.exec(args);
    if (code !== 0) throw new Error('裁剪失败。该文件可能包含当前音频引擎不支持的编码。');
    const data = await state.ffmpeg.readFile(outName);
    downloadOutput(data, format, `${safeOutputBase(track.name)}_裁剪.${format}`);
    await state.ffmpeg.deleteFile(outName).catch(() => {});
    $('progressBar').style.width = '100%';
    $('progressPercent').textContent = '100%';
    showToast('裁剪完成，文件已开始下载。', 'success');
  });
}

async function exportMerged() {
  if (!state.tracks.length) return;
  const tracks = [...state.tracks];
  for (const track of tracks) {
    if (!Number.isFinite(track.trimStart) || !Number.isFinite(track.trimEnd) || track.trimStart < 0 || track.trimEnd <= track.trimStart) {
      showToast(`「${track.name}」的裁剪区间无效，请先修正。`, 'error');
      selectTrack(track.id);
      return;
    }
    if (track.duration > 0 && track.trimEnd > track.duration + 0.05) {
      showToast(`「${track.name}」的结束时间超出总时长。`, 'error');
      selectTrack(track.id);
      return;
    }
  }
  const format = $('formatSelect').value;
  const outName = `sonora_merge_${Date.now()}.${format}`;
  await withTask('正在按列表顺序合并音频…', async () => {
    for (const track of tracks) await ensureTrackFile(track);
    const filters = [];
    tracks.forEach((track, index) => {
      const label = `a${index}`;
      const start = Math.max(0, track.trimStart).toFixed(3);
      const end = Math.max(track.trimStart, track.trimEnd).toFixed(3);
      filters.push(`[${index}:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[${label}]`);
    });
    if (tracks.length === 1) {
      const normalize = $('normalizeCheck').checked ? ',loudnorm=I=-16:TP=-1.5:LRA=11' : '';
      filters.push(`[a0]anull${normalize}[outa]`);
    } else {
      const inputs = tracks.map((_, index) => `[a${index}]`).join('');
      const normalize = $('normalizeCheck').checked ? ',loudnorm=I=-16:TP=-1.5:LRA=11' : '';
      filters.push(`${inputs}concat=n=${tracks.length}:v=0:a=1${normalize}[outa]`);
    }
    const args = ['-hide_banner', '-y'];
    tracks.forEach((track) => args.push('-i', track.ffName));
    args.push('-filter_complex', filters.join(';'), '-map', '[outa]', ...outputSettings(format), outName);
    const code = await state.ffmpeg.exec(args);
    if (code !== 0) throw new Error('合并失败。请检查音频文件是否损坏，或尝试更换输出格式。');
    const data = await state.ffmpeg.readFile(outName);
    const base = tracks.length === 1 ? safeOutputBase(tracks[0].name) : 'Sonora_合并音频';
    downloadOutput(data, format, `${base}.${format}`);
    await state.ffmpeg.deleteFile(outName).catch(() => {});
    $('progressBar').style.width = '100%';
    $('progressPercent').textContent = '100%';
    showToast(`已按当前顺序导出 ${tracks.length} 段音频。`, 'success');
  });
}

async function exportSplitParts() {
  const track = getSelectedTrack();
  if (!track) {
    showToast('请先选择要分轨的音频。', 'error');
    return;
  }
  if (!state.splitSegments.length) {
    showToast('请先生成分段预览，再开始导出。', 'error');
    return;
  }
  const segments = [...state.splitSegments];
  const format = $('formatSelect').value;
  const base = safeOutputBase(track.name);
  const cueAlbum = state.splitMode === 'cue' && state.cueData?.albumTitle
    ? safeFilenamePart(state.cueData.albumTitle)
    : base;
  const zipName = state.splitMode === 'cue'
    ? `${cueAlbum}_CUE分轨_${segments.length}首.zip`
    : state.splitMode === 'list'
      ? `${base}_曲目清单分轨_${segments.length}首.zip`
      : `${base}_分轨_${segments.length}段.zip`;
  await withTask(`正在将音频分成 ${segments.length} 段…`, async () => {
    await ensureTrackFile(track);
    const zip = new JSZip();
    const runId = Date.now();
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const outName = `sonora_split_${runId}_${String(index + 1).padStart(3, '0')}.${format}`;
      const args = ['-hide_banner', '-y', '-i', track.ffName, '-ss', segment.start.toFixed(6), '-t', segment.duration.toFixed(6), '-vn'];
      if ($('normalizeCheck').checked) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
      if (segment.fromCue || segment.fromList) {
        args.push('-metadata', `title=${segment.title || ''}`);
        args.push('-metadata', `track=${segment.number || index + 1}`);
        if (segment.performer) args.push('-metadata', `artist=${segment.performer}`);
        if (segment.album) args.push('-metadata', `album=${segment.album}`);
      }
      args.push(...outputSettings(format), outName);
      const code = await state.ffmpeg.exec(args);
      if (code !== 0) throw new Error(`第 ${index + 1} 段导出失败。请尝试 WAV 或 FLAC 格式，或检查音频文件编码。`);
      const data = await state.ffmpeg.readFile(outName);
      const partName = (segment.fromCue || segment.fromList)
        ? `${String(segment.number || index + 1).padStart(2, '0')} - ${safeFilenamePart(segment.title || `Track ${index + 1}`)}.${format}`
        : `${base}_${String(index + 1).padStart(2, '0')}.${format}`;
      zip.file(partName, data);
      await state.ffmpeg.deleteFile(outName).catch(() => {});
      const percent = Math.round(((index + 1) / segments.length) * 85);
      $('progressBar').style.width = `${percent}%`;
      $('progressPercent').textContent = `${percent}%`;
      $('progressLabel').textContent = `正在处理第 ${index + 1}/${segments.length} 段：${formatTime(segment.start)}–${formatTime(segment.end)}`;
    }
    $('progressLabel').textContent = '正在打包 ZIP 文件…';
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (metadata) => {
      const percent = 85 + Math.round(metadata.percent * 0.14);
      $('progressBar').style.width = `${percent}%`;
      $('progressPercent').textContent = `${percent}%`;
    });
    downloadBlob(blob, zipName);
    $('progressBar').style.width = '100%';
    $('progressPercent').textContent = '100%';
    showToast(`分轨完成！${segments.length} 个文件已打包为 ZIP。`, 'success');
  });
}

async function generateWaveform() {
  const track = getSelectedTrack();
  if (!track) return;
  if (track.waveformUrl) {
    $('waveImage').src = track.waveformUrl;
    $('waveImage').hidden = false;
    $('wavePlaceholder').hidden = true;
    updateTrimVisual();
    return;
  }
  await withTask('正在分析音频并生成波形…', async () => {
    await ensureTrackFile(track);
    const waveName = `wave_${track.id}.png`;
    const code = await state.ffmpeg.exec(['-hide_banner', '-y', '-i', track.ffName, '-filter_complex', 'showwavespic=s=1400x240:colors=0x3478f6:scale=sqrt', '-frames:v', '1', waveName]);
    if (code !== 0) throw new Error('波形生成失败，但仍可使用起止时间进行裁剪。');
    const data = await state.ffmpeg.readFile(waveName);
    track.waveformUrl = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
    await state.ffmpeg.deleteFile(waveName).catch(() => {});
    $('waveImage').src = track.waveformUrl;
    $('waveImage').hidden = false;
    $('wavePlaceholder').hidden = true;
    updateTrimVisual();
    showToast('真实波形已生成。', 'success');
  });
}

async function generatePreview() {
  const track = getSelectedTrack();
  if (!track) return;
  if (!(track.trimEnd > track.trimStart)) {
    showToast('请先设置有效的试听区间。', 'error');
    return;
  }
  await withTask('正在生成 WAV 试听文件…', async () => {
    await ensureTrackFile(track);
    const outName = `preview_${track.id}_${Date.now()}.wav`;
    const args = ['-hide_banner', '-y', '-i', track.ffName, '-ss', track.trimStart.toFixed(3), '-t', (track.trimEnd - track.trimStart).toFixed(3), '-vn', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', outName];
    const code = await state.ffmpeg.exec(args);
    if (code !== 0) throw new Error('无法生成试听文件。请确认该音频可以正常解码。');
    const data = await state.ffmpeg.readFile(outName);
    if (track.previewUrl) URL.revokeObjectURL(track.previewUrl);
    track.previewUrl = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
    await state.ffmpeg.deleteFile(outName).catch(() => {});
    setAudioSource(track);
    showToast('试听文件已生成，可使用下方播放器试听当前保留区间。', 'success');
  });
}

function updateTrimFromInputs(changed) {
  const track = getSelectedTrack();
  if (!track) return;
  let start = Number($('startInput').value);
  let end = Number($('endInput').value);
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = track.duration || 0;
  if (track.duration > 0) {
    start = Math.max(0, Math.min(track.duration, start));
    end = Math.max(0, Math.min(track.duration, end));
  } else {
    start = Math.max(0, start);
    end = Math.max(0, end);
  }
  if (changed === 'start' && end <= start) {
    end = track.duration > 0 ? Math.min(track.duration, start + 0.01) : start + 0.01;
    if (end <= start) start = Math.max(0, end - 0.01);
  }
  if (changed === 'end' && start >= end) start = Math.max(0, end - 0.01);
  if (track.duration > 0) {
    start = Math.max(0, Math.min(track.duration, start));
    end = Math.max(0, Math.min(track.duration, end));
  }
  track.trimStart = Number(start.toFixed(3));
  track.trimEnd = Number(end.toFixed(3));
  $('startInput').value = String(track.trimStart);
  $('endInput').value = String(track.trimEnd);
  updateDurationLabels(track);
  updateTrimVisual();
  renderTracks();
}


// v1.5 — independent views, shared audio library and settings
const PAGE_META = {
  home: ['工作概览', '欢迎回到声音工作台。选择左侧工具，专注完成每一项任务。'],
  files: ['素材管理', '统一导入、排序、检查 WAV / FLAC / MP3 / APE 音频素材。'],
  trim: ['精确裁剪', '指定开始与结束秒数，查看波形并试听后单独导出。'],
  merge: ['多段合并', '按当前素材顺序合并音频，自动采用各文件设置的保留区间。'],
  split: ['专辑分轨', '使用 CUE、曲目清单、指定秒数或时间点批量分轨。'],
  convert: ['格式转换', '将素材批量转换为 MP3、WAV 或 FLAC，自动打包 ZIP。'],
  tasks: ['任务中心', '查看当前处理进度、任务结果与 FFmpeg 调试信息。'],
  settings: ['导出设置', '统一设置所有工具使用的采样率、比特率和响度处理。'],
};
function navigate(page, setHash = true) {
  const next = PAGE_META[page] ? page : 'home';
  state.page = next;
  document.querySelectorAll('[data-page]').forEach((element) => {
    element.hidden = element.dataset.page !== next;
  });
  document.querySelectorAll('[data-nav]').forEach((button) => {
    const active = button.dataset.nav === next;
    button.classList.toggle('active', active);
    if (button.classList.contains('nav-item')) button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  $('topPageTitle').textContent = PAGE_META[next][0];
  $('topPageSubtitle').textContent = PAGE_META[next][1];
  $('topBread').textContent = next.toUpperCase();
  document.title = `${PAGE_META[next][0]} · Sonora Audio Studio`;
  if (setHash && location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (next === 'tasks') renderTaskHistory();
  refreshStudioUI();
}
function refreshStudioUI() {
  const count = state.tracks.length;
  const totalDuration = state.tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  const trimmedDuration = state.tracks.reduce((sum, track) => sum + Math.max(0, (Number(track.trimEnd) || 0) - (Number(track.trimStart) || 0)), 0);
  const format = $('formatSelect').value.toUpperCase();
  $('topFileNumber').textContent = String(count);
  $('homeFiles').textContent = String(count);
  $('homeDuration').textContent = formatTime(totalDuration);
  $('homeFormat').textContent = format;
  $('homeJobs').textContent = String(state.jobs.length);
  $('mergeCount').textContent = String(count);
  $('mergeParts').textContent = String(count);
  $('mergeDuration').textContent = formatTime(trimmedDuration);
  $('mergeOutputFormat').textContent = format;
  $('convertCount').textContent = String(count);
  $('convertFiles').textContent = String(count);
  $('convertFormat').textContent = format;
  const selected = state.selectedId == null ? '' : String(state.selectedId);
  for (const id of ['trimSourcePicker', 'splitSourcePicker']) {
    const picker = $(id);
    const existing = Array.from(picker.options).map(x => x.value).join(',');
    const target = state.tracks.map(t => String(t.id)).join(',');
    if (existing !== target) {
      picker.replaceChildren();
      if (!count) picker.add(new Option('请先导入音频素材', ''));
      else state.tracks.forEach(t => picker.add(new Option(`${t.name} · ${formatTime(t.duration)}`, t.id)));
    }
    picker.value = selected;
    picker.disabled = !count || state.busy;
  }
  // Mirror the same list on the merge page, preserving its event delegation.
  $('mergeTrackList').innerHTML = count
    ? $('trackList').innerHTML
    : '<div class="empty-list"><strong>暂无合并素材</strong><p>请先到素材管理页面导入文件。</p></div>';
  $('convertPreviewList').innerHTML = count
    ? state.tracks.map((t,i) => `<div class="convert-file-row"><span class="convert-file-number">${String(i+1).padStart(2,'0')}</span><div><strong>${escapeHtml(t.name)}</strong><small>${t.ext.toUpperCase()} · ${formatTime(t.duration)} · ${formatSize(t.size)}</small></div><span class="convert-arrow">→ ${format}</span></div>`).join('')
    : '<div class="empty-list"><strong>暂无转换素材</strong><p>请先到素材管理页面导入文件。</p></div>';
  $('taskEngineStatus').textContent = state.engineReady ? '✓ 音频引擎就绪（FFmpeg WebAssembly）' : '○ 尚未成功加载音频引擎';
}
function renderTaskHistory() {
  $('taskCounter').textContent = `${state.jobs.length} 项`;
  $('taskHistory').innerHTML = state.jobs.length
    ? state.jobs.map(job => `<article class="job-row job-${job.status}"><span class="job-status">${job.status === 'done'?'✓':job.status==='failed'?'!':'◷'}</span><div class="job-info"><strong>${escapeHtml(job.label)}</strong><small>${escapeHtml(job.time.toLocaleTimeString('zh-CN'))} · ${job.status==='done'?'已完成':job.status==='failed'?'失败':'处理中'}</small>${job.detail ? `<p>${escapeHtml(job.detail)}</p>`:''}</div></article>`).join('')
    : '<div class="empty-list"><div class="empty-symbol">◷</div><strong>暂无处理任务</strong><p>裁剪、合并、分轨、批量转换完成后会显示在这里。</p></div>';
}
function saveExportPreferences() {
  try {
    const data = { format: $('formatSelect').value, rate: $('sampleRateSelect').value,
      bitrate: $('bitrateSelect').value, normalize: $('normalizeCheck').checked };
    localStorage.setItem('sonora_output_settings_v15', JSON.stringify(data));
  } catch (_) {} // Storage may be disabled by browser privacy settings.
}
function restoreExportPreferences() {
  try {
    const data = JSON.parse(localStorage.getItem('sonora_output_settings_v15') || '{}');
    const pairs = [['formatSelect','format'],['sampleRateSelect','rate'],['bitrateSelect','bitrate']];
    for (const [id,key] of pairs) if (data[key] && Array.from($(id).options).some(o=>o.value===data[key])) $(id).value=data[key];
    if (typeof data.normalize === 'boolean') $('normalizeCheck').checked = data.normalize;
  } catch (_) {}
}
async function exportAllConverted() {
  if (!state.tracks.length) { showToast('请先导入至少一个音频文件。', 'error'); return; }
  const format = $('formatSelect').value;
  const files = [...state.tracks];
  const useTrim = $('convertUseTrim').checked;
  await withTask(`正在批量转换 ${files.length} 个音频…`, async () => {
    const zip = new JSZip();
    for (let i = 0; i < files.length; i++) {
      const track = files[i];
      await ensureTrackFile(track);
      const outName = `convert_${Date.now()}_${i}.${format}`;
      const args = ['-hide_banner','-y','-i',track.ffName];
      if (useTrim) {
        if (!(track.trimEnd > track.trimStart)) throw new Error(`「${track.name}」的裁剪区间无效`);
        args.push('-ss',track.trimStart.toFixed(3),'-t',(track.trimEnd-track.trimStart).toFixed(3));
      }
      args.push('-vn');
      if ($('normalizeCheck').checked) args.push('-af','loudnorm=I=-16:TP=-1.5:LRA=11');
      args.push(...outputSettings(format),outName);
      const code=await state.ffmpeg.exec(args);
      if (code!==0) throw new Error(`转换第 ${i+1}/${files.length} 个文件失败：${track.name}`);
      const data=await state.ffmpeg.readFile(outName);
      const base=safeOutputBase(track.name);
      zip.file(`${String(i+1).padStart(2,'0')} - ${base}.${format}`, data);
      await state.ffmpeg.deleteFile(outName).catch(()=>{});
      const percent=Math.round((i+1)/files.length*85);
      $('progressLabel').textContent=`正在转换第 ${i+1}/${files.length} 个：${track.name}`;
      $('progressBar').style.width=`${percent}%`;
      $('progressPercent').textContent=`${percent}%`;
    }
    $('progressLabel').textContent='正在生成转换结果 ZIP…';
    const archive=await zip.generateAsync({type:'blob',compression:'STORE'}, m=>{
      const percent=85+Math.round(m.percent*0.14);
      $('progressBar').style.width=`${percent}%`; $('progressPercent').textContent=`${percent}%`;
    });
    downloadBlob(archive, `Sonora_批量格式转换_${files.length}文件_${format}.zip`);
    showToast(`已完成 ${files.length} 个文件的 ${format} 转换并开始下载。`,'success');
  });
}
for (const b of document.querySelectorAll('[data-nav],[data-go]')) b.addEventListener('click', () => navigate(b.dataset.nav || b.dataset.go));
for (const id of ['trimSourcePicker','splitSourcePicker']) $(id).addEventListener('change', e => {
  const target=Number(e.target.value);
  if (state.tracks.some(t=>t.id===target)) selectTrack(target);
});
$('convertBatchBtn').addEventListener('click', exportAllConverted);
$('clearTasksBtn').addEventListener('click', ()=>{ if(state.busy){ showToast('正在处理任务，不能清空。','error');return;}state.jobs=[];renderTaskHistory();refreshStudioUI();});
$('copyLogsBtn').addEventListener('click', async()=>{
  const content=state.lastLogs.slice(-60).join('\n') || '本次尚无 FFmpeg 引擎日志。';
  try { await navigator.clipboard.writeText(content);showToast('已复制最近 60 行引擎日志。','success'); }
  catch(_){showToast('无法访问剪贴板，可在 F12 控制台查看日志。','error');}
});
window.addEventListener('hashchange',()=>navigate(location.hash.replace('#',''),false));
$('fileInput').addEventListener('change', (event) => addFiles(event.target.files));
$('dropZone').addEventListener('dragover', (event) => { event.preventDefault(); $('dropZone').classList.add('drag-over'); });
$('dropZone').addEventListener('dragleave', () => $('dropZone').classList.remove('drag-over'));
$('dropZone').addEventListener('drop', (event) => { event.preventDefault(); $('dropZone').classList.remove('drag-over'); addFiles(event.dataTransfer.files); });

async function handleTrackListClick(event) {
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) {
    event.stopPropagation();
    if (state.busy) return;
    const id = Number(actionButton.dataset.id);
    const index = state.tracks.findIndex((track) => track.id === id);
    if (index < 0) return;
    const action = actionButton.dataset.action;
    if (action === 'up' && index > 0) [state.tracks[index - 1], state.tracks[index]] = [state.tracks[index], state.tracks[index - 1]];
    if (action === 'down' && index < state.tracks.length - 1) [state.tracks[index + 1], state.tracks[index]] = [state.tracks[index], state.tracks[index + 1]];
    if (action === 'remove') {
      const [removed] = state.tracks.splice(index, 1);
      if (removed.waveformUrl) URL.revokeObjectURL(removed.waveformUrl);
      if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      if (removed.ffReady && state.engineReady) await state.ffmpeg.deleteFile(removed.ffName).catch(() => {});
      if (state.selectedId === id) {
        state.selectedId = null;
        if (state.tracks.length) selectTrack(state.tracks[Math.min(index, state.tracks.length - 1)].id);
        else {
          $('editorContent').hidden = true;
          $('noSelection').hidden = false;
          state.splitSegments = [];
          updateSplitSource(null);
          renderSplitSegments();
          setAudioSource(null);
        }
      }
    }
    renderTracks();
    return;
  }
  const card = event.target.closest('[data-track-id]');
  if (card) selectTrack(Number(card.dataset.trackId));
}

function handleTrackListKeydown(event) {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-track-id]')) {
    event.preventDefault();
    selectTrack(Number(event.target.dataset.trackId));
  }
}

for (const id of ['trackList', 'mergeTrackList']) {
  $(id).addEventListener('click', handleTrackListClick);
  $(id).addEventListener('keydown', handleTrackListKeydown);
}

$('clearAllBtn').addEventListener('click', async () => {
  if (state.busy) return;
  for (const track of state.tracks) {
    if (track.waveformUrl) URL.revokeObjectURL(track.waveformUrl);
    if (track.previewUrl) URL.revokeObjectURL(track.previewUrl);
    if (track.ffReady && state.engineReady) await state.ffmpeg.deleteFile(track.ffName).catch(() => {});
  }
  state.tracks = [];
  state.selectedId = null;
  state.splitSegments = [];
  state.cueData = null;
  $('cueStatus').textContent = '尚未导入 CUE 文件。支持单个整轨音频的标准 CUE 断点。';
  $('cueSummary').hidden = true;
  $('clearCueBtn').disabled = true;
  updateSplitSource(null);
  renderSplitSegments();
  $('editorContent').hidden = true;
  $('noSelection').hidden = false;
  setAudioSource(null);
  renderTracks();
});

$('startInput').addEventListener('change', () => updateTrimFromInputs('start'));
$('endInput').addEventListener('change', () => updateTrimFromInputs('end'));
$('resetTrimBtn').addEventListener('click', () => {
  const track = getSelectedTrack();
  if (!track) return;
  track.trimStart = 0;
  track.trimEnd = track.duration || 0;
  $('startInput').value = '0';
  $('endInput').value = String(track.trimEnd.toFixed(2));
  updateDurationLabels(track);
  updateTrimVisual();
  renderTracks();
  showToast('已重置为整段音频。', 'info');
});
$('waveformBtn').addEventListener('click', generateWaveform);
$('convertPreviewBtn').addEventListener('click', generatePreview);
$('trimExportBtn').addEventListener('click', exportSelectedTrim);
$('mergeExportBtn').addEventListener('click', exportMerged);
$('previewSplitBtn').addEventListener('click', buildSplitSegments);
$('exportSplitBtn').addEventListener('click', exportSplitParts);
document.querySelectorAll('[data-split-mode]').forEach((button) => button.addEventListener('click', () => {
  const mode = button.dataset.splitMode;
  if (mode !== 'cue') {
    setSplitMode(mode);
    return;
  }
  if (!state.cueData) {
    showToast('请先点击“导入 CUE 文件”选择 .cue 文件。', 'error');
    $('cueFileInput').click();
    return;
  }
  const match = findCueSourceTrack();
  if (!match) {
    showToast(`请先导入 CUE 中指定的音频文件：${cueBasename(state.cueData.fileName)}`, 'error');
    return;
  }
  activateCueForTrack(match.track, match.exact, true);
}));
$('cueImportBtn').addEventListener('click', () => $('cueFileInput').click());
$('applyCueCurrentBtn').addEventListener('click', () => {
  const track = getSelectedTrack();
  if (!state.cueData) {
    showToast('请先导入 CUE 文件。', 'error');
    return;
  }
  if (!track) {
    showToast('请先在左侧选择对应的整轨音频。', 'error');
    return;
  }
  activateCueForTrack(track, false, true);
});
$('cueFileInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await readCueText(file);
    const parsed = parseCueText(text, file.name);
    state.cueData = parsed;
    state.splitSegments = [];
    renderSplitSegments();
    $('clearCueBtn').disabled = false;
    $('cueStatus').textContent = `已解析 ${parsed.tracks.length} 首曲目，等待匹配音频…`;
    $('cueSummary').hidden = false;
    $('cueSummary').innerHTML = `<span class="cue-summary-chip">${parsed.tracks.length} 首曲目</span><span class="cue-summary-chip">专辑：${escapeHtml(parsed.albumTitle || '未命名专辑')}</span><span class="cue-summary-chip">音频：${escapeHtml(cueBasename(parsed.fileName))}</span>`;
    const match = findCueSourceTrack();
    if (match) {
      activateCueForTrack(match.track, match.exact, true);
    } else {
      $('cueModeHelp').textContent = `CUE 已解析 ${parsed.tracks.length} 首曲目；请导入音频文件“${cueBasename(parsed.fileName)}”。`;
      showToast(`CUE 已读取，请导入对应的整轨音频：${cueBasename(parsed.fileName)}`, 'info');
    }
  } catch (error) {
    state.cueData = null;
    state.splitSegments = [];
    if (state.splitMode === 'cue') setSplitMode('duration');
    else renderSplitSegments();
    $('clearCueBtn').disabled = true;
    $('cueSummary').hidden = true;
    $('cueStatus').textContent = 'CUE 读取失败，请检查文件内容。';
    showToast(error.message || '无法解析该 CUE 文件。', 'error');
  } finally {
    event.target.value = '';
    updateButtons();
  }
});
$('clearCueBtn').addEventListener('click', () => {
  state.cueData = null;
  if (state.splitMode === 'cue') setSplitMode('duration');
  $('cueStatus').textContent = '尚未导入 CUE 文件。支持单个整轨音频的标准 CUE 断点。';
  $('cueSummary').hidden = true;
  $('clearCueBtn').disabled = true;
  showToast('已清除 CUE 信息。', 'info');
});

$('splitDurationInput').addEventListener('input', () => { state.splitSegments = []; renderSplitSegments(); });
$('splitPointsInput').addEventListener('input', () => { state.splitSegments = []; renderSplitSegments(); });
$('trackListInput').addEventListener('input', () => { state.splitSegments = []; renderSplitSegments(); });
$('includeIntroCheck').addEventListener('change', () => {
  state.splitSegments = [];
  renderSplitSegments();
  if (state.splitMode === 'list' && getSelectedTrack()) buildSplitSegments();
});
$('formatSelect').addEventListener('change', () => { $('bitrateField').classList.toggle('muted-setting', $('formatSelect').value !== 'mp3'); });
for (const id of ['formatSelect','sampleRateSelect','bitrateSelect','normalizeCheck']) $(id).addEventListener('change',()=>{ saveExportPreferences(); refreshStudioUI(); });

window.addEventListener('beforeunload', () => {
  if (state.activeAudioUrl && !state.activeAudioIsPreview) URL.revokeObjectURL(state.activeAudioUrl);
  for (const track of state.tracks) {
    if (track.waveformUrl) URL.revokeObjectURL(track.waveformUrl);
    if (track.previewUrl) URL.revokeObjectURL(track.previewUrl);
  }
});

restoreExportPreferences();
renderTracks();
updateSplitSource(null);
renderSplitSegments();
$('bitrateField').classList.toggle('muted-setting', $('formatSelect').value !== 'mp3');
renderTaskHistory();
navigate(location.hash.replace('#',''), false);
