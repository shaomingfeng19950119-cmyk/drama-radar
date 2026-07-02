/**
 * 短剧雷达 · 自动更新（v2 完整版）
 * 解析 iOS免费榜 + iOS畅销榜 + GP免费榜 + 综合排名
 * 自动检测产品数量（支持11/15产品）
 */
import { readFileSync, writeFileSync } from 'fs';

async function fetchPage(url) {
  console.log('  fetch: ' + url);
  const r = await fetch(url, { headers: { 'User-Agent': 'DramaRadar/2.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

function strip(h) { return h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, '-').replace(/&[^;]+;/g, ' ').replace(/\*+/g, '').trim(); }

function parseRank(s) {
  if (!s) return null;
  const c = s.replace(/[#＃*]/g, '').replace(/[‑–—]/g, '').trim();
  if (!c || c === '-' || c === '\u2013') return null;
  const n = parseInt(c); return isNaN(n) ? null : n;
}

// Split HTML into sections by headings, then parse tables in each
function parseSections(html) {
  // Extract content area
  const contentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/article|<div[^>]*class="[^"]*(?:post-|entry-|comments))/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article/i);
  const content = contentMatch ? contentMatch[1] : html;

  // Find all tables with preceding context
  const sections = [];
  const parts = content.split(/<table/i);

  for (let i = 1; i < parts.length; i++) {
    const before = parts[i - 1].slice(-500); // text before this table
    const tableHtml = '<table' + parts[i].split(/<\/table>/i)[0] + '</table>';

    // Determine table type from preceding text
    let type = 'unknown';
    if (/iOS\s*免费|免费榜|topfree|iOS 免费/i.test(before) && !/畅销|grossing/i.test(before.slice(-200))) type = 'ios_free';
    else if (/畅销|grossing|收入/i.test(before)) type = 'ios_grossing';
    else if (/GP|Google\s*Play|GP 免费/i.test(before)) type = 'gp_free';
    else if (/综合排名|综合分|全球综合/i.test(before)) type = 'ranking';

    // Parse table rows
    const rows = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tableHtml)) !== null) {
      const cells = [];
      const cRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = cRe.exec(rm[1])) !== null) cells.push(strip(cm[1]).trim());
      if (cells.length > 0) rows.push(cells);
    }

    if (rows.length > 2) sections.push({ type, rows });
  }

  return sections;
}

function parseCountryTable(rows) {
  // First row is header - extract product abbreviations
  const header = rows[0];
  let abbrs = [];
  let startCol = -1;

  for (let i = 0; i < header.length; i++) {
    const h = header[i].trim();
    if (h === '国家' || h === '國家') { startCol = i + 1; continue; }
    if (h === '领先' || h === '優勢' || h === '优势方') break;
    if (startCol > 0 && i >= startCol && /^[A-Z]{2}$/.test(h)) abbrs.push(h);
  }

  if (abbrs.length === 0) {
    // Fallback: try to detect from known abbreviations
    for (let i = 1; i < header.length - 1; i++) {
      const h = header[i].trim();
      if (/^[A-Z]{2}$/.test(h)) abbrs.push(h);
    }
  }

  const productCount = abbrs.length;
  if (productCount === 0) return null;

  const tableRows = [];
  const stats = {};
  abbrs.forEach(a => stats[a] = { cnt: 0, lead: 0, ranks: [] });

  for (let ri = 1; ri < rows.length; ri++) {
    const row = rows[ri];
    const country = row[0]?.trim();
    if (!country || country.length !== 2 || country === '国家' || country === '缩写') continue;

    const ranks = [];
    let best = 999, bi = -1;

    for (let i = 0; i < productCount; i++) {
      const r = parseRank(row[i + 1]);
      ranks.push(r);
      if (r !== null) {
        stats[abbrs[i]].cnt++;
        stats[abbrs[i]].ranks.push(r);
        if (r < best) { best = r; bi = i; }
      }
    }

    const lead = bi >= 0 ? abbrs[bi] : '–';
    if (bi >= 0) stats[abbrs[bi]].lead++;

    tableRows.push([country, ...ranks.map(r => r === null ? '-' : r), lead]);
  }

  return { h: abbrs, r: tableRows, stats };
}

