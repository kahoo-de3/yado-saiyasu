/* =========================================================
 * 楽天トラベル プロバイダ
 *
 * プロバイダ共通インターフェース（ヤフートラベル/じゃらん統合時も同じ形で実装する）:
 *   id            : string  プロバイダ識別子
 *   label         : string  表示名
 *   badgeClass    : string  結果カードのバッジ用CSSクラス
 *   isConfigured(settings)      -> boolean
 *   fetchAreas(settings)        -> Promise<AreaNode[]>   // [{code,name,children:[{code,name,children:[...]}]}]
 *   search(params, settings)    -> Promise<{items, page, pageCount, total}>
 *
 * params: { checkin, checkout, middle, small, detail, adults, rooms,
 *           kids{upClassNum,lowClassNum,infantWith*Num}, minCharge, maxCharge,
 *           squeeze[], page }  ※localFilters(露天風呂等)はapp.js側で判定
 * items(正規化形式): { provider, id, name, url, thumb, address, access,
 *                      review, reviewCount, price, planName, roomName }
 * ========================================================= */
(function () {
  'use strict';

  // 新形式キー(accessKeyあり)はopenapi、従来キーはapp.rakuten.co.jpを使う。
  // どちらでも失敗時はもう一方へフォールバックする。
  const BASES = {
    openapi: 'https://openapi.rakuten.co.jp/engine/api/Travel/',
    legacy:  'https://app.rakuten.co.jp/services/api/Travel/',
  };
  const VERSIONS = {
    vacant: { openapi: '20170426', legacy: '20170426' },
    area:   { openapi: '20140210', legacy: '20131024' },
  };
  const PATHS = { vacant: 'VacantHotelSearch', area: 'GetAreaClass' };

  let jsonpSeq = 0;

  function buildQuery(obj) {
    return Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  function jsonpGet(url) {
    return new Promise((resolve, reject) => {
      const cb = `__ysRakutenCb${++jsonpSeq}`;
      const script = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 12000);
      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
      }
      window[cb] = (data) => { cleanup(); resolve(data); };
      script.src = `${url}&callback=${cb}`;
      script.onerror = () => { cleanup(); reject(new Error('jsonp_load_error')); };
      document.head.appendChild(script);
    });
  }

  // fetch優先、CORS不可ならJSONPへフォールバック（legacyのみ。openapiはOriginヘッダ必須のためJSONP不可）
  async function apiGet(url, allowJsonp) {
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(
          (data && (data.error_description || data.error
            || (data.errors && data.errors.errorMessage) || data.message)) || `HTTP ${res.status}`
        );
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.status || !allowJsonp) throw e; // HTTPエラー or JSONP不可はそのまま
      const data = await jsonpGet(url);     // ネットワーク/CORSエラー → JSONP
      if (data && data.error) {
        const err = new Error(data.error_description || data.error);
        err.status = data.error === 'not_found' ? 404 : 400;
        err.body = data;
        throw err;
      }
      return data;
    }
  }

  // 新形式キー(pk_...)=openapi、従来の数値ID=app.rakuten.co.jp。
  // openapiはapplicationIdとaccessKeyの両方が必須（accessKey未設定ならappIdを流用）で、
  // 許可ドメインからのOriginヘッダも必須（=localhostでは動かない。公開サイト上でのみ動作）。
  async function requestApi(op, params, settings) {
    const isNewKey = /^pk_/.test(settings.rakutenAppId) || !!settings.rakutenAccessKey;
    const base = isNewKey ? 'openapi' : 'legacy';
    const q = { ...params, applicationId: settings.rakutenAppId, format: 'json' };
    if (isNewKey) q.accessKey = settings.rakutenAccessKey || settings.rakutenAppId;
    if (settings.affiliateId) q.affiliateId = settings.affiliateId;
    const url = `${BASES[base]}${PATHS[op]}/${VERSIONS[op][base]}?${buildQuery(q)}`;
    return apiGet(url, base === 'legacy');
  }

  /* ---- GetAreaClass を {code,name,children} に正規化 ----
   * openapi(新)はフラットなオブジェクト、legacy(旧)は [{...Code,...Name},{childClasses:[...]}] の
   * ペア配列。両形式に対応する。 */
  function parseAreaTree(data) {
    const root = data && data.areaClasses && data.areaClasses.largeClasses;
    if (!root) return [];
    const japan = root[0] && root[0].largeClass;
    if (!japan) return [];
    const middles = Array.isArray(japan)
      ? findChildList(japan, 'middleClasses')
      : japan.middleClasses;
    return (middles || []).map((m) => normalizeNode(m.middleClass, 'middle')).filter(Boolean);
  }

  function findChildList(pairArray, key) {
    for (const part of pairArray) {
      if (part && part[key]) return part[key];
    }
    return null;
  }

  const NEXT_LEVEL = { middle: 'small', small: 'detail', detail: null };

  function normalizeNode(node, level) {
    if (!node) return null;
    const isPairArray = Array.isArray(node);
    const info = isPairArray
      ? node.find((p) => p && (p[`${level}ClassCode`] !== undefined))
      : node;
    if (!info || info[`${level}ClassCode`] === undefined) return null;
    const out = {
      code: info[`${level}ClassCode`],
      name: info[`${level}ClassName`],
      children: [],
    };
    const next = NEXT_LEVEL[level];
    if (next) {
      const kids = isPairArray
        ? findChildList(node, `${next}Classes`)
        : node[`${next}Classes`];
      if (kids) {
        out.children = kids
          .map((k) => normalizeNode(k[`${next}Class`], next))
          .filter(Boolean);
      }
    }
    return out;
  }

  /* ---- VacantHotelSearch レスポンス → 正規化アイテム ---- */
  function parseHotels(data, settings) {
    const items = [];
    for (const wrap of data.hotels || []) {
      const parts = wrap.hotel || [];
      let basic = null;
      let rooms = [];
      for (const part of parts) {
        if (part.hotelBasicInfo) basic = part.hotelBasicInfo;
        if (part.roomInfo) rooms = rooms.concat(part.roomInfo);
      }
      if (!basic) continue;

      // roomInfoは {roomBasicInfo} と {dailyCharge} が交互に並ぶ → プラン単位に集約
      const plans = [];
      let cur = null;
      for (const r of rooms) {
        if (r.roomBasicInfo) {
          cur = { info: r.roomBasicInfo, charges: [] };
          plans.push(cur);
        } else if (r.dailyCharge && cur) {
          cur.charges.push(r.dailyCharge);
        }
      }
      // プランの宿泊合計 = 各日のdailyCharge.total(1室・人数分)の合計。
      // hotelMinChargeは検索条件と無関係なホテル全体の最安値なので使わない（実測で不一致を確認済み）。
      let best = null;
      for (const p of plans) {
        const total = p.charges.reduce(
          (sum, c) => sum + (Number(c.total) > 0 ? Number(c.total) : Number(c.rakutenCharge) || 0),
          0
        );
        if (total > 0 && (!best || total < best.total)) best = { ...p, total };
      }

      const price = best ? best.total : (Number(basic.hotelMinCharge) || 0);

      items.push({
        provider: 'rakuten',
        id: String(basic.hotelNo),
        name: basic.hotelName || '',
        url: basic.hotelInformationUrl || basic.planListUrl || '#',
        thumb: basic.hotelThumbnailUrl || basic.hotelImageUrl || '',
        address: `${basic.address1 || ''}${basic.address2 || ''}`,
        access: basic.access || '',
        review: Number(basic.reviewAverage) || null,
        reviewCount: Number(basic.reviewCount) || 0,
        price,
        planName: best ? (best.info.planName || '') : '',
        roomName: best ? (best.info.roomName || '') : '',
      });
    }
    return items;
  }

  window.RakutenProvider = {
    id: 'rakuten',
    label: '楽天トラベル',
    badgeClass: 'badge--rakuten',

    isConfigured(settings) {
      return !!(settings && settings.rakutenAppId);
    },

    async fetchAreas(settings) {
      const data = await requestApi('area', {}, settings);
      const tree = parseAreaTree(data);
      if (!tree.length) throw new Error('エリア情報の解析に失敗しました');
      return tree;
    },

    async search(params, settings) {
      const q = {
        checkinDate: params.checkin,
        checkoutDate: params.checkout,
        largeClassCode: 'japan',
        middleClassCode: params.middle,
        smallClassCode: params.small,
        detailClassCode: params.detail,
        adultNum: params.adults,
        roomNum: params.rooms,
        // 子供の人数（楽天の年齢6区分。0は送らない）
        ...(params.kids || {}),
        minCharge: params.minCharge,
        maxCharge: params.maxCharge,
        sort: '+roomCharge',
        page: params.page || 1,
        hits: 30,
      };
      if (params.squeeze && params.squeeze.length) {
        q.squeezeCondition = params.squeeze.join(',');
      }
      let data;
      try {
        data = await requestApi('vacant', q, settings);
      } catch (e) {
        if (e.status === 404) {
          return { items: [], page: 1, pageCount: 1, total: 0 }; // 空室なし
        }
        throw e;
      }
      const paging = data.pagingInfo || {};
      return {
        items: parseHotels(data, settings),
        page: Number(paging.page) || 1,
        pageCount: Number(paging.pageCount) || 1,
        total: Number(paging.recordCount) || 0,
      };
    },
  };
})();
