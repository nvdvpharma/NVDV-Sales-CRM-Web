
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, APP_VERSION } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const $ = id => document.getElementById(id);
const colors = {
  visita:"#22C55E", cita:"#3B82F6", formación:"#8B5CF6", formacion:"#8B5CF6",
  llamada:"#F59E0B", prospección:"#EF4444", prospeccion:"#EF4444",
  seguimiento:"#14B8A6", vacaciones:"#F97316"
};
let currentStateFilter = "";
let agendaMode = "week";
let selectedPharmacy = null;
let editingActivity = null;
let selectedOrderPharmacy = null;
let editingPharmacy = null;
let pharmacyFichaData = null;
let returnToActivityId = null;
let visitStartedAt = null;
let visitTimerId = null;
let pendingQueue = JSON.parse(localStorage.getItem("nvdv_pending_queue") || "[]");

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
}[c]));
const formatMoney = value => new Intl.NumberFormat("es-ES", {
  style:"currency",currency:"EUR"
}).format(Number(value || 0));

function monthlySalesTarget(date = new Date()){
  return date.getMonth() === 7 ? 5000 : 15000;
}

function progressColor(progress){
  if(progress >= 1) return "#22C55E";
  if(progress >= 0.70) return "#F59E0B";
  return "#EF4444";
}

function applyProgress(fillId, labelId, progress){
  const normalized = Math.max(0, Math.min(1, Number(progress || 0)));
  const color = progressColor(normalized);
  const fill = $(fillId);
  fill.style.width = `${normalized * 100}%`;
  fill.style.background = color;
  $(labelId).textContent = `${Math.round(normalized * 100)} %`;
  $(labelId).style.color = color;
}
const isoToday = () => new Date().toISOString().slice(0,10);
const isoDateOffset = days => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0,10);
};
const normalize = value => String(value || "").trim().toLowerCase();

function setPendingCount(){
  $("pending-count").textContent = pendingQueue.length;
  localStorage.setItem("nvdv_pending_queue", JSON.stringify(pendingQueue));
}

function setOnlineStatus(){
  $("offline-banner").classList.toggle("hidden", navigator.onLine);
  if(navigator.onLine) flushPendingQueue();
}
window.addEventListener("online", setOnlineStatus);
window.addEventListener("offline", setOnlineStatus);
setOnlineStatus();

function showPage(id){
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === id));
  document.querySelectorAll(".bottom-nav button").forEach(
    b => b.classList.toggle("active", b.dataset.page === id)
  );
  if(id === "today-page") loadDashboard();
  if(id === "agenda-page") loadAgenda();
  if(id === "orders-page") loadOrders();
}
document.querySelectorAll(".bottom-nav button").forEach(
  b => b.addEventListener("click", () => showPage(b.dataset.page))
);

document.querySelectorAll("[data-dashboard-state]").forEach(button => {
  button.addEventListener("click", async () => {
    currentStateFilter = button.dataset.dashboardState;
    $("pharmacy-search").value = "";

    document.querySelectorAll("[data-state-filter]").forEach(filterButton => {
      filterButton.classList.toggle(
        "active",
        filterButton.dataset.stateFilter === currentStateFilter
      );
    });

    showPage("pharmacies-page");
    await renderPharmacySearch();
  });
});

async function showSession(session){
  $("login-view").classList.toggle("hidden", !!session);
  $("crm-view").classList.toggle("hidden", !session);
  if(session){
    $("user-email").textContent = session.user.email || "";
    $("today-date").textContent = new Intl.DateTimeFormat("es-ES", {
      weekday:"long", day:"numeric", month:"long"
    }).format(new Date());
    $("app-version").textContent = `v${APP_VERSION}`;
    subscribeRealtime();
    await Promise.all([loadDashboard(), flushPendingQueue()]);
  }
}

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("login-error").textContent = "";
  const { error } = await supabase.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value
  });
  if(error) $("login-error").textContent = error.message;
});
$("logout-btn").addEventListener("click", () => supabase.auth.signOut());
supabase.auth.onAuthStateChange((_event, session) => showSession(session));
showSession((await supabase.auth.getSession()).data.session);

async function countByState(states){
  const { count, error } = await supabase
    .from("farmacias")
    .select("id", { count:"exact", head:true })
    .in("estado_comercial", states)
    .is("sync_deleted_at", null);

  if(error) throw error;
  return count || 0;
}

