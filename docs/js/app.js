/* 宿最安ファインダー 本体
 * プロバイダ横断で検索し、価格昇順にマージ表示する。
 * 現在: 楽天トラベル / 将来: ヤフートラベル・じゃらんを PROVIDERS に追加するだけで統合される */
(function () {
  'use strict';

  const PROVIDERS = [window.RakutenProvider];

  const LS_SETTINGS = 'ys_settings_v1';
  const LS_AREAS = 'ys_areas_v1';
  const LS_LASTFORM = 'ys_lastform_v1';
  const AREAS_TTL = 7 * 24 * 3600 * 1000; // 7日キャッシュ

  const $ = (id) => document.getElementById(id);

  let settings = loadJson(LS_SETTINGS) || {};
  let areaTree = [];
  let lastParams = null;
  // プロバイダごとのページング状態 { rakuten: {page, pageCount} }
  let pagingState = {};
  let allItems = [];

  /* ---------------- util ---------------- */
  function loadJson(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function saveJson(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function yen(n) {
    return '¥' + Number(n).toLocaleString('ja-JP');
  }
  function fmtDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* ---------------- 初期化 ---------------- */
  function init() {
    // 日付デフォルト: 1週間後に1泊
    const today = new Date();
    const ci = new Date(today); ci.setDate(ci.getDate() + 7);
    const co = new Date(today); co.setDate(co.getDate() + 8);
    $('inpCheckin').value = fmtDate(ci);
    $('inpCheckin').min = fmtDate(today);
    $('inpCheckout').value = fmtDate(co);
    $('inpCheckout').min = fmtDate(today);

    // 人数・部屋数
    fillSelect($('selAdults'), Array.from({ length: 10 }, (_, i) => [i + 1, `${i + 1}名`]), '2');
    fillSelect($('selRooms'), Array.from({ length: 10 }, (_, i) => [i + 1, `${i + 1}室`]), '1');

    // 予算
    const budgets = [3000, 5000, 8000, 10000, 15000, 20000, 30000, 50000];
    fillSelect($('selMinCharge'), [['', '指定なし'], ...budgets.map((b) => [b, `${yen(b)}〜`])], '');
    fillSelect($('selMaxCharge'), [['', '指定なし'], ...budgets.map((b) => [b, `〜${yen(b)}`])], '');

    // 設定
    $('inpAppId').value = settings.rakutenAppId || '';
    $('inpAccessKey').value = settings.rakutenAccessKey || '';
    $('inpAffiliateId').value = settings.affiliateId || '';
    if (!window.RakutenProvider.isConfigured(settings)) {
      $('settingsPanel').classList.remove('hidden');
    }

    // イベント
    $('btnSettings').addEventListener('click', () => $('settingsPanel').classList.toggle('hidden'));
    $('btnSaveSettings').addEventListener('click', onSaveSettings);
    $('selMiddle').addEventListener('change', () => populateSmall());
    $('selSmall').addEventListener('change', () => populateDetail());
    $('inpCheckin').addEventListener('change', onCheckinChange);
    $('searchForm').addEventListener('submit', onSearch);
    $('btnMore').addEventListener('click', onMore);

    // エリア復元 or 取得
    const cached = loadJson(LS_AREAS);
    if (cached && cached.tree && Date.now() - cached.ts < AREAS_TTL) {
      areaTree = cached.tree;
      populateMiddle();
      restoreLastForm();
    } else if (window.RakutenProvider.isConfigured(settings)) {
      loadAreas();
    }
  }

  function fillSelect(sel, pairs, selected) {
    sel.innerHTML = pairs
      .map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${esc(t)}</option>`)
      .join('');
  }

  function onCheckinChange() {
    // チェックアウトがチェックイン以前ならチェックイン+1日に補正
    const ci = new Date($('inpCheckin').value);
    const co = new Date($('inpCheckout').value);
    if (!(co > ci)) {
      const next = new Date(ci); next.setDate(next.getDate() + 1);
      $('inpCheckout').value = fmtDate(next);
    }
    $('inpCheckout').min = $('inpCheckin').value;
  }

  /* ---------------- 設定・エリア ---------------- */
  async function onSaveSettings() {
    settings = {
      rakutenAppId: $('inpAppId').value.trim(),
      rakutenAccessKey: $('inpAccessKey').value.trim(),
      affiliateId: $('inpAffiliateId').value.trim(),
    };
    saveJson(LS_SETTINGS, settings);
    if (!settings.rakutenAppId) {
      setMsg('settingsMsg', 'アプリIDを入力してください', true);
      return;
    }
    setMsg('settingsMsg', 'エリア情報を取得中…');
    try {
      await loadAreas(true);
      setMsg('settingsMsg', '✓ 保存しました。エリアを選択して検索できます。');
      setTimeout(() => $('settingsPanel').classList.add('hidden'), 900);
    } catch (e) {
      setMsg('settingsMsg', `エリア取得に失敗: ${e.message}（アプリIDを確認してください）`, true);
    }
  }

  async function loadAreas(force) {
    if (!force) {
      const cached = loadJson(LS_AREAS);
      if (cached && cached.tree && Date.now() - cached.ts < AREAS_TTL) {
        areaTree = cached.tree;
        populateMiddle();
        return;
      }
    }
    areaTree = await window.RakutenProvider.fetchAreas(settings);
    saveJson(LS_AREAS, { ts: Date.now(), tree: areaTree });
    populateMiddle();
  }

  function populateMiddle() {
    fillSelect(
      $('selMiddle'),
      [['', '都道府県を選択'], ...areaTree.map((m) => [m.code, m.name])],
      ''
    );
    $('selMiddle').disabled = false;
    populateSmall();
  }

  function populateSmall() {
    const m = areaTree.find((x) => x.code === $('selMiddle').value);
    const smalls = (m && m.children) || [];
    if (smalls.length) {
      fillSelect($('selSmall'), smalls.map((s) => [s.code, s.name]), smalls[0].code);
      $('selSmall').disabled = false;
    } else {
      $('selSmall').innerHTML = '<option value="">—</option>';
      $('selSmall').disabled = true;
    }
    populateDetail();
  }

  function populateDetail() {
    const m = areaTree.find((x) => x.code === $('selMiddle').value);
    const s = m && (m.children || []).find((x) => x.code === $('selSmall').value);
    const details = (s && s.children) || [];
    if (details.length) {
      fillSelect($('selDetail'), [['', '指定なし'], ...details.map((d) => [d.code, d.name])], '');
      $('selDetail').disabled = false;
    } else {
      $('selDetail').innerHTML = '<option value="">指定なし</option>';
      $('selDetail').disabled = true;
    }
  }

  function restoreLastForm() {
    const f = loadJson(LS_LASTFORM);
    if (!f) return;
    if (f.middle && areaTree.some((m) => m.code === f.middle)) {
      $('selMiddle').value = f.middle;
      populateSmall();
      if (f.small) { $('selSmall').value = f.small; populateDetail(); }
      if (f.detail) $('selDetail').value = f.detail;
    }
    if (f.adults) $('selAdults').value = f.adults;
    if (f.rooms) $('selRooms').value = f.rooms;
  }

  /* ---------------- 検索 ---------------- */
  function collectParams() {
    const squeeze = Array.from(
      document.querySelectorAll('#squeezeChecks input:checked')
    ).map((c) => c.value);
    return {
      checkin: $('inpCheckin').value,
      checkout: $('inpCheckout').value,
      middle: $('selMiddle').value,
      small: $('selSmall').value,
      detail: $('selDetail').value,
      adults: $('selAdults').value,
      rooms: $('selRooms').value,
      minCharge: $('selMinCharge').value,
      maxCharge: $('selMaxCharge').value,
      squeeze,
    };
  }

  async function onSearch(ev) {
    ev.preventDefault();
    hideError();

    if (!window.RakutenProvider.isConfigured(settings)) {
      $('settingsPanel').classList.remove('hidden');
      setMsg('settingsMsg', 'まず楽天アプリIDを設定してください', true);
      return;
    }
    const params = collectParams();
    if (!params.middle) { showError('都道府県を選択してください'); return; }
    if (!(new Date(params.checkout) > new Date(params.checkin))) {
      showError('チェックアウト日はチェックイン日より後にしてください');
      return;
    }
    saveJson(LS_LASTFORM, {
      middle: params.middle, small: params.small, detail: params.detail,
      adults: params.adults, rooms: params.rooms,
    });

    lastParams = params;
    pagingState = {};
    allItems = [];
    $('resultSection').classList.add('hidden');
    $('resultList').innerHTML = '';
    setLoading(true);
    $('btnSearch').disabled = true;

    try {
      await runProviders(1);
      renderResults();
    } catch (e) {
      showError(errorText(e));
    } finally {
      setLoading(false);
      $('btnSearch').disabled = false;
    }
  }

  async function onMore() {
    if (!lastParams) return;
    $('btnMore').disabled = true;
    setLoading(true);
    try {
      const nexts = Object.entries(pagingState)
        .filter(([, s]) => s.page < s.pageCount)
        .map(([id, s]) => ({ id, page: s.page + 1 }));
      await runProviders(null, nexts);
      renderResults();
    } catch (e) {
      showError(errorText(e));
    } finally {
      setLoading(false);
      $('btnMore').disabled = false;
    }
  }

  // page指定(初回)またはプロバイダ別nextページ指定で全プロバイダ検索
  async function runProviders(page, nexts) {
    const targets = PROVIDERS.filter((p) => p.isConfigured(settings));
    for (const p of targets) {
      let reqPage = page;
      if (nexts) {
        const n = nexts.find((x) => x.id === p.id);
        if (!n) continue;
        reqPage = n.page;
      }
      const res = await p.search({ ...lastParams, page: reqPage }, settings);
      pagingState[p.id] = { page: res.page, pageCount: res.pageCount, total: res.total };
      // 同一ホテルの重複を除外して追加
      const seen = new Set(allItems.map((i) => `${i.provider}:${i.id}`));
      for (const item of res.items) {
        if (!seen.has(`${item.provider}:${item.id}`)) allItems.push(item);
      }
    }
    allItems.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
  }

  /* ---------------- 描画 ---------------- */
  function renderResults() {
    const total = Object.values(pagingState).reduce((s, p) => s + (p.total || 0), 0);
    $('resultCount').innerHTML = total
      ? `<strong>${total.toLocaleString()}</strong> 件（${allItems.length}件表示）`
      : '該当する空室が見つかりませんでした';
    $('resultList').innerHTML = allItems.map(cardHtml).join('');
    const hasMore = Object.values(pagingState).some((s) => s.page < s.pageCount);
    $('btnMore').classList.toggle('hidden', !hasMore);
    $('resultSection').classList.remove('hidden');
  }

  function cardHtml(item) {
    const provider = PROVIDERS.find((p) => p.id === item.provider);
    const nights = lastParams
      ? Math.max(1, Math.round((new Date(lastParams.checkout) - new Date(lastParams.checkin)) / 86400000))
      : 1;
    const priceNote = lastParams
      ? `〜 1室合計（大人${esc(lastParams.adults)}名・${nights}泊）`
      : '〜';
    const review = item.review
      ? `<div class="hotel-card__review">★ ${item.review.toFixed(1)} <span class="cnt">(${item.reviewCount.toLocaleString()}件)</span></div>`
      : '';
    const plan = item.planName
      ? `<div class="hotel-card__plan">${esc(item.roomName ? item.roomName + ' / ' : '')}${esc(item.planName)}</div>`
      : '';
    const thumb = item.thumb
      ? `<img class="hotel-card__thumb" src="${esc(item.thumb)}" alt="" loading="lazy">`
      : '<div class="hotel-card__thumb"></div>';
    return `
      <article class="hotel-card">
        ${thumb}
        <div class="hotel-card__body">
          <div class="hotel-card__name">${esc(item.name)}</div>
          ${review}
          <div class="hotel-card__addr">${esc(item.address)}</div>
          ${plan}
        </div>
        <div class="hotel-card__foot">
          <div>
            <span class="badge ${provider ? provider.badgeClass : ''}">${provider ? esc(provider.label) : ''}</span>
            <span class="price">${item.price ? yen(item.price) : '—'}<small>${priceNote}</small></span>
          </div>
          <a class="btn-book" href="${esc(item.url)}" target="_blank" rel="noopener">プランを見る</a>
        </div>
      </article>`;
  }

  /* ---------------- メッセージ ---------------- */
  function setLoading(on) {
    $('loading').classList.toggle('hidden', !on);
  }
  function setMsg(id, text, isError) {
    const el = $(id);
    el.textContent = text;
    el.className = isError ? 'msg msg--error' : 'msg msg--ok';
  }
  function showError(text) {
    const el = $('errorMsg');
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function hideError() {
    $('errorMsg').classList.add('hidden');
  }
  function errorText(e) {
    if (e.status === 429) return 'リクエストが多すぎます。少し待ってから再検索してください。';
    if (e.status === 400) return `検索条件エラー: ${e.message}（アプリIDやエリア指定を確認してください）`;
    if (e.status === 503) return '楽天側がメンテナンス中です。時間をおいて再試行してください。';
    return `検索に失敗しました: ${e.message}`;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
