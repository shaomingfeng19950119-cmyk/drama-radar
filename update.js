/**
 * 短剧雷达 · 每日自动更新脚本（纯爬虫版，无需任何 API Key）
 * 
 * 直接解析 narku.com HTML 表格，自动生成结构化数据
 * 用法：node update.js
 * 完全免费，零成本运行
 */

import { readFileSync, writeFileSync } from 'fs';

async function fetchPage(url) {
  console.log('  抓取: ' + url);
  const res = await fetch(url, { headers: { 'User-Agent': 'DramaRadar/1.0' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return await res.text();
}

function strip(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#8211;/g, '-').replace(/&[^;]+;/g, ' ').trim();
}

function parseTables(html) {
  const tables = [];
  const tRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tRe.exec(html)) !== null) {
    const rows = [];
    const rRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rRe.exec(tm[1])) !== null) {
      const cells = [];
      const cRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = cRe.exec(rm[1])) !== null) {
        cells.push(strip(cm[1]).replace(/\s+/g, ' ').trim());
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

function parseRank(s) {
  if (!s) return null;
  const c = s.replace(/[#＃*]/g, '').replace(/[‑–—]/g, '').trim();
  if (!c || c === '-' || c === '–') return null;
  const n = parseInt(c);
  return isNaN(n) ? null : n;
}

const PA = ['RS','DB','NS','DW','SM','GS','MR','SR','VS','DS','ST'];
const PN = ['ReelShort','DramaBox','NetShort','DramaWave','ShortMax','GoodShort','MoboReels','StoryReel','VibeShort','DreameShort','StarDustTV'];
const FA = ['Fr','Pd','Me','MD','KT'];
const FN = ['Freereels','Pinedrama','Melolo','MicroDrama','KukuTV'];
const FC = ['昆仑万维','字节跳动','字节跳动','—','印度本土'];

// ─── 找最新文章 ───
async function findLatest() {
  console.log('\n📡 扫描最新文章...');
  const html = await fetchPage('https://www.narku.com/archives/category/daily-drama-report');
  const ms = [...html.matchAll(/<h2[^>]*>\s*<a\s+href="(https:\/\/www\.narku\.com\/archives\/\d+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const arts = ms.map(m => ({ url: m[1], title: strip(m[2]) }));
  const getDate = t => { const m = t.match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
  const paid = arts.find(a => a.title.includes('付费') && getDate(a.title));
  const free = arts.find(a => a.title.includes('免费') && getDate(a.title));
  const date = [paid, free].map(a => a ? getDate(a.title) : null).filter(Boolean).sort().reverse()[0];
  return { paid, free, date };
}

// ─── 解析付费报告 ───
function parsePaid(html) {
  console.log('\n📊 解析付费短剧...');
  const tables = parseTables(html);
  // 找包含 "US" 行且宽 >= 12 列的表
  let cTable = null;
  for (const t of tables) { for (const r of t) { if (r[0] === 'US' && r.length >= 12) { cTable = t; break; } } if (cTable) break; }
  if (!cTable) { console.log('  ⚠️ 未找到排名表'); return null; }

  const rows = [], scores = {};
  PN.forEach(n => scores[n] = { cnt: 0, lead: 0, ranks: [] });

  for (const row of cTable) {
    if (row.length < 12) continue;
    const co = row[0].trim();
    if (co.length !== 2 || co === '国家' || co === '缩写') continue;
    const ranks = [];
    let best = 999, bi = -1;
    for (let i = 0; i < 11; i++) {
      const r = parseRank(row[i + 1]);
      ranks.push(r);
      if (r !== null) { scores[PN[i]].cnt++; scores[PN[i]].ranks.push(r); if (r < best) { best = r; bi = i; } }
    }
    const lead = bi >= 0 ? PA[bi] : '–';
    if (bi >= 0) scores[PN[bi]].lead++;
    rows.push([co, ...ranks.map(r => r === null ? '-' : r), lead]);
  }

  const rankings = PN.map(name => {
    const s = scores[name];
    const avg = s.ranks.length > 0 ? s.ranks.reduce((a, b) => a + b, 0) / s.ranks.length : 200;
    const score = Math.round(((s.cnt / 30) * 10 + Math.max(0, (200 - avg) / 200) * 15) * 10) / 10;
    return { n: name, s: score, gl: 0, fl: s.lead, c: s.cnt + '/30', t: 'flat', ch: '+0.0' };
  }).sort((a, b) => b.s - a.s);

  console.log('  ✅ ' + rows.length + ' 个国家');
  return { rankings, table: { h: PA, r: rows } };
}

// ─── 解析免费报告 ───
function parseFree(html) {
  console.log('\n📊 解析免费短剧...');
  const tables = parseTables(html);
  const iosT = [], gpT = [];
  const iosS = FN.map(() => ({ c: 0, tags: [] }));
  const gpS = FN.map(() => ({ c: 0, tags: [] }));

  for (const table of tables) {
    let hasUS = false;
    for (const r of table) { if (r[0] === 'US' && r.length >= 6) { hasUS = true; break; } }
    if (!hasUS) continue;

    const isIos = iosT.length === 0;
    const target = isIos ? iosT : gpT;
    const stats = isIos ? iosS : gpS;

    for (const row of table) {
      if (row.length < 6) continue;
      const co = row[0].trim();
      if (co.length !== 2 || co === '国家') continue;
      const ranks = [];
      let best = 999, bi = -1;
      for (let i = 0; i < 5; i++) {
        const r = parseRank(row[i + 1]);
        ranks.push(r);
        if (r !== null) {
          stats[i].c++;
          if (r <= 5) stats[i].tags.push({ t: co + ' #' + r, top: true });
          else if (r <= 20) stats[i].tags.push({ t: co + ' #' + r, top: false });
          if (r < best) { best = r; bi = i; }
        }
      }
      target.push([co, ...ranks.map(r => r === null ? '-' : r), bi >= 0 ? FA[bi] : '–']);
    }
  }

  const products = FN.map((n, i) => ({
    n, co: FC[i], ios: iosS[i].c, gp: gpS[i].c,
    total: Math.max(iosS[i].c, gpS[i].c, iosS[i].c + gpS[i].c > 0 ? new Set([...iosT.map(r => r[0]), ...gpT.map(r => r[0])].filter((co, idx) => {
      // rough: just use max
      return true;
    })).size : 0),
    tags: [...gpS[i].tags, ...iosS[i].tags].slice(0, 7)
  }));
  // Simpler total calc
  products.forEach(p => { p.total = Math.max(p.ios, p.gp); });

  console.log('  ✅ iOS ' + iosT.length + ' 国 / GP ' + gpT.length + ' 国');
  return { products, iosT, gpT };
}

// ─── 自动洞察（规则引擎）───
function paidInsights(rk) {
  const ins = [];
  if (!rk || rk.length === 0) return ins;
  const top = rk[0];
  ins.push({ h: top.n + ' 以 ' + top.s + ' 分领跑', p: '在 ' + top.fl + ' 个国家免费榜领先，覆盖 ' + top.c + ' 个市场。', tag: 'g' });
  const fl = [...rk].sort((a, b) => b.fl - a.fl)[0];
  if (fl.n !== top.n && fl.fl > 0) ins.push({ h: fl.n + ' 在 ' + fl.fl + ' 国免费榜领先', p: '免费榜领先国家数最多，下载获取能力突出。', tag: 'p' });
  const bot = rk[rk.length - 1];
  if (bot.s < 8) ins.push({ h: bot.n + ' 综合分仅 ' + bot.s, p: '排名末位，覆盖 ' + bot.c + ' 个市场。', tag: 'r' });
  return ins;
}

function freeInsights(prods) {
  const ins = [], s = [...prods].sort((a, b) => b.total - a.total);
  if (s[0]) ins.push({ h: s[0].n + ' 覆盖 ' + s[0].total + ' 国领跑', p: 'iOS ' + s[0].ios + ' 国 + GP ' + s[0].gp + ' 国，全球化程度最高。', tag: 'g' });
  if (s[1]) ins.push({ h: s[1].n + ' 覆盖 ' + s[1].total + ' 国', p: 'iOS ' + s[1].ios + ' 国 + GP ' + s[1].gp + ' 国，新兴市场发力。', tag: 'p' });
  const w = s.filter(p => p.total <= 2);
  if (w.length) ins.push({ h: w.map(p => p.n).join('、') + ' 覆盖面有限', p: '仅少数市场上榜，全球化是挑战。', tag: 'r' });
  return ins;
}

// ─── 组装 & 保存 ───
function save(date, pd, fd) {
  console.log('\n💾 保存 data.json...');
  let data;
  try { data = JSON.parse(readFileSync('data.json', 'utf-8')); } catch { data = { colors: {}, profiles: [], reports: {} }; }

  if (!data.colors || !data.colors.DramaBox) {
    data.colors = { DramaBox:'#D97706',NetShort:'#4F46E5',DramaWave:'#06B6D4',ReelShort:'#F97316',GoodShort:'#10B981',ShortMax:'#8B5CF6',VibeShort:'#EC4899',StarDustTV:'#14B8A6',StoryReel:'#EAB308',MoboReels:'#60A5FA',DreameShort:'#EF4444',Freereels:'#F97316',Pinedrama:'#4F46E5',Melolo:'#06B6D4',MicroDrama:'#8B5CF6',KukuTV:'#9CA3AF' };
  }
  if (!data.profiles?.length) {
    data.profiles = [
      {n:'ReelShort',co:'Crazy Maple Studio / 中文在线',y:2022,d:'全球短剧先驱，TIME100最具影响力公司。'},
      {n:'DramaBox',co:'点众科技',y:2023,d:'全球#2短剧App，AI推荐引擎驱动付费转化。'},
      {n:'NetShort',co:'NETSTORY / 麦芽',y:2024,d:'Q1下载增长196%，日韩东南亚强势。'},
      {n:'DramaWave',co:'SKYWORK AI / 昆仑万维',y:2024,d:'3万+剧集，17种语言。'},
      {n:'ShortMax',co:'九洲文化',y:2023,d:'5000万+下载，曾为全球三强。'},
      {n:'GoodShort',co:'新阅时代',y:2023,d:'精品短剧平台，电影级制作品质。'},
      {n:'MoboReels',co:'畅读科技',y:2023,d:'广告+免费模式，多语言字幕。'},
      {n:'StoryReel',co:'Equinox Enterprises',y:2024,d:'新兴短剧平台，iOS/Android双端。'},
      {n:'VibeShort',co:'VibeShort',y:2024,d:'AI漫画短剧平台。'},
      {n:'DreameShort',co:'Dreame / STARY',y:2024,d:'字节生态短剧平台。'},
      {n:'StarDustTV',co:'山海星辰',y:2024,d:'新兴短剧平台，多语言支持。'},
      {n:'Freereels',co:'昆仑万维',y:2024,d:'免费短剧全球第1，累计下载突破2亿。',free:true},
      {n:'Pinedrama',co:'字节跳动',y:2026,d:'TikTok旗下免费短剧App。',free:true},
      {n:'Melolo',co:'字节跳动',y:2024,d:'东南亚基本盘稳固。',free:true},
      {n:'KukuTV',co:'印度本土',y:2024,d:'印度市场龙头，累计下载1.7亿+。',free:true}
    ];
  }

  // 趋势：拼接历史
  const rk = pd?.rankings || [];
  const histDates = Object.keys(data.reports || {}).sort().slice(-5);
  const trendData = {};
  for (const r of rk) {
    const hist = histDates.map(d => data.reports[d]?.paid?.rankings?.find(x => x.n === r.n)?.s).filter(v => v != null);
    trendData[r.n] = [...hist, r.s];
    if (hist.length > 0) {
      const prev = hist[hist.length - 1];
      const diff = (r.s - prev).toFixed(1);
      r.ch = (+diff >= 0 ? '+' : '') + diff;
      r.t = +diff > 0.3 ? 'up' : +diff < -0.3 ? 'down' : 'flat';
    }
  }

  const topP = rk[0];
  const report = {
    meta: {
      type: '日报', period: date, eye: 'Daily Intelligence · ' + date,
      title: topP ? (topP.n + ' 以 <em>' + topP.s + '分</em> 领跑<br>全球综合排名') : ('短剧出海竞品<em>日报</em>'),
      sub: date + ' 付费短剧11产品×30国矩阵，免费短剧5产品×16国追踪。',
      stats: [{l:'追踪付费产品',v:'11',c:'var(--indigo)'},{l:'覆盖国家',v:'30',c:'var(--blue)'},{l:'追踪免费产品',v:'5',c:'var(--cyan)'},{l:'免费覆盖国家',v:'16',c:'var(--green)'}]
    },
    paid: {
      rankings: rk,
      trends: { dates: [...histDates.map(d => d.slice(5)), date.slice(5)].slice(-6), data: trendData },
      table: pd?.table || { h: PA, r: [] },
      insights: paidInsights(rk)
    },
    free: {
      products: fd?.products || [],
      iosT: fd?.iosT || [],
      gpT: fd?.gpT || [],
      insights: freeInsights(fd?.products || [])
    }
  };

  data.reports[date] = report;
  const dates = Object.keys(data.reports).sort().reverse();
  if (dates.length > 30) dates.slice(30).forEach(d => delete data.reports[d]);

  writeFileSync('data.json', JSON.stringify(data, null, 2));
  console.log('  ✅ 写入 ' + date + ' (共 ' + Object.keys(data.reports).length + ' 天)');
}

// ─── 主流程 ───
async function main() {
  console.log('🎬 短剧雷达 · 自动更新（纯爬虫，零成本）');
  console.log('='.repeat(40));
  try {
    const { paid, free, date } = await findLatest();
    if (!date) { console.log('\n⚠️ 未找到新文章'); return; }
    console.log('\n📅 目标: ' + date);

    let pd = null, fd = null;
    if (paid) pd = parsePaid(await fetchPage(paid.url));
    if (free) fd = parseFree(await fetchPage(free.url));

    save(date, pd, fd);
    console.log('\n' + '='.repeat(40));
    console.log('🎉 完成！零成本，无需 API Key。');
  } catch (e) {
    console.error('\n❌ 失败:', e.message);
    process.exit(1);
  }
}

main();