async function loadDashboard(){
  try{
    const [active, prospect, inactive] = await Promise.all([
      countByState(["ACTIVO"]), countByState(["PROSPECCIÓN","PROSPECCION"]), countByState(["INACTIVO"])
    ]);
    $("kpi-active").textContent = active;
    $("kpi-prospect").textContent = prospect;
    $("kpi-inactive").textContent = inactive;

    const today = isoToday();
    const { data: activities, error } = await supabase.from("visitas")
      .select("id,fecha,hora,tipo,observaciones,estado,realizado,farmacia_id,farmacias(id,nombre,direccion,localidad,telefono,movil,email)")
      .eq("fecha", today).is("sync_deleted_at", null).order("hora");
    if(error) throw error;
    renderActivities($("today-list"), activities || [], "No hay actividades para hoy.");

    const now = new Date();
    const monthStart = today.slice(0,8) + "01";
    const yearStart = `${now.getFullYear()}-01-01`;
    const yearEnd = `${now.getFullYear()}-12-31`;

    const [
      { data: monthOrders, error: monthOrdersError },
      { data: yearOrders, error: yearOrdersError }
    ] = await Promise.all([
      supabase.from("pedidos")
        .select("importe,fecha")
        .gte("fecha",monthStart)
        .lte("fecha",today)
        .is("sync_deleted_at",null),
      supabase.from("pedidos")
        .select("importe,fecha")
        .gte("fecha",yearStart)
        .lte("fecha",yearEnd)
        .is("sync_deleted_at",null)
    ]);

    if(monthOrdersError) throw monthOrdersError;
    if(yearOrdersError) throw yearOrdersError;

    const monthTotal = (monthOrders || []).reduce(
      (sum, order) => sum + Number(order.importe || 0), 0
    );
    const annualTotal = (yearOrders || []).reduce(
      (sum, order) => sum + Number(order.importe || 0), 0
    );

    const monthTarget = monthlySalesTarget(now);
    const monthRemaining = Math.max(0, monthTarget - monthTotal);
    const monthProgress = monthTarget > 0 ? monthTotal / monthTarget : 0;
    const annualGoldTarget = 165000;
    const annualProgress = annualTotal / annualGoldTarget;

    $("month-sales").textContent = formatMoney(monthTotal);
    $("month-sales-target").textContent = `Objetivo: ${formatMoney(monthTarget)}`;
    $("month-sales-remaining").textContent = `Pendiente: ${formatMoney(monthRemaining)}`;
    applyProgress("month-sales-progress","month-sales-progress-label",monthProgress);

    $("annual-sales").textContent = formatMoney(annualTotal);
    applyProgress("annual-sales-progress","annual-sales-progress-label",annualProgress);
  }catch(error){
    $("today-list").innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}
$("refresh-all").addEventListener("click", async () => {
  await Promise.all([loadDashboard(), loadAgenda(), loadOrders()]);
});
$("quick-new-activity").addEventListener("click", openNewActivity);

function renderActivities(container, items, emptyText){
  if(!items.length){
    container.innerHTML = `<p class="muted">${emptyText}</p>`;
    return;
  }
  container.innerHTML = items.map(a => {
    const type = normalize(a.tipo || "Actividad");
    const pharmacy = a.farmacias?.nombre || "Sin farmacia";
    const done = Number(a.realizado || 0) === 1 || normalize(a.estado) === "completada";
    return `<article class="list-item" style="border-left-color:${colors[type] || "#3B82F6"}" data-activity-id="${a.id}">
      <div class="row">
        <div>
          <strong>${done ? "✓ " : ""}${escapeHtml(a.hora || "--:--")} · ${escapeHtml(a.tipo || "Actividad")}</strong>
          <span>${escapeHtml(pharmacy)}</span>
          <small>${escapeHtml(a.observaciones || "")}</small>
        </div>
        ${a.farmacias ? `<button class="ghost small visit-mode-btn" data-pharmacy='${escapeHtml(JSON.stringify(a.farmacias))}'>Visita</button>` : ""}
      </div>
    </article>`;
  }).join("");
  container.querySelectorAll("[data-activity-id]").forEach(card => {
    card.addEventListener("click", async event => {
      if(event.target.closest("button")) return;
      await openActivityEditor(Number(card.dataset.activityId));
    });
  });
  container.querySelectorAll(".visit-mode-btn").forEach(button => {
    button.textContent = "Abrir";
    button.addEventListener("click", async event => {
      event.stopPropagation();
      const card = button.closest("[data-activity-id]");
      if(card) await openActivityEditor(Number(card.dataset.activityId));
    });
  });
}

function getAgendaRange(anchor, mode){
  const date = new Date(`${anchor}T12:00:00`);
  let from = new Date(date), to = new Date(date);
  if(mode === "week"){
    const day = (date.getDay() + 6) % 7;
    from.setDate(date.getDate() - day);
    to = new Date(from);
    to.setDate(from.getDate() + 6);
  }else if(mode === "month"){
    from = new Date(date.getFullYear(), date.getMonth(), 1, 12);
    to = new Date(date.getFullYear(), date.getMonth() + 1, 0, 12);
  }
  return [from.toISOString().slice(0,10), to.toISOString().slice(0,10)];
}

$("agenda-anchor").value = isoToday();
document.querySelectorAll("[data-agenda-mode]").forEach(button => {
  button.addEventListener("click", () => {
    agendaMode = button.dataset.agendaMode;
    document.querySelectorAll("[data-agenda-mode]").forEach(
      b => b.classList.toggle("active", b === button)
    );
    loadAgenda();
  });
});

function monthMatrix(anchor){
  const date = new Date(`${anchor}T12:00:00`);
  const year = date.getFullYear();
  const month = date.getMonth();

  const firstDay = new Date(year, month, 1, 12);
  const lastDay = new Date(year, month + 1, 0, 12);

  const startOffset = (firstDay.getDay() + 6) % 7;
  const totalCells = Math.ceil((startOffset + lastDay.getDate()) / 7) * 7;

  const cells = [];
  for(let index = 0; index < totalCells; index++){
    const current = new Date(year, month, index - startOffset + 1, 12);
    cells.push({
      date: current.toISOString().slice(0,10),
      day: current.getDate(),
      currentMonth: current.getMonth() === month,
      today: current.toISOString().slice(0,10) === isoToday()
    });
  }

  return {
    year,
    month,
    cells
  };
}

function renderMonthCalendar(anchor, activities){
  const calendar = monthMatrix(anchor);
  const byDate = {};

  for(const activity of activities){
    if(!byDate[activity.fecha]) byDate[activity.fecha] = [];
    byDate[activity.fecha].push(activity);
  }

  $("month-calendar-grid").innerHTML = calendar.cells.map(cell => {
    const dayActivities = byDate[cell.date] || [];
    const classes = [
      "month-day",
      cell.currentMonth ? "" : "other-month",
      cell.today ? "today" : ""
    ].filter(Boolean).join(" ");

    const events = dayActivities.slice(0,3).map(activity => {
      const type = normalize(activity.tipo || "Actividad");
      const color = colors[type] || "#3B82F6";
      const pharmacy = activity.farmacias?.nombre || "Sin farmacia";

      return `<button
        class="month-event"
        style="border-left-color:${color}"
        data-month-activity="${activity.id}"
        title="${escapeHtml(activity.hora || "")} ${escapeHtml(activity.tipo || "")} ${escapeHtml(pharmacy)}"
      >
        <span>${escapeHtml(activity.hora || "--:--")}</span>
        <strong>${escapeHtml(activity.tipo || "")}</strong>
      </button>`;
    }).join("");

    const extra = dayActivities.length > 3
      ? `<button class="month-more" data-month-date="${cell.date}">+${dayActivities.length - 3} más</button>`
      : "";

    return `<article class="${classes}" data-calendar-date="${cell.date}">
      <div class="month-day-number">${cell.day}</div>
      <div class="month-events">${events}${extra}</div>
    </article>`;
  }).join("");

  $("month-calendar-grid").querySelectorAll("[data-month-activity]").forEach(button => {
    button.addEventListener("click", async event => {
      event.stopPropagation();
      await openActivityEditor(Number(button.dataset.monthActivity));
    });
  });

  $("month-calendar-grid").querySelectorAll("[data-calendar-date]").forEach(day => {
    day.addEventListener("click", event => {
      if(event.target.closest(".month-event") || event.target.closest(".month-more")) return;
      $("agenda-anchor").value = day.dataset.calendarDate;
      agendaMode = "day";
      document.querySelectorAll("[data-agenda-mode]").forEach(
        button => button.classList.toggle("active", button.dataset.agendaMode === "day")
      );
      loadAgenda();
    });
  });

  $("month-calendar-grid").querySelectorAll("[data-month-date]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      $("agenda-anchor").value = button.dataset.monthDate;
      agendaMode = "day";
      document.querySelectorAll("[data-agenda-mode]").forEach(
        item => item.classList.toggle("active", item.dataset.agendaMode === "day")
      );
      loadAgenda();
    });
  });
}

async function loadAgenda(){
  const [from, to] = getAgendaRange($("agenda-anchor").value || isoToday(), agendaMode);

  $("agenda-range-label").textContent = from === to
    ? new Date(`${from}T12:00:00`).toLocaleDateString("es-ES")
    : `${new Date(`${from}T12:00:00`).toLocaleDateString("es-ES")} — ${new Date(`${to}T12:00:00`).toLocaleDateString("es-ES")}`;

  const { data, error } = await supabase.from("visitas")
    .select("id,fecha,hora,tipo,observaciones,estado,realizado,farmacia_id,farmacias(id,nombre,direccion,localidad,telefono,movil,email)")
    .gte("fecha",from).lte("fecha",to).is("sync_deleted_at",null)
    .order("fecha").order("hora");

  if(error){
    $("month-calendar").classList.add("hidden");
    $("agenda-list").classList.remove("hidden");
    $("agenda-list").innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    return;
  }

  const activities = data || [];

  if(agendaMode === "month"){
    $("month-calendar").classList.remove("hidden");
    $("agenda-list").classList.add("hidden");
    renderMonthCalendar($("agenda-anchor").value || isoToday(), activities);
    return;
  }

  $("month-calendar").classList.add("hidden");
  $("agenda-list").classList.remove("hidden");

  renderActivities(
    $("agenda-list"),
    activities.map(activity => ({
      ...activity,
      observaciones: agendaMode === "week"
        ? `${activity.fecha} · ${activity.observaciones || ""}`
        : activity.observaciones || ""
    })),
    "No hay actividades en el periodo."
  );
}
$("load-agenda").addEventListener("click", loadAgenda);
$("new-activity-btn").addEventListener("click", openNewActivity);

