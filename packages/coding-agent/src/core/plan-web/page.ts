export const planPage = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi · Plan actual</title><style>
:root{color-scheme:light dark;font:16px/1.6 system-ui}body{max-width:960px;margin:40px auto;padding:0 24px}
header{display:flex;justify-content:space-between;align-items:center;gap:20px}h1{margin:0}small{opacity:.7}
pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:24px;border:1px solid #8886;border-radius:12px}
button{padding:10px 16px;border:1px solid #8888;border-radius:8px;cursor:pointer;font:inherit}button:disabled{cursor:default;opacity:.5}
.toolbar{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;gap:8px;margin:20px 0;padding:12px;border:1px solid #8886;border-radius:12px;background:Canvas}.primary{font-weight:650}.danger{color:#d64e4e;margin-left:auto}#error{color:#d64e4e}#status{font-weight:600}#activity{max-height:250px;overflow:auto}
@media(max-width:640px){body{margin:20px auto;padding:0 16px}.toolbar button{flex:1 1 45%}.danger{margin-left:0}}
</style></head><body>
<header><h1>Plan actual</h1><span id="status">Conectando…</span></header>
<p id="project"></p><small id="version"></small>
<nav class="toolbar" role="toolbar" aria-label="Acciones del plan"><button id="approve" class="primary" disabled>Aprobar y ejecutar</button><button id="revise" disabled>Solicitar cambios</button><button id="new" disabled>Crear nuevo plan</button><button id="discard" class="danger" disabled>Descartar plan actual</button></nav>
<p id="error" role="alert"></p><pre id="plan">Esperando el plan…</pre>
<h2>Actividad y resultado</h2><pre id="activity"></pre>
<script>
const token=location.hash.slice(1)||sessionStorage.getItem('pi-plan-token')||'';sessionStorage.setItem('pi-plan-token',token);history.replaceState(null,'',location.pathname);
const labels={draft:'Borrador',planning:'Planificando',review:'Listo para revisión',approving:'Aprobando',executing:'Ejecutando',completed:'Completado',blocked:'Bloqueado',failed:'Fallido'};
let state, busy=false, connected=false;
const byId=id=>document.getElementById(id);
function render(){if(!state)return;const idle=['review','draft','blocked','failed','completed'].includes(state.status);const hasPlan=Boolean(state.content.trim());byId('status').textContent=connected?labels[state.status]:'Desconectado';byId('project').textContent=state.project;byId('version').textContent='Versión '+state.revision;byId('plan').textContent=state.content||'Esperando el plan…';byId('activity').textContent=state.result||state.activity;byId('approve').disabled=busy||!connected||state.status!=='review';byId('revise').disabled=busy||!connected||!idle||!hasPlan;byId('new').disabled=busy||!connected||!idle;byId('discard').disabled=busy||!connected||!idle||!hasPlan;}
async function action(action,feedback=''){if(!state||busy)return;busy=true;render();byId('error').textContent='';try{const response=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json','X-Plan-Token':token},body:JSON.stringify({action,revision:state.revision,feedback})});const result=await response.json();if(!response.ok)throw Error(result.error);}catch(error){byId('error').textContent=error.message;}finally{busy=false;render();}}
byId('approve').onclick=()=>action('approve');byId('revise').onclick=()=>{const feedback=prompt('Observaciones para el planner');if(feedback?.trim())action('revise',feedback.trim());};byId('new').onclick=()=>{const task=prompt('Describe la nueva tarea');if(task?.trim())action('new',task.trim());};byId('discard').onclick=()=>{if(confirm('¿Descartar el plan actual?'))action('discard');};
const events=new EventSource('/events?token='+encodeURIComponent(token));
events.onmessage=event=>{connected=true;state=JSON.parse(event.data);render();};
events.onerror=()=>{connected=false;render();byId('error').textContent='Conexión perdida. Si reiniciaste Pi, abre la página otra vez con /plan.';};
events.onopen=()=>{connected=true;byId('error').textContent='';render();};
</script></body></html>`;
