(function () {
  "use strict";

  /* ============================================================
     КОНСТАНТЫ
     ============================================================ */
  const STORAGE_KEY = "daily-budget-v1";
  const LARGE_RATIO = 0.2; // 20% месячного бюджета

  /* ============================================================
     СОСТОЯНИЕ + ХРАНИЛИЩЕ (localStorage)
     ============================================================ */
  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          budget: Number(parsed.budget) || 0,
          expenses:
            parsed.expenses && typeof parsed.expenses === "object"
              ? parsed.expenses
              : {},
          distributeDays: Array.isArray(parsed.distributeDays)
            ? parsed.distributeDays
            : [],
        };
      }
    } catch (e) {
      /* повреждённые данные — начинаем заново */
    }
    return { budget: 0, expenses: {}, distributeDays: [] };
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* переполнение / приватный режим */
    }
  }

  /* ============================================================
     УТИЛИТЫ
     ============================================================ */
  const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const money = (n) => nf.format(Math.round(n)) + " ₽";

  const pad2 = (n) => String(n).padStart(2, "0");
  const keyOf = (d) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const dateFmt = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const timeFmt = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ============================================================
     DOM
     ============================================================ */
  const $ = (id) => document.getElementById(id);

  const els = {
    todayDate: $("todayDate"),
    todayAmount: $("todayAmount"),
    todayNote: $("todayNote"),
    todayLeft: $("todayLeft"),
    form: $("spendForm"),
    input: $("amountInput"),
    spentToday: $("spentToday"),
    monthLeft: $("monthLeft"),
    dailyBase: $("dailyBase"),
    daysLeft: $("daysLeft"),
    logList: $("logList"),
    logTotal: $("logTotal"),
    settingsBtn: $("settingsBtn"),
    modal: $("settingsModal"),
    budgetInput: $("budgetInput"),
    monthInfo: $("monthInfo"),
    saveSettings: $("saveSettings"),
    todayCard: $("todayCard"),
    resetBtn: $("resetBtn"),
    distributeBtn: $("distributeBtn"),
  };

  /* ============================================================
     ЯДРО АЛГОРИТМА

     Бюджет месяца B, дней в месяце N  ->  база дня D = B / N.

     Проходим по дням месяца по порядку:
       1) крупные траты дня ( > 20% B ) раскидываются равномерно
          на оставшиеся дни (включая текущий) — они не «съедают»
          один день целиком, а уменьшают остаток месяца;
       2) доступно на день = база дня + перенос с прошлого дня;
       3) остаток = доступно − обычные траты дня;
          • остаток >= 0  ->  целиком переносится на следующий день;
          • остаток <  0  ->  переносится НЕ он, а его модуль,
            распределённый равномерно по всем оставшимся дням
            (уменьшаем базу каждого из них).
     ============================================================ */
  function computeMonth(budget, year, month) {
    const N = daysIn(year, month);
    const D = N > 0 ? budget / N : 0;
    const prefix = `${year}-${pad2(month + 1)}-`;
    const threshold = budget > 0 ? budget * LARGE_RATIO : Infinity;

    const small = new Array(N + 2).fill(0);
    const large = new Array(N + 2).fill(0);

    for (const key in state.expenses) {
      if (!key.startsWith(prefix)) continue;
      const day = parseInt(key.slice(prefix.length), 10);
      if (!(day >= 1 && day <= N)) continue;
      const list = state.expenses[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const amt = Number(item && item.amount) || 0;
        if (amt <= 0) continue;
        if (amt > threshold) large[day] += amt;
        else small[day] += amt;
      }
    }

    const distributeSet = new Set(state.distributeDays || []);

    const base = new Array(N + 2).fill(D);
    const available = new Array(N + 2).fill(0);
    const incomingCarry = new Array(N + 2).fill(0); // перенос, пришедший в день
    const distributeFlags = new Array(N + 2).fill(false); // активен ли сброс на день

    let carry = 0;

    for (let d = 1; d <= N; d++) {
      incomingCarry[d] = carry;

      /* 1. крупные траты дня — раскидываем на оставшиеся дни */
      if (large[d] > 0) {
        const rest = N - d + 1;
        const cut = large[d] / rest;
        for (let k = d; k <= N; k++) base[k] -= cut;
      }

      /* 1.5. если включено распределение — размазываем carry по дням d..N */
      const key = `${prefix}${pad2(d)}`;
      if (distributeSet.has(key) && carry !== 0) {
        const rest = N - d + 1;
        const cut = carry / rest;
        for (let k = d; k <= N; k++) base[k] += cut;
        distributeFlags[d] = true;
        carry = 0;
      }

      /* 2. доступно на день */
      const avail = base[d] + carry;
      available[d] = avail;

      /* 3. остаток дня */
      const rem = avail - small[d];

      if (rem >= 0) {
        carry = rem;
      } else {
        carry = 0;
        const rest = N - d;
        if (rest > 0) {
          const cut = -rem / rest;
          for (let k = d + 1; k <= N; k++) base[k] -= cut;
        }
      }
    }

    return {
      N,
      D,
      base,
      available,
      small,
      large,
      incomingCarry,
      distributeFlags,
    };
  }

  /* ============================================================
     РЕНДЕР
     ============================================================ */
  let lastKey = keyOf(new Date());

  function render() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const today = now.getDate();
    const key = keyOf(now);
    lastKey = key;

    const calc = computeMonth(state.budget, y, m);

    const avail = calc.available[today] || 0;
    const spentSmall = calc.small[today] || 0;
    const spentLarge = calc.large[today] || 0;
    const left = avail - spentSmall;

    /* ---------- Верхняя зона ---------- */
    els.todayDate.textContent = capitalize(dateFmt.format(now));
    els.todayAmount.textContent = money(left);
    els.todayAmount.classList.toggle("is-negative", left < 0);

    if (state.budget <= 0) {
      els.todayNote.textContent = "Укажите бюджет месяца в настройках";
      els.distributeBtn.hidden = true;
    } else {
      const baseToday = calc.base[today] || 0;
      const carryIn = calc.incomingCarry[today] || 0;
      const isDist = calc.distributeFlags[today];

      const parts = [`база ${money(baseToday)}`];
      if (isDist) {
        parts.push("остаток распределён");
      } else if (Math.abs(carryIn) >= 1) {
        parts.push(
          `${carryIn >= 0 ? "перенос +" : "перенос −"}${money(Math.abs(carryIn))}`,
        );
      }
      els.todayNote.textContent = parts.join("  ·  ");

      /* --- ссылка «Распределить остаток» / «Вернуть перенос» --- */
      const canDistribute = !isDist && Math.abs(carryIn) >= 1;
      const canUndo = isDist;

      if (canDistribute || canUndo) {
        els.distributeBtn.hidden = false;
        els.distributeBtn.textContent = canUndo
          ? "Вернуть перенос"
          : "Распределить остаток";
        els.distributeBtn.classList.toggle("is-active", canUndo);
      } else {
        els.distributeBtn.hidden = true;
      }
    }

    /* ---------- Строка-подсказка над полем ---------- */
    els.todayLeft.textContent = money(avail);
    els.todayLeft.classList.toggle("is-negative", avail < 0);

    /* ---------- Нижняя зона ---------- */
    els.spentToday.textContent = money(spentSmall + spentLarge);

    const monthSpent = totalSpentForMonth(y, m);
    const monthRest = state.budget - monthSpent;
    els.monthLeft.textContent = money(monthRest);
    els.monthLeft.classList.toggle("is-negative", monthRest < 0);

    els.dailyBase.textContent = money(calc.base[today] || 0);
    els.daysLeft.textContent = String(Math.max(0, calc.N - today + 1));

    renderLog(key);
  }

  function totalSpentForMonth(year, month) {
    const prefix = `${year}-${pad2(month + 1)}-`;
    let total = 0;
    for (const key in state.expenses) {
      if (!key.startsWith(prefix)) continue;
      const list = state.expenses[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) total += Number(item && item.amount) || 0;
    }
    return total;
  }

  function renderLog(key) {
    const list = state.expenses[key];

    if (!list || !list.length) {
      els.logList.innerHTML = '<li class="log-empty">Сегодня ещё нет трат</li>';
      els.logTotal.textContent = "";
      return;
    }

    const threshold = state.budget > 0 ? state.budget * LARGE_RATIO : Infinity;

    let total = 0;
    for (const item of list) total += Number(item.amount) || 0;
    els.logTotal.textContent = money(total);

    const sorted = list.slice().sort((a, b) => (b.t || 0) - (a.t || 0));

    els.logList.innerHTML = sorted
      .map((item) => {
        const isBig = item.amount > threshold;
        const time = item.t ? timeFmt.format(new Date(item.t)) : "";
        return (
          '<li class="log-item">' +
          `<span class="log-dot${isBig ? " is-big" : ""}"></span>` +
          `<span class="log-amount">${money(item.amount)}</span>` +
          (isBig ? '<span class="log-badge">крупная</span>' : "") +
          `<span class="log-time">${time}</span>` +
          `<button class="log-del" type="button" data-id="${item.id}" aria-label="Удалить">×</button>` +
          "</li>"
        );
      })
      .join("");
  }

  /* ============================================================
     ДЕЙСТВИЯ
     ============================================================ */
  function addExpense(amount) {
    const key = keyOf(new Date());
    if (!Array.isArray(state.expenses[key])) state.expenses[key] = [];

    state.expenses[key].push({
      id: uid(),
      amount: amount,
      t: Date.now(),
    });

    persist();
    render();
    pulse();
  }

  function pulse() {
    els.todayAmount.classList.remove("pulse");
    void els.todayAmount.offsetWidth;
    els.todayAmount.classList.add("pulse");
  }

  function shake(el) {
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
    setTimeout(() => el.classList.remove("shake"), 420);
  }

  const digitsOnly = (value) => value.replace(/[^\d]/g, "");

  /* ============================================================
     СОБЫТИЯ
     ============================================================ */

  /* --- ввод суммы --- */
  els.input.addEventListener("input", () => {
    const clean = digitsOnly(els.input.value);
    if (clean !== els.input.value) els.input.value = clean;
  });

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();

    const amount = parseInt(digitsOnly(els.input.value), 10);

    if (!amount || amount <= 0) {
      shake(els.input);
      els.input.focus();
      return;
    }

    addExpense(amount);
    els.input.value = "";
    els.input.focus();
  });

  /* --- удаление записи --- */
  els.logList.addEventListener("click", (e) => {
    const btn = e.target.closest(".log-del");
    if (!btn) return;

    const key = keyOf(new Date());
    const list = state.expenses[key];
    if (!Array.isArray(list)) return;

    const idx = list.findIndex((x) => x.id === btn.dataset.id);
    if (idx === -1) return;

    list.splice(idx, 1);
    if (!list.length) delete state.expenses[key];

    persist();
    render();
  });

  /* --- настройки --- */
  function openSettings() {
    els.budgetInput.value =
      state.budget > 0 ? String(Math.round(state.budget)) : "";
    updateMonthInfo();
    els.modal.hidden = false;
    setTimeout(() => els.budgetInput.focus(), 40);
  }

  function closeSettings() {
    els.modal.hidden = true;
    els.input.focus();
  }

  function updateMonthInfo() {
    const now = new Date();
    const N = daysIn(now.getFullYear(), now.getMonth());
    const value = parseInt(digitsOnly(els.budgetInput.value), 10);

    if (!value || value <= 0) {
      els.monthInfo.textContent = `В этом месяце ${N} дней.`;
      return;
    }

    const perDay = value / N;
    const perDayRounded = Math.round(perDay);
    const largeLimit = Math.round(value * LARGE_RATIO);

    els.monthInfo.innerHTML =
      `В этом месяце <b>${N}</b> дн. → база <b>${money(perDayRounded)}</b> в день.
` +
      `Траты больше <b>${money(largeLimit)}</b> считаются крупными и распределяются по остатку месяца.`;
  }

  els.settingsBtn.addEventListener("click", openSettings);

  els.budgetInput.addEventListener("input", () => {
    const clean = digitsOnly(els.budgetInput.value);
    if (clean !== els.budgetInput.value) els.budgetInput.value = clean;
    updateMonthInfo();
  });

  /* --- распределение переноса по оставшимся дням --- */
  els.distributeBtn.addEventListener("click", () => {
    const key = keyOf(new Date());
    if (!Array.isArray(state.distributeDays)) state.distributeDays = [];

    const idx = state.distributeDays.indexOf(key);
    if (idx === -1) {
      state.distributeDays.push(key);
    } else {
      state.distributeDays.splice(idx, 1);
    }

    persist();
    render();
    pulse();
  });

  els.saveSettings.addEventListener("click", () => {
    const value = parseInt(digitsOnly(els.budgetInput.value), 10);
    state.budget = value && value > 0 ? value : 0;
    persist();
    closeSettings();
    render();
  });

  /* --- сброс к заводским настройкам --- */
  els.resetBtn.addEventListener("click", () => {
    const ok = window.confirm(
      "Удалить всю историю трат и сбросить бюджет?\nЭто действие нельзя отменить.",
    );
    if (!ok) return;

    state = { budget: 0, expenses: {}, distributeDays: [] };

    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}

    persist();
    closeSettings();
    render();

    setTimeout(() => {
      try {
        els.input.focus({ preventScroll: true });
      } catch (e) {
        els.input.focus();
      }
    }, 60);
  });

  els.budgetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      els.saveSettings.click();
    }
  });

  /* --- закрытие модалки --- */
  els.modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeSettings();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.modal.hidden) closeSettings();
  });

  /* ============================================================
     СТАРТ
     ============================================================ */
  render();

  // Автофокус на поле ввода
  setTimeout(() => {
    if (!els.modal.hidden) return;
    try {
      els.input.focus({ preventScroll: true });
    } catch (e) {
      els.input.focus();
    }
  }, 80);

  // Смена суток / возврат на вкладку
  setInterval(() => {
    if (keyOf(new Date()) !== lastKey) render();
  }, 30000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) render();
  });

  window.addEventListener("focus", render);
})();
