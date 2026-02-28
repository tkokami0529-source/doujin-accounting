/* ===== DoujinPOS - 同人イベント会計アプリ ===== */

(function () {
  'use strict';

  // ===== State =====
  const state = {
    events: [],
    products: [],     // グローバル商品マスター (eventId不要)
    sales: [],
    sets: [],         // グローバルセットマスター
    gifts: [],
    currentEventId: null,
    cart: [],
    settings: {
      darkMode: false,
      goal: 0,
      firebaseConfig: null,
      syncRoomId: '',
    },
    editingProductId: null,
    editingEventId: null,
    editingSetId: null,
    editingGiftId: null,
    selectedPaymentMethod: 'cash',
    giftPhotoData: null,
    syncConnected: false,
  };

  const STORAGE_KEY = 'doujinpos_data';

  // ===== Persistence =====
  function save() {
    const data = {
      events: state.events,
      products: state.products,
      sales: state.sales,
      sets: state.sets,
      gifts: state.gifts,
      currentEventId: state.currentEventId,
      settings: state.settings,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    if (state.syncConnected) syncPush(data);
  }

  function load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      state.events = data.events || [];
      state.products = data.products || [];
      state.sales = data.sales || [];
      state.sets = data.sets || [];
      state.gifts = data.gifts || [];
      state.currentEventId = data.currentEventId || null;
      if (data.settings) Object.assign(state.settings, data.settings);

      // Migration: 旧データからeventId依存の商品をグローバルに移行
      state.products.forEach(p => {
        if (p.eventId) {
          delete p.eventId;
        }
        // 原価フィールドがない場合は0で初期化
        if (p.cost === undefined) p.cost = 0;
      });
      // Migration: セットもグローバルに
      state.sets.forEach(s => {
        if (s.eventId) {
          delete s.eventId;
        }
      });
      // Migration: イベントにeventProductsがない場合は旧データから推測
      state.events.forEach(ev => {
        if (!ev.eventProducts) {
          // 旧データ: そのイベントの売上から使われた商品を推測
          ev.eventProducts = [];
        }
      });
    } catch (e) {
      console.error('Failed to load data:', e);
    }
  }

  // ===== Utilities =====
  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  function formatYen(n) {
    return '¥' + Number(n).toLocaleString();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function formatDate(str) {
    if (!str) return '';
    const d = new Date(str);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  // ===== Toast =====
  let toastTimer;
  function showToast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ===== Sound =====
  function playSound(type) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.value = 0.12;

      if (type === 'sale') {
        osc.frequency.value = 800;
        osc.type = 'sine';
        osc.start();
        osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.1);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'add') {
        osc.frequency.value = 600;
        osc.type = 'sine';
        osc.start();
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
        osc.stop(ctx.currentTime + 0.08);
      } else if (type === 'error') {
        osc.frequency.value = 300;
        osc.type = 'square';
        osc.start();
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
        osc.stop(ctx.currentTime + 0.3);
      }
    } catch (e) { /* Audio not available */ }
  }

  // ===== Navigation =====
  function switchView(viewName) {
    $$('.view').forEach(v => v.classList.remove('active'));
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    $(`#view-${viewName}`).classList.add('active');
    $(`.nav-item[data-view="${viewName}"]`).classList.add('active');

    const titles = {
      home: 'イベント',
      products: '商品マスター',
      register: 'レジ',
      sales: '売上管理',
      gifts: '差し入れメモ',
      settings: '設定',
    };
    $('#page-title').textContent = titles[viewName] || 'DoujinPOS';

    if (viewName === 'register') renderRegister();
    if (viewName === 'sales') renderSales();
    if (viewName === 'products') renderProducts();
    if (viewName === 'home') renderEvents();
    if (viewName === 'gifts') renderGifts();
  }

  // ===== Modal =====
  function openModal(id) {
    $(`#${id}`).classList.add('active');
  }

  function closeModal(id) {
    $(`#${id}`).classList.remove('active');
  }

  function closeAllModals() {
    $$('.modal').forEach(m => m.classList.remove('active'));
  }

  // ===== Current Event Helpers =====
  function currentEvent() {
    return state.events.find(e => e.id === state.currentEventId);
  }

  // イベントに紐づく商品を取得（eventProductsから）
  function eventProducts() {
    const ev = currentEvent();
    if (!ev || !ev.eventProducts) return [];
    return ev.eventProducts.map(ep => {
      const product = state.products.find(p => p.id === ep.productId);
      if (!product) return null;
      return { ...product, initialStock: ep.initialStock };
    }).filter(Boolean);
  }

  function eventSales() {
    return state.sales.filter(s => s.eventId === state.currentEventId && !s.voided);
  }

  function eventSets() {
    // セットはグローバルだが、含まれる商品がすべてイベントに持ち込まれている場合のみ表示
    const ev = currentEvent();
    if (!ev || !ev.eventProducts) return [];
    const eventProdIds = new Set(ev.eventProducts.map(ep => ep.productId));
    return state.sets.filter(s => {
      return s.items.every(si => eventProdIds.has(si.productId));
    });
  }

  // ===== Events =====
  function renderEvents() {
    const container = $('#event-list');
    if (state.events.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📅</span>
          <p>イベントがありません</p>
          <p class="text-muted">「新規イベント」ボタンで追加しましょう</p>
        </div>`;
      return;
    }

    container.innerHTML = state.events.map(ev => {
      const sales = state.sales.filter(s => s.eventId === ev.id && !s.voided);
      const total = sales.reduce((sum, s) => sum + s.total, 0);
      const prods = (ev.eventProducts || []).length;
      const isSelected = ev.id === state.currentEventId;
      return `
        <div class="card event-card ${isSelected ? 'selected' : ''}" data-id="${ev.id}">
          <div class="card-header">
            <div>
              <div class="card-title">${esc(ev.name)}</div>
              <div class="card-subtitle">${esc(ev.location || '')}</div>
            </div>
            <div class="card-actions">
              <span class="event-date-badge">${formatDate(ev.date)}</span>
            </div>
          </div>
          <div class="product-meta">
            <span>持込商品: <strong>${prods}</strong></span>
            <span>売上: <strong>${formatYen(total)}</strong></span>
            <span>取引: <strong>${sales.length}</strong></span>
          </div>
          <div class="card-actions" style="margin-top:8px;justify-content:flex-end;">
            <button class="btn btn-outline btn-sm btn-edit-event" data-id="${ev.id}">編集</button>
            <button class="btn btn-danger btn-sm btn-delete-event" data-id="${ev.id}">削除</button>
          </div>
        </div>`;
    }).join('');

    // Click to select event
    container.querySelectorAll('.event-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn')) return;
        state.currentEventId = card.dataset.id;
        save();
        renderEvents();
        showToast(`${currentEvent().name} を選択しました`);
      });
    });

    container.querySelectorAll('.btn-edit-event').forEach(btn => {
      btn.addEventListener('click', () => {
        const ev = state.events.find(e => e.id === btn.dataset.id);
        if (!ev) return;
        state.editingEventId = ev.id;
        $('#modal-event-title').textContent = 'イベント編集';
        $('#event-name').value = ev.name;
        $('#event-date').value = ev.date;
        $('#event-location').value = ev.location || '';
        renderEventProductChecklist(ev);
        openModal('modal-event');
      });
    });

    container.querySelectorAll('.btn-delete-event').forEach(btn => {
      btn.addEventListener('click', () => {
        const ev = state.events.find(e => e.id === btn.dataset.id);
        if (!ev) return;
        showConfirm(
          'イベント削除',
          `「${ev.name}」を削除しますか？関連する売上データもすべて削除されます。`,
          () => {
            state.sales = state.sales.filter(s => s.eventId !== ev.id);
            state.gifts = state.gifts.filter(g => g.eventId !== ev.id);
            state.events = state.events.filter(e => e.id !== ev.id);
            if (state.currentEventId === ev.id) state.currentEventId = null;
            save();
            renderEvents();
            showToast('イベントを削除しました');
          }
        );
      });
    });
  }

  function renderEventProductChecklist(ev) {
    const checklist = $('#event-product-checklist');
    if (state.products.length === 0) {
      checklist.innerHTML = '<p class="text-muted" style="font-size:13px;">商品マスターに商品を登録してください</p>';
      return;
    }

    const existing = ev ? (ev.eventProducts || []) : [];
    checklist.innerHTML = state.products.map(p => {
      const ep = existing.find(x => x.productId === p.id);
      return `
        <div class="set-check-item">
          <input type="checkbox" id="ev-chk-${p.id}" data-id="${p.id}" ${ep ? 'checked' : ''}>
          <label for="ev-chk-${p.id}">${esc(p.name)} (${formatYen(p.price)})</label>
          <input type="number" class="ev-check-stock" data-id="${p.id}" value="${ep ? ep.initialStock : 30}" min="0" placeholder="持込数">
        </div>`;
    }).join('');
  }

  function saveEvent() {
    const name = $('#event-name').value.trim();
    const date = $('#event-date').value;
    const location = $('#event-location').value.trim();
    if (!name) { showToast('イベント名を入力してください'); return; }

    // 持ち込み商品を収集
    const eventProds = [];
    $$('#event-product-checklist input[type="checkbox"]:checked').forEach(chk => {
      const stock = parseInt($(`.ev-check-stock[data-id="${chk.dataset.id}"]`).value) || 0;
      eventProds.push({ productId: chk.dataset.id, initialStock: stock });
    });

    if (state.editingEventId) {
      const ev = state.events.find(e => e.id === state.editingEventId);
      if (ev) {
        ev.name = name;
        ev.date = date;
        ev.location = location;
        ev.eventProducts = eventProds;
      }
      state.editingEventId = null;
    } else {
      const ev = { id: genId(), name, date, location, eventProducts: eventProds };
      state.events.push(ev);
      state.currentEventId = ev.id;
    }
    save();
    closeModal('modal-event');
    renderEvents();
    showToast('イベントを保存しました');
  }

  // ===== Products (グローバル商品マスター) =====
  function renderProducts() {
    const container = $('#product-list');

    if (state.products.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📦</span>
          <p>商品がありません</p>
          <p class="text-muted">「商品追加」ボタンで追加しましょう</p>
        </div>`;
      renderSets();
      return;
    }

    container.innerHTML = state.products.map(p => {
      const catLabels = { doujinshi: '同人誌', goods: 'グッズ', cd: 'CD/音楽', other: 'その他' };
      return `
        <div class="card">
          <div class="product-card">
            <div class="product-color-tag" style="background:${p.color || '#6C5CE7'}"></div>
            <div class="product-info">
              <div class="card-title">${esc(p.name)}</div>
              <div class="product-meta">
                <span>${formatYen(p.price)}</span>
                <span>原価 ${formatYen(p.cost || 0)}</span>
                <span>${catLabels[p.category] || p.category}</span>
              </div>
            </div>
            <div class="card-actions">
              <button class="btn btn-outline btn-sm btn-edit-product" data-id="${p.id}">編集</button>
              <button class="btn btn-danger btn-sm btn-delete-product" data-id="${p.id}">削除</button>
            </div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.btn-edit-product').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = state.products.find(x => x.id === btn.dataset.id);
        if (!p) return;
        state.editingProductId = p.id;
        $('#modal-product-title').textContent = '商品編集';
        $('#product-name').value = p.name;
        $('#product-price').value = p.price;
        $('#product-cost').value = p.cost || 0;
        $('#product-category').value = p.category;
        $$('.color-opt').forEach(c => c.classList.toggle('selected', c.dataset.color === p.color));
        openModal('modal-product');
      });
    });

    container.querySelectorAll('.btn-delete-product').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = state.products.find(x => x.id === btn.dataset.id);
        if (!p) return;
        showConfirm('商品削除', `「${p.name}」を削除しますか？`, () => {
          state.products = state.products.filter(x => x.id !== p.id);
          // イベントの持ち込みリストからも削除
          state.events.forEach(ev => {
            if (ev.eventProducts) {
              ev.eventProducts = ev.eventProducts.filter(ep => ep.productId !== p.id);
            }
          });
          save();
          renderProducts();
          showToast('商品を削除しました');
        });
      });
    });

    // Render sets
    renderSets();
  }

  // ===== Sets (グローバル) =====
  function renderSets() {
    const container = $('#set-list');

    if (state.sets.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:20px;">
          <span class="empty-icon" style="font-size:32px;">🎁</span>
          <p style="font-size:13px;">セット販売を設定すると、レジにセットボタンが表示されます</p>
        </div>`;
      return;
    }

    container.innerHTML = state.sets.map(s => {
      const itemNames = s.items.map(si => {
        const p = state.products.find(x => x.id === si.productId);
        return p ? `${p.name}×${si.quantity}` : '(削除済み)';
      }).join(', ');
      const originalPrice = s.items.reduce((sum, si) => {
        const p = state.products.find(x => x.id === si.productId);
        return sum + (p ? p.price * si.quantity : 0);
      }, 0);
      const discount = originalPrice - s.price;
      return `
        <div class="card">
          <div class="product-card">
            <div class="product-color-tag" style="background:${s.color || '#E17055'}"></div>
            <div class="product-info">
              <div class="card-title">${esc(s.name)}</div>
              <div class="product-meta">
                <span>${formatYen(s.price)}</span>
                ${discount > 0 ? `<span style="color:var(--danger);">(-${formatYen(discount)} OFF)</span>` : ''}
              </div>
              <div class="set-card-items">${esc(itemNames)}</div>
            </div>
            <div class="card-actions">
              <button class="btn btn-outline btn-sm btn-edit-set" data-id="${s.id}">編集</button>
              <button class="btn btn-danger btn-sm btn-delete-set" data-id="${s.id}">削除</button>
            </div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.btn-edit-set').forEach(btn => {
      btn.addEventListener('click', () => openSetModal(btn.dataset.id));
    });

    container.querySelectorAll('.btn-delete-set').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = state.sets.find(x => x.id === btn.dataset.id);
        if (!s) return;
        showConfirm('セット削除', `「${s.name}」を削除しますか？`, () => {
          state.sets = state.sets.filter(x => x.id !== s.id);
          save();
          renderProducts();
          showToast('セットを削除しました');
        });
      });
    });
  }

  function openSetModal(editId) {
    if (state.products.length === 0) { showToast('先に商品を登録してください'); return; }

    const editing = editId ? state.sets.find(s => s.id === editId) : null;
    state.editingSetId = editing ? editing.id : null;
    $('#modal-set-title').textContent = editing ? 'セット編集' : 'セット追加';
    $('#set-name').value = editing ? editing.name : '';
    $('#set-price').value = editing ? editing.price : '';

    // Build checklist from all products
    const checklist = $('#set-product-checklist');
    checklist.innerHTML = state.products.map(p => {
      const inSet = editing ? editing.items.find(i => i.productId === p.id) : null;
      return `
        <div class="set-check-item">
          <input type="checkbox" id="set-chk-${p.id}" data-id="${p.id}" ${inSet ? 'checked' : ''}>
          <label for="set-chk-${p.id}">${esc(p.name)} (${formatYen(p.price)})</label>
          <input type="number" class="set-check-qty" data-id="${p.id}" value="${inSet ? inSet.quantity : 1}" min="1" max="99">
        </div>`;
    }).join('');

    // Color picker
    const currentColor = editing ? editing.color : '#E17055';
    $$('.color-opt-set').forEach(c => c.classList.toggle('selected', c.dataset.color === currentColor));

    openModal('modal-set');
  }

  function saveSet() {
    const name = $('#set-name').value.trim();
    const price = parseInt($('#set-price').value) || 0;
    if (!name) { showToast('セット名を入力してください'); return; }
    if (price <= 0) { showToast('セット価格を入力してください'); return; }

    const items = [];
    $$('#set-product-checklist input[type="checkbox"]:checked').forEach(chk => {
      const qty = parseInt($(`.set-check-qty[data-id="${chk.dataset.id}"]`).value) || 1;
      items.push({ productId: chk.dataset.id, quantity: qty });
    });
    if (items.length === 0) { showToast('商品を1つ以上選択してください'); return; }

    const color = $('.color-opt-set.selected')?.dataset.color || '#E17055';

    if (state.editingSetId) {
      const s = state.sets.find(x => x.id === state.editingSetId);
      if (s) { s.name = name; s.price = price; s.items = items; s.color = color; }
      state.editingSetId = null;
    } else {
      state.sets.push({
        id: genId(),
        name, price, items, color,
      });
    }

    save();
    closeModal('modal-set');
    renderProducts();
    showToast('セットを保存しました');
  }

  function getSoldCount(productId) {
    return eventSales().reduce((sum, s) => {
      let count = 0;
      s.items.forEach(i => {
        if (i.isSet && i.items) {
          const si = i.items.find(x => x.productId === productId);
          if (si) count += si.quantity * i.quantity;
        } else if (i.productId === productId) {
          count += i.quantity;
        }
      });
      return sum + count;
    }, 0);
  }

  function saveProduct() {
    const name = $('#product-name').value.trim();
    const price = parseInt($('#product-price').value) || 0;
    const cost = parseInt($('#product-cost').value) || 0;
    const category = $('#product-category').value;
    const color = $('.color-opt.selected')?.dataset.color || '#6C5CE7';

    if (!name) { showToast('商品名を入力してください'); return; }
    if (price <= 0) { showToast('販売価格を正しく入力してください'); return; }

    if (state.editingProductId) {
      const p = state.products.find(x => x.id === state.editingProductId);
      if (p) {
        p.name = name;
        p.price = price;
        p.cost = cost;
        p.category = category;
        p.color = color;
      }
      state.editingProductId = null;
    } else {
      state.products.push({
        id: genId(),
        name, price, cost, category, color,
      });
    }

    save();
    closeModal('modal-product');
    renderProducts();
    showToast('商品を保存しました');
  }

  // ===== Register =====
  function renderRegister() {
    renderRegisterProducts();
    renderCart();
    renderGoal();
  }

  function renderRegisterProducts() {
    const container = $('#register-products');
    const prods = eventProducts();

    if (!currentEvent() || prods.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <span class="empty-icon">📦</span>
          <p>${currentEvent() ? '持ち込み商品を設定してください' : 'イベントを選択してください'}</p>
        </div>`;
      return;
    }

    container.innerHTML = prods.map(p => {
      const sold = getSoldCount(p.id);
      const remaining = p.initialStock - sold;
      const soldOut = remaining <= 0 && p.initialStock > 0;
      return `
        <button class="register-product-btn ${soldOut ? 'sold-out' : ''}"
                data-id="${p.id}" style="background:${p.color || '#6C5CE7'}">
          <div class="product-btn-name">${esc(p.name)}</div>
          <div class="product-btn-price">${formatYen(p.price)}</div>
          <div class="product-btn-stock">${p.initialStock > 0 ? `残 ${remaining}` : ''}</div>
        </button>`;
    }).join('');

    // Add set buttons
    const sets = eventSets();
    const setHtml = sets.map(s => `
      <button class="register-set-btn" data-set-id="${s.id}" style="background:linear-gradient(135deg,${s.color || '#E17055'},${s.color || '#E17055'}CC);">
        <div class="set-btn-label">SET</div>
        <div class="product-btn-name">${esc(s.name)}</div>
        <div class="product-btn-price">${formatYen(s.price)}</div>
      </button>
    `).join('');
    container.innerHTML = setHtml + container.innerHTML;

    container.querySelectorAll('.register-product-btn:not(.sold-out)').forEach(btn => {
      btn.addEventListener('click', () => addToCart(btn.dataset.id));
    });

    container.querySelectorAll('.register-set-btn').forEach(btn => {
      btn.addEventListener('click', () => addSetToCart(btn.dataset.setId));
    });
  }

  function addSetToCart(setId) {
    const set = state.sets.find(s => s.id === setId);
    if (!set) return;

    const ev = currentEvent();
    // Check stock for all items in the set
    for (const si of set.items) {
      const product = state.products.find(p => p.id === si.productId);
      if (!product) { showToast('セットに含まれる商品が見つかりません'); return; }
      const ep = ev.eventProducts.find(x => x.productId === si.productId);
      const stock = ep ? ep.initialStock : 0;
      const sold = getSoldCount(si.productId);
      const inCart = state.cart.reduce((s, c) => s + (c.productId === si.productId ? c.quantity : 0), 0);
      if (stock > 0 && sold + inCart + si.quantity > stock) {
        showToast(`「${product.name}」の在庫が不足しています`);
        playSound('error');
        return;
      }
    }

    // Add a special cart entry for the set
    state.cart.push({
      isSet: true,
      setId: set.id,
      name: set.name,
      price: set.price,
      quantity: 1,
      items: set.items.map(si => ({ productId: si.productId, quantity: si.quantity })),
    });
    playSound('add');
    renderCart();
  }

  function addToCart(productId) {
    const product = state.products.find(p => p.id === productId);
    if (!product) return;

    const ev = currentEvent();
    const ep = ev ? ev.eventProducts.find(x => x.productId === productId) : null;
    const stock = ep ? ep.initialStock : 0;

    const sold = getSoldCount(productId);
    const inCart = getCartProductCount(productId);
    if (stock > 0 && sold + inCart >= stock) {
      showToast('在庫がありません');
      playSound('error');
      return;
    }

    const existing = state.cart.find(c => c.productId === productId);
    if (existing) {
      existing.quantity++;
    } else {
      state.cart.push({ productId, quantity: 1, price: product.price, name: product.name });
    }
    playSound('add');
    renderCart();
  }

  function getCartProductCount(productId) {
    let count = 0;
    state.cart.forEach(c => {
      if (c.isSet) {
        const si = c.items.find(i => i.productId === productId);
        if (si) count += si.quantity * c.quantity;
      } else if (c.productId === productId) {
        count += c.quantity;
      }
    });
    return count;
  }

  function renderCart() {
    const container = $('#register-cart');
    if (state.cart.length === 0) {
      container.innerHTML = '<div class="cart-empty">商品をタップして追加</div>';
      $('#cart-total').textContent = '¥0';
      $('#btn-payment').disabled = true;
      return;
    }

    const total = state.cart.reduce((s, c) => s + c.price * c.quantity, 0);
    container.innerHTML = state.cart.map((c, idx) => `
      <div class="cart-item">
        <span class="cart-item-name">${c.isSet ? '🎁 ' : ''}${esc(c.name)}</span>
        <div class="cart-item-qty">
          <button class="cart-qty-btn" data-idx="${idx}" data-action="minus">-</button>
          <span>${c.quantity}</span>
          ${c.isSet ? '' : `<button class="cart-qty-btn" data-idx="${idx}" data-action="plus">+</button>`}
          <span style="min-width:60px;text-align:right;font-weight:700;">${formatYen(c.price * c.quantity)}</span>
        </div>
      </div>
    `).join('');

    $('#cart-total').textContent = formatYen(total);
    $('#btn-payment').disabled = false;

    container.querySelectorAll('.cart-qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const item = state.cart[idx];
        if (!item) return;
        if (btn.dataset.action === 'plus') {
          if (!item.isSet) {
            const product = state.products.find(p => p.id === item.productId);
            const ev = currentEvent();
            const ep = ev ? ev.eventProducts.find(x => x.productId === item.productId) : null;
            const stock = ep ? ep.initialStock : 0;
            const sold = getSoldCount(item.productId);
            const inCart = getCartProductCount(item.productId);
            if (product && stock > 0 && sold + inCart >= stock) {
              showToast('在庫がありません');
              return;
            }
          }
          item.quantity++;
        } else {
          item.quantity--;
          if (item.quantity <= 0) {
            state.cart.splice(idx, 1);
          }
        }
        renderCart();
      });
    });
  }

  function renderGoal() {
    const goal = state.settings.goal;
    const totalSales = eventSales().reduce((s, sale) => s + sale.total, 0);

    if (goal > 0) {
      const pct = Math.min(100, Math.round((totalSales / goal) * 100));
      $('#goal-fill').style.width = pct + '%';
      $('#goal-text').textContent = `目標: ${formatYen(totalSales)} / ${formatYen(goal)} (${pct}%)`;
    } else {
      $('#goal-fill').style.width = '0%';
      $('#goal-text').textContent = `売上: ${formatYen(totalSales)}　※設定で目標を設定できます`;
    }
  }

  // ===== Payment =====
  function openPayment() {
    const total = state.cart.reduce((s, c) => s + c.price * c.quantity, 0);
    if (total <= 0) return;

    state.selectedPaymentMethod = 'cash';
    $('#payment-total-amount').textContent = formatYen(total);
    $('#payment-received').value = '';
    $('#change-display').style.display = 'none';
    $('#btn-confirm-payment').disabled = true;
    $('#cash-payment-section').style.display = 'block';

    // Reset payment method buttons
    $$('.payment-method-btn').forEach(b => b.classList.remove('active'));
    $('.payment-method-btn[data-method="cash"]').classList.add('active');

    // Quick amount buttons
    const quickAmounts = generateQuickAmounts(total);
    $('#quick-amounts').innerHTML = quickAmounts.map(a =>
      `<button class="quick-amount-btn" data-amount="${a}">${formatYen(a)}</button>`
    ).join('') + `<button class="quick-amount-btn" data-amount="${total}">ぴったり</button>`;

    $$('.quick-amount-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('#payment-received').value = btn.dataset.amount;
        updateChange();
      });
    });

    openModal('modal-payment');
    setTimeout(() => $('#payment-received').focus(), 300);
  }

  function selectPaymentMethod(method) {
    state.selectedPaymentMethod = method;
    $$('.payment-method-btn').forEach(b => b.classList.remove('active'));
    $(`.payment-method-btn[data-method="${method}"]`).classList.add('active');

    if (method === 'cash') {
      $('#cash-payment-section').style.display = 'block';
      $('#btn-confirm-payment').disabled = true;
      updateChange();
    } else {
      // Electronic payment: no change needed
      $('#cash-payment-section').style.display = 'none';
      $('#btn-confirm-payment').disabled = false;
    }
  }

  function generateQuickAmounts(total) {
    const amounts = [];
    const bases = [500, 1000, 2000, 3000, 5000, 10000];
    for (const b of bases) {
      if (b >= total && amounts.length < 5) amounts.push(b);
    }
    if (amounts.length === 0) {
      const rounded = Math.ceil(total / 1000) * 1000;
      amounts.push(rounded);
      if (rounded + 1000 <= 50000) amounts.push(rounded + 1000);
    }
    return [...new Set(amounts)].slice(0, 5);
  }

  function updateChange() {
    const total = state.cart.reduce((s, c) => s + c.price * c.quantity, 0);
    const received = parseInt($('#payment-received').value) || 0;
    const change = received - total;

    if (received >= total) {
      $('#change-display').style.display = 'block';
      $('#change-amount').textContent = formatYen(change);
      $('#change-breakdown').textContent = change > 0 ? getChangeBreakdown(change) : '';
      $('#btn-confirm-payment').disabled = false;
    } else {
      $('#change-display').style.display = 'none';
      $('#btn-confirm-payment').disabled = true;
    }
  }

  function getChangeBreakdown(amount) {
    const denominations = [
      { value: 10000, label: '一万円' },
      { value: 5000, label: '五千円' },
      { value: 1000, label: '千円' },
      { value: 500, label: '500円' },
      { value: 100, label: '100円' },
      { value: 50, label: '50円' },
      { value: 10, label: '10円' },
      { value: 5, label: '5円' },
      { value: 1, label: '1円' },
    ];
    const parts = [];
    let remaining = amount;
    for (const d of denominations) {
      if (remaining >= d.value) {
        const count = Math.floor(remaining / d.value);
        parts.push(`${d.label}×${count}`);
        remaining -= d.value * count;
      }
    }
    return parts.join('　');
  }

  function confirmPayment() {
    const total = state.cart.reduce((s, c) => s + c.price * c.quantity, 0);
    const method = state.selectedPaymentMethod;

    if (method === 'cash') {
      const received = parseInt($('#payment-received').value) || 0;
      if (received < total) return;
      var saleReceived = received;
      var saleChange = received - total;
    } else {
      var saleReceived = total;
      var saleChange = 0;
    }

    // Flatten cart items (expand sets into individual product entries for stock tracking)
    const saleItems = [];
    state.cart.forEach(c => {
      if (c.isSet) {
        // Record as a set in sale items
        saleItems.push({
          isSet: true,
          setId: c.setId,
          name: c.name,
          quantity: c.quantity,
          price: c.price,
          items: c.items,
        });
      } else {
        saleItems.push({
          productId: c.productId,
          name: c.name,
          quantity: c.quantity,
          price: c.price,
        });
      }
    });

    const sale = {
      id: genId(),
      eventId: state.currentEventId,
      timestamp: Date.now(),
      items: saleItems,
      total,
      received: saleReceived,
      change: saleChange,
      paymentMethod: method,
      voided: false,
    };

    state.sales.push(sale);
    state.cart = [];
    save();

    closeModal('modal-payment');
    playSound('sale');
    const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    showToast(`${methodLabels[method]} ${formatYen(total)} を記録しました！`);
    renderRegister();
  }

  // ===== Sales =====
  function calcNetProfit(sales) {
    let totalCost = 0;
    sales.forEach(s => {
      s.items.forEach(item => {
        if (item.isSet && item.items) {
          // セット: 各商品の原価を合算
          item.items.forEach(si => {
            const product = state.products.find(p => p.id === si.productId);
            if (product) totalCost += (product.cost || 0) * si.quantity * item.quantity;
          });
        } else if (item.productId) {
          const product = state.products.find(p => p.id === item.productId);
          if (product) totalCost += (product.cost || 0) * item.quantity;
        }
      });
    });
    return totalCost;
  }

  function renderSales() {
    const sales = eventSales();
    const totalSales = sales.reduce((s, sale) => s + sale.total, 0);
    const totalItems = sales.reduce((s, sale) => s + sale.items.reduce((ss, i) => ss + i.quantity, 0), 0);
    const avgPrice = sales.length > 0 ? Math.round(totalSales / sales.length) : 0;
    const totalCost = calcNetProfit(sales);
    const netProfit = totalSales - totalCost;

    $('#stat-total-sales').textContent = formatYen(totalSales);
    $('#stat-net-profit').textContent = formatYen(netProfit);
    $('#stat-transactions').textContent = sales.length.toLocaleString();
    $('#stat-avg-price').textContent = formatYen(avgPrice);

    renderPaymentMethodStats(sales);
    renderHourlyChart(sales);
    renderProductSales();
    renderSalesHistory(sales);
  }

  function renderPaymentMethodStats(sales) {
    const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    const methods = {};
    sales.forEach(s => {
      const m = s.paymentMethod || 'cash';
      if (!methods[m]) methods[m] = { count: 0, total: 0 };
      methods[m].count++;
      methods[m].total += s.total;
    });

    // Insert after stats grid
    let existingEl = document.getElementById('payment-method-stats');
    if (!existingEl) {
      existingEl = document.createElement('div');
      existingEl.id = 'payment-method-stats';
      existingEl.className = 'method-stats';
      const statsGrid = $('.stats-grid');
      if (statsGrid) statsGrid.after(existingEl);
    }

    existingEl.innerHTML = Object.entries(methods).map(([m, data]) =>
      `<span class="method-stat-chip sale-method-badge ${m}">
        ${methodLabels[m] || m}: ${formatYen(data.total)} (${data.count}件)
      </span>`
    ).join('');
  }

  function renderHourlyChart(sales) {
    const canvas = $('#hourly-chart');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padding = { top: 20, right: 16, bottom: 32, left: 50 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // Aggregate by hour
    const hourly = {};
    for (let i = 6; i <= 22; i++) hourly[i] = 0;
    sales.forEach(s => {
      const hour = new Date(s.timestamp).getHours();
      hourly[hour] = (hourly[hour] || 0) + s.total;
    });

    const hours = Object.keys(hourly).map(Number).sort((a, b) => a - b);
    const values = hours.map(h => hourly[h]);
    const maxVal = Math.max(...values, 1);

    ctx.clearRect(0, 0, w, h);

    const isDark = document.body.classList.contains('dark');
    const textColor = isDark ? '#888' : '#888';
    const gridColor = isDark ? '#3A3A5C' : '#E1E4E8';

    // Grid lines
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();

      ctx.fillStyle = textColor;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(formatYen(Math.round(maxVal * (4 - i) / 4)), padding.left - 6, y + 4);
    }

    // Bars
    const barWidth = Math.max(8, (chartW / hours.length) - 4);
    const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
    gradient.addColorStop(0, '#6C5CE7');
    gradient.addColorStop(1, '#A29BFE');

    hours.forEach((hour, i) => {
      const x = padding.left + (chartW / hours.length) * i + (chartW / hours.length - barWidth) / 2;
      const barH = (values[i] / maxVal) * chartH;
      const y = padding.top + chartH - barH;

      ctx.fillStyle = gradient;
      ctx.beginPath();
      const r = Math.min(4, barWidth / 2);
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + barWidth - r, y);
      ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + r);
      ctx.lineTo(x + barWidth, padding.top + chartH);
      ctx.lineTo(x, padding.top + chartH);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.fill();

      // Hour label
      ctx.fillStyle = textColor;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(hour + '時', x + barWidth / 2, h - padding.bottom + 16);
    });
  }

  function renderProductSales() {
    const container = $('#product-sales-list');
    const prods = eventProducts();
    const sales = eventSales();

    const productStats = prods.map(p => {
      let qty = 0;
      let revenue = 0;
      sales.forEach(s => {
        s.items.forEach(item => {
          if (item.isSet && item.items) {
            const si = item.items.find(x => x.productId === p.id);
            if (si) { qty += si.quantity * item.quantity; }
          } else if (item.productId === p.id) {
            qty += item.quantity;
            revenue += item.price * item.quantity;
          }
        });
      });
      // For items sold as part of sets, estimate revenue by unit price
      revenue = revenue || qty * p.price;
      const cost = (p.cost || 0) * qty;
      const profit = revenue - cost;
      return { ...p, qty, revenue, cost, profit };
    }).sort((a, b) => b.revenue - a.revenue);

    const maxQty = Math.max(...productStats.map(p => p.qty), 1);

    container.innerHTML = productStats.map((p, i) => `
      <div class="card">
        <div class="product-rank">
          <span class="rank-num">${i + 1}</span>
          <div class="rank-info">
            <div class="card-title" style="font-size:14px;">${esc(p.name)}</div>
            <div class="rank-bar-bg">
              <div class="rank-bar-fill" style="width:${(p.qty / maxQty * 100)}%;background:${p.color || '#6C5CE7'}"></div>
            </div>
          </div>
          <div class="rank-count">
            <div style="font-weight:800;">${formatYen(p.revenue)}</div>
            <div class="text-muted">${p.qty}個</div>
            <div style="font-size:11px;color:var(--success);">利益 ${formatYen(p.profit)}</div>
          </div>
        </div>
      </div>
    `).join('');
  }

  function renderSalesHistory(sales) {
    const container = $('#sales-history');
    const sorted = [...sales].sort((a, b) => b.timestamp - a.timestamp);

    if (sorted.length === 0) {
      container.innerHTML = '<div class="empty-state"><p class="text-muted">取引履歴がありません</p></div>';
      return;
    }

    const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    container.innerHTML = sorted.slice(0, 50).map(s => {
      const m = s.paymentMethod || 'cash';
      return `
      <div class="card">
        <div class="sale-item">
          <div>
            <div class="sale-time">${formatTime(s.timestamp)} <span class="sale-method-badge ${m}">${methodLabels[m] || m}</span></div>
            <div class="sale-details">${s.items.map(i => `${i.isSet ? '🎁' : ''}${esc(i.name)}×${i.quantity}`).join(', ')}</div>
          </div>
          <div style="text-align:right;">
            <div class="sale-amount">${formatYen(s.total)}</div>
            <button class="sale-undo" data-id="${s.id}">取消</button>
          </div>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.sale-undo').forEach(btn => {
      btn.addEventListener('click', () => {
        showConfirm('取引取消', 'この取引を取り消しますか？在庫が元に戻ります。', () => {
          const sale = state.sales.find(s => s.id === btn.dataset.id);
          if (sale) sale.voided = true;
          save();
          renderSales();
          renderRegister();
          showToast('取引を取り消しました');
        });
      });
    });
  }

  // ===== Export / Import =====
  function exportCSV() {
    const sales = eventSales();
    const ev = currentEvent();
    if (!ev || sales.length === 0) { showToast('エクスポートするデータがありません'); return; }

    const methodLabels = { cash: '現金', paypay: 'PayPay', credit: 'クレジット', other_pay: 'その他' };
    const rows = [['時刻', '商品名', '数量', '単価', '原価', '小計', '合計', '決済方法', 'お預かり', 'お釣り']];
    sales.sort((a, b) => a.timestamp - b.timestamp).forEach(s => {
      s.items.forEach((item, i) => {
        const product = item.productId ? state.products.find(p => p.id === item.productId) : null;
        const cost = product ? (product.cost || 0) : 0;
        rows.push([
          i === 0 ? formatTime(s.timestamp) : '',
          item.isSet ? `[セット]${item.name}` : item.name,
          item.quantity,
          item.price,
          cost,
          item.price * item.quantity,
          i === 0 ? s.total : '',
          i === 0 ? (methodLabels[s.paymentMethod] || '現金') : '',
          i === 0 ? s.received : '',
          i === 0 ? s.change : '',
        ]);
      });
    });

    const csv = rows.map(r => r.join(',')).join('\n');
    const bom = '\uFEFF';
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `${ev.name}_売上_${new Date().toISOString().slice(0, 10)}.csv`);
    showToast('CSVをエクスポートしました');
  }

  function exportData() {
    const data = {
      events: state.events,
      products: state.products,
      sales: state.sales,
      sets: state.sets,
      gifts: state.gifts,
      settings: state.settings,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `doujinpos_backup_${new Date().toISOString().slice(0, 10)}.json`);
    showToast('データをエクスポートしました');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.events) state.events = data.events;
        if (data.products) state.products = data.products;
        if (data.sales) state.sales = data.sales;
        if (data.sets) state.sets = data.sets;
        if (data.gifts) state.gifts = data.gifts;
        if (data.settings) Object.assign(state.settings, data.settings);
        state.currentEventId = state.events.length > 0 ? state.events[0].id : null;
        save();
        applySettings();
        renderEvents();
        showToast('データをインポートしました');
      } catch (err) {
        showToast('インポートに失敗しました');
      }
    };
    reader.readAsText(file);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ===== Confirm Dialog =====
  let confirmCallback = null;
  function showConfirm(title, message, onConfirm) {
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    confirmCallback = onConfirm;
    openModal('modal-confirm');
  }

  // ===== Settings =====
  function applySettings() {
    document.body.classList.toggle('dark', state.settings.darkMode);
    $('#btn-dark-mode').textContent = state.settings.darkMode ? '☀️' : '🌙';
    $('#setting-goal').value = state.settings.goal || '';
    $('#sync-room-id').value = state.settings.syncRoomId || '';
    if (state.settings.firebaseConfig) {
      try {
        $('#firebase-config').value = JSON.stringify(state.settings.firebaseConfig);
      } catch (e) { /* ignore */ }
    }
  }

  // ===== Firebase Sync =====
  let firebaseDb = null;
  let unsubscribe = null;

  function syncConnect() {
    const roomId = $('#sync-room-id').value.trim();
    if (!roomId) { showToast('ルームIDを入力してください'); return; }

    let configStr = $('#firebase-config').value.trim();
    if (!configStr) { showToast('Firebase設定を入力してください'); return; }

    let config;
    try {
      config = JSON.parse(configStr);
    } catch (e) { showToast('Firebase設定のJSON形式が正しくありません'); return; }

    state.settings.syncRoomId = roomId;
    state.settings.firebaseConfig = config;
    save();

    // Load Firebase SDK dynamically
    if (!window.firebase) {
      loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js')
        .then(() => loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js'))
        .then(() => initFirebase(config, roomId))
        .catch(err => {
          showToast('Firebase SDKの読み込みに失敗しました');
          console.error(err);
        });
    } else {
      initFirebase(config, roomId);
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function initFirebase(config, roomId) {
    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      firebaseDb = firebase.firestore();

      // Listen for changes
      const docRef = firebaseDb.collection('doujinpos_rooms').doc(roomId);
      unsubscribe = docRef.onSnapshot((doc) => {
        if (doc.exists) {
          const remoteData = doc.data();
          if (remoteData.lastUpdatedBy !== getDeviceId() && remoteData.updatedAt > (state._lastSyncAt || 0)) {
            // Merge remote data
            if (remoteData.events) state.events = remoteData.events;
            if (remoteData.products) state.products = remoteData.products;
            if (remoteData.sales) state.sales = remoteData.sales;
            if (remoteData.sets) state.sets = remoteData.sets;
            if (remoteData.gifts) state.gifts = remoteData.gifts;
            state._lastSyncAt = remoteData.updatedAt;
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
              events: state.events,
              products: state.products,
              sales: state.sales,
              sets: state.sets,
              gifts: state.gifts,
              currentEventId: state.currentEventId,
              settings: state.settings,
            }));
            // Re-render current view
            const activeView = $('.view.active');
            if (activeView) {
              const viewId = activeView.id.replace('view-', '');
              switchView(viewId);
            }
            showToast('データが同期されました');
          }
        }
      });

      // Push current data
      syncPush({
        events: state.events,
        products: state.products,
        sales: state.sales,
        sets: state.sets,
        gifts: state.gifts,
      });

      state.syncConnected = true;
      updateSyncStatus(true);
      $('#btn-connect-sync').style.display = 'none';
      $('#btn-disconnect-sync').style.display = 'inline-flex';
      showToast('同期を開始しました');
    } catch (err) {
      showToast('Firebase接続に失敗しました');
      console.error(err);
    }
  }

  function syncPush(data) {
    if (!firebaseDb || !state.settings.syncRoomId) return;
    const docRef = firebaseDb.collection('doujinpos_rooms').doc(state.settings.syncRoomId);
    const payload = {
      events: data.events,
      products: data.products,
      sales: data.sales,
      sets: data.sets || [],
      gifts: data.gifts || [],
      updatedAt: Date.now(),
      lastUpdatedBy: getDeviceId(),
    };
    state._lastSyncAt = payload.updatedAt;
    docRef.set(payload, { merge: true }).catch(err => console.error('Sync push error:', err));
  }

  function syncDisconnect() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    state.syncConnected = false;
    updateSyncStatus(false);
    $('#btn-connect-sync').style.display = 'inline-flex';
    $('#btn-disconnect-sync').style.display = 'none';
    showToast('同期を停止しました');
  }

  function updateSyncStatus(connected) {
    const badge = $('#sync-status');
    if (connected) {
      badge.classList.add('connected');
      badge.querySelector('.sync-icon').textContent = '●';
      badge.querySelector('.sync-text').textContent = '同期中';
    } else {
      badge.classList.remove('connected');
      badge.querySelector('.sync-icon').textContent = '○';
      badge.querySelector('.sync-text').textContent = '未接続';
    }
  }

  function getDeviceId() {
    let id = localStorage.getItem('doujinpos_device_id');
    if (!id) {
      id = genId();
      localStorage.setItem('doujinpos_device_id', id);
    }
    return id;
  }

  // ===== Gifts / 差し入れ =====
  function eventGifts() {
    return state.gifts.filter(g => g.eventId === state.currentEventId);
  }

  function renderGifts() {
    const container = $('#gift-list');
    const ev = currentEvent();

    if (!ev) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📅</span>
          <p>イベントを選択してください</p>
        </div>`;
      return;
    }

    const gifts = eventGifts().sort((a, b) => b.timestamp - a.timestamp);
    if (gifts.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🎀</span>
          <p>差し入れの記録がありません</p>
          <p class="text-muted">いただいた差し入れを写真付きで記録しましょう</p>
        </div>`;
      return;
    }

    container.innerHTML = gifts.map(g => `
      <div class="card gift-card">
        <div class="gift-card-content">
          ${g.photo ? `<img src="${g.photo}" class="gift-card-photo" data-id="${g.id}" alt="差し入れ写真">` : ''}
          <div class="gift-card-info">
            <div class="gift-card-from">${esc(g.from || '(送り主不明)')}</div>
            <div class="gift-card-note">${esc(g.note || '')}</div>
            <div class="gift-card-time">${formatTime(g.timestamp)} - ${formatDate(new Date(g.timestamp).toISOString().slice(0, 10))}</div>
          </div>
        </div>
        <div class="gift-card-actions">
          <button class="btn btn-outline btn-sm btn-edit-gift" data-id="${g.id}">編集</button>
          <button class="btn btn-danger btn-sm btn-delete-gift" data-id="${g.id}">削除</button>
        </div>
      </div>
    `).join('');

    // Photo lightbox
    container.querySelectorAll('.gift-card-photo').forEach(img => {
      img.addEventListener('click', () => showLightbox(img.src));
    });

    container.querySelectorAll('.btn-edit-gift').forEach(btn => {
      btn.addEventListener('click', () => openGiftModal(btn.dataset.id));
    });

    container.querySelectorAll('.btn-delete-gift').forEach(btn => {
      btn.addEventListener('click', () => {
        showConfirm('差し入れ削除', 'この記録を削除しますか？', () => {
          state.gifts = state.gifts.filter(g => g.id !== btn.dataset.id);
          save();
          renderGifts();
          showToast('記録を削除しました');
        });
      });
    });
  }

  function openGiftModal(editId) {
    if (!currentEvent()) { showToast('先にイベントを選択してください'); return; }

    const editing = editId ? state.gifts.find(g => g.id === editId) : null;
    state.editingGiftId = editing ? editing.id : null;
    state.giftPhotoData = editing ? editing.photo : null;

    $('#modal-gift-title').textContent = editing ? '差し入れ編集' : '差し入れを記録';
    $('#gift-from').value = editing ? (editing.from || '') : '';
    $('#gift-note').value = editing ? (editing.note || '') : '';

    if (state.giftPhotoData) {
      $('#gift-photo-preview').src = state.giftPhotoData;
      $('#gift-photo-preview').style.display = 'block';
      $('#gift-photo-placeholder').style.display = 'none';
      $('#gift-photo-remove').style.display = 'inline-flex';
    } else {
      $('#gift-photo-preview').style.display = 'none';
      $('#gift-photo-placeholder').style.display = 'flex';
      $('#gift-photo-remove').style.display = 'none';
    }

    openModal('modal-gift');
  }

  function handleGiftPhoto(file) {
    if (!file) return;
    // Resize image to save localStorage space
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 800;
        let w = img.width, h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) { h = (h / w) * maxSize; w = maxSize; }
          else { w = (w / h) * maxSize; h = maxSize; }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        state.giftPhotoData = canvas.toDataURL('image/jpeg', 0.7);

        $('#gift-photo-preview').src = state.giftPhotoData;
        $('#gift-photo-preview').style.display = 'block';
        $('#gift-photo-placeholder').style.display = 'none';
        $('#gift-photo-remove').style.display = 'inline-flex';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function saveGift() {
    const from = $('#gift-from').value.trim();
    const note = $('#gift-note').value.trim();
    if (!from && !note && !state.giftPhotoData) {
      showToast('送り主、メモ、写真のいずれかを入力してください');
      return;
    }

    if (state.editingGiftId) {
      const g = state.gifts.find(x => x.id === state.editingGiftId);
      if (g) {
        g.from = from;
        g.note = note;
        g.photo = state.giftPhotoData;
      }
      state.editingGiftId = null;
    } else {
      state.gifts.push({
        id: genId(),
        eventId: state.currentEventId,
        timestamp: Date.now(),
        from, note,
        photo: state.giftPhotoData,
      });
    }

    state.giftPhotoData = null;
    save();
    closeModal('modal-gift');
    renderGifts();
    showToast('差し入れを記録しました');
  }

  // Lightbox
  function showLightbox(src) {
    let lb = document.getElementById('lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'lightbox';
      lb.className = 'lightbox';
      lb.innerHTML = '<img>';
      lb.addEventListener('click', () => lb.classList.remove('active'));
      document.body.appendChild(lb);
    }
    lb.querySelector('img').src = src;
    lb.classList.add('active');
  }

  // ===== HTML Escape =====
  function esc(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
  }

  // ===== Init =====
  function init() {
    load();
    applySettings();
    renderEvents();

    // Navigation
    $$('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Event modal
    $('#btn-add-event').addEventListener('click', () => {
      state.editingEventId = null;
      $('#modal-event-title').textContent = '新規イベント';
      $('#event-name').value = '';
      $('#event-date').value = new Date().toISOString().slice(0, 10);
      $('#event-location').value = '';
      renderEventProductChecklist(null);
      openModal('modal-event');
    });
    $('#btn-save-event').addEventListener('click', saveEvent);

    // Product modal (グローバル - イベント選択不要)
    $('#btn-add-product').addEventListener('click', () => {
      state.editingProductId = null;
      $('#modal-product-title').textContent = '商品追加';
      $('#product-name').value = '';
      $('#product-price').value = '';
      $('#product-cost').value = '';
      $('#product-category').value = 'doujinshi';
      $$('.color-opt').forEach((c, i) => c.classList.toggle('selected', i === 0));
      openModal('modal-product');
    });
    $('#btn-save-product').addEventListener('click', saveProduct);

    // Color picker (product modal)
    $$('.color-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        $$('.color-opt').forEach(c => c.classList.remove('selected'));
        opt.classList.add('selected');
      });
    });

    // Color picker (set modal)
    $$('.color-opt-set').forEach(opt => {
      opt.addEventListener('click', () => {
        $$('.color-opt-set').forEach(c => c.classList.remove('selected'));
        opt.classList.add('selected');
      });
    });

    // Set modal
    $('#btn-add-set').addEventListener('click', () => openSetModal());
    $('#btn-save-set').addEventListener('click', saveSet);

    // Gift modal
    $('#btn-add-gift').addEventListener('click', () => openGiftModal());
    $('#btn-save-gift').addEventListener('click', saveGift);
    $('#gift-photo-area').addEventListener('click', (e) => {
      if (e.target.closest('#gift-photo-remove')) return;
      $('#gift-photo-input').click();
    });
    $('#gift-photo-input').addEventListener('change', (e) => {
      if (e.target.files[0]) handleGiftPhoto(e.target.files[0]);
      e.target.value = '';
    });
    $('#gift-photo-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      state.giftPhotoData = null;
      $('#gift-photo-preview').style.display = 'none';
      $('#gift-photo-placeholder').style.display = 'flex';
      $('#gift-photo-remove').style.display = 'none';
    });

    // Payment method selector
    $$('.payment-method-btn').forEach(btn => {
      btn.addEventListener('click', () => selectPaymentMethod(btn.dataset.method));
    });

    // Register actions
    $('#btn-payment').addEventListener('click', openPayment);
    $('#btn-clear-cart').addEventListener('click', () => {
      state.cart = [];
      renderCart();
    });

    // Payment
    $('#payment-received').addEventListener('input', updateChange);
    $('#btn-confirm-payment').addEventListener('click', confirmPayment);

    // Sales
    $('#btn-export-csv').addEventListener('click', exportCSV);

    // Settings
    $('#btn-dark-mode').addEventListener('click', () => {
      state.settings.darkMode = !state.settings.darkMode;
      applySettings();
      save();
    });

    $('#btn-save-goal').addEventListener('click', () => {
      state.settings.goal = parseInt($('#setting-goal').value) || 0;
      save();
      renderGoal();
      showToast('売上目標を保存しました');
    });

    $('#btn-generate-room').addEventListener('click', () => {
      $('#sync-room-id').value = 'room-' + genId();
    });

    $('#btn-connect-sync').addEventListener('click', syncConnect);
    $('#btn-disconnect-sync').addEventListener('click', syncDisconnect);

    // Data management
    $('#btn-export-data').addEventListener('click', exportData);
    $('#btn-import-data').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });
    $('#btn-reset-data').addEventListener('click', () => {
      showConfirm('全データリセット', 'すべてのデータが削除されます。この操作は元に戻せません。', () => {
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
      });
    });

    // Confirm modal
    $('#btn-confirm-ok').addEventListener('click', () => {
      closeModal('modal-confirm');
      if (confirmCallback) { confirmCallback(); confirmCallback = null; }
    });

    // Modal close
    $$('.modal-overlay, .modal-cancel').forEach(el => {
      el.addEventListener('click', closeAllModals);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();
    });

    // Auto-reconnect sync
    if (state.settings.firebaseConfig && state.settings.syncRoomId) {
      setTimeout(syncConnect, 500);
    }
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
