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
  // 選択中の都道府県コード配列 と エリア（`middle#small`）配列
  let selMids = [];
  let selAreas = [];
  // ジョブ(プロバイダ×エリア)ごとのページング状態 key=`${providerId}#${middle}#${small}`
  let pagingState = {};
  let allItems = [];

  const APP_VER = 19; // index.htmlの ?v= と合わせる（フッターに表示＝キャッシュ切り分け用）
  const MAX_TARGETS = 12; // 1検索で叩くエリア数の上限（レート制限対策）
  const areaKey = (mid, small) => `${mid}#${small}`;

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
    $('appVer').textContent = `v${APP_VER}`;

    // 過去に保存された不正なアフィリエイトIDを自動修復（v11以前の事故データ対策）
    if (settings.affiliateId && !AFF_RE.test(settings.affiliateId)) {
      settings.affiliateId = '';
      saveJson(LS_SETTINGS, settings);
    }
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

    // 子供の人数（楽天APIの6区分、0〜9名）
    document.querySelectorAll('.kids-num').forEach((sel) => {
      fillSelect(sel, Array.from({ length: 10 }, (_, i) => [i, i === 0 ? '0名' : `${i}名`]), '0');
      sel.addEventListener('change', updateKidsSummary);
    });

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
    $('btnCloseSettings').addEventListener('click', () => $('settingsPanel').classList.add('hidden'));
    $('btnSaveSettings').addEventListener('click', onSaveSettings);
    $('prefList').addEventListener('change', onPrefToggle);
    $('areaList').addEventListener('change', onAreaToggle);
    $('areaChips').addEventListener('click', onChipRemove);
    $('inpCheckin').addEventListener('change', onCheckinChange);
    $('searchForm').addEventListener('submit', onSearch);
    $('btnMore').addEventListener('click', onMore);
    document.querySelector('#squeezeChecks input[value="rotenburo"]')
      .addEventListener('change', (ev) => {
        $('rotenNote').style.display = ev.target.checked ? '' : 'none';
      });

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

  const KID_FIELDS = {
    upClassNum: 'selKidsUp',
    lowClassNum: 'selKidsLow',
    infantWithMBNum: 'selKidsInfMB',
    infantWithMNum: 'selKidsInfM',
    infantWithBNum: 'selKidsInfB',
    infantWithoutMBNum: 'selKidsInfNone',
  };

  function collectKids() {
    const kids = {};
    for (const [param, id] of Object.entries(KID_FIELDS)) {
      const n = Number($(id).value);
      if (n > 0) kids[param] = n;
    }
    return kids;
  }

  function kidsTotal(kids) {
    return Object.values(kids || {}).reduce((s, n) => s + n, 0);
  }

  function updateKidsSummary() {
    const total = kidsTotal(collectKids());
    $('kidsSummary').textContent = total
      ? `子供の人数（1室あたり）: 合計${total}名`
      : '子供の人数（1室あたり・任意）';
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
  // 楽天アフィリエイトIDは「16進をドットで繋いだ形式」(例: 0ea62065.34400275.0ea62066.204f04c0)。
  // それ以外の文字列を渡すとAPIが全リンクを無効なhb.afl.rakuten.co.jpラッパーで包み、
  // クリック時に楽天市場トップへ飛ばされる事故になる（実例:「宿さがし」と入力されていた）→形式検証必須。
  const AFF_RE = /^[0-9a-z]+(\.[0-9a-z]+)+$/i;
  function cleanAffiliateId(v) {
    return AFF_RE.test(v || '') ? v : '';
  }

  async function onSaveSettings() {
    const affRaw = $('inpAffiliateId').value.trim();
    const affiliateId = cleanAffiliateId(affRaw);
    settings = {
      rakutenAppId: $('inpAppId').value.trim(),
      rakutenAccessKey: $('inpAccessKey').value.trim(),
      affiliateId,
    };
    saveJson(LS_SETTINGS, settings);
    if (affRaw && !affiliateId) {
      $('inpAffiliateId').value = '';
      setMsg('settingsMsg', `「${affRaw}」は楽天アフィリエイトIDの形式ではないため保存しませんでした（この欄は通常空欄でOKです）`, true);
    }
    if (!settings.rakutenAppId) {
      setMsg('settingsMsg', 'アプリIDを入力してください', true);
      return;
    }
    if (!(affRaw && !affiliateId)) setMsg('settingsMsg', 'エリア情報を取得中…');
    try {
      await loadAreas(true);
      if (!(affRaw && !affiliateId)) {
        setMsg('settingsMsg', '✓ 保存しました。エリアを選択して検索できます。');
        setTimeout(() => $('settingsPanel').classList.add('hidden'), 900);
      }
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

  const midName = (mid) => (areaTree.find((m) => m.code === mid) || {}).name || mid;
  const smallsOf = (mid) => ((areaTree.find((m) => m.code === mid) || {}).children) || [];
  const smallName = (mid, small) => (smallsOf(mid).find((s) => s.code === small) || {}).name || small;

  // 都道府県一覧を描画（複数選択）
  function populateMiddle() {
    if (!areaTree.length) return;
    $('prefList').innerHTML = areaTree.map((m) => (
      `<label class="ms-opt"><input type="checkbox" data-mid="${esc(m.code)}"`
      + `${selMids.includes(m.code) ? ' checked' : ''}>${esc(m.name)}</label>`
    )).join('');
    renderAreaList();
    renderAreaChips();
  }

  // 選択中の都道府県ごとに、その配下エリア（＋全域）を描画
  function renderAreaList() {
    if (!selMids.length) {
      $('areaList').innerHTML = '<p class="ms-hint">左で都道府県を選ぶと表示されます</p>';
      return;
    }
    $('areaList').innerHTML = selMids.map((mid) => {
      const smalls = smallsOf(mid);
      if (!smalls.length) return '';
      const allOn = smalls.every((s) => selAreas.includes(areaKey(mid, s.code)));
      const opts = smalls.map((s) => {
        const k = areaKey(mid, s.code);
        return `<label class="ms-opt"><input type="checkbox" data-area="${esc(k)}"`
          + `${selAreas.includes(k) ? ' checked' : ''}>${esc(s.name)}</label>`;
      }).join('');
      return `<div class="ms-group"><div class="ms-group__head">${esc(midName(mid))}</div>`
        + `<label class="ms-opt ms-opt--all"><input type="checkbox" data-all="${esc(mid)}"`
        + `${allOn ? ' checked' : ''}>${esc(midName(mid))} 全域</label>${opts}</div>`;
    }).join('') || '<p class="ms-hint">選択した都道府県にエリア情報がありません</p>';
  }

  // 選択中エリアをチップ表示（都道府県だけ選んでエリア未選択なら都道府県チップ）
  function renderAreaChips() {
    const chips = [];
    for (const mid of selMids) {
      const areas = selAreas.filter((k) => k.startsWith(mid + '#'));
      if (areas.length) {
        for (const k of areas) {
          chips.push(`<span class="ms-chip">${esc(midName(mid))}/${esc(smallName(mid, k.split('#')[1]))}`
            + `<span class="ms-chip__x" data-rm-area="${esc(k)}">×</span></span>`);
        }
      } else {
        chips.push(`<span class="ms-chip">${esc(midName(mid))}<small>（エリア未選択）</small>`
          + `<span class="ms-chip__x" data-rm-mid="${esc(mid)}">×</span></span>`);
      }
    }
    $('areaChips').innerHTML = chips.join('');
    const n = selAreas.length;
    $('areaSummary').textContent = n
      ? `都道府県・エリアを選ぶ（${n}エリア選択中）`
      : '都道府県・エリアを選ぶ';
  }

  function onPrefToggle(ev) {
    const mid = ev.target.dataset.mid;
    if (!mid) return;
    if (ev.target.checked) {
      if (!selMids.includes(mid)) selMids.push(mid);
    } else {
      selMids = selMids.filter((x) => x !== mid);
      selAreas = selAreas.filter((k) => !k.startsWith(mid + '#'));
    }
    renderAreaList();
    renderAreaChips();
  }

  function onAreaToggle(ev) {
    const t = ev.target;
    if (t.dataset.all !== undefined) {
      const mid = t.dataset.all;
      const keys = smallsOf(mid).map((s) => areaKey(mid, s.code));
      selAreas = selAreas.filter((k) => !keys.includes(k));
      if (t.checked) selAreas.push(...keys);
    } else if (t.dataset.area !== undefined) {
      const k = t.dataset.area;
      if (t.checked) { if (!selAreas.includes(k)) selAreas.push(k); }
      else selAreas = selAreas.filter((x) => x !== k);
    } else return;
    renderAreaList();
    renderAreaChips();
  }

  function onChipRemove(ev) {
    const x = ev.target.closest('.ms-chip__x');
    if (!x) return;
    if (x.dataset.rmArea !== undefined) {
      selAreas = selAreas.filter((k) => k !== x.dataset.rmArea);
    } else if (x.dataset.rmMid !== undefined) {
      const mid = x.dataset.rmMid;
      selMids = selMids.filter((m) => m !== mid);
      selAreas = selAreas.filter((k) => !k.startsWith(mid + '#'));
    }
    populateMiddle(); // チェック状態も戻すため全再描画
  }

  // 選択状態 → 検索対象エリア配列 [{middle, small}]
  function deriveTargets() {
    const targets = [];
    for (const mid of selMids) {
      const areas = selAreas.filter((k) => k.startsWith(mid + '#'));
      for (const k of areas) targets.push({ middle: mid, small: k.split('#')[1] });
    }
    return targets;
  }

  function restoreLastForm() {
    const f = loadJson(LS_LASTFORM);
    if (!f) return;
    if (Array.isArray(f.mids)) selMids = f.mids.filter((mid) => areaTree.some((m) => m.code === mid));
    if (Array.isArray(f.areas)) {
      selAreas = f.areas.filter((k) => {
        const [mid, small] = k.split('#');
        return selMids.includes(mid) && smallsOf(mid).some((s) => s.code === small);
      });
    }
    populateMiddle();
    if (f.adults) $('selAdults').value = f.adults;
    if (f.rooms) $('selRooms').value = f.rooms;
    if (f.kids && kidsTotal(f.kids) > 0) {
      for (const [param, id] of Object.entries(KID_FIELDS)) {
        if (f.kids[param]) $(id).value = String(f.kids[param]);
      }
      $('kidsDetails').open = true;
      updateKidsSummary();
    }
  }

  /* ---------------- 検索 ---------------- */
  function collectParams() {
    const checked = Array.from(document.querySelectorAll('#squeezeChecks input:checked'));
    // data-local付きはAPIに送らずクライアント側でプラン名判定する条件（露天風呂付客室）
    const squeeze = checked.filter((c) => !c.dataset.local).map((c) => c.value);
    const localFilters = checked.filter((c) => c.dataset.local).map((c) => c.value);
    return {
      checkin: $('inpCheckin').value,
      checkout: $('inpCheckout').value,
      targets: deriveTargets(),
      adults: $('selAdults').value,
      rooms: $('selRooms').value,
      kids: collectKids(),
      minCharge: $('selMinCharge').value,
      maxCharge: $('selMaxCharge').value,
      squeeze,
      localFilters,
    };
  }

  // 露天風呂付客室: APIに絞込条件が無いため、返却プラン名・部屋名で判定。
  // 「絶景露天を満喫」のような大浴場の露天に触れただけの文言を拾わないよう、客室系パターンに限定
  const ROTEN_RE = /露天風呂付|露天付|客室露天|部屋露天|お部屋.{0,4}露天|専用露天|露天風呂の?ある(客室|部屋|離れ)/;
  function applyLocalFilters(items) {
    if (!lastParams || !lastParams.localFilters.includes('rotenburo')) return items;
    return items.filter((i) => {
      // 「貸切露天風呂付き」は客室露天ではないため、貸切系の語を除いてから判定
      const text = `${i.planName}${i.roomName}`.replace(/貸切(半)?露天/g, '');
      return ROTEN_RE.test(text);
    });
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
    if (!params.targets.length) {
      if (selMids.length) {
        showError('エリアを選択してください（都道府県名の「全域」も選べます）');
        $('areaPicker').open = true;
      } else {
        showError('都道府県・エリアを選択してください');
        $('areaPicker').open = true;
      }
      return;
    }
    if (!(new Date(params.checkout) > new Date(params.checkin))) {
      showError('チェックアウト日はチェックイン日より後にしてください');
      return;
    }
    let capped = false;
    if (params.targets.length > MAX_TARGETS) {
      params.targets = params.targets.slice(0, MAX_TARGETS);
      capped = true;
    }
    saveJson(LS_LASTFORM, {
      mids: selMids, areas: selAreas,
      adults: params.adults, rooms: params.rooms, kids: params.kids,
    });

    lastParams = params;
    lastParams.capped = capped;
    pagingState = {};
    allItems = [];
    $('resultSection').classList.add('hidden');
    $('resultList').innerHTML = '';
    setLoading(true);
    $('btnSearch').disabled = true;

    try {
      const jobs = initialJobs();
      await runJobs(jobs);
      // ローカルフィルタ(露天風呂)で件数が減る場合は自動で追加ページを取得
      let guard = 0;
      while (
        lastParams.localFilters.length &&
        applyLocalFilters(allItems).length < 10 &&
        hasMorePages() && guard < 4
      ) {
        await runJobs(nextPageJobs());
        guard++;
      }
      renderResults();
    } catch (e) {
      showError(errorText(e));
    } finally {
      setLoading(false);
      $('btnSearch').disabled = false;
    }
  }

  function hasMorePages() {
    return Object.values(pagingState).some((s) => s.page < s.pageCount);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  const configuredProviders = () => PROVIDERS.filter((p) => p.isConfigured(settings));

  // 初回: 全プロバイダ × 全対象エリア を page1 で
  function initialJobs() {
    const jobs = [];
    for (const p of configuredProviders()) {
      for (const t of lastParams.targets) {
        jobs.push({ provider: p, target: t, key: `${p.id}#${t.middle}#${t.small}`, page: 1 });
      }
    }
    return jobs;
  }

  // 追加読み込み: まだページが残るジョブを次ページで
  function nextPageJobs() {
    return Object.values(pagingState)
      .filter((s) => s.page < s.pageCount)
      .map((s) => ({
        provider: PROVIDERS.find((p) => p.id === s.providerId),
        target: s.target,
        key: `${s.providerId}#${s.target.middle}#${s.target.small}`,
        page: s.page + 1,
      }))
      .filter((j) => j.provider);
  }

  // ジョブ列を順次実行（楽天レート制限1req/秒のため各API呼び出し間に1.1秒待つ）
  async function runJobs(jobs) {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (i > 0) await sleep(1100);
      if (jobs.length > 1) {
        setLoading(true, `検索中… ${i + 1}/${jobs.length} エリア`);
      }
      const res = await job.provider.search(
        { ...lastParams, middle: job.target.middle, small: job.target.small, detail: '', page: job.page },
        settings
      );
      pagingState[job.key] = {
        page: res.page, pageCount: res.pageCount, total: res.total,
        providerId: job.provider.id, target: job.target,
      };
      const seen = new Set(allItems.map((it) => `${it.provider}:${it.id}`));
      for (const item of res.items) {
        if (!seen.has(`${item.provider}:${item.id}`)) allItems.push(item);
      }
    }
    allItems.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
  }

  async function onMore() {
    if (!lastParams) return;
    $('btnMore').disabled = true;
    setLoading(true);
    try {
      await runJobs(nextPageJobs());
      renderResults();
    } catch (e) {
      showError(errorText(e));
    } finally {
      setLoading(false);
      $('btnMore').disabled = false;
    }
  }

  /* 他サイト横断リンク(Google/Booking/Agoda/じゃらん/Yahoo)はv13〜v18で実装・検証したが、
   * 方針変更(2026-07-09ユーザー指示)により全廃し楽天のみの構成に(v19)。
   * 経緯・各サイトのディープリンク可否の知見はREADME参照。
   * 注意: カードの外部リンクは意図的に target="_blank" を付けない（同一タブで開く）。
   * 新規タブ遷移はユーザー環境の拡張に横取りされ楽天市場トップへ差し替えられた実例あり。 */

  /* ---------------- 描画 ---------------- */
  function renderResults() {
    const total = Object.values(pagingState).reduce((s, p) => s + (p.total || 0), 0);
    const shown = applyLocalFilters(allItems);
    const filtered = lastParams && lastParams.localFilters.length;
    const nAreas = lastParams ? lastParams.targets.length : 1;
    const areaNote = nAreas > 1 ? `${nAreas}エリア横断・` : '';
    if (!total) {
      $('resultCount').innerHTML = '該当する空室が見つかりませんでした';
    } else if (filtered && !shown.length) {
      $('resultCount').innerHTML = `露天風呂付プランは見つかりませんでした（${allItems.length}件を判定済み。「もっと見る」で続きを判定できます）`;
    } else {
      $('resultCount').innerHTML = `<strong>${shown.length.toLocaleString()}</strong> 件表示`
        + (filtered ? `（${areaNote}${allItems.length}件中・露天風呂判定）` : `（${areaNote}全${total.toLocaleString()}件）`);
    }
    if (lastParams && lastParams.capped) {
      $('resultCount').innerHTML += `<br><small class="cap-note">※エリアが多いため先頭${MAX_TARGETS}エリアで検索しました</small>`;
    }
    $('resultList').innerHTML = shown.map(cardHtml).join('');
    const hasMore = Object.values(pagingState).some((s) => s.page < s.pageCount);
    $('btnMore').classList.toggle('hidden', !hasMore);
    $('resultSection').classList.remove('hidden');
  }

  function cardHtml(item) {
    const provider = PROVIDERS.find((p) => p.id === item.provider);
    const nights = lastParams
      ? Math.max(1, Math.round((new Date(lastParams.checkout) - new Date(lastParams.checkin)) / 86400000))
      : 1;
    const kidsN = lastParams ? kidsTotal(lastParams.kids) : 0;
    const priceNote = lastParams
      ? `〜 1室合計（大人${esc(lastParams.adults)}名${kidsN ? `・子${kidsN}名` : ''}・${nights}泊）`
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
          <a class="btn-book" href="${esc(item.url)}" rel="noopener">プランを見る</a>
        </div>
      </article>`;
  }

  /* ---------------- メッセージ ---------------- */
  function setLoading(on, msg) {
    const el = $('loading');
    el.classList.toggle('hidden', !on);
    if (on) el.innerHTML = `<span class="spinner"></span>${esc(msg || '検索中…')}`;
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
