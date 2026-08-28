const fs = require('node:fs');

const API_KEY = process.env.NARA_API_KEY || '';
const API_BASE = process.env.NARA_API_BASE || 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
const LOOKBACK_DAYS = Number(process.env.NARA_LOOKBACK_DAYS || 30);
const ROWS = process.env.NARA_ROWS || '100';
const ACTIVE_KEYWORDS = ['반도체', '증착', '진공', 'PVD', 'CVD', 'Sputtering', '스퍼터', '스퍼터링', '웨이퍼'];

if (!API_KEY) throw new Error('NARA_API_KEY secret is not configured.');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fetchJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, {signal: controller.signal});
      if (!response.ok) throw new Error(`나라장터 API 응답 오류: ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(3000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

const itemValue = (item, keys) => {
  for (const key of keys) if (item && item[key] != null) return item[key];
  return '';
};

function keywordMatchesText(text, keyword) {
  if (/^[a-z0-9][a-z0-9 .-]*$/i.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&').replace(/\\s+/g, '\\s+');
    return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i').test(text);
  }
  return text.includes(keyword);
}

function mapItems(items, businessType) {
  return items.map(item => {
    const title = itemValue(item, ['bidNtceNm', 'bidNtceName']);
    const organization = itemValue(item, ['dminsttNm', 'ntceInsttNm', 'orderInsttNm']);
    const postedRaw = itemValue(item, ['bidNtceDt', 'bidNtceDate', 'rgstDt']);
    const posted = postedRaw ? String(postedRaw).slice(0, 10).replaceAll('-', '.') : '';
    const deadlineRaw = itemValue(item, ['bidClseDt', 'bidClseDate']);
    const amount = itemValue(item, ['presmptPrce', 'asignBdgtAmt', 'bdgtAmt']);
    const deadline = deadlineRaw ? String(deadlineRaw).slice(0, 10).replaceAll('-', '.') : '';
    const deadlineAt = deadline ? new Date(`${deadline.replaceAll('.', '-')}T23:59:59+09:00`) : null;
    const urgent = deadlineAt ? deadlineAt >= new Date() && (deadlineAt.getTime() - Date.now()) <= 72 * 60 * 60 * 1000 : false;
    const noticeUrl = itemValue(item, ['bidNtceDtlUrl', 'bidNtceUrl', 'bidNtceUrlInfo']);
    return {
      t: String(title || '공고명 확인 필요'), o: String(organization || '기관 확인 필요'),
      k: '나라장터 ' + businessType, y: businessType,
      p: amount ? String(amount) : '금액 확인 필요', d: deadline, s: urgent,
      posted, postedDate: posted,
      u: String(noticeUrl || ''), title: String(title || '공고명 확인 필요'),
      organization: String(organization || '기관 확인 필요'), keyword: '나라장터 ' + businessType,
      businessType, baseAmount: amount ? String(amount) : '금액 확인 필요', deadline, urgent,
      noticeNumber: String(itemValue(item, ['bidNtceNo', 'bidNtceNum']) || ''),
      noticeUrl: String(noticeUrl || ''), source: '조달청 나라장터 API'
    };
  });
}

async function fetchOperation(operation, businessType, params, searchKeyword) {
  const requestParams = new URLSearchParams(params);
  requestParams.set('bidNtceNm', searchKeyword);
  const raw = await fetchJson(`${API_BASE}/${operation}PPSSrch?${requestParams}`);
  const items = raw?.response?.body?.items?.item || raw?.response?.body?.items || [];
  return mapItems(Array.isArray(items) ? items : [items], businessType);
}

function formatApiDate(date) { return date.toISOString().slice(0, 16).replace(/[-:T]/g, ''); }

async function main() {
  let decodedKey = API_KEY;
  try { if (API_KEY.includes('%')) decodedKey = decodeURIComponent(API_KEY); } catch {}
  const end = new Date();
  const begin = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const params = new URLSearchParams({serviceKey: decodedKey, pageNo: '1', numOfRows: ROWS, type: 'json', inqryDiv: '1', inqryBgnDt: formatApiDate(begin), inqryEndDt: formatApiDate(end)});
  const operations = [['getBidPblancListInfoThng', '물품'], ['getBidPblancListInfoServc', '용역']];
  const responses = [];
  for (const keyword of ACTIVE_KEYWORDS) {
    for (const [op, type] of operations) {
      responses.push(await fetchOperation(op, type, params, keyword));
      await wait(500);
    }
  }
  const unique = new Map();
  responses.flat().forEach(item => {
    const key = item.noticeNumber || item.noticeUrl || `${item.businessType}|${item.title}|${item.organization}`;
    if (!unique.has(key)) unique.set(key, item);
  });
  const results = [...unique.values()]
    .map(item => ({...item, matchedKeyword: ACTIVE_KEYWORDS.map(x => x.toLowerCase()).find(keyword => keywordMatchesText(`${item.title} ${item.organization} ${item.keyword}`.toLowerCase(), keyword)) || ''}))
    .filter(item => item.matchedKeyword)
    .sort((a, b) => (a.businessType === '물품' ? 0 : 1) - (b.businessType === '물품' ? 0 : 1));
  const payload = {source: '나라장터 장비공고 레이더', savedAt: new Date().toISOString(), live: true, keywordFile: 'GitHub Actions 자동 수집', relatedKeywords: ACTIVE_KEYWORDS, relatedKeywordCount: ACTIVE_KEYWORDS.length, keywordFiltered: true, results};
  fs.writeFileSync('nara-data.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Updated ${results.length} notices.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