async function searchPharmacies(term, limit=60){
  let query = supabase.from("farmacias")
    .select("id,codigo_laboratorio,estado_comercial,ruta,nombre,titular,direccion,codigo_postal,localidad,provincia,telefono,email,frecuencia_visita,potencial,fecha_alta_crm,observaciones,es_interesado,contacto,codigo_lovren,telefono_contacto,movil,cif_nif,horario,instagram,forma_pago_habitual,alta_nuevo_cliente,fecha_alta_nuevo_cliente")
    .is("sync_deleted_at",null).limit(limit);

  const clean = term.trim();
  if(clean){
    query = query.or(
      `nombre.ilike.%${clean}%,localidad.ilike.%${clean}%,codigo_postal.ilike.%${clean}%,ruta.ilike.%${clean}%`
    );
  }
  if(currentStateFilter){
    if(currentStateFilter === "ACTIVO"){
      query = query.eq("estado_comercial", "ACTIVO");
    }else if(currentStateFilter === "INACTIVO"){
      query = query.eq("estado_comercial", "INACTIVO");
    }else if(currentStateFilter === "PROSPECCION"){
      query = query.in("estado_comercial", ["PROSPECCIÓN", "PROSPECCION"]);
    }
  }
  const { data, error } = await query.order("nombre");
  if(error) throw error;
  return data || [];
}