function parseRankingTable(rows) {
  // Parse the comprehensive ranking table
  const rankings = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Find columns: rank, product, score, coverage, grossing_lead, free_lead
    if (row.length < 4) continue;

    let name = null, score = null, coverage = null, gl = 0, fl = 0;

    for (const cell of row) {
      const c = cell.trim();
      if (/^\d+\.\d+$/.test(c)) score = parseFloat(c);
      else if (/^\d+\/\d+$/.test(c)) coverage = c;
      else if (/^\d+国$/.test(c)) {
        const n = parseInt(c);
        if (gl === 0 && fl === 0) gl = n;
        else fl = n;
      }
      // Product name: English word with no digits-only
      else if (/^[A-Za-z]{4,}$/.test(c)) name = c;
    }

    if (!name && row.length >= 3) {
      // Try second column
      name = row[1].replace(/\*+/g, '').trim();
    }

    if (name && score) {
      rankings.push({ n: name, s: score, gl, fl, c: coverage || '30/30', t: 'flat', ch: '+0.0' });
    }
  }
  return rankings;
}

// ─── Main flow ───
async function findLatest() {
  console.log('\n📡 Scanning narku.com...');
  const html = await fetchPage('https://www.narku.com/archives/category/daily-drama-report');
  const ms = [...html.matchAll(/<h2[^>]*>\s*<a\s+href="(https:\/\/www\.narku\.com\/archives\/\d+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const arts = ms.map(m => ({ url: m[1], title: strip(m[2]) }));
  const getDate = t => { const m = t.match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
  const paid = arts.find(a => a.title.includes('付费') && getDate(a.title));
  const free = arts.find(a => a.title.includes('免费') && getDate(a.title));
  const date = [paid, free].map(a => a ? getDate(a.title) : null).filter(Boolean).sort().reverse()[0];
  return { paid, free, date };
}

function paidInsights(rk) {
  const ins = [];
  if (!rk?.length) return ins;
  const t = rk[0];
  ins.push({ h: t.n + ' 以 ' + t.s + ' 分领跑综合排名', p: '畅销榜 ' + t.gl + ' 国领先，免费榜 ' + t.fl + ' 国领先，覆盖 ' + t.c + ' 个市场。', tag: 'g' });
  const fl = [...rk].sort((a, b) => b.fl - a.fl)[0];
  if (fl.n !== t.n && fl.fl > 0) ins.push({ h: fl.n + ' 在 ' + fl.fl + ' 国免费榜领先', p: '下载获取能力全场最强。', tag: 'p' });
  const bot = rk[rk.length - 1];
  if (bot.s < 5) ins.push({ h: bot.n + ' 综合分仅 ' + bot.s, p: '排名末位，覆盖 ' + bot.c + '。', tag: 'r' });
  return ins;
}

function freeInsights(prods) {
  const ins = [], s = [...prods].sort((a, b) => b.total - a.total);
  if (s[0]) ins.push({ h: s[0].n + ' 覆盖 ' + s[0].total + ' 国领跑', p: 'iOS ' + s[0].ios + ' 国 + GP ' + s[0].gp + ' 国。', tag: 'g' });
  if (s[1]) ins.push({ h: s[1].n + ' 覆盖 ' + s[1].total + ' 国', p: 'iOS ' + s[1].ios + ' 国 + GP ' + s[1].gp + ' 国。', tag: 'p' });
  const w = s.filter(p => p.total <= 2);
  if (w.length) ins.push({ h: w.map(p => p.n).join('、') + ' 覆盖面有限', p: '仅少数市场上榜。', tag: 'r' });
  return ins;
}

async function main() {
  console.log('🎬 短剧雷达 v2 · 完整三榜抓取');
  console.log('='.repeat(40));

  const { paid, free, date } = await findLatest();
  if (!date) { console.log('⚠️ 无新文章'); return; }
  console.log('📅 ' + date);

  // ── Parse paid report ──
  let iosFreeTable = null, iosGrossingTable = null, gpFreeTable = null, rankings = [];

  if (paid) {
    console.log('\n📄 付费: ' + paid.title);
    const html = await fetchPage(paid.url);
    const sections = parseSections(html);
    console.log('  找到 ' + sections.length + ' 个表格段落');

    // Parse all tables: large country tables assigned by order
    // narku order is always: iOS Free → iOS Grossing → GP Free → Ranking
    const countryTables = [];
    for (const sec of sections) {
      const parsed = parseCountryTable(sec.rows);
      if (parsed && parsed.r.length >= 10) {
        countryTables.push(parsed);
        console.log('  表格' + countryTables.length + ': ' + parsed.h.length + '产品 × ' + parsed.r.length + '国');
      } else if (sec.type === 'ranking' || sec.rows.some(r => r.some(c => /综合分|综合/.test(c)))) {
        rankings = parseRankingTable(sec.rows);
        console.log('  综合排名: ' + rankings.length + '产品');
      } else {
        // Try ranking table detection by checking for score-like numbers
        const maybeRanking = sec.rows.filter(r => r.some(c => /^\d+\.\d+$/.test(c.trim())));
        if (maybeRanking.length >= 5) {
          rankings = parseRankingTable(sec.rows);
          console.log('  综合排名(auto): ' + rankings.length + '产品');
        }
      }
    }

    // Assign by order: 1st=iOS Free, 2nd=iOS Grossing, 3rd=GP Free
    if (countryTables.length >= 1) iosFreeTable = countryTables[0];
    if (countryTables.length >= 2) iosGrossingTable = countryTables[1];
    if (countryTables.length >= 3) gpFreeTable = countryTables[2];
    console.log('  分配: iOS免费=' + (iosFreeTable?'✓':'✗') + ' iOS畅销=' + (iosGrossingTable?'✓':'✗') + ' GP免费=' + (gpFreeTable?'✓':'✗'));
  }

  // ── Parse free report ──
  let freeProducts = [], freeIosT = [], freeGpT = [];
  const FA = ['Fr', 'Pd', 'Me', 'MD', 'KT'];
  const FN = ['Freereels', 'Pinedrama', 'Melolo', 'MicroDrama', 'KukuTV'];
  const FC = ['昆仑万维', '字节跳动', '字节跳动', '—', '印度本土'];

  if (free) {
    console.log('\n📄 免费: ' + free.title);
    const html = await fetchPage(free.url);
    const sections = parseSections(html);
    const iosS = FN.map(() => ({ c: 0, tags: [] }));
    const gpS = FN.map(() => ({ c: 0, tags: [] }));

    let tableCount = 0;
    for (const sec of sections) {
      const parsed = parseCountryTable(sec.rows);
      if (!parsed || parsed.r.length < 3) continue;

      const isIos = tableCount === 0;
      tableCount++;
      const target = isIos ? freeIosT : freeGpT;
      const stats = isIos ? iosS : gpS;

      // Map by header abbreviation
      for (const row of parsed.r) {
        const co = row[0];
        const mapped = [];
        let best = 999, bi = -1;
        for (let i = 0; i < FA.length; i++) {
          const hi = parsed.h.indexOf(FA[i]);
          const r = hi >= 0 ? (row[hi + 1] === '-' ? null : parseInt(row[hi + 1])) : null;
          mapped.push(r);
          if (r !== null) {
            stats[i].c++;
            if (r <= 5) stats[i].tags.push({ t: co + ' #' + r, top: true });
            else if (r <= 20) stats[i].tags.push({ t: co + ' #' + r, top: false });
            if (r < best) { best = r; bi = i; }
          }
        }
        target.push([co, ...mapped.map(r => r === null ? '-' : r), bi >= 0 ? FA[bi] : '–']);
      }
    }

    freeProducts = FN.map((n, i) => ({
      n, co: FC[i], ios: iosS[i].c, gp: gpS[i].c,
      total: Math.max(iosS[i].c, gpS[i].c),
      tags: [...gpS[i].tags, ...iosS[i].tags].slice(0, 7)
    }));
  }

  // ── Build & save ──
  let data;
  try { data = JSON.parse(readFileSync('data.json', 'utf-8')); } catch { data = { colors: {}, profiles: [], reports: {} }; }

  if (!data.colors?.DramaBox) {
    data.colors = { DramaBox:'#D97706',NetShort:'#4F46E5',DramaWave:'#06B6D4',ReelShort:'#F97316',GoodShort:'#10B981',ShortMax:'#8B5CF6',VibeShort:'#EC4899',StarDustTV:'#14B8A6',StoryReel:'#EAB308',MoboReels:'#60A5FA',DreameShort:'#EF4444',FlareFlow:'#F472B6',FlickReels:'#34D399',KalosTV:'#A3E635',MiniShorts:'#FB923C',Freereels:'#F97316',Pinedrama:'#4F46E5',Melolo:'#06B6D4',MicroDrama:'#8B5CF6',KukuTV:'#9CA3AF' };
  }

  // Trend: merge history
  const histDates = Object.keys(data.reports || {}).sort().slice(-5);
  const trendData = {};
  for (const r of rankings) {
    const hist = histDates.map(d => data.reports[d]?.paid?.rankings?.find(x => x.n === r.n)?.s).filter(v => v != null);
    trendData[r.n] = [...hist, r.s];
    if (hist.length > 0) {
      const prev = hist[hist.length - 1];
      const diff = (r.s - prev).toFixed(1);
      r.ch = (+diff >= 0 ? '+' : '') + diff;
      r.t = +diff > 0.3 ? 'up' : +diff < -0.3 ? 'down' : 'flat';
    }
  }

  const topP = rankings[0];
  const report = {
    meta: {
      type: '日报', period: date, eye: 'Daily Intelligence · ' + date,
      title: topP ? (topP.n + ' 以 <em>' + topP.s + '分</em> 领跑<br>全球综合排名') : '短剧出海竞品<em>日报</em>',
      sub: date + ' 付费短剧' + rankings.length + '产品×30国三榜矩阵，免费短剧5产品×16国追踪。',
      stats: [
        { l: '追踪付费产品', v: String(rankings.length || '?'), c: 'var(--indigo)' },
        { l: '覆盖国家', v: '30', c: 'var(--blue)' },
        { l: '追踪免费产品', v: '5', c: 'var(--cyan)' },
        { l: '免费覆盖国家', v: '16', c: 'var(--green)' }
      ]
    },
    paid: {
      rankings,
      trends: { dates: [...histDates.map(d => d.slice(5)), date.slice(5)].slice(-6), data: trendData },
      iosFree: iosFreeTable ? { h: iosFreeTable.h, r: iosFreeTable.r } : { h: [], r: [] },
      iosGrossing: iosGrossingTable ? { h: iosGrossingTable.h, r: iosGrossingTable.r } : { h: [], r: [] },
      gpFree: gpFreeTable ? { h: gpFreeTable.h, r: gpFreeTable.r } : { h: [], r: [] },
      insights: paidInsights(rankings)
    },
    free: {
      products: freeProducts, iosT: freeIosT, gpT: freeGpT,
      insights: freeInsights(freeProducts)
    }
  };

  data.reports[date] = report;
  const dates = Object.keys(data.reports).sort().reverse();
  if (dates.length > 30) dates.slice(30).forEach(d => delete data.reports[d]);

  writeFileSync('data.json', JSON.stringify(data, null, 2));
  console.log('\n✅ 写入 ' + date + ' (' + Object.keys(data.reports).length + ' 天)');
  console.log('  iOS免费: ' + (iosFreeTable?.r.length || 0) + '国 / iOS畅销: ' + (iosGrossingTable?.r.length || 0) + '国 / GP免费: ' + (gpFreeTable?.r.length || 0) + '国');
  console.log('  综合排名: ' + rankings.length + '产品');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
