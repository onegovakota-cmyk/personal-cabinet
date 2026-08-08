(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const cfg = window.APP_CONFIG || {};
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const currentMonthISO = () => todayISO().slice(0, 7);
  const money = (v) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(Number(v || 0));
  const num = (v) => Number(v || 0);
  const esc = (s) => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const prettyDate = (iso) => iso ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso + 'T12:00:00')) : '—';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const daysInMonth = (ym) => { const [y,m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
  const monthBounds = (ym) => { const [y,m] = ym.split('-').map(Number); const start = `${ym}-01`; const end = `${ym}-${String(new Date(y,m,0).getDate()).padStart(2,'0')}`; return {start,end}; };
  const isInMonth = (date, ym) => date && date.slice(0,7) === ym;

  let sb = null;
  let user = null;
  let authMode = 'login';
  let activeTab = 'dashboard';
  let state = {
    settings: { monthly_income_target: 110000 },
    debts: [], fixed: [], incomes: [], expenses: [], payments: [], habits: [], habitLogs: [], tasks: []
  };

  const tabMeta = {
    dashboard: ['Главная', 'Ваш финансовый обзор на сегодня'],
    debts: ['Долги', 'Текущие остатки, цели и платежи'],
    incomes: ['Доходы', 'Добавляйте поступления и распределяйте их по плану'],
    expenses: ['Расходы', 'Фактические траты и постоянные расходы'],
    habits: ['Привычки', 'Трекер на каждый день месяца'],
    tasks: ['Задачи', 'Работа, репетиторство и домашние дела'],
    settings: ['Настройки', 'Параметры вашего личного кабинета']
  };

  function toast(message, kind = 'ok') {
    const el = $('#toast');
    el.textContent = message;
    el.style.background = kind === 'error' ? '#b53f4c' : '#212632';
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function setSync(text = 'Синхронизировано', busy = false) {
    const el = $('#syncState');
    el.textContent = `${busy ? '○' : '●'} ${text}`;
    el.style.color = busy ? '#b7791f' : '#1f9d6a';
    el.style.background = busy ? '#fff7e6' : '#eaf8f2';
  }

  function showApp(show) {
    $('#authView').classList.toggle('hidden', show);
    $('#appView').classList.toggle('hidden', !show);
  }

  function switchTab(tab) {
    activeTab = tab;
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
    $$('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const [title, subtitle] = tabMeta[tab] || tabMeta.dashboard;
    $('#pageTitle').textContent = title;
    $('#pageSubtitle').textContent = subtitle;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (tab === 'habits') renderHabits();
    if (tab === 'tasks') renderTasks();
  }

  function monthsRemaining(targetDate) {
    if (!targetDate) return null;
    const now = new Date(todayISO() + 'T12:00:00');
    const target = new Date(targetDate + 'T12:00:00');
    const days = (target - now) / 86400000;
    return Math.max(1, Math.ceil(days / 30.4375));
  }

  function targetPayment(debt) {
    const balance = num(debt.current_balance);
    if (balance <= 0) return 0;
    const min = num(debt.min_payment);
    const n = monthsRemaining(debt.target_date);
    if (!n) return min;
    const apr = num(debt.apr);
    let goal;
    if (apr > 0) {
      const r = apr / 100 / 12;
      goal = balance * r / (1 - Math.pow(1 + r, -n));
    } else {
      goal = balance / n;
    }
    return Math.max(min, goal);
  }

  function buildPlan() {
    const monthlyIncome = num(state.settings.monthly_income_target || 110000);
    const fixedTotal = state.fixed.reduce((s,x) => s + num(x.monthly_amount), 0);
    const activeDebts = state.debts.filter(d => d.active && num(d.current_balance) > 0);

    const planByDebt = new Map();
    let used = fixedTotal;
    activeDebts.forEach(d => {
      const base = Math.min(num(d.min_payment), num(d.current_balance));
      planByDebt.set(d.id, base);
      used += base;
    });

    let remaining = Math.max(0, monthlyIncome - used);
    [...activeDebts].sort((a,b) => num(a.priority) - num(b.priority)).forEach(d => {
      const current = planByDebt.get(d.id) || 0;
      const goal = Math.min(targetPayment(d), num(d.current_balance));
      const gap = Math.max(0, goal - current);
      const add = Math.min(gap, remaining);
      planByDebt.set(d.id, current + add);
      remaining -= add;
    });

    if (remaining > 0) {
      const top = [...activeDebts].sort((a,b) => num(a.priority) - num(b.priority))[0];
      if (top) planByDebt.set(top.id, (planByDebt.get(top.id) || 0) + remaining);
    }

    const desiredDebt = activeDebts.reduce((s,d) => s + Math.min(targetPayment(d), num(d.current_balance)), 0);
    const desiredTotal = fixedTotal + desiredDebt;
    const gap = Math.max(0, desiredTotal - monthlyIncome);
    const shortMinimum = Math.max(0, fixedTotal + activeDebts.reduce((s,d)=>s+num(d.min_payment),0) - monthlyIncome);

    const items = [];
    if (fixedTotal > 0) items.push({ key:'fixed', label:'Постоянные расходы', amount: Math.min(fixedTotal, monthlyIncome), pct: monthlyIncome ? Math.min(fixedTotal, monthlyIncome) / monthlyIncome * 100 : 0 });
    activeDebts.forEach(d => {
      const amount = planByDebt.get(d.id) || 0;
      items.push({ key:d.id, label:d.name, amount, pct: monthlyIncome ? amount / monthlyIncome * 100 : 0, debt:d });
    });

    return { monthlyIncome, fixedTotal, items, desiredTotal, gap, shortMinimum, planByDebt };
  }

  async function ensureDefaults() {
    const uid = user.id;
    await sb.from('pf_settings').upsert({ user_id: uid, monthly_income_target: 110000 }, { onConflict: 'user_id', ignoreDuplicates: true });

    const debts = [
      { user_id: uid, name: 'Автокредит', debt_type: 'car', initial_balance: 1153814, current_balance: 1153814, apr: 21.9, min_payment: 60479, target_date: '2027-08-08', priority: 2 },
      { user_id: uid, name: 'Кредитная карта', debt_type: 'credit_card', initial_balance: 104086, current_balance: 104086, apr: 0, min_payment: 0, target_date: '2027-02-08', priority: 1 },
      { user_id: uid, name: 'Кредит на учёбу', debt_type: 'education', initial_balance: 29328, current_balance: 29328, apr: 0, min_payment: 3289, target_date: null, priority: 3 }
    ];
    await sb.from('pf_debts').upsert(debts, { onConflict: 'user_id,name', ignoreDuplicates: true });

    const fixed = [
      { user_id: uid, name: 'Уход', monthly_amount: 5000 },
      { user_id: uid, name: 'Телефон', monthly_amount: 2000 },
      { user_id: uid, name: 'Подписки', monthly_amount: 2000 }
    ];
    await sb.from('pf_fixed_expenses').upsert(fixed, { onConflict: 'user_id,name', ignoreDuplicates: true });
  }

  async function loadAll({silent=false} = {}) {
    if (!user) return;
    if (!silent) setSync('Обновление…', true);
    const uid = user.id;
    const [settings, debts, fixed, incomes, expenses, payments, habits, habitLogs, tasks] = await Promise.all([
      sb.from('pf_settings').select('*').eq('user_id', uid).maybeSingle(),
      sb.from('pf_debts').select('*').eq('user_id', uid).order('priority'),
      sb.from('pf_fixed_expenses').select('*').eq('user_id', uid).order('created_at'),
      sb.from('pf_incomes').select('*').eq('user_id', uid).order('received_on', {ascending:false}).order('created_at',{ascending:false}),
      sb.from('pf_expenses').select('*').eq('user_id', uid).order('spent_on', {ascending:false}).order('created_at',{ascending:false}),
      sb.from('pf_debt_payments').select('*, pf_debts(name)').eq('user_id', uid).order('paid_on', {ascending:false}).order('created_at',{ascending:false}),
      sb.from('pf_habits').select('*').eq('user_id', uid).eq('active', true).order('created_at'),
      sb.from('pf_habit_logs').select('*').eq('user_id', uid),
      sb.from('pf_tasks').select('*').eq('user_id', uid).order('created_at')
    ]);

    const errors = [settings,debts,fixed,incomes,expenses,payments,habits,habitLogs,tasks].map(x=>x.error).filter(Boolean);
    if (errors.length) {
      console.error(errors);
      toast('Не удалось загрузить часть данных. Проверьте supabase.sql.', 'error');
      setSync('Ошибка', false);
      return;
    }

    state.settings = settings.data || { monthly_income_target: 110000 };
    state.debts = debts.data || [];
    state.fixed = fixed.data || [];
    state.incomes = incomes.data || [];
    state.expenses = expenses.data || [];
    state.payments = payments.data || [];
    state.habits = habits.data || [];
    state.habitLogs = habitLogs.data || [];
    state.tasks = tasks.data || [];

    renderAll();
    setSync('Синхронизировано', false);
  }

  function renderAll() {
    $('#userEmail').textContent = user?.email || '';
    $('#monthlyIncomeTarget').value = num(state.settings.monthly_income_target || 110000);
    renderDashboard();
    renderDebts();
    renderIncomes();
    renderExpenses();
    renderHabits();
    renderTasks();
  }

  function renderDashboard() {
    const ym = currentMonthISO();
    const monthIncomes = state.incomes.filter(x=>isInMonth(x.received_on,ym));
    const monthExpenses = state.expenses.filter(x=>isInMonth(x.spent_on,ym));
    const monthPayments = state.payments.filter(x=>isInMonth(x.paid_on,ym));
    const inc = monthIncomes.reduce((s,x)=>s+num(x.amount),0);
    const exp = monthExpenses.reduce((s,x)=>s+num(x.amount),0);
    const pay = monthPayments.reduce((s,x)=>s+num(x.amount),0);
    const bal = inc-exp-pay;
    const target = num(state.settings.monthly_income_target || 110000);
    $('#sumIncome').textContent = money(inc);
    $('#sumExpenses').textContent = money(exp);
    $('#sumDebtPayments').textContent = money(pay);
    $('#sumBalance').textContent = money(bal);
    $('#sumBalance').style.color = bal < 0 ? '#d95763' : '#3578e5';
    $('#sumIncomeHint').textContent = `цель ${money(target)}`;

    const plan = buildPlan();
    const debtPlanMonth = [...plan.planByDebt.values()].reduce((s,x)=>s+x,0);
    $('#sumDebtHint').textContent = `ориентир ${money(debtPlanMonth)} / месяц`;
    renderAllocation($('#allocationPlan'), plan, null);

    const gapBadge = $('#planGapBadge');
    if (plan.shortMinimum > 0) {
      gapBadge.textContent = `не хватает ${money(plan.shortMinimum)} даже на минимум`;
      gapBadge.className = 'badge bad';
    } else if (plan.gap > 0) {
      gapBadge.textContent = `до целей +${money(plan.gap)}/мес`;
      gapBadge.className = 'badge warn';
    } else {
      gapBadge.textContent = 'цели укладываются в доход';
      gapBadge.className = 'badge good';
    }
    $('#planNote').innerHTML = plan.gap > 0
      ? `Чтобы закрывать долги по выбранным срокам и покрывать указанные постоянные расходы, ориентир по среднему доходу — <strong>${money(plan.desiredTotal)}</strong> в месяц. При текущем среднем доходе ${money(plan.monthlyIncome)} разница составляет <strong>${money(plan.gap)}</strong>. Поэтому приложение сначала закрывает постоянные расходы и минимальные платежи, затем — цели по приоритету.`
      : `Текущего среднего дохода достаточно для указанных целей. Свободный остаток можно направлять в долг с самым высоким приоритетом.`;

    const debtBox = $('#dashboardDebts');
    if (!state.debts.length) debtBox.innerHTML = '<div class="empty">Долгов нет.</div>';
    else debtBox.innerHTML = state.debts.map(d => {
      const progress = num(d.initial_balance) ? clamp((1-num(d.current_balance)/num(d.initial_balance))*100,0,100) : 0;
      return `<div class="debt-mini"><div><strong>${esc(d.name)}</strong><small>Осталось ${money(d.current_balance)} · цель ${d.target_date ? prettyDate(d.target_date) : 'по графику'}</small></div><strong>${Math.round(progress)}%</strong><div class="progress"><span style="width:${progress}%"></span></div></div>`;
    }).join('');

    $('#todayLabel').textContent = new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long'}).format(new Date());
    renderTodayTasks();
    renderTodayHabits();
  }

  function renderAllocation(container, plan, enteredAmount) {
    const base = plan.monthlyIncome || 1;
    const amountToSplit = enteredAmount == null ? base : Math.max(0, enteredAmount);
    container.innerHTML = plan.items.map(item => {
      const share = base ? item.amount/base : 0;
      const displayAmount = enteredAmount == null ? item.amount : amountToSplit * share;
      return `<div class="allocation-row"><span>${esc(item.label)}</span><em>${(share*100).toFixed(1).replace('.',',')}%</em><strong>${money(displayAmount)}</strong><div class="track"><span style="width:${clamp(share*100,0,100)}%"></span></div></div>`;
    }).join('') || '<div class="empty">Добавьте доход и финансовые цели.</div>';
  }

  function renderDebts() {
    const box = $('#debtsList');
    if (!state.debts.length) { box.innerHTML = '<div class="empty">Долгов нет.</div>'; return; }
    const plan = buildPlan();
    box.innerHTML = state.debts.map(d => {
      const initial = num(d.initial_balance);
      const current = num(d.current_balance);
      const progress = initial ? clamp((1-current/initial)*100,0,100) : 0;
      const goal = targetPayment(d);
      const allocated = plan.planByDebt.get(d.id) || 0;
      const months = monthsRemaining(d.target_date);
      const reached = current <= 0;
      return `<article class="debt-card">
        <div class="debt-card-head"><div><h3>${esc(d.name)}</h3><span class="badge ${reached?'good':''}">${reached?'Погашен':`приоритет ${d.priority}`}</span></div><button class="icon-btn debt-edit" data-id="${d.id}" title="Редактировать">✎</button></div>
        <div class="debt-amount">${money(current)}</div><div class="muted">текущий остаток</div>
        <div class="progress mt-md"><span style="width:${progress}%"></span></div><div class="hint">Погашено ${progress.toFixed(1).replace('.',',')}% от исходного остатка</div>
        <div class="debt-meta">
          <div class="mini-stat"><span>Ставка</span><strong>${num(d.apr).toFixed(2).replace('.',',')}%</strong></div>
          <div class="mini-stat"><span>Мин. платёж</span><strong>${money(d.min_payment)}</strong></div>
          <div class="mini-stat"><span>Для цели сейчас</span><strong>${money(goal)}/мес</strong></div>
          <div class="mini-stat"><span>Реально по плану</span><strong>${money(allocated)}/мес</strong></div>
          <div class="mini-stat"><span>Целевая дата</span><strong>${d.target_date ? prettyDate(d.target_date) : 'по графику'}</strong></div>
          <div class="mini-stat"><span>До цели</span><strong>${months ? `${months} мес.` : '—'}</strong></div>
        </div>
        ${d.debt_type==='credit_card' && num(d.apr)===0 ? '<div class="hint">Ставка кредитки пока не указана — прогноз считается без процентов.</div>' : ''}
        <div class="debt-actions"><button class="btn primary small debt-pay" data-id="${d.id}" ${reached?'disabled':''}>+ Платёж</button><button class="btn ghost small debt-edit" data-id="${d.id}">Изменить остаток</button></div>
      </article>`;
    }).join('');

    const ym = currentMonthISO();
    const monthPayments = state.payments.filter(x=>isInMonth(x.paid_on,ym));
    $('#debtPaymentsMonthTotal').textContent = money(monthPayments.reduce((sum,x)=>sum+num(x.amount),0));
    $('#debtPaymentsHistory').innerHTML = state.payments.length ? `<table><thead><tr><th>Дата</th><th>Долг</th><th>Комментарий</th><th>Платёж</th></tr></thead><tbody>${state.payments.slice(0,100).map(x=>`<tr><td>${prettyDate(x.paid_on)}</td><td>${esc(x.pf_debts?.name || 'Долг')}</td><td>${esc(x.note||'—')}</td><td class="amount-neg">${money(x.amount)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Платежей пока нет.</div>';

    $$('.debt-edit').forEach(b => b.onclick = () => openDebtEdit(b.dataset.id));
    $$('.debt-pay').forEach(b => b.onclick = () => openPayment(b.dataset.id));
  }

  function openDebtNew() {
    $('#debtDialogTitle').textContent = 'Добавить долг';
    $('#debtEditId').value = '';
    $('#debtEditName').value = '';
    $('#debtEditBalance').value = '';
    $('#debtEditApr').value = '0';
    $('#debtEditMin').value = '0';
    $('#debtEditTarget').value = '';
    $('#debtEditPriority').value = '5';
    $('#debtDialog').showModal();
  }

  function openDebtEdit(id) {
    const d = state.debts.find(x=>x.id===id); if (!d) return;
    $('#debtDialogTitle').textContent = 'Редактировать долг';
    $('#debtEditId').value = d.id;
    $('#debtEditName').value = d.name;
    $('#debtEditBalance').value = num(d.current_balance);
    $('#debtEditApr').value = num(d.apr);
    $('#debtEditMin').value = num(d.min_payment);
    $('#debtEditTarget').value = d.target_date || '';
    $('#debtEditPriority').value = num(d.priority || 5);
    $('#debtDialog').showModal();
  }

  function openPayment(id) {
    const d = state.debts.find(x=>x.id===id); if (!d) return;
    $('#paymentDebtId').value = id;
    $('#paymentDebtName').textContent = `${d.name} · осталось ${money(d.current_balance)}`;
    $('#paymentAmount').value = '';
    $('#paymentAmount').max = num(d.current_balance);
    $('#paymentDate').value = todayISO();
    $('#paymentNote').value = '';
    $('#paymentDialog').showModal();
  }

  function renderIncomes() {
    const ym = currentMonthISO();
    const month = state.incomes.filter(x=>isInMonth(x.received_on,ym));
    const total = month.reduce((s,x)=>s+num(x.amount),0);
    $('#incomeMonthTotal').textContent = money(total);
    const rows = state.incomes.slice(0,100);
    $('#incomeHistory').innerHTML = rows.length ? `<table><thead><tr><th>Дата</th><th>Источник</th><th>Комментарий</th><th>Сумма</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${prettyDate(x.received_on)}</td><td>${esc(x.category)}</td><td>${esc(x.note||'—')}</td><td class="amount-pos">+${money(x.amount)}</td><td class="table-actions"><button class="delete-income" data-id="${x.id}">Удалить</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Доходов пока нет.</div>';
    $$('.delete-income').forEach(b=>b.onclick=()=>deleteRow('pf_incomes',b.dataset.id,'Доход удалён'));
    updateSplitPreview();
  }

  function renderExpenses() {
    const ym = currentMonthISO();
    const month = state.expenses.filter(x=>isInMonth(x.spent_on,ym));
    const total = month.reduce((s,x)=>s+num(x.amount),0);
    $('#expenseMonthTotal').textContent = money(total);
    const rows = state.expenses.slice(0,100);
    $('#expenseHistory').innerHTML = rows.length ? `<table><thead><tr><th>Дата</th><th>Категория</th><th>Комментарий</th><th>Сумма</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${prettyDate(x.spent_on)}</td><td>${esc(x.category)}</td><td>${esc(x.note||'—')}</td><td class="amount-neg">−${money(x.amount)}</td><td class="table-actions"><button class="delete-expense" data-id="${x.id}">Удалить</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Расходов пока нет.</div>';
    $$('.delete-expense').forEach(b=>b.onclick=()=>deleteRow('pf_expenses',b.dataset.id,'Расход удалён'));

    $('#fixedExpensesList').innerHTML = state.fixed.length ? state.fixed.map(x=>`<div class="fixed-row"><span>${esc(x.name)}</span><strong>${money(x.monthly_amount)}</strong><button class="text-btn delete-fixed" data-id="${x.id}">Удалить</button></div>`).join('') : '<div class="empty">Постоянных расходов пока нет.</div>';
    $$('.delete-fixed').forEach(b=>b.onclick=()=>deleteRow('pf_fixed_expenses',b.dataset.id,'Категория удалена'));
  }

  function updateSplitPreview() {
    const amount = num($('#splitAmount')?.value || 0);
    const el = $('#splitPreview'); if (!el) return;
    renderAllocation(el, buildPlan(), amount);
  }

  function renderHabits() {
    const ym = $('#habitMonth').value || currentMonthISO();
    if (!$('#habitMonth').value) $('#habitMonth').value = ym;
    const totalDays = daysInMonth(ym);
    const tracker = $('#habitTracker');
    if (!state.habits.length) { tracker.innerHTML = '<article class="panel"><div class="empty">Добавьте первую привычку — например, чтение, прогулку или зарядку.</div></article>'; return; }
    tracker.innerHTML = state.habits.map(h => {
      const logs = state.habitLogs.filter(l=>l.habit_id===h.id && l.day.slice(0,7)===ym && l.completed);
      const doneSet = new Set(logs.map(l=>l.day));
      const cells = Array.from({length:31},(_,i)=>{
        const day = i+1;
        if (day > totalDays) return `<button class="day-cell out">${day}</button>`;
        const date = `${ym}-${String(day).padStart(2,'0')}`;
        return `<button class="day-cell ${doneSet.has(date)?'done':''} habit-day" data-habit="${h.id}" data-day="${date}">${day}</button>`;
      }).join('');
      const pct = totalDays ? logs.length / totalDays * 100 : 0;
      return `<article class="habit-card"><div class="habit-head"><div><div class="habit-title">${esc(h.name)}</div><div class="muted">${logs.length} из ${totalDays} дней</div></div><button class="text-btn delete-habit" data-id="${h.id}">Удалить</button></div><div class="habit-grid">${cells}</div><div class="habit-progress-line"><div class="progress"><span style="width:${pct}%"></span></div><strong>${Math.round(pct)}%</strong></div></article>`;
    }).join('');
    $$('.habit-day').forEach(b=>b.onclick=()=>toggleHabitDay(b.dataset.habit,b.dataset.day));
    $$('.delete-habit').forEach(b=>b.onclick=()=>deleteHabit(b.dataset.id));
  }

  function renderTodayHabits() {
    const box = $('#todayHabits');
    if (!state.habits.length) { box.innerHTML = '<div class="empty">Привычек пока нет.</div>'; return; }
    const day = todayISO();
    box.innerHTML = state.habits.map(h=>{
      const done = state.habitLogs.some(l=>l.habit_id===h.id && l.day===day && l.completed);
      return `<button class="today-habit ${done?'done':''}" data-habit="${h.id}" data-day="${day}"><span>${done?'✓':'○'} ${esc(h.name)}</span><strong>${done?'готово':'отметить'}</strong></button>`;
    }).join('');
    $$('.today-habit').forEach(b=>b.onclick=()=>toggleHabitDay(b.dataset.habit,b.dataset.day));
  }

  function renderTasks() {
    const date = $('#taskDate').value || todayISO();
    if (!$('#taskDate').value) $('#taskDate').value = date;
    const categories = ['work','tutoring','home'];
    categories.forEach(cat=>{
      const items = state.tasks.filter(t=>t.task_date===date && t.category===cat);
      $(`#count-${cat}`).textContent = `${items.filter(x=>x.completed).length}/${items.length}`;
      const box = $(`#tasks-${cat}`);
      box.innerHTML = items.length ? items.map(t=>taskRow(t)).join('') : '<div class="empty">Нет задач.</div>';
    });
    bindTaskEvents();
  }

  function taskRow(t) {
    return `<div class="task-row ${t.completed?'completed':''}"><input class="task-check" type="checkbox" ${t.completed?'checked':''} data-id="${t.id}" /><span class="task-text">${esc(t.title)}</span><button class="task-delete" data-id="${t.id}" title="Удалить">✕</button></div>`;
  }

  function bindTaskEvents() {
    $$('.task-check').forEach(c=>c.onchange=()=>toggleTask(c.dataset.id,c.checked));
    $$('.task-delete').forEach(b=>b.onclick=()=>deleteRow('pf_tasks',b.dataset.id,'Задача удалена'));
  }

  function renderTodayTasks() {
    const box = $('#todayTasks');
    const items = state.tasks.filter(t=>t.task_date===todayISO());
    if (!items.length) { box.innerHTML = '<div class="empty">На сегодня задач нет.</div>'; return; }
    box.innerHTML = items.slice(0,7).map(t=>taskRow(t)).join('');
    bindTaskEvents();
  }

  async function toggleHabitDay(habitId, day) {
    const existing = state.habitLogs.find(l=>l.habit_id===habitId && l.day===day);
    setSync('Сохранение…', true);
    let result;
    if (existing) result = await sb.from('pf_habit_logs').delete().eq('id',existing.id);
    else result = await sb.from('pf_habit_logs').insert({user_id:user.id, habit_id:habitId, day, completed:true});
    if (result.error) { console.error(result.error); toast('Не удалось сохранить привычку','error'); }
    await loadAll({silent:true});
  }

  async function toggleTask(id, completed) {
    const {error} = await sb.from('pf_tasks').update({completed}).eq('id',id);
    if (error) toast('Не удалось обновить задачу','error');
    await loadAll({silent:true});
  }

  async function deleteHabit(id) {
    if (!confirm('Удалить привычку и все отметки по ней?')) return;
    const {error} = await sb.from('pf_habits').delete().eq('id',id);
    if (error) toast('Не удалось удалить привычку','error'); else toast('Привычка удалена');
    await loadAll({silent:true});
  }

  async function deleteRow(table, id, success) {
    if (!confirm('Удалить эту запись?')) return;
    const {error} = await sb.from(table).delete().eq('id',id);
    if (error) { console.error(error); toast('Не удалось удалить запись','error'); }
    else toast(success);
    await loadAll({silent:true});
  }

  function bindUI() {
    $$('[data-tab]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
    $$('[data-go]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.go)));
    $('#refreshBtn').onclick = ()=>loadAll();
    $('#logoutBtn').onclick = logout;
    $('#logoutBtn2').onclick = logout;
    $('#splitAmount').addEventListener('input', updateSplitPreview);
    $('#habitMonth').addEventListener('change', renderHabits);
    $('#taskDate').addEventListener('change', renderTasks);
    $('#addHabitBtn').onclick = ()=>{ $('#habitName').value=''; $('#habitDialog').showModal(); };
    $('#addDebtBtn').onclick = openDebtNew;
    $$('.dialog-close').forEach(b => b.onclick = () => { const d = document.getElementById(b.dataset.dialog); if (d?.open) d.close(); });

    $('#authModeToggle').onclick = () => {
      authMode = authMode === 'login' ? 'register' : 'login';
      $('#authSubmit').textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт';
      $('#authModeToggle').textContent = authMode === 'login' ? 'Создать аккаунт' : 'У меня уже есть аккаунт';
      $('#authPassword').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    };

    $('#authForm').addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#authEmail').value.trim();
      const password = $('#authPassword').value;
      $('#authSubmit').disabled = true;
      $('#authHint').textContent = authMode === 'login' ? 'Проверяю email и пароль…' : 'Создаю аккаунт…';
      $('#authHint').style.color = '';
      try {
        if (authMode === 'login') {
          const {error} = await sb.auth.signInWithPassword({email,password});
          if (error) throw error;
          $('#authHint').textContent = 'Вход выполнен. Загружаю личный кабинет…';
        } else {
          const {data,error} = await sb.auth.signUp({email,password});
          if (error) throw error;
          if (!data.session) {
            toast('Аккаунт создан. Подтвердите email и затем войдите.');
            $('#authHint').textContent = 'Аккаунт создан. Проверьте почту для подтверждения email.';
          }
        }
      } catch (err) {
        console.error(err);
        const message = err.message || 'Ошибка входа';
        toast(message,'error');
        $('#authHint').textContent = `Ошибка: ${message}`;
        $('#authHint').style.color = '#b53f4c';
      } finally { $('#authSubmit').disabled = false; }
    });

    $('#incomeForm').addEventListener('submit', async e => {
      e.preventDefault();
      const payload = {user_id:user.id, amount:num($('#incomeAmount').value), category:$('#incomeCategory').value, received_on:$('#incomeDate').value, note:$('#incomeNote').value.trim() || null};
      const {error} = await sb.from('pf_incomes').insert(payload);
      if (error) toast('Не удалось добавить доход','error'); else { toast('Доход добавлен'); e.target.reset(); $('#incomeDate').value=todayISO(); }
      await loadAll({silent:true});
    });

    $('#expenseForm').addEventListener('submit', async e => {
      e.preventDefault();
      const payload = {user_id:user.id, amount:num($('#expenseAmount').value), category:$('#expenseCategory').value, spent_on:$('#expenseDate').value, note:$('#expenseNote').value.trim() || null};
      const {error} = await sb.from('pf_expenses').insert(payload);
      if (error) toast('Не удалось добавить расход','error'); else { toast('Расход добавлен'); e.target.reset(); $('#expenseDate').value=todayISO(); }
      await loadAll({silent:true});
    });

    $('#fixedExpenseForm').addEventListener('submit', async e => {
      e.preventDefault();
      const payload = {user_id:user.id, name:$('#fixedExpenseName').value.trim(), monthly_amount:num($('#fixedExpenseAmount').value)};
      const {error} = await sb.from('pf_fixed_expenses').upsert(payload,{onConflict:'user_id,name'});
      if (error) toast('Не удалось сохранить расход','error'); else { toast('Постоянный расход сохранён'); e.target.reset(); }
      await loadAll({silent:true});
    });

    $('#settingsForm').addEventListener('submit', async e => {
      e.preventDefault();
      const amount = num($('#monthlyIncomeTarget').value);
      const {error} = await sb.from('pf_settings').upsert({user_id:user.id, monthly_income_target:amount},{onConflict:'user_id'});
      if (error) toast('Не удалось сохранить настройки','error'); else toast('Настройки сохранены');
      await loadAll({silent:true});
    });

    $('#taskForm').addEventListener('submit', async e => {
      e.preventDefault();
      const payload = {user_id:user.id,title:$('#taskTitle').value.trim(),category:$('#taskCategory').value,task_date:$('#taskDate').value,completed:false};
      const {error} = await sb.from('pf_tasks').insert(payload);
      if (error) toast('Не удалось добавить задачу','error'); else { $('#taskTitle').value=''; toast('Задача добавлена'); }
      await loadAll({silent:true});
    });

    $('#habitForm').addEventListener('submit', async e => {
      e.preventDefault();
      const name = $('#habitName').value.trim();
      if (!name) return;
      const {error} = await sb.from('pf_habits').upsert({user_id:user.id,name,active:true},{onConflict:'user_id,name'});
      if (error) toast('Не удалось добавить привычку','error'); else { toast('Привычка добавлена'); $('#habitDialog').close(); }
      await loadAll({silent:true});
    });

    $('#debtEditForm').addEventListener('submit', async e => {
      e.preventDefault();
      const id = $('#debtEditId').value;
      const balance = num($('#debtEditBalance').value);
      const payload = {name:$('#debtEditName').value.trim(),current_balance:balance,apr:num($('#debtEditApr').value),min_payment:num($('#debtEditMin').value),target_date:$('#debtEditTarget').value || null,priority:num($('#debtEditPriority').value || 5)};
      let result;
      if (id) result = await sb.from('pf_debts').update(payload).eq('id',id);
      else result = await sb.from('pf_debts').insert({...payload,user_id:user.id,debt_type:'other',initial_balance:balance,active:true});
      if (result.error) toast(id ? 'Не удалось обновить долг' : 'Не удалось добавить долг','error');
      else { toast(id ? 'Долг обновлён' : 'Долг добавлен'); $('#debtDialog').close(); }
      await loadAll({silent:true});
    });

    $('#paymentForm').addEventListener('submit', async e => {
      e.preventDefault();
      const debtId = $('#paymentDebtId').value;
      const amount = num($('#paymentAmount').value);
      const d = state.debts.find(x=>x.id===debtId);
      if (!d || amount <= 0) return;
      if (amount > num(d.current_balance)) {
        if (!confirm('Платёж больше текущего остатка. Записать его всё равно? Остаток станет 0 ₽.')) return;
      }
      const {error} = await sb.rpc('pf_record_debt_payment',{p_debt_id:debtId,p_amount:amount,p_paid_on:$('#paymentDate').value,p_note:$('#paymentNote').value.trim() || null});
      if (error) { console.error(error); toast('Не удалось записать платёж','error'); }
      else { toast('Платёж записан'); $('#paymentDialog').close(); }
      await loadAll({silent:true});
    });
  }

  async function logout() {
    await sb.auth.signOut();
    user = null;
    showApp(false);
  }

  async function onSession(session) {
    user = session?.user || null;
    if (!user) { showApp(false); return; }
    showApp(true);
    $('#incomeDate').value = todayISO();
    $('#expenseDate').value = todayISO();
    $('#taskDate').value = todayISO();
    $('#habitMonth').value = currentMonthISO();
    $('#paymentDate').value = todayISO();
    setSync('Подготовка…', true);
    await ensureDefaults();
    await loadAll();
  }

  async function init() {
    bindUI();
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_URL.includes('ВАШ')) {
      $('#configWarning').textContent = 'Сначала заполните SUPABASE_URL и SUPABASE_PUBLISHABLE_KEY в config.js.';
      $('#configWarning').classList.remove('hidden');
      $('#authSubmit').disabled = true;
      return;
    }
    if (!window.supabase) {
      $('#configWarning').textContent = 'Не удалось загрузить библиотеку Supabase. Проверьте интернет.';
      $('#configWarning').classList.remove('hidden');
      return;
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
    const {data} = await sb.auth.getSession();
    await onSession(data.session);
    sb.auth.onAuthStateChange((_event, session) => {
      if (session?.user?.id !== user?.id) onSession(session);
    });
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./service-worker.js').catch(console.warn);
    window.addEventListener('focus',()=>{ if (user) loadAll({silent:true}); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