async function renderPharmacySearch(){
  try{
    const items = await searchPharmacies($("pharmacy-search").value);
    $("pharmacy-list").innerHTML = items.length ? items.map(f => `
      <article class="list-item pharmacy-card" data-pharmacy='${escapeHtml(JSON.stringify(f))}'>
        <strong>${escapeHtml(f.nombre)}</strong>
        <span>${escapeHtml(f.localidad || "")} · ${escapeHtml(f.codigo_postal || "")}</span>
        <small>${escapeHtml(f.ruta || "")} · ${escapeHtml(f.estado_comercial || "")}</small>
      </article>`).join("") : "<p class='muted'>Sin resultados.</p>";
    $("pharmacy-list").querySelectorAll(".pharmacy-card").forEach(card => {
      card.addEventListener("click", () => openPharmacyDetail(JSON.parse(card.dataset.pharmacy)));
    });
  }catch(error){
    $("pharmacy-list").innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}
$("search-pharmacies").addEventListener("click", renderPharmacySearch);
$("pharmacy-search").addEventListener("search", renderPharmacySearch);
document.querySelectorAll("[data-state-filter]").forEach(button => {
  button.addEventListener("click", () => {
    currentStateFilter = button.dataset.stateFilter;
    document.querySelectorAll("[data-state-filter]").forEach(
      b => b.classList.toggle("active", b === button)
    );
    renderPharmacySearch();
  });
});


async function fetchPharmacyById(pharmacyId){
  const {data,error}=await supabase
    .from("farmacias")
    .select("*")
    .eq("id",pharmacyId)
    .single();

  if(error || !data){
    throw new Error(error?.message || "No se pudo cargar la farmacia.");
  }
  return data;
}

async function loadPharmacyFichaData(pharmacy){
  const pharmacyId=pharmacy.id;

  const [
    activitiesResult,
    ordersResult,
    notesResult,
    contactsResult
  ]=await Promise.all([
    supabase.from("visitas")
      .select("id,fecha,hora,tipo,resultado,estado,realizado,observaciones,notas_cierre,duracion_minutos")
      .eq("farmacia_id",pharmacyId)
      .is("sync_deleted_at",null)
      .order("fecha",{ascending:false})
      .order("hora",{ascending:false})
      .limit(50),
    supabase.from("pedidos")
      .select("id,fecha,importe,numero_pedido,forma_pago,tipo_pedido,realizado_por,es_implantacion,observaciones")
      .eq("farmacia_id",pharmacyId)
      .is("sync_deleted_at",null)
      .order("fecha",{ascending:false})
      .limit(50),
    supabase.from("notas")
      .select("id,fecha,titulo,contenido")
      .eq("farmacia_id",pharmacyId)
      .is("sync_deleted_at",null)
      .order("fecha",{ascending:false})
      .limit(50),
    supabase.from("contactos_farmacia")
      .select("id,nombre,cargo,telefono,email,observaciones,es_principal,fecha_creacion")
      .eq("farmacia_id",pharmacyId)
      .is("sync_deleted_at",null)
      .order("es_principal",{ascending:false})
      .order("nombre")
  ]);

  return {
    pharmacy,
    activities:activitiesResult.data || [],
    orders:ordersResult.data || [],
    notes:notesResult.data || [],
    contacts:contactsResult.data || [],
    errors:[
      activitiesResult.error,
      ordersResult.error,
      notesResult.error,
      contactsResult.error
    ].filter(Boolean)
  };
}

function renderPharmacyTab(tabName){
  if(!pharmacyFichaData) return;
  const {pharmacy,activities,orders,notes,contacts}=pharmacyFichaData;
  const container=$("pharmacy-tab-content");

  document.querySelectorAll("[data-pharmacy-tab]").forEach(button=>{
    button.classList.toggle("active",button.dataset.pharmacyTab===tabName);
  });

  if(tabName==="summary"){
    const totalOrders=orders.reduce((sum,item)=>sum+Number(item.importe || 0),0);
    const completed=activities.filter(item=>
      Number(item.realizado || 0)===1 ||
      normalize(item.estado)==="completada"
    ).length;

    container.innerHTML=`
      <div class="ficha-summary-grid">
        <article><small>Estado</small><strong>${escapeHtml(pharmacy.estado_comercial || "")}</strong></article>
        <article><small>Actividades</small><strong>${activities.length}</strong></article>
        <article><small>Cerradas</small><strong>${completed}</strong></article>
        <article><small>Pedidos</small><strong>${orders.length}</strong></article>
        <article><small>Facturación histórica</small><strong>${formatMoney(totalOrders)}</strong></article>
      </div>
      <section class="ficha-section">
        <h4>Datos comerciales</h4>
        <p><b>Titular:</b> ${escapeHtml(pharmacy.titular || "")}</p>
        <p><b>Contacto:</b> ${escapeHtml(pharmacy.contacto || "")}</p>
        <p><b>Teléfono:</b> ${escapeHtml(pharmacy.telefono || "")}</p>
        <p><b>Móvil:</b> ${escapeHtml(pharmacy.movil || "")}</p>
        <p><b>Email:</b> ${escapeHtml(pharmacy.email || "")}</p>
        <p><b>Dirección:</b> ${escapeHtml(pharmacy.direccion || "")}, ${escapeHtml(pharmacy.codigo_postal || "")} ${escapeHtml(pharmacy.localidad || "")}</p>
        <p><b>Ruta:</b> ${escapeHtml(pharmacy.ruta || "")}</p>
        <p><b>Potencial:</b> ${escapeHtml(pharmacy.potencial || "")}</p>
        <p><b>Frecuencia:</b> ${escapeHtml(pharmacy.frecuencia_visita || "")}</p>
        <p><b>Forma de pago:</b> ${escapeHtml(pharmacy.forma_pago_habitual || "")}</p>
        <p><b>Observaciones:</b> ${escapeHtml(pharmacy.observaciones || "")}</p>
      </section>`;
    return;
  }

  if(tabName==="activities"){
    container.innerHTML=activities.length ? activities.map(item=>`
      <button class="ficha-history-item" data-ficha-activity="${item.id}">
        <div>
          <strong>${escapeHtml(item.fecha || "")} · ${escapeHtml((item.hora || "").slice(0,5))} · ${escapeHtml(item.tipo || "")}</strong>
          <span>${escapeHtml(item.resultado || item.estado || "Pendiente")}</span>
          <small>${escapeHtml(item.notas_cierre || item.observaciones || "")}</small>
        </div>
        <span>›</span>
      </button>`).join("") : `<p class="muted">No hay actividades.</p>`;

    container.querySelectorAll("[data-ficha-activity]").forEach(button=>{
      button.addEventListener("click",async()=>{
        $("pharmacy-dialog").close();
        await openActivityEditor(Number(button.dataset.fichaActivity));
      });
    });
    return;
  }

  if(tabName==="orders"){
    const total=orders.reduce((sum,item)=>sum+Number(item.importe || 0),0);
    container.innerHTML=`
      <div class="ficha-total">Total histórico: ${formatMoney(total)}</div>
      ${orders.length ? orders.map(item=>`
        <article class="ficha-list-item">
          <strong>${escapeHtml(item.fecha || "")} · ${formatMoney(item.importe || 0)}</strong>
          <span>${escapeHtml(item.numero_pedido || "")} ${item.es_implantacion ? "· Implantación" : ""}</span>
          <small>${escapeHtml(item.tipo_pedido || "")} · ${escapeHtml(item.forma_pago || "")}</small>
          <small>${escapeHtml(item.observaciones || "")}</small>
        </article>`).join("") : `<p class="muted">No hay pedidos.</p>`}`;
    return;
  }

  if(tabName==="notes"){
    container.innerHTML=`
      <form id="new-note-form" class="ficha-note-form">
        <input id="new-note-title" placeholder="Título" value="Nota comercial">
        <textarea id="new-note-content" rows="3" placeholder="Escribe una nota"></textarea>
        <button class="primary" type="submit">Guardar nota</button>
      </form>
      <div class="ficha-note-list">
        ${notes.length ? notes.map(item=>`
          <article class="ficha-list-item">
            <strong>${escapeHtml(item.fecha || "")} · ${escapeHtml(item.titulo || "")}</strong>
            <p>${escapeHtml(item.contenido || "")}</p>
          </article>`).join("") : `<p class="muted">No hay notas.</p>`}
      </div>`;

    $("new-note-form").addEventListener("submit",async event=>{
      event.preventDefault();
      const title=$("new-note-title").value.trim() || "Nota comercial";
      const content=$("new-note-content").value.trim();
      if(!content) return;

      const now=new Date().toISOString();
      const {data,error}=await supabase.from("notas").insert({
        farmacia_id:pharmacy.id,
        fecha:isoToday(),
        titulo:title,
        contenido:content,
        sync_uuid:crypto.randomUUID(),
        sync_created_at:now,
        sync_updated_at:now,
        sync_deleted_at:null,
        sync_status:"pending",
        sync_device_id:"iphone-pwa"
      }).select("id").single();

      if(error || !data?.id){
        alert(error?.message || "No se pudo guardar la nota.");
        return;
      }

      pharmacyFichaData=await loadPharmacyFichaData(pharmacy);
      renderPharmacyTab("notes");
    });
    return;
  }

  if(tabName==="contacts"){
    container.innerHTML=contacts.length ? contacts.map(item=>`
      <article class="ficha-list-item ${Number(item.es_principal || 0)===1 ? "principal" : ""}">
        <strong>${escapeHtml(item.nombre || "")}${Number(item.es_principal || 0)===1 ? " · Principal" : ""}</strong>
        <span>${escapeHtml(item.cargo || "")}</span>
        <small>${escapeHtml(item.telefono || "")} · ${escapeHtml(item.email || "")}</small>
        <small>${escapeHtml(item.observaciones || "")}</small>
      </article>`).join("") : `<p class="muted">No hay contactos registrados.</p>`;
  }
}

function mapLinks(pharmacy){
  const address = [pharmacy.direccion, pharmacy.codigo_postal, pharmacy.localidad, pharmacy.provincia]
    .filter(Boolean).join(", ");
  const encoded = encodeURIComponent(address);
  return {
    apple: `https://maps.apple.com/?q=${encoded}`,
    google: `https://www.google.com/maps/search/?api=1&query=${encoded}`
  };
}


function setPharmacyForm(pharmacy={}){
  editingPharmacy = pharmacy?.id ? pharmacy : null;
  $("pharmacy-edit-title").textContent =
    editingPharmacy ? "Editar farmacia" : "Nueva farmacia";
  $("ph-name").value = pharmacy.nombre || "";
  $("ph-state").value = pharmacy.estado_comercial || "PROSPECCIÓN";
  $("ph-owner").value = pharmacy.titular || "";
  $("ph-contact").value = pharmacy.contacto || "";
  $("ph-phone").value = pharmacy.telefono || "";
  $("ph-mobile").value = pharmacy.movil || "";
  $("ph-email").value = pharmacy.email || "";
  $("ph-address").value = pharmacy.direccion || "";
  $("ph-postal").value = pharmacy.codigo_postal || "";
  $("ph-city").value = pharmacy.localidad || "";
  $("ph-province").value = pharmacy.provincia || "";
  $("ph-route").value = pharmacy.ruta || "";
  $("ph-potential").value = pharmacy.potencial || "";
  $("ph-frequency").value = pharmacy.frecuencia_visita || "";
  $("ph-tax").value = pharmacy.cif_nif || "";
  $("ph-lovren").value = pharmacy.codigo_lovren || "";
  $("ph-payment").value = pharmacy.forma_pago_habitual || "30 días";
  $("ph-hours").value = pharmacy.horario || "";
  $("ph-instagram").value = pharmacy.instagram || "";
  $("ph-notes").value = pharmacy.observaciones || "";
  $("pharmacy-edit-error").textContent = "";
}

function openPharmacyEditor(pharmacy={}){
  setPharmacyForm(pharmacy);
  $("pharmacy-edit-dialog").showModal();
}

$("new-pharmacy-btn").addEventListener("click",()=>openPharmacyEditor());
$("close-pharmacy-edit").addEventListener("click",()=>$("pharmacy-edit-dialog").close());

$("pharmacy-edit-form").addEventListener("submit",async event=>{
  event.preventDefault();
  $("pharmacy-edit-error").textContent="";

  const now = new Date().toISOString();
  const row = {
    nombre:$("ph-name").value.trim(),
    estado_comercial:$("ph-state").value,
    titular:$("ph-owner").value.trim(),
    contacto:$("ph-contact").value.trim(),
    telefono:$("ph-phone").value.trim(),
    movil:$("ph-mobile").value.trim(),
    email:$("ph-email").value.trim(),
    direccion:$("ph-address").value.trim(),
    codigo_postal:$("ph-postal").value.trim(),
    localidad:$("ph-city").value.trim(),
    provincia:$("ph-province").value.trim(),
    ruta:$("ph-route").value.trim(),
    potencial:$("ph-potential").value.trim(),
    frecuencia_visita:$("ph-frequency").value.trim(),
    cif_nif:$("ph-tax").value.trim(),
    codigo_lovren:$("ph-lovren").value.trim(),
    forma_pago_habitual:$("ph-payment").value.trim(),
    horario:$("ph-hours").value.trim(),
    instagram:$("ph-instagram").value.trim(),
    observaciones:$("ph-notes").value.trim(),
    sync_updated_at:now,
    sync_status:"pending",
    sync_device_id:"iphone-pwa"
  };

  if(!row.nombre){
    $("pharmacy-edit-error").textContent="El nombre es obligatorio.";
    return;
  }

  if(editingPharmacy){
    const {data,error}=await supabase.from("farmacias")
      .update(row).eq("id",editingPharmacy.id).select("id").single();
    if(error || !data?.id){
      $("pharmacy-edit-error").textContent =
        `No se pudo actualizar: ${error?.message || "Sin confirmación"}`;
      return;
    }
  }else{
    Object.assign(row,{
      fecha_alta_crm:isoToday(),
      sync_uuid:crypto.randomUUID(),
      sync_created_at:now,
      sync_deleted_at:null
    });
    const {data,error}=await supabase.from("farmacias")
      .insert(row).select("id").single();
    if(error || !data?.id){
      $("pharmacy-edit-error").textContent =
        `No se pudo crear: ${error?.message || "Sin confirmación"}`;
      return;
    }
  }

  $("pharmacy-edit-dialog").close();
  editingPharmacy=null;
  await Promise.all([renderPharmacySearch(),loadDashboard()]);
  alert("Farmacia guardada correctamente.");
});

document.querySelectorAll("[data-pharmacy-tab]").forEach(button=>{
  button.addEventListener("click",()=>{
    renderPharmacyTab(button.dataset.pharmacyTab);
  });
});

async function openPharmacyDetail(pharmacy){
  try{
    const fullPharmacy = pharmacy?.id
      ? await fetchPharmacyById(pharmacy.id)
      : pharmacy;

    selectedPharmacy=fullPharmacy;
    pharmacyFichaData=await loadPharmacyFichaData(fullPharmacy);

    const phone=fullPharmacy.movil || fullPharmacy.telefono_contacto || fullPharmacy.telefono || "";
    const maps=mapLinks(fullPharmacy);

    $("pharmacy-detail").innerHTML=`
      <div class="ficha-header">
        <div>
          <small>${escapeHtml(fullPharmacy.estado_comercial || "")}</small>
          <h3>${escapeHtml(fullPharmacy.nombre || "")}</h3>
          <p>${escapeHtml(fullPharmacy.localidad || "")} · ${escapeHtml(fullPharmacy.ruta || "")}</p>
        </div>
        <div class="ficha-header-actions">
          ${phone ? `<a href="tel:${escapeHtml(phone)}">📞</a>` : ""}
          ${fullPharmacy.email ? `<a href="mailto:${escapeHtml(fullPharmacy.email)}">✉️</a>` : ""}
          <a href="${maps.apple}" target="_blank">🧭</a>
        </div>
      </div>
      <div class="action-grid ficha-actions">
        <button id="detail-edit-pharmacy">✏️ Editar ficha</button>
        <button id="detail-new-activity">+ Actividad</button>
        <button id="detail-new-order">🛒 Crear pedido</button>
      </div>`;

    $("pharmacy-dialog").showModal();
    renderPharmacyTab("summary");

    $("detail-edit-pharmacy").addEventListener("click",()=>{
      $("pharmacy-dialog").close();
      openPharmacyEditor(fullPharmacy);
    });
    $("detail-new-activity").addEventListener("click",()=>{
      $("pharmacy-dialog").close();
      openNewActivity(fullPharmacy);
    });
    $("detail-new-order").addEventListener("click",()=>{
      $("pharmacy-dialog").close();
      openOrderDialog(fullPharmacy);
    });

  }catch(error){
    alert(`No se pudo abrir la ficha: ${error.message}`);
  }
}

$("close-pharmacy").addEventListener("click",async()=>{
  $("pharmacy-dialog").close();
  if(returnToActivityId){
    const activityId=returnToActivityId;
    returnToActivityId=null;
    await openActivityEditor(activityId);
  }
});

$("orders-from").value = isoDateOffset(-30);
$("orders-to").value = isoToday();
async function loadOrders(){
  const { data, error } = await supabase.from("pedidos")
    .select("id,fecha,importe,es_implantacion,observaciones,tipo_pedido,numero_pedido,forma_pago,farmacias(nombre)")
    .gte("fecha",$("orders-from").value).lte("fecha",$("orders-to").value)
    .is("sync_deleted_at",null).order("fecha",{ascending:false}).limit(100);
  if(error){
    $("orders-list").innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    return;
  }
  $("orders-list").innerHTML = (data || []).length ? (data || []).map(order => `
    <article class="list-item" style="border-left-color:#22C55E">
      <strong>${escapeHtml(order.fecha)} · ${escapeHtml(order.farmacias?.nombre || "Sin farmacia")}</strong>
      <span>${formatMoney(order.importe || 0)}</span>
      <small>${escapeHtml(order.tipo_pedido || "")}${order.es_implantacion ? " · Implantación" : ""}${order.forma_pago ? " · " + escapeHtml(order.forma_pago) : ""}</small>
    </article>`).join("") : "<p class='muted'>No hay pedidos en el periodo.</p>";
}
$("load-orders").addEventListener("click", loadOrders);

function openNewActivity(pharmacy=null){
  editingActivity = null;
  $("activity-dialog-title").textContent = "Nueva actividad";
  $("open-close-activity").classList.add("hidden");
  $("delete-activity").classList.add("hidden");
  $("closed-activity-fields").classList.add("hidden");
  $("activity-result").value="";
  $("activity-close-notes").value="";
  $("activity-status").value="PENDIENTE";
  $("activity-completed").checked=false;
  $("activity-form").reset();
  $("activity-date").value = isoToday();
  $("activity-time").value = new Date().toTimeString().slice(0,5);
  $("activity-duration").value = 45;
  $("activity-contact").value = pharmacy?.contacto || "";
  $("activity-phone").value = pharmacy?.movil || pharmacy?.telefono_contacto || pharmacy?.telefono || "";
  $("activity-pharmacy").innerHTML = "";
  if(pharmacy){
    $("activity-pharmacy").innerHTML = `<option value="${pharmacy.id}">${escapeHtml(pharmacy.nombre)}</option>`;
    $("activity-pharmacy-search").value = pharmacy.nombre;
  }
  $("activity-dialog").showModal();
}

async function openActivityEditor(activityId){
  const {data,error}=await supabase.from("visitas")
    .select("id,farmacia_id,fecha,hora,tipo,contacto,telefono,observaciones,duracion_minutos,resultado,estado,notas_cierre,realizado,sync_uuid,sync_created_at,sync_updated_at,sync_deleted_at,sync_status,sync_device_id,farmacias(id,nombre,localidad)")
    .eq("id",activityId)
    .is("sync_deleted_at",null)
    .single();
  if(error || !data){ alert(`No se pudo abrir la actividad: ${error?.message || "No encontrada"}`); return; }
  editingActivity=data;
  $("activity-dialog-title").textContent = Number(data.realizado || 0)===1 ? "Editar actividad cerrada" : "Editar actividad";
  $("open-close-activity").classList.toggle("hidden", Number(data.realizado || 0) === 1);
  $("delete-activity").classList.remove("hidden");
  $("activity-type").value=data.tipo || "Visita";
  $("activity-date").value=data.fecha || isoToday();
  $("activity-time").value=(data.hora || "09:00").slice(0,5);
  $("activity-duration").value=Number(data.duracion_minutos || 45);
  $("activity-contact").value=data.contacto || "";
  $("activity-phone").value=data.telefono || "";
  $("activity-notes").value=data.observaciones || "";

  $("closed-activity-fields").classList.remove("hidden");
  $("activity-result").value=data.resultado || "";
  $("activity-close-notes").value=data.notas_cierre || "";
  $("activity-status").value=normalize(data.estado)==="completada"
    ? "COMPLETADA"
    : "PENDIENTE";
  $("activity-completed").checked=Number(data.realizado || 0)===1;
  const pharmacy=data.farmacias;
  $("activity-pharmacy").innerHTML=pharmacy
    ? `<option value="${pharmacy.id}">${escapeHtml(pharmacy.nombre)} · ${escapeHtml(pharmacy.localidad || "")}</option>`
    : `<option value="${data.farmacia_id || ""}">Farmacia asociada</option>`;
  $("activity-pharmacy-search").value=pharmacy?.nombre || "";
  $("activity-dialog").showModal();
}

$("activity-open-pharmacy").addEventListener("click",async()=>{
  const pharmacyId=Number($("activity-pharmacy").value || 0);
  if(!pharmacyId){
    $("activity-error").textContent="Selecciona primero una farmacia.";
    return;
  }

  returnToActivityId=editingActivity?.id || null;
  $("activity-dialog").close();

  try{
    const pharmacy=await fetchPharmacyById(pharmacyId);
    await openPharmacyDetail(pharmacy);
  }catch(error){
    alert(error.message);
    if(returnToActivityId){
      const activityId=returnToActivityId;
      returnToActivityId=null;
      await openActivityEditor(activityId);
    }
  }
});

$("close-activity").addEventListener("click", () => $("activity-dialog").close());
$("activity-pharmacy-search").addEventListener("input", async event => {
  if(event.target.value.length < 2) return;
  try{
    const items = await searchPharmacies(event.target.value, 20);
    $("activity-pharmacy").innerHTML = items.map(
      f => `<option value="${f.id}">${escapeHtml(f.nombre)} · ${escapeHtml(f.localidad || "")}</option>`
    ).join("");
  }catch(error){
    $("activity-error").textContent = error.message;
  }
});

function buildActivityRow(){
  const now = new Date().toISOString();
  return {
    farmacia_id: Number($("activity-pharmacy").value),
    fecha: $("activity-date").value,
    hora: $("activity-time").value,
    tipo: $("activity-type").value,
    observaciones: $("activity-notes").value.trim(),
    resultado: "Pendiente",
    estado: "PENDIENTE",
    realizado: 0,
    contacto: "",
    telefono: "",
    duracion_minutos: Number($("activity-duration").value || 45),
    origen_automatico: "App móvil",
    fecha_creacion: now,
    sync_uuid: crypto.randomUUID(),
    sync_created_at: now,
    sync_updated_at: now,
    sync_deleted_at: null,
    sync_status: "pending",
    sync_device_id: "iphone-pwa"
  };
}

function queuePendingUnique(table, row){
  const syncUuid = String(row?.sync_uuid || "").trim();

  pendingQueue = pendingQueue.filter(item => {
    const sameTable = item.table === table;
    const sameUuid = String(item.row?.sync_uuid || "").trim() === syncUuid;
    return !(syncUuid && sameTable && sameUuid);
  });

  pendingQueue.push({
    table,
    row,
    createdAt:new Date().toISOString()
  });

  setPendingCount();
}

function removePendingByUuid(table, syncUuid){
  const uuid = String(syncUuid || "").trim();
  if(!uuid) return;

  pendingQueue = pendingQueue.filter(item =>
    !(
      item.table === table &&
      String(item.row?.sync_uuid || "").trim() === uuid
    )
  );

  setPendingCount();
}

async function insertOrQueue(table, row){
  if(!navigator.onLine){
    queuePendingUnique(table,row);
    return {
      ok:false,
      queued:true,
      message:"Sin conexión. El cambio queda guardado en el iPhone."
    };
  }

  const {data,error} = await supabase
    .from(table)
    .upsert(row,{onConflict:"sync_uuid"})
    .select("id,sync_uuid")
    .single();

  if(error){
    queuePendingUnique(table,row);
    return {
      ok:false,
      queued:true,
      message:error.message,
      details:error.details || "",
      hint:error.hint || "",
      code:error.code || ""
    };
  }

  if(!data || !data.id){
    queuePendingUnique(table,row);
    return {
      ok:false,
      queued:true,
      message:"Supabase no confirmó la creación del registro."
    };
  }

  removePendingByUuid(
    table,
    data.sync_uuid || row.sync_uuid
  );

  return {
    ok:true,
    queued:false,
    id:data.id,
    sync_uuid:data.sync_uuid || row.sync_uuid
  };
}

$("activity-status").addEventListener("change",()=>{
  $("activity-completed").checked=
    $("activity-status").value==="COMPLETADA";
});

$("activity-completed").addEventListener("change",()=>{
  $("activity-status").value=
    $("activity-completed").checked ? "COMPLETADA" : "PENDIENTE";
});

$("activity-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("activity-error").textContent="";
  if(!$("activity-pharmacy").value){$("activity-error").textContent="Selecciona una farmacia.";return;}
  const now=new Date().toISOString();
  const fields={
    farmacia_id:Number($("activity-pharmacy").value),
    fecha:$("activity-date").value,
    hora:$("activity-time").value,
    tipo:$("activity-type").value,
    contacto:$("activity-contact").value.trim(),
    telefono:$("activity-phone").value.trim(),
    observaciones:$("activity-notes").value.trim(),
    duracion_minutos:Number($("activity-duration").value || 45),
    sync_updated_at:now,sync_status:"pending",sync_device_id:"iphone-pwa"
  };
  if(editingActivity){
    Object.assign(fields,{
      resultado:$("activity-result").value.trim(),
      notas_cierre:$("activity-close-notes").value.trim(),
      estado:$("activity-status").value,
      realizado:$("activity-completed").checked ? 1 : 0
    });

    const editQuery = supabase
      .from("visitas")
      .update(fields)
      .is("sync_deleted_at",null);

    const {data,error} = editingActivity.sync_uuid
      ? await editQuery
          .eq("sync_uuid",editingActivity.sync_uuid)
          .select("id,sync_uuid")
          .single()
      : await editQuery
          .eq("id",editingActivity.id)
          .select("id,sync_uuid")
          .single();

    if(error || !data?.id){
      $("activity-error").textContent=
        `No se pudo actualizar: ${error?.message || "Sin confirmación"}`;
      return;
    }
    editingActivity=null;$("activity-dialog").close();
    await Promise.all([loadAgenda(),loadDashboard()]);
    alert("Actividad actualizada correctamente.");return;
  }
  const result=await insertOrQueue("visitas",{...buildActivityRow(),...fields});
  if(!result.ok){$("activity-error").textContent=`No se pudo guardar: ${result.message}`;return;}
  $("activity-dialog").close();await Promise.all([loadAgenda(),loadDashboard()]);
  alert(`Actividad creada correctamente (ID ${result.id}).`);
});

