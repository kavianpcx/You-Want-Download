'use strict';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const preview = params.has('preview');
const backend = window.go?.main?.App || null;
const statuses = { downloading:'Downloading', queued:'Queued', paused:'Paused', completed:'Completed', error:'Failed' };
let state = { items: [], settings:{ concurrency:3,segments:4,downloadDirectory:'C:\\Downloads',programsDirectory:'C:\\Downloads\\Installers',separatePrograms:false,networkMode:'system',interfaces:[],proxyUrl:'',retries:2,autoPaste:true }, version:'0.3.0' };
let view = 'all', query = '', selected = null, pending = false;
let adapters = [], settingsTab = 'general';
const samples = [
 {id:'demo-1',fileName:'Design-assets.zip',url:'https://example.com/design-assets.zip',status:'downloading',total:912680550,downloaded:593240200,speed:6453451,connections:8,directory:'C:\\Downloads',target:'C:\\Downloads\\Design-assets.zip',parts:[{start:0,end:100}]},
 {id:'demo-2',fileName:'Project-backup.tar',url:'https://example.com/backup.tar',status:'paused',total:3589323450,downloaded:1150744369,speed:0,connections:4,directory:'C:\\Downloads',target:'C:\\Downloads\\Project-backup.tar',parts:[{start:0,end:100}]},
 {id:'demo-3',fileName:'App-setup.exe',url:'https://example.com/setup.exe',status:'completed',total:56258100,downloaded:56258100,speed:0,connections:4,directory:'C:\\Downloads',target:'C:\\Downloads\\App-setup.exe',parts:[]},
 {id:'demo-4',fileName:'Archive-2026.7z',url:'https://example.com/archive.7z',status:'queued',total:null,downloaded:0,speed:0,connections:16,directory:'C:\\Downloads',target:'C:\\Downloads\\Archive-2026.7z',parts:[]}
];
const mock = {
 State:async()=>state,
 Add:async x=>{const id='demo-'+Date.now();state.items.unshift({id,fileName:x.fileName || decodeURIComponent(new URL(x.url).pathname.split('/').at(-1)) || 'download',url:x.url,status:'queued',total:null,downloaded:0,speed:0,connections:x.connections||state.settings.segments,directory:x.directory||'Downloads',target:'Downloads',parts:[]});refresh();return id},
 Pause:async id=>{state.items.find(i=>i.id===id).status='paused';refresh()},
 Resume:async id=>{state.items.find(i=>i.id===id).status='queued';refresh()},
 Remove:async id=>{state.items=state.items.filter(i=>i.id!==id);refresh()},
 UpdateSettings:async s=>{state.settings=s;refresh()},
 SetConnections:async(id,c)=>{state.items.find(i=>i.id===id).connections=c;refresh()},
 ChooseDirectory:async()=> 'C:\\Selected Downloads', Clipboard:async()=>'https://example.com/from-clipboard.zip', ShowFile:async()=>{},
 NetworkInterfaces:async()=>[{id:'Wi-Fi',label:'Wi-Fi · 192.168.1.100',address:'192.168.1.100',index:5},{id:'Ethernet',label:'Ethernet · 192.168.2.120',address:'192.168.2.120',index:10}],
 PauseAll:async()=>{state.items.filter(i=>['queued','downloading'].includes(i.status)).forEach(i=>i.status='paused');refresh()},
 ResumeAll:async()=>{state.items.filter(i=>i.status==='paused').forEach(i=>i.status='queued');refresh()},
 ClearCompleted:async()=>{state.items=state.items.filter(i=>i.status!=='completed');refresh()}, OpenDownloadDirectory:async()=>{},
 CheckUpdate:async()=>({status:'current',message:'Preview only. Update checks require the installed application.',version:'0.3.0'}),OpenReleases:async()=>{},OpenRepository:async()=>{}
};
const api = preview ? mock : backend;
function el(tag, cls='', txt='') {const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined&&txt!==null)e.textContent=txt;return e}
function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('aria-hidden','true');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#i-'+name);svg.append(use);return svg}
function formatSize(n){if(n===null||n===undefined||!Number.isFinite(n))return '—';if(n<1024)return `${n} B`;let index=0;const units=['B','KB','MB','GB','TB'];while(n>=1024&&index<4){n/=1024;index++};return `${n.toFixed(n>=10?1:2)} ${units[index]}`}
function formatSpeed(n){return `${formatSize(Math.max(0,n||0))}/s`}
function percent(i){return i.status==='completed'?100:i.total>0?Math.min(100,Math.round(100*i.downloaded/i.total)):0}
function report(msg){const div=$('toast');div.textContent=String(msg);div.hidden=false;clearTimeout(report.timer);report.timer=setTimeout(()=>div.hidden=true,4600)}
async function task(method,...args){if(!api||!api[method]){report('This action is available in the installed Windows app.');return undefined};try{const result=await api[method](...args);return result===undefined?null:result}catch(e){report(e?.message||e);return undefined}}
function isQueued(i){return i.status==='queued'||i.status==='paused'}
function matches(i){const byView=view==='all'||(view==='queued'?isQueued(i):i.status===view);return byView&&(`${i.fileName} ${i.url}`.toLowerCase().includes(query))}
function count(s){return state.items.filter(i=>s==='all'||(s==='queued'?isQueued(i):i.status===s)).length}
function switchView(next){const previous=view;view=next;document.querySelectorAll('.nav-btn[data-view]').forEach(b=>b.classList.toggle('selected',b.dataset.view===view));const labels={all:'All downloads',downloading:'Downloading',queued:'Queue',completed:'Completed',error:'Failed',settings:'Settings',updates:'Updates'};$('page-title').textContent=labels[view]||'Downloads';for(const sec of ['downloads','settings','updates']){const pane=$(sec+'-screen');const active=sec==='downloads'?!['settings','updates'].includes(view):sec===view;pane.hidden=!active;pane.classList.toggle('active-screen',active)}$('search').closest('label').hidden=['settings','updates'].includes(view);if(view==='settings'&&previous!=='settings'){hydrateSettings();loadAdapters()}renderList()}
function renderCounts(){for(const s of ['all','downloading','queued','completed','error'])$('cnt-'+s).textContent=count(s);$('global-speed').textContent='↓ '+formatSpeed(state.items.reduce((n,i)=>n+(i.status==='downloading'?(i.speed||0):0),0));$('summary').textContent=`${state.items.length} download${state.items.length===1?'':'s'} · ${count('downloading')} active · ${count('queued')} queued`}
function row(i){const r=el('div','download-row');r.dataset.id=i.id;r.setAttribute('role','option');r.tabIndex=0;r.setAttribute('aria-selected',String(i.id===selected));if(i.id===selected)r.classList.add('active');r.title=i.url;
 const file=el('div','file-cell'),fileIcon=el('div','file-icon'),fileText=el('div','file-text');fileIcon.append(icon('file'));const name=el('strong','',i.fileName);const host=el('small','');try{host.textContent=new URL(i.url).hostname}catch{host.textContent=i.url}fileText.append(name,host);file.append(fileIcon,fileText);
 const size=el('div','size-cell',formatSize(i.total));const progress=el('div','progress-wrapper'),track=el('div','bar-track'),fill=el('div','bar-fill');fill.style.width=percent(i)+'%';track.append(fill);const detail=el('div','progress-description');detail.append(el('span','',percent(i)+'%'),el('span','',formatSize(i.downloaded||0)));progress.append(track,detail);
 const status=el('div','');const pill=el('span','status-chip '+i.status,statuses[i.status]||i.status);if(i.error)pill.title=i.error;status.append(pill);
 const speed=el('div','speed-cell',i.status==='downloading'?formatSpeed(i.speed):'—');const connections=el('div','connection-cell',`${i.connections||state.settings.segments} ×`);
 r.append(file,size,progress,status,speed,connections);r.addEventListener('click',()=>{selected=i.id;refresh()});r.addEventListener('dblclick',()=>{if(i.status==='completed')task('ShowFile',i.id)});r.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();selected=i.id;refresh()} });return r}
