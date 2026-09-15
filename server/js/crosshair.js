
'use strict';

window.XenonCrosshair = (() => {
  const model = window.XenonCrosshairModel;
  const dialog = document.getElementById('crosshair-dialog');
  const root = document.getElementById('xenon-crosshair-studio');
  const q = s => root.querySelector(s);
  const qa = s => [...root.querySelectorAll(s)];
  let state = null, draft = { ...model.defaults }, sending = false, queued = null, editing = false;
  let toggling = false;
  let revision = 0, timer, statusRequest, error = '', uploading = false, uploadSequence = 0;
  let selected = 'custom', scene = 'dark', saved = [];
  const profiles = {
    classic: { ...model.defaults, color: '#FFFFFF', length: 6, gap: 3 },
    dot: { ...model.defaults, shape: 'dot', thickness: 3, color: '#FFE66D' },
    ring: { ...model.defaults, shape: 'ring', length: 7, centerDot: true, color: '#4BCCFF' }
  };
  const imageUrl = asset => SERVER + '/api/crosshair/assets?id=' + encodeURIComponent(asset);
  const ready = () => state?.online && state.visible && state.protocol >= 2;
  const validDraft = () => draft.mode !== 'image' || !!draft.asset;

  async function request(path, body, method = 'POST') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const binary = body instanceof Blob;
      const response = await fetch(SERVER + path, {
        ...(body !== undefined ? { method, headers: { 'Content-Type': binary ? body.type : 'application/json' }, body: binary ? body : JSON.stringify(body) } : {}),
        signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Crosshair request failed.');
      return result;
    } finally { clearTimeout(timeout); }
  }

  function paint(canvas, style, scale = 3, visible = true) {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
    const ctx = canvas.getContext('2d'); ctx.scale(ratio,ratio);
    if (!visible) return;
    ctx.translate(Math.round(box.width/2),Math.round(box.height/2)+(scale===3?5:0)); ctx.scale(scale,scale);
    const length=style.length, thickness=style.thickness, gap=style.gap, border=style.outline?1:0;
    function rect(x,y,w,h) {
      if(border){ctx.fillStyle='#000';ctx.fillRect(x-border,y-border,w+2*border,h+2*border);}
      ctx.fillStyle=style.color;ctx.fillRect(x,y,w,h);
    }
    function dot(radius) {
      if(border){ctx.beginPath();ctx.arc(0,0,radius+border,0,Math.PI*2);ctx.fillStyle='#000';ctx.fill();}
      ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.fillStyle=style.color;ctx.fill();
    }
    if(style.shape==='dot')dot(thickness/2+.5);
    else if(style.shape==='ring'){
      ctx.beginPath();ctx.arc(0,0,length,0,Math.PI*2);
      if(border){ctx.lineWidth=thickness+2;ctx.strokeStyle='#000';ctx.stroke();}
      ctx.lineWidth=thickness;ctx.strokeStyle=style.color;ctx.stroke();
    } else {
      rect(-gap-length,-thickness/2,length,thickness);rect(gap,-thickness/2,length,thickness);
      rect(-thickness/2,gap,thickness,length);
      if(style.shape!=='t')rect(-thickness/2,-gap-length,thickness,length);
    }
    if(style.centerDot&&style.shape!=='dot')dot(Math.max(1,thickness/2));
  }
  function draw() {
    if (!dialog.open) return;
    paint(q('[data-main-canvas]'),draft,3,draft.mode==='draw');
    qa('[data-mini]').forEach(c=>paint(c,{...draft,shape:c.dataset.mini,color:c.dataset.mini===draft.shape?'#4BC7FA':'#a0b2be',length:5,gap:2,thickness:1.5,outline:false,centerDot:false},1));
    const img=q('[data-main-image]');
    img.hidden=draft.mode!=='image'||!draft.asset;
    if(!img.hidden){
      const url=imageUrl(draft.asset);
      if(img.getAttribute('src')!==url)img.src=url;
      img.style.width=draft.imageSize+'px';img.style.height=draft.imageSize+'px';
    }
  }
  function render() {
    const on=!!(state?.online&&state.visible&&state.enabled);
    document.querySelectorAll('[data-crosshair-toggle]').forEach(b=>{
      b.textContent='Crosshair '+(on?'ON':'OFF');b.setAttribute('aria-pressed',String(on));b.disabled=sending||toggling||!!queued;b.classList.toggle('active',on);
    });
    document.querySelectorAll('[data-crosshair-rail]').forEach(b=>{
      b.dataset.enabled=String(on);b.setAttribute('aria-expanded',String(dialog.open));b.hidden=state?.supported===false;
    });
    if(!dialog.open)return;
    q('[data-power]').setAttribute('aria-pressed',String(on));q('[data-power]').disabled=sending||toggling||!!queued||!ready();
    q('[data-power-label]').textContent=sending||toggling?'กำลังซิงก์':on?'เปิดอยู่':'ปิดอยู่';
    q('[data-connection]').textContent=!state?.installed?'ยังไม่ได้ติดตั้ง Xenon Crosshair':state.protocol<2?'อัปเดต Xenon Crosshair ก่อนใช้งาน':!state.online||!state.visible?'เปิด Xenon Crosshair ใน Win + G':'Game Bar เชื่อมต่อแล้ว';
    q('[data-connection]').style.color=ready()?'#8fe0bd':'#efc384';
    q('.xc-check').textContent=state?.pinned?(state.clickThrough?'ปักหมุด · Click-through':'เปิด Click-through ใน Game Bar'):'ปักหมุดใน Game Bar';
    q('.xc-check').hidden=!ready();q('[data-offline]').hidden=ready();
    q('[data-sync]').textContent=error|| (sending?'กำลังส่งไป Game Bar…':!validDraft()?'เลือกรูปเพื่อใช้เป้าแบบนี้':queued?!ready()?'รอ Game Bar เชื่อมต่อ':'รอส่งการปรับแต่ง':editing?'ยังไม่ได้ซิงก์การปรับแต่ง':ready()?'ซิงก์กับ Game Bar แล้ว':'Game Bar ไม่ได้เชื่อมต่อ');
    q('[data-sync]').style.color=error?'#ffacb7':'';
    q('[data-retry]').hidden=!error||!validDraft()||!ready();q('[data-retry]').disabled=sending;
    q('[data-center]').disabled=!ready()||sending;
    q('[data-preview]').dataset.mode=draft.mode;q('[data-preview]').dataset.scene=scene;
    q('[data-preview-scale]').textContent=draft.mode==='image'?'พรีวิว · 1×':'พรีวิว · 3×';
    q('[data-preview-state]').textContent=!validDraft()?'ยังไม่ได้เลือกรูป':editing||queued||sending?'ตัวอย่างการปรับแต่ง':on?'แสดงเป้าบนจอเกม':'ปิดบนจอเกม · พรีวิวเท่านั้น';
    q('[data-preview-name]').textContent=(saved.find(p=>p.id===selected)?.name||({custom:'Current',classic:'Classic',dot:'Dot',ring:'Ring'}[selected]||'Current'))+(editing?' · ปรับแต่งแล้ว':'');
    qa('button[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===draft.mode)));
    q('[data-media-controls]').hidden=draft.mode!=='image';q('[data-draw-controls]').hidden=draft.mode!=='draw';
    q('[data-image-layer]').hidden=draft.mode!=='image';q('[data-image-empty]').hidden=!!draft.asset;
    q('[data-file-row]').hidden=!draft.asset;q('[data-upload]').hidden=!!draft.asset;
    q('[data-upload-label]').textContent=uploading?'กำลังอ่านไฟล์…':'เลือกรูป หรือวางไฟล์ที่นี่';
    q('[data-file-name]').textContent=draft.assetName||'Custom image';
    q('[data-file-meta]').textContent=uploading?'กำลังอัปโหลด…':draft.asset?.endsWith('.gif')?'GIF · เล่นภาพเคลื่อนไหวตามไฟล์':'รูปภาพ · คงสัดส่วนเดิม';
    q('[data-save-open]').disabled=!validDraft()||uploading;q('[data-save-confirm]').disabled=!validDraft()||uploading;
    q('[data-delete-preset]').hidden=!saved.some(p=>p.id===selected);
    qa('[data-shape]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.shape===draft.shape)));
    qa('[data-color]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.color===draft.color)));
    q('[data-color-input]').value=draft.color;
    if(document.activeElement!==q('[data-hex]'))q('[data-hex]').value=draft.color;
    qa('[data-setting]').forEach(input=>{
      const key=input.dataset.setting;
      if(input.type==='checkbox')input.checked=draft[key];
      else{input.value=draft[key];q('[data-value="'+key+'"]').textContent=draft[key]+' px';}
    });
    q('[data-setting="gap"]').disabled=!['cross','t'].includes(draft.shape);
    q('[data-setting="length"]').disabled=draft.shape==='dot';
    q('[data-setting="centerDot"]').disabled=draft.shape==='dot';
    q('[data-setting="imageSize"]').disabled=!draft.asset;
    q('[data-length-label]').textContent=draft.shape==='ring'?'รัศมี':'ความยาว';
    qa('button[data-scene]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scene===scene)));
    draw();
  }
  async function refresh() {
    if(sending)return;
    if(statusRequest)return statusRequest;
    const before=revision;
    statusRequest=request('/api/crosshair').then(result=>{
      if(sending)return;
      state=result;
      if(before===revision&&!editing&&!queued)draft=model.settings(result);
      render();
      if(queued&&ready())flush();
    }).catch(e=>{state=null;error=e.message;render();}).finally(()=>{statusRequest=null;});
    return statusRequest;
  }
  async function flush() {
    clearTimeout(timer);
    if(sending||!queued||!ready()){render();return;}
    const patch=queued, before=revision;queued=null;sending=true;error='';render();
    try{
      state=await request('/api/crosshair',patch);
      if(before===revision&&!queued&&(Object.keys(patch).some(k=>model.keys.includes(k))||!editing)){draft=model.settings(state);editing=false;}
    }catch(e){
      error=e.name==='AbortError'?'Game Bar ไม่ตอบกลับ เปิด Win + G แล้วลองใหม่':e.message;
      state=await request('/api/crosshair').catch(()=>null);
    }finally{sending=false;render();if(queued)timer=setTimeout(flush,100);}
  }
  function change(patch) {
    try { Object.assign(draft,model.validatePatch(patch)); }
    catch(e){error=e.message;render();return;}
    revision++;editing=true;error='';
    if(validDraft()){queued={...queued,...model.settings(draft)};clearTimeout(timer);timer=setTimeout(flush,180);}
    else{queued=null;clearTimeout(timer);}
    render();
  }
  async function apply(patch) {
    try{
      const validated=model.validatePatch(patch);
      if(Object.keys(validated).some(k=>model.keys.includes(k)))change(validated);
      else{queued={...queued,...validated};revision++;await flush();}
    }catch(e){error=e.message;render();}
  }
  async function toggle() {
    if(sending||toggling||queued)return;
    toggling=true;render();
    try {
      await refresh();
      if(!ready()){await open();return;}
      await apply({enabled:!state.enabled});
    } finally { toggling=false;render(); }
  }
  async function loadPresets() {
    if(!state?.installed)return;
    try{
      saved=await request('/api/crosshair/presets');
      q('[data-profile]').querySelectorAll('[data-saved]').forEach(el=>el.remove());
      for(const row of saved){const option=document.createElement('option');option.value=row.id;option.textContent=row.name;option.dataset.saved='';q('[data-profile]').append(option);}
      q('[data-profile]').value=selected;
    }catch(e){error=e.message;}
    render();
  }
  async function open() { if(!dialog.open)dialog.show();render();await refresh();await loadPresets(); }
  function close() { dialog.close();render();document.querySelector('[data-crosshair-rail]')?.focus(); }
  async function openGameBar() { try{await request('/api/crosshair/open',{});}catch(e){error=e.message;render();} }
  function cancelUpload() { uploadSequence++;uploading=false;q('[data-file-error]').hidden=true; }
  async function upload(file) {
    if(!file)return;
    const sequence=++uploadSequence;
    const fileError=text=>{q('[data-file-error]').textContent=text;q('[data-file-error]').hidden=!text;};
    fileError('');
    if(!['image/png','image/gif','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024){fileError('เลือก PNG, GIF, WebP หรือ JPG ไม่เกิน 5 MB');return;}
    uploading=true;render();
    const url=URL.createObjectURL(file);
    try{
      const img=new Image();
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('เปิดรูปนี้ไม่ได้ ลองเลือกไฟล์อื่น'));img.src=url;});
      if(img.naturalWidth>2048||img.naturalHeight>2048)throw new Error('ใช้รูปขนาดไม่เกิน 2048 × 2048 px');
      let body=file,name=file.name;
      // Windows' optional WebP codec is not required: import its still image as PNG.
      if(file.type==='image/webp'){
        const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;canvas.getContext('2d').drawImage(img,0,0);
        body=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));name=name.replace(/\.webp$/i,'')+'.png';
        if(!body||body.size>5*1024*1024)throw new Error('รูปหลังแปลงเป็น PNG ใหญ่เกิน 5 MB');
      }
      if(sequence!==uploadSequence)return;
      const result=await request('/api/crosshair/assets?name='+encodeURIComponent(name),body);
      if(sequence!==uploadSequence)return;
      change({mode:'image',asset:result.asset,assetName:result.assetName});
    }catch(e){if(sequence===uploadSequence)fileError(e.message);}
    finally{URL.revokeObjectURL(url);if(sequence===uploadSequence){uploading=false;render();}}
  }
  q('[data-power]').addEventListener('click',toggle);
  q('[data-close]').addEventListener('click',close);
  q('[data-center]').addEventListener('click',()=>apply({center:true}));
  q('[data-reconnect]').addEventListener('click',openGameBar);
  q('[data-retry]').addEventListener('click',()=>change(model.settings(draft)));
  qa('button[data-mode]').forEach(b=>b.addEventListener('click',()=>{cancelUpload();change({mode:b.dataset.mode});}));
  qa('[data-shape]').forEach(b=>b.addEventListener('click',()=>change({shape:b.dataset.shape})));
  qa('[data-color]').forEach(b=>b.addEventListener('click',()=>change({color:b.dataset.color})));
  q('[data-color-input]').addEventListener('input',e=>change({color:e.target.value}));
  q('[data-hex]').addEventListener('change',e=>{if(/^#[a-f0-9]{6}$/i.test(e.target.value)){e.target.setCustomValidity('');change({color:e.target.value});}else{e.target.setCustomValidity('ใช้รหัสสี เช่น #65F5BA');e.target.reportValidity();}});
  qa('[data-setting]').forEach(el=>el.addEventListener('input',()=>change({[el.dataset.setting]:el.type==='checkbox'?el.checked:Number(el.value)})));
  qa('button[data-scene]').forEach(b=>b.addEventListener('click',()=>{scene=b.dataset.scene;render();}));
  for(const selector of ['[data-upload]','[data-replace]'])q(selector).addEventListener('click',()=>q('[data-file]').click());
  q('[data-file]').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';upload(file);});
  q('[data-remove]').addEventListener('click',()=>{cancelUpload();change({mode:'draw',asset:null,assetName:''});});
  q('[data-media-controls]').addEventListener('dragover',e=>{e.preventDefault();e.currentTarget.dataset.dragging='true';});
  q('[data-media-controls]').addEventListener('dragleave',e=>{e.currentTarget.dataset.dragging='false';});
  q('[data-media-controls]').addEventListener('drop',e=>{e.preventDefault();e.currentTarget.dataset.dragging='false';upload(e.dataTransfer.files[0]);});
  q('[data-profile]').addEventListener('change',e=>{
    cancelUpload();selected=e.target.value;
    const next=profiles[selected]||saved.find(p=>p.id===selected)?.settings||(state?model.settings(state):model.defaults);
    change(next);
  });
  q('[data-save-open]').addEventListener('click',()=>{q('[data-save-form]').hidden=false;q('[data-preset-name]').focus();});
  q('[data-save-cancel]').addEventListener('click',()=>{q('[data-save-form]').hidden=true;});
  let saving=false;
  q('[data-save-confirm]').addEventListener('click',async()=>{
    const name=q('[data-preset-name]').value.trim();if(!name||saving)return;
    saving=true;
    try{
      const row=await request('/api/crosshair/presets',{name,settings:model.drawable(draft)});
      selected=row.id;q('[data-save-form]').hidden=true;q('[data-preset-name]').value='';await loadPresets();
    }catch(e){error=e.message;render();}
    finally{saving=false;}
  });
  q('[data-preset-name]').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();q('[data-save-confirm]').click();}});
  q('[data-delete-preset]').addEventListener('click',async()=>{
    try{await request('/api/crosshair/presets',{id:selected},'DELETE');selected='custom';await loadPresets();}
    catch(e){error=e.message;render();}
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&dialog.open){e.preventDefault();close();}});
  const visible=()=>!document.hidden&&(dialog.open||[...document.querySelectorAll('[data-crosshair-rail],[data-crosshair-toggle]')].some(el=>el.getClientRects().length));
  document.addEventListener('visibilitychange',()=>{if(visible())refresh();});
  setInterval(()=>{if(visible())refresh();},2000);
  new ResizeObserver(draw).observe(root);
  refresh();
  return { open, close, toggle, apply, openGameBar, togglePanel:()=>dialog.open?close():open() };
})();