async function flushPendingQueue(){
  if(!navigator.onLine || !pendingQueue.length){
    setPendingCount();
    return;
  }

  const uniqueItems = [];
  const seen = new Set();

  for(const item of pendingQueue){
    const uuid = String(item.row?.sync_uuid || "").trim();
    const key = `${item.table}:${uuid}`;

    if(uuid && seen.has(key)) continue;
    if(uuid) seen.add(key);

    uniqueItems.push(item);
  }

  const remaining = [];
  const errors = [];

  for(const item of uniqueItems){
    const {data,error} = await supabase
      .from(item.table)
      .upsert(item.row,{onConflict:"sync_uuid"})
      .select("id,sync_uuid")
      .single();

    if(error || !data?.id){
      remaining.push(item);
      errors.push(
        error?.message ||
        "Supabase no confirmó el registro."
      );
    }
  }

  pendingQueue = remaining;
  setPendingCount();

  if(errors.length){
    alert(
      "Algunos cambios siguen pendientes.\n\n" +
      errors[0]
    );
    return;
  }

  await Promise.all([
    loadDashboard(),
    loadAgenda(),
    loadOrders()
  ]);

  alert(
    "Todos los cambios pendientes se han enviado correctamente."
  );
}
$("sync-pending").addEventListener("click", flushPendingQueue);
setPendingCount();

