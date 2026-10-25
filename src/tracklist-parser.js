/**
 * 曲目清单解析器：支持时间在前/后、紧贴歌名、常见编号与分隔符。
 * 仅负责解析清单；实际音频转码/裁剪由 FFmpeg 完成。
 */
const TIME_TOKEN = String.raw`\d{1,4}:\d{2}(?::\d{2})?(?:\.\d{1,3})?`;
const TIME_AT_START = new RegExp(`^(?:\\[(${TIME_TOKEN})\\]|\\((${TIME_TOKEN})\\)|(${TIME_TOKEN}))(.*)$`, 'u');
const TIME_AT_END = new RegExp(`^(.*?)(?:\\[(${TIME_TOKEN})\\]|\\((${TIME_TOKEN})\\)|(${TIME_TOKEN}))\\s*$`, 'u');

function formatForMessage(seconds) {
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole % 3600 / 60);
  const s = whole % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${two(h)}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

export function parseUserTimecode(value) {
  const raw = String(value ?? '').trim().replace(/：/g, ':').replace(/．/g, '.').replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xFF10));
  if (!new RegExp(`^${TIME_TOKEN}$`).test(raw)) {
    throw new Error(`时间“${raw}”格式无法识别，请使用 mm:ss 或 hh:mm:ss（也支持 .毫秒）。`);
  }
  const numbers = raw.split(':').map(Number);
  if (numbers.length === 2) {
    if (numbers[1] >= 60) throw new Error(`时间“${raw}”中的秒数必须小于 60。`);
    return numbers[0] * 60 + numbers[1];
  }
  if (numbers[1] >= 60 || numbers[2] >= 60) {
    throw new Error(`时间“${raw}”中的分钟和秒数必须小于 60。`);
  }
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

function stripTrackNumber(raw) {
  // 01.、01)、[01]、01 -、第01首，以及列表标记。
  let line = raw.trim().replace(/^(?:[-*•]\s+)/u, '');
  line = line.replace(/^(?:\[\s*\d{1,3}\s*\]|\(\s*\d{1,3}\s*\)|第\s*\d{1,3}\s*首|\d{1,3}[.)、．]|\d{1,3}\s*[-—–|｜])\s*/u, '');
  // 01 00:03:47 歌名，或 01 歌名 03:47（避免误删“100种生活”中的数字）。
  line = line.replace(/^(\d{1,3})\s+(?=(?:[[(]?\d{1,4}:)|(?:\S.*\d{1,4}:))/u, '');
  return line.trim();
}

function parseOneLine(raw, lineNumber) {
  const line = stripTrackNumber(
    raw.replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xFF10)).replace(/：/g, ':').replace(/．/g, '.')
  );
  let time;
  let title;
  const leading = line.match(TIME_AT_START);
  if (leading) {
    time = leading[1] || leading[2] || leading[3];
    title = leading[4].replace(/^[\s|｜,:：、.\-—–]+/u, '').trim();
  } else {
    const trailing = line.match(TIME_AT_END);
    if (trailing) {
      title = trailing[1].replace(/[\s|｜,:：、.\-—–]+$/u, '').trim();
      time = trailing[2] || trailing[3] || trailing[4];
    }
  }
  if (!time) throw new Error(`第 ${lineNumber} 行无法识别：“${raw.trim()}”。支持“00:07:22 歌名”或“歌名 07:22”。`);
  if (!title) throw new Error(`第 ${lineNumber} 行缺少歌曲名称。`);
  const start = parseUserTimecode(time);
  return { title, start: Number(start.toFixed(3)) };
}

/**
 * @param {string} rawText  用户粘贴的清单
 * @param {number} totalDuration  整轨总时长（秒）
 * @param {{ includeIntro?: boolean }} options 首首前未命名片头是否单独导出
 * @returns {Array<{title:string,number:string,start:number,end:number,duration:number,fromList:boolean}>}
 */
export function parseUserTrackList(rawText, totalDuration, options = {}) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) throw new Error('音频总时长未知，无法生成分轨时间。');
  const lines = String(rawText ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
    .map((text, index) => ({ text: text.trim(), number: index + 1 }))
    .filter(({ text }) => text && !/^(?:#|\/\/)/.test(text));
  if (!lines.length) throw new Error('请粘贴曲目清单，每行填写歌曲名称和开始时间。');
  if (lines.length > 500) throw new Error('一次最多支持 500 首曲目，请拆分清单后再处理。');
  const tracks = lines.map(({ text, number }, index) => ({
    ...parseOneLine(text, number),
    number: String(index + 1).padStart(2, '0'),
  }));
  for (let i = 1; i < tracks.length; i += 1) {
    if (tracks[i].start <= tracks[i - 1].start) {
      throw new Error(`第 ${lines[i].number} 行“${tracks[i].title}”的时间必须晚于上一首（${formatForMessage(tracks[i - 1].start)}）。`);
    }
  }
  const outside = tracks.find((entry) => entry.start >= totalDuration);
  if (outside) {
    throw new Error(`曲目“${outside.title}”的起点 ${formatForMessage(outside.start)} 已达到或超过音频总时长 ${formatForMessage(totalDuration)}。请导入对应的完整专辑。`);
  }
  const result = tracks.map((entry, index) => {
    const end = index + 1 < tracks.length ? tracks[index + 1].start : Number(totalDuration.toFixed(3));
    return {
      start: entry.start,
      end,
      duration: Number((end - entry.start).toFixed(3)),
      number: entry.number,
      title: entry.title,
      fromList: true,
    };
  });
  if (options.includeIntro && tracks[0].start > 0) {
    result.unshift({
      start: 0,
      end: tracks[0].start,
      duration: tracks[0].start,
      number: '00',
      title: '片头（未命名）',
      fromList: true,
    });
  }
  return result;
}