function renderList(){renderCounts();const list=$('download-list');list.replaceChildren();const show=state.items.filter(matches);if(show.length===0){const empty=el('div','empty');empty.append(icon('download'),el('strong','',state.items.length?'No matching downloads':'No downloads yet'),el('span','',state.items.length?'Try a different filter or search.':'Paste a link to get started.'));const btn=el('button','secondary-btn','Add download');btn.addEventListener('click',openAdd);empty.append(btn);list.append(empty)}else{show.forEach(i=>list.append(row(i)))}renderSelected()}
function renderSelected(){const i=state.items.find(t=>t.id===selected),visible=i&&matches(i);$('details').hidden=!visible;$('action-resume').disabled=!i||!['paused','error','queued'].includes(i.status);$('action-pause').disabled=!i||!['queued','downloading'].includes(i.status);$('action-remove').disabled=!i;$('action-folder').disabled=!i||i.status!=='completed';if(!visible)return;
 $('details-title').textContent=i.fileName;$('detail-name').textContent=i.fileName;$('detail-size').textContent=`${formatSize(i.downloaded)} / ${formatSize(i.total)}`;$('detail-path').textContent=i.directory||'—';$('detail-path').title=i.directory||'';$('detail-url').textContent=i.url;$('detail-url').title=i.url;
 const select=$('detail-connections');select.value=String(i.connections||state.settings.segments);const canEdit=!['downloading','completed'].includes(i.status)&&!(i.parts?.length>0)&&!(i.downloaded>0);select.disabled=!canEdit;$('save-connections').disabled=!canEdit;$('detail-info').textContent=canEdit?'Choose 1–16 connections. The server must support byte ranges to use more than one.':'Connections are locked after a transfer begins. To change them, add the URL again with a new setting.';
}
function refresh(){renderList()}
function hydrateSettings(){
 const s=state.settings;
 $('settings-concurrency').value=String(s.concurrency||3);
 $('settings-segments').value=String(s.segments||4);
 $('settings-retries').value=String(s.retries??2);
 $('settings-download-dir').value=s.downloadDirectory||'';
 $('settings-programs-dir').value=s.programsDirectory||'';
 $('settings-separate-programs').checked=!!s.separatePrograms;
 $('settings-autopaste').checked=s.autoPaste!==false;
 $('settings-network-mode').value=s.networkMode||'system';
 $('settings-proxy').value=s.proxyUrl||'';
 $('network-controls').hidden=$('settings-network-mode').value!=='combine';
 renderAdapters();
}
function showSettingsTab(tab){settingsTab=tab;document.querySelectorAll('[data-settings-tab]').forEach(b=>{b.classList.toggle('selected',b.dataset.settingsTab===tab);b.setAttribute('aria-selected',String(b.dataset.settingsTab===tab))});document.querySelectorAll('[data-setting-group]').forEach(g=>g.hidden=g.dataset.settingGroup!==tab)}
function renderAdapters(){const container=$('network-adapters');container.replaceChildren();if(!adapters.length){container.append(el('span','adapter-empty','No active IPv4 adapters detected. Connect to Wi-Fi, Ethernet or a hotspot, then refresh.'));return}
 const selected=state.settings.interfaces||[];
 for(const a of adapters){const label=el('label','adapter-item'),input=el('input');input.type='checkbox';input.value=a.id;input.checked=selected.includes(a.id);label.append(input,el('span','',a.label));container.append(label)}
}
async function loadAdapters(){const found=await task('NetworkInterfaces');if(Array.isArray(found)){adapters=found;renderAdapters()}}
function validLink(value){try{const u=new URL(value.trim());return ['http:','https:'].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password}catch{return false}}
async function openAdd(forceClipboard=false){
 const dialog=$('add-dialog');if(dialog.open){$('add-url').focus();return}
 $('add-form').reset();$('add-advanced').open=false;$('add-connections').value=String(state.settings.segments||4);
 $('add-defaults-hint').textContent=`Defaults: ${state.settings.segments||4} connections · ${state.settings.downloadDirectory||'Downloads folder'}`;
 dialog.showModal();$('add-url').focus();
 if(forceClipboard||state.settings.autoPaste!==false){const copied=await task('Clipboard');if(dialog.open&&$('add-url').value.trim()===''&&typeof copied==='string'&&validLink(copied)){$('add-url').value=copied.trim();$('add-url').select()}}
}
function closeDialog(){ $('add-dialog').close() }
function bindClicks(){document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));$('new-download').addEventListener('click',()=>openAdd());
 document.querySelectorAll('[data-settings-tab]').forEach(b=>b.addEventListener('click',()=>showSettingsTab(b.dataset.settingsTab)));
 $('settings-network-mode').addEventListener('change',e=>{$('network-controls').hidden=e.target.value!=='combine'});
 $('refresh-adapters').addEventListener('click',loadAdapters);
 $('choose-download-dir').addEventListener('click',async()=>{const folder=await task('ChooseDirectory');if(folder)$('settings-download-dir').value=folder});
 $('choose-programs-dir').addEventListener('click',async()=>{const folder=await task('ChooseDirectory');if(folder)$('settings-programs-dir').value=folder});
 const commands={add:()=>openAdd(),clipboard:()=>openAdd(true),folder:()=>task('OpenDownloadDirectory'),
 'pause-all':()=>task('PauseAll'),'resume-all':()=>task('ResumeAll'),'clear-completed':async()=>{if(confirm('Clear completed downloads from the list? Downloaded files will be kept.'))await task('ClearCompleted')},
 all:()=>switchView('all'),queued:()=>switchView('queued'),completed:()=>switchView('completed'),search:()=>{$('search').focus();$('search').select()},
 settings:()=>switchView('settings'),connection:()=>{switchView('settings');showSettingsTab('connection')},updates:()=>switchView('updates'),repository:()=>task('OpenRepository'),releases:()=>task('OpenReleases')};
 document.querySelectorAll('[data-command]').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.menu[open]').forEach(m=>m.open=false);commands[btn.dataset.command]?.()}));
 document.querySelectorAll('.menu').forEach(m=>m.addEventListener('toggle',()=>{if(m.open)document.querySelectorAll('.menu').forEach(other=>{if(other!==m)other.open=false})}));
 document.addEventListener('pointerdown',e=>{if(!e.target.closest('.app-menu'))document.querySelectorAll('.menu[open]').forEach(m=>m.open=false)});
 $('search').addEventListener('input',e=>{query=e.target.value.toLowerCase().trim();renderList()});$('add-dialog').addEventListener('click',e=>{if(e.target===$('add-dialog'))closeDialog()});document.querySelectorAll('[data-dismiss]').forEach(b=>b.addEventListener('click',closeDialog));
 $('add-form').addEventListener('submit',async e=>{e.preventDefault();if(pending)return;pending=true;const btn=$('add-form').querySelector('[type=submit]');btn.disabled=true;try{const url=$('add-url').value.trim();const when=$('add-schedule').value;const data={url,fileName:$('add-filename').value.trim(),directory:$('add-directory').value.trim(),connections:Number($('add-connections').value),scheduledAt:when?new Date(when).toISOString():''};const id=await task('Add',data);if(id!==undefined){closeDialog();$('add-form').reset();switchView('all');selected=id;if(preview)refresh()}}finally{pending=false;btn.disabled=false}});
 $('browse-directory').addEventListener('click',async()=>{const directory=await task('ChooseDirectory');if(directory)$('add-directory').value=directory});
 $('action-resume').addEventListener('click',()=>selected&&task('Resume',selected).then(refresh));$('action-pause').addEventListener('click',()=>selected&&task('Pause',selected).then(refresh));$('action-folder').addEventListener('click',()=>selected&&task('ShowFile',selected));$('action-remove').addEventListener('click',async()=>{const i=state.items.find(i=>i.id===selected);if(i&&confirm(`Remove "${i.fileName}" from the list?\nDownloaded files will not be deleted.`)){await task('Remove',i.id);selected=null;refresh()}});
 $('close-details').addEventListener('click',()=>{selected=null;refresh()});$('save-connections').addEventListener('click',async()=>{if(!selected)return;const n=Number($('detail-connections').value);const result=await task('SetConnections',selected,n);if(result!==undefined||preview){if(preview)refresh();report('Connections updated')}});
 $('settings-form').addEventListener('submit',async e=>{e.preventDefault();const s={
 concurrency:Number($('settings-concurrency').value),segments:Number($('settings-segments').value),retries:Number($('settings-retries').value),
 downloadDirectory:$('settings-download-dir').value.trim(),programsDirectory:$('settings-programs-dir').value.trim(),separatePrograms:$('settings-separate-programs').checked,
 autoPaste:$('settings-autopaste').checked,networkMode:$('settings-network-mode').value,
 interfaces:[...$('network-adapters').querySelectorAll('input:checked')].map(x=>x.value),proxyUrl:$('settings-proxy').value.trim()
 };const result=await task('UpdateSettings',s);if(result!==undefined){state.settings=s;report('Settings saved and applied to new downloads')}});
 $('check-update').addEventListener('click',async()=>{const button=$('check-update');button.disabled=true;$('update-status').textContent='Checking GitHub Releases…';const info=await task('CheckUpdate');button.disabled=false;if(info){$('update-status').textContent=info.message||'No update information';if(info.status==='available'){$('update-current').textContent='v'+state.version+' · new '+info.version}}});$('visit-release').addEventListener('click',()=>task('OpenReleases'));
 document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();if(!$('add-dialog').open)openAdd()};if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='v'){e.preventDefault();openAdd(true)};if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();switchView('all');$('search').focus()};if(e.key==='Escape'){document.querySelectorAll('.menu[open]').forEach(m=>m.open=false);if(selected&&!$('add-dialog').open){selected=null;refresh()}}});
}
async function startup(){bindClicks();if(preview){state.items=samples.map(i=>({...i}));const tag=el('div','preview-tag','UI PREVIEW · SAMPLE DOWNLOADS');tag.style.cssText='position:fixed;bottom:8px;right:9px;font-size:9px;color:#c6d5ee;background:#27394b;padding:5px 9px;border:1px solid #3a546a;border-radius:4px;pointer-events:none;z-index:10';document.body.append(tag)}else if(api){try{const live=await api.State();state={...state,...live,items:live.items||[]};$('app-version').textContent='v'+live.version;$('update-current').textContent='v'+live.version}catch(e){report('Could not initialize: '+(e.message||e))}if(window.runtime?.EventsOn){window.runtime.EventsOn('downloads:changed',next=>{state.items=next.items||[];state.settings=next.settings||state.settings;refresh()})}}else{report('Open the desktop app for working downloads. This browser view is static.')}
 refresh();hydrateSettings();showSettingsTab('general');switchView('all')}
startup();