function setupDictation(buttonId, targetId){
  $(buttonId).addEventListener("click", () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SpeechRecognition){
      alert("El dictado directo no está disponible en este navegador. Usa el micrófono del teclado del iPhone.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "es-ES";
    recognition.interimResults = false;
    recognition.onresult = event => {
      const text = event.results[0][0].transcript;
      $(targetId).value = [$(targetId).value, text].filter(Boolean).join(" ");
    };
    recognition.start();
  });
}
setupDictation("dictate-notes","activity-notes");
setupDictation("dictate-visit","visit-notes");

function openVisitMode(pharmacy){
  selectedPharmacy = pharmacy;
  visitStartedAt = new Date();
  $("visit-pharmacy-name").textContent = pharmacy.nombre || "Farmacia";
  $("visit-notes").value = "";
  $("visit-photo").value = "";
  $("visit-photo-preview").classList.add("hidden");
  updateVisitTimer();
  clearInterval(visitTimerId);
  visitTimerId = setInterval(updateVisitTimer,1000);
  $("visit-dialog").showModal();
}
function updateVisitTimer(){
  if(!visitStartedAt) return;
  const seconds = Math.floor((Date.now() - visitStartedAt.getTime()) / 1000);
  const h = String(Math.floor(seconds/3600)).padStart(2,"0");
  const m = String(Math.floor((seconds%3600)/60)).padStart(2,"0");
  const s = String(seconds%60).padStart(2,"0");
  $("visit-timer").textContent = `${h}:${m}:${s}`;
}
$("close-visit").addEventListener("click", () => {
  clearInterval(visitTimerId);
  $("visit-dialog").close();
});
$("visit-photo").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("visit-photo-preview").src = reader.result;
    $("visit-photo-preview").classList.remove("hidden");
    localStorage.setItem("nvdv_last_visit_photo", reader.result);
  };
  reader.readAsDataURL(file);
});
$("finish-visit").addEventListener("click", async () => {
  if(!selectedPharmacy || !visitStartedAt) return;
  const endedAt = new Date();
  const duration = Math.max(1, Math.round((endedAt - visitStartedAt)/60000));
  const now = new Date().toISOString();
  const row = {
    farmacia_id: selectedPharmacy.id,
    fecha: visitStartedAt.toISOString().slice(0,10),
    hora: visitStartedAt.toTimeString().slice(0,5),
    tipo: "Visita",
    observaciones: $("visit-notes").value.trim(),
    resultado: "Realizada",
    estado: "COMPLETADA",
    realizado: 1,
    contacto: "",
    telefono: selectedPharmacy.movil || selectedPharmacy.telefono_contacto || selectedPharmacy.telefono || "",
    duracion_minutos: duration,
    origen_automatico: "Modo visita iPhone",
    fecha_creacion: now,
    sync_uuid: crypto.randomUUID(),
    sync_created_at: now,
    sync_updated_at: now,
    sync_deleted_at: null,
    sync_status: "pending",
    sync_device_id: "iphone-pwa"
  };
  const result = await insertOrQueue("visitas", row);

  if(!result.ok){
    $("visit-error").textContent =
      `No se pudo guardar en Supabase: ${result.message}` +
      (result.code ? ` [${result.code}]` : "");
    alert(
      "La visita NO se ha enviado a Supabase.\n\n" +
      `Motivo: ${result.message}\n\n` +
      "Ha quedado en Cambios pendientes."
    );
    return;
  }

  clearInterval(visitTimerId);
  $("visit-dialog").close();
  await Promise.all([loadDashboard(),loadAgenda()]);
  alert(`Visita creada correctamente en Supabase (ID ${result.id}).`);
});




$("delete-activity").addEventListener("click", async () => {
  if(!editingActivity) return;

  if(!confirm(
    "¿Seguro que deseas eliminar esta actividad?\n\n" +
    "Desaparecerá también de Windows y Google Calendar " +
    "cuando sincronices el CRM."
  )) return;

  $("activity-error").textContent = "";
  const now = new Date().toISOString();

  const tombstone = {
    sync_deleted_at: now,
    sync_updated_at: now,
    sync_status: "pending",
    sync_device_id: "iphone-pwa"
  };

  const deleteQuery = supabase
    .from("visitas")
    .update(tombstone)
    .is("sync_deleted_at",null);

  const {data,error} = editingActivity.sync_uuid
    ? await deleteQuery
        .eq("sync_uuid",editingActivity.sync_uuid)
        .select("id,sync_uuid,sync_deleted_at")
        .single()
    : await deleteQuery
        .eq("id",editingActivity.id)
        .select("id,sync_uuid,sync_deleted_at")
        .single();

  if(error || !data?.id){
    $("activity-error").textContent =
      `No se pudo eliminar: ${error?.message || "Sin confirmación"}`;
    return;
  }

  removePendingByUuid(
    "visitas",
    data.sync_uuid || editingActivity.sync_uuid
  );

  editingActivity = null;
  $("activity-dialog").close();
  await Promise.all([loadAgenda(),loadDashboard()]);
  alert(
    "Actividad eliminada en la web.\n\n" +
    "Pulsa Sincronizar ahora en Windows para retirarla también " +
    "del CRM local y de Google Calendar."
  );
});

const CALL_RESULTS = [
  "Contestó",
  "No contestó",
  "Devolver llamada",
  "Llamar más tarde",
  "Cita concertada",
  "Pedido",
  "No interesa"
];

const STANDARD_RESULTS = [
  "Ausente",
  "Seguimiento",
  "Formación",
  "Queja",
  "Pedido",
  "No interesa"
];

function addDaysISO(dateISO, days){
  const date = new Date(`${dateISO}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0,10);
}

function addMonthsISO(dateISO, months){
  const date = new Date(`${dateISO}T12:00:00`);
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0
  ).getDate();
  date.setDate(Math.min(originalDay,lastDay));
  return date.toISOString().slice(0,10);
}

async function nextWorkingDay(dateISO){
  let current = dateISO;

  for(let attempt=0; attempt<370; attempt++){
    const date = new Date(`${current}T12:00:00`);
    const weekday = date.getDay();

    if(weekday !== 0 && weekday !== 6){
      const {data,error} = await supabase
        .from("festivos")
        .select("fecha")
        .eq("fecha",current)
        .limit(1);

      if(error || !data?.length){
        return current;
      }
    }

    current = addDaysISO(current,1);
  }

  throw new Error("No se pudo encontrar un día laborable.");
}

function openCloseActivityDialog(){
  if(!editingActivity) return;

  const results = normalize(editingActivity.tipo) === "llamada"
    ? CALL_RESULTS
    : STANDARD_RESULTS;

  $("close-result").innerHTML = results
    .map(item => `<option>${escapeHtml(item)}</option>`)
    .join("");

  $("close-notes").value = editingActivity.notas_cierre || "";
  $("future-action-date").value = "";
  $("future-action-time").value =
    (editingActivity.hora || "09:00").slice(0,5);
  $("close-activity-error").textContent = "";
  $("close-activity-dialog").showModal();
}

$("open-close-activity").addEventListener(
  "click",
  openCloseActivityDialog
);

$("cancel-close-activity").addEventListener(
  "click",
  () => $("close-activity-dialog").close()
);

$("close-activity-form").addEventListener("submit",async event=>{
  event.preventDefault();
  $("close-activity-error").textContent = "";

  if(!editingActivity){
    $("close-activity-error").textContent =
      "No hay una actividad abierta.";
    return;
  }

  const result = $("close-result").value;
  const resultNormalized = normalize(result);
  const typeNormalized = normalize(editingActivity.tipo);
  const notes = $("close-notes").value.trim();
  const futureDateInput =
    $("future-action-date").value || null;
  const futureTime =
    $("future-action-time").value ||
    editingActivity.hora ||
    "09:00";

  let futureType = null;
  let futureDate = null;

  try{
    // Reglas exactas de database.py / cerrar_actividad.
    if(typeNormalized === "llamada"){
      if(resultNormalized === "no contestó" ||
         resultNormalized === "no contesto"){
        futureType = "Llamada";
        futureDate = addDaysISO(editingActivity.fecha,2);

      }else if(resultNormalized === "contestó" ||
               resultNormalized === "contesto"){
        // Contestó solo genera llamada si el usuario indica fecha.
        if(futureDateInput){
          futureType = "Llamada";
          futureDate = futureDateInput;
        }

      }else if(
        resultNormalized === "llamar más tarde" ||
        resultNormalized === "llamar mas tarde" ||
        resultNormalized === "devolver llamada"
      ){
        if(!futureDateInput){
          throw new Error(
            "Debes indicar la fecha de la próxima llamada."
          );
        }
        futureType = "Llamada";
        futureDate = futureDateInput;

      }else if(resultNormalized === "cita concertada"){
        if(!futureDateInput){
          throw new Error(
            "Debes indicar la fecha de la cita."
          );
        }
        futureType = "Cita";
        futureDate = futureDateInput;

      }else if(resultNormalized === "pedido"){
        futureType = "Visita";
        futureDate = addDaysISO(editingActivity.fecha,90);
      }

    }else{
      if(resultNormalized === "ausente"){
        futureType = "Visita";
        futureDate = addDaysISO(editingActivity.fecha,15);

      }else if(resultNormalized === "pedido"){
        futureType = "Visita";
        futureDate = addDaysISO(editingActivity.fecha,90);

      }else if(resultNormalized === "no interesa"){
        futureType = "Visita";
        futureDate = addMonthsISO(editingActivity.fecha,10);
      }
      // Seguimiento, Formación y Queja cierran sin crear actividad futura.
    }

    if(futureDate){
      futureDate = await nextWorkingDay(futureDate);
    }

    const now = new Date().toISOString();

    const {data:closed,error:closeError} = await supabase
      .from("visitas")
      .update({
        resultado:result,
        notas_cierre:notes,
        estado:"COMPLETADA",
        realizado:1,
        sync_updated_at:now,
        sync_status:"pending",
        sync_device_id:"iphone-pwa"
      })
      .eq("id",editingActivity.id)
      .select("id")
      .single();

    if(closeError || !closed?.id){
      throw new Error(
        closeError?.message ||
        "Supabase no confirmó el cierre."
      );
    }

    let futureId = null;

    if(futureType && futureDate){
      const futureRow = {
        farmacia_id:editingActivity.farmacia_id,
        fecha:futureDate,
        hora:futureTime,
        tipo:futureType,
        contacto:editingActivity.contacto || "",
        telefono:editingActivity.telefono || "",
        duracion_minutos:
          futureType === "Llamada" ? 10 : 45,
        observaciones:
          `Actividad generada automáticamente tras cerrar ` +
          `${editingActivity.tipo} con resultado ${result}.`,
        resultado:"Pendiente",
        estado:"PENDIENTE",
        notas_cierre:"",
        realizado:0,
        origen_automatico:result,
        actividad_origen_id:editingActivity.id,
        fecha_creacion:now,
        sync_uuid:crypto.randomUUID(),
        sync_created_at:now,
        sync_updated_at:now,
        sync_deleted_at:null,
        sync_status:"pending",
        sync_device_id:"iphone-pwa"
      };

      const {data:future,error:futureError} = await supabase
        .from("visitas")
        .insert(futureRow)
        .select("id")
        .single();

      if(futureError || !future?.id){
        throw new Error(
          "La actividad se cerró, pero no se pudo crear " +
          "la acción futura: " +
          (futureError?.message || "sin confirmación")
        );
      }

      futureId = future.id;
    }

    $("close-activity-dialog").close();
    $("activity-dialog").close();
    editingActivity = null;

    await Promise.all([
      loadAgenda(),
      loadDashboard()
    ]);

    alert(
      futureId
        ? `Actividad cerrada. ${futureType} creada para ` +
          `${futureDate} a las ${futureTime}.`
        : "Actividad cerrada correctamente."
    );

  }catch(error){
    $("close-activity-error").textContent = error.message;
  }
});


function openOrderDialog(pharmacy){
  selectedOrderPharmacy=pharmacy;
  $("order-form").reset();
  $("order-pharmacy-name").value=pharmacy.nombre || "";
  $("order-date").value=isoToday();
  $("order-payment").value=pharmacy.forma_pago_habitual || "30 días";
  $("order-error").textContent="";
  $("order-dialog").showModal();
}
$("close-order").addEventListener("click",()=>$("order-dialog").close());
$("order-form").addEventListener("submit",async event=>{
  event.preventDefault();$("order-error").textContent="";
  if(!selectedOrderPharmacy?.id){$("order-error").textContent="No hay farmacia seleccionada.";return;}
  const now=new Date().toISOString();
  const row={
    farmacia_id:selectedOrderPharmacy.id,fecha:$("order-date").value,
    importe:Number($("order-amount").value || 0),
    es_implantacion:$("order-implantation").checked ? 1 : 0,
    observaciones:$("order-notes").value.trim(),
    tipo_pedido:$("order-type").value,fecha_creacion:now,
    numero_pedido:$("order-number").value.trim(),
    forma_pago:$("order-payment").value.trim(),
    realizado_por:$("order-made-by").value.trim(),
    sync_uuid:crypto.randomUUID(),sync_created_at:now,sync_updated_at:now,
    sync_deleted_at:null,sync_status:"pending",sync_device_id:"iphone-pwa"
  };
  const result=await insertOrQueue("pedidos",row);
  if(!result.ok){$("order-error").textContent=`No se pudo guardar: ${result.message}`;return;}
  $("order-dialog").close();await Promise.all([loadOrders(),loadDashboard()]);
  alert(`Pedido creado correctamente (ID ${result.id}).`);
});

function subscribeRealtime(){
  supabase.removeAllChannels();
  supabase.channel("nvdv-mobile-live")
    .on("postgres_changes",{event:"*",schema:"public",table:"visitas"},() => {
      loadDashboard(); loadAgenda();
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"farmacias"},() => {
      if($("pharmacies-page").classList.contains("active")) renderPharmacySearch();
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"pedidos"},() => {
      loadDashboard(); if($("orders-page").classList.contains("active")) loadOrders();
    })
    .subscribe();
}

if("serviceWorker" in navigator){
  let newWorker = null;
  window.addEventListener("load", async () => {
    const registration = await navigator.serviceWorker.register("./sw.js");
    registration.addEventListener("updatefound", () => {
      newWorker = registration.installing;
      newWorker.addEventListener("statechange", () => {
        if(newWorker.state === "installed" && navigator.serviceWorker.controller){
          $("update-banner").classList.remove("hidden");
        }
      });
    });
    setInterval(() => registration.update(), 60 * 60 * 1000);
  });
  $("apply-update").addEventListener("click", () => {
    if(newWorker) newWorker.postMessage({type:"SKIP_WAITING"});
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
}
