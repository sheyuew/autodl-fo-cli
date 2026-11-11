// Runs in the server's AutoDL page. Authentication never leaves this function.
// It reads catalog APIs and fills Fo's existing UI; only "submit" clicks Start.
export async function foPage({op,args={}}){
  let user={},token,loading=false;
  try{user=JSON.parse(localStorage.getItem('user')||'{}');token=localStorage.getItem('token');}
  catch{loading=true;if(op!=='diagnose')throw new Error('AutoDL 页面尚未就绪，请稍后重试');}
  const identity=user.uuid||user.id,account=identity?`${identity}:${user.sub_name||''}`:'';
  const root=document.getElementById('autodl-helper-host')?.shadowRoot;
  if(op==='diagnose')return {origin:location.origin,readyState:document.readyState,loading,authenticated:!!(token&&account),account,subaccount:!!user.sub_name,fo:!!root};
  if(!token||!account)throw new Error('服务器 AutoDL 未登录或登录已过期，请运行 fo login');
  if(!root)throw new Error('Fo 尚未加载或脚本未启用');
  const wait=async(fn,label)=>{const end=Date.now()+30000;while(Date.now()<end){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}throw new Error(`等待超时：${label}`);};
  const btn=(scope,text)=>[...scope.querySelectorAll('button')].find(x=>x.textContent.trim()===text);
  const field=(scope,label)=>[...scope.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')===label);
  const set=(scope,label,value)=>{const x=field(scope,label);if(!x)throw new Error('Fo 表单字段已改变：'+label);x.value=String(value);x.dispatchEvent(new Event('input',{bubbles:true}));x.dispatchEvent(new Event('change',{bubbles:true}));return x;};
  const view=name=>root.querySelector(`.tabs button[data-name="${name}"]`)?.classList.contains('selected')&&[...root.querySelector('.panel').children].find(x=>!x.hidden&&x.tagName==='DIV'&&!x.classList.contains('top'));
  const section=(scope,title)=>[...scope.querySelectorAll('.section')].find(x=>x.querySelector('h3')?.textContent.trim()===title||x.querySelector('h3')?.textContent.trim().endsWith(title));
  const picker=(scope,title)=>[...scope.querySelectorAll('.picker-title')].find(x=>x.textContent===title)?.parentElement;
  const ordered=p=>[...p.querySelectorAll('.ordered span')].map(x=>x.textContent.replace(/^\d+\.\s*/,''));
  const choose=async(p,names)=>{
    if(!p)throw new Error('Fo 选项控件已改变');
    await wait(()=>names.every(n=>btn(p.querySelector('.picks'),n)),names.join(' / '));
    for(const x of [...p.querySelectorAll('.picks button.selected')])x.click();
    for(const n of names){const x=btn(p.querySelector('.picks'),n);if(!x)throw new Error('选项已刷新：'+n);x.click();}
  };
  async function call(path,body){
    if(user.sub_name)path=path.replace('/api/v1/','/api/v1/sub_user/');
    const res=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'include',headers:{Authorization:token,AppVersion:JSON.parse(localStorage.getItem('app_version')||'{}').version||'0.0.0','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw new Error('AutoDL HTTP '+res.status);
    const json=await res.json();if(json.code!=='Success')throw new Error(String(json.msg||json.code||'读取失败').slice(0,200));return json.data;
  }
  async function pages(path,body){let list=[];for(let page=1;page<=100;page++){
    const data=await call(path,{...body,page_index:page,page_size:90});if(!Array.isArray(data?.list))throw new Error('AutoDL 列表结构已改变');
    list.push(...data.list);if(!data.list.length||(data.result_total!=null?list.length>=Number(data.result_total):data.list.length<90))return list;
  }throw new Error('AutoDL 分页异常');}
  function tasks(){return [...root.querySelectorAll('article.card')].map(x=>{
    const text=x.textContent,source=text.match(/原实例优先：([^\s（]+)/)?.[1]||text.match(/实例：([^\s]+)/)?.[1]||null;
    return {name:x.querySelector('strong')?.textContent||'',status:x.querySelector('.status')?.textContent||'',source,text};
  });}
  if(op==='account')return account;
  if(op==='status')return {account,subaccount:!!user.sub_name,fo:true,tasks:tasks(),logs:[...root.querySelectorAll('.log')].slice(0,20).map(x=>x.textContent)};
  if(op==='catalog'){
    const q=args.query;
    if(q==='instances')return (await pages('/api/v1/instance',{status:[],charge_type:[],name:'',sub_name:''})).map(r=>({uuid:r.uuid,name:r.name||r.uuid,gpu:r.snapshot_gpu_alias_name||r.gpu_name,count:Number(r.req_gpu_amount),regionSign:r.region_sign,status:r.status,mode:r.start_mode,expandGb:Math.ceil(Number(r.expand_data_disk_size||0)/(1024**3))}));
    if(q==='regions'){
      const rows=await call('/api/v1/region/list');const grouped=new Map();
      for(const r of rows){if(r.visible!=='all'||r.used_for!=='all')continue;const id=r.data_center||r.region_name;if(!grouped.has(id))grouped.set(id,{id,name:r.region_name,signs:[]});grouped.get(id).signs.push(r.region_sign);}return [...grouped.values()];
    }
    if(q==='gpus'){
      const catalog=await call('/api/v1/machine/gpu_type'),sets=[];
      for(const region of args.regions||[]){const rows=await call('/api/v1/machine/region/gpu_type',{region_sign_list:region.signs});sets.push(new Set(rows.flatMap(row=>Object.keys(row))));}
      return catalog.filter(g=>g.chip_corp!=='cpu'&&sets.length&&(args.common?sets.every(s=>s.has(g.gpu_name)):sets.some(s=>s.has(g.gpu_name)))).map(g=>({name:g.gpu_name,chip_corp:g.chip_corp,cpu_arch:g.cpu_arch}));
    }
    if(q==='drivers'){
      const rows=await pages('/api/v1/user/machine/list',{charge_type:'payg',gpu_type_name:args.gpus,gpu_idle_num:0,region_sign_list:args.regions.flatMap(r=>r.signs),default_order:true,machine_tag_name:[],mount_net_disk:false,cpu_arch:[],chip_corp:[],instance_disk_size_order:'',date_range:'',date_from:'',date_to:'',pay_price_order:'',gpu_idle_type:''});
      return [...new Set(rows.filter(r=>args.gpus.includes(r.gpu_name)&&args.regions.some(x=>x.signs.includes(r.region_sign))).map(r=>String(r.driver_version||'')).filter(v=>/^\d+(\.\d+)*$/.test(v)))].sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
    }
    if(q==='images'){
      const type=args.imageType,body={chip_corp:[args.gpu.chip_corp],cpu_arch:[args.gpu.cpu_arch]};
      const rows=await call(type==='base'?'/api/v1/image/all':'/api/v1/image/private/get',body);const images=[];
      if(type==='base'){
        const walk=(nodes,path=[])=>{for(const n of nodes){const l=n.label_name;if(n.children)walk(n.children,[...path,String(l)]);else if(l&&typeof l==='object'&&l.uuid)images.push({type,uuid:l.uuid,name:[...path,l.v].join(' / '),chip_corp:l.chip_corp||args.gpu.chip_corp,cpu_arch:l.cpu_arch||args.gpu.cpu_arch});}};walk(rows);
      }else for(const i of rows)images.push({type:'private',uuid:i.image_uuid,name:i.name||i.image_uuid,chip_corp:i.chip_corp||args.gpu.chip_corp,cpu_arch:i.cpu_arch||args.gpu.cpu_arch});
      return images;
    }
    throw new Error('不支持的只读查询');
  }
  const p=args.plan,r=p?.resolved;if(!p||account!==r.account)throw new Error('账号与计划不一致');
  const isNew=r.mode==='new',name=isNew?'new':'existing';
  function readForm(){
    const scope=view(name);if(!scope)throw new Error('Fo 当前模式与计划不一致');
    const read=(s,l)=>{const x=field(s,l);if(!x)throw new Error('Fo 字段缺失：'+l);return x.value;};
    const f=r.filters,out={mode:r.mode};
    let target=scope;
    if(!isNew){
      out.mode=read(scope,'开机方式');
      const options=[...scope.querySelectorAll('.instance-option')];
      const rows=args.instanceRows;
      if(!rows||rows.length!==options.length)throw new Error('实例列表已变化');
      // Refuse ambiguous labels instead of guessing which UUID a checkbox represents.
      const keys=rows.map(x=>`${x.name}|${x.gpu}|${x.count}|${x.status}|${x.mode}`);
      if(new Set(keys).size!==keys.length)throw new Error('存在完全相同的实例标签，无法可靠映射 UUID，请使用远程页面');
      options.forEach((o,i)=>{const x=rows[i];if(o.querySelector('strong')?.textContent!==x.name||!o.textContent.includes(x.status)||!o.textContent.includes(`${x.gpu} · ${x.count} 卡`))throw new Error('实例列表顺序或内容已变化');});
      out.instances=rows.filter((x,i)=>options[i].querySelector('input').checked).map(x=>x.uuid);
      if(r.mode==='clone')target=scope.querySelector('.clone-filter-editor');
    }
    if(f){
      out.gpus=ordered(picker(target,isNew?'可选 GPU 型号 · 多选，↑↓调整优先级':'目标 GPU · 多选，↑↓调整优先级'));
      if(isNew)out.regions=ordered(picker(scope,'可选地区 · 多选，↑↓调整地区优先级'));
      out.gpuCount=Number(read(target,isNew?'每个实例 GPU 数量':'克隆 GPU 数量'));
      out.minMemoryGb=Number(read(target,isNew?'实例最低内存（GB，0 不限制）':'克隆实例最低内存（GB，0 不限制）'));
      out.minExpandGb=Number(read(target,isNew?'主机可扩容容量至少（GB）':'克隆主机可扩容容量至少（GB）'));
      out.expandGb=Number(read(target,isNew?'实际额外扩容（GB，0 使用基础盘）':'克隆实际额外扩容（GB）'));
      const mode=read(target,isNew?'显卡驱动筛选':'克隆显卡驱动筛选');
      out.driver={mode,value:mode==='minimum'?read(target,isNew?'最低驱动版本':'克隆最低驱动版本'):mode==='exact'?[...target.querySelectorAll('.driver-choices label')].filter(x=>x.querySelector('input').checked).map(x=>x.textContent.trim()).join(','):''};
    }
    if(isNew){out.imageType=read(scope,'镜像来源');out.image=read(scope,'使用的镜像');out.name=read(scope,'任务名称');}
    return out;
  }
  function expected(){return {mode:r.mode,...(!isNew?{instances:r.instances.map(x=>x.uuid)}:{}),...(r.filters?{...r.filters,...(isNew?{regions:r.regions.map(x=>x.name)}:{})}:{}),...(isNew?{imageType:r.image.type,image:r.image.uuid,name:`${r.name} [${p.marker}]`}:{})};}
  function assertForm(){const a=readForm(),b=expected();for(const key of Object.keys(b)){
    if(JSON.stringify(a[key])!==JSON.stringify(b[key]))throw new Error('Fo 配置核对失败：'+key);
  }return true;}
  if(op==='stage'){
    root.querySelector('.panel').hidden=false;root.querySelector(`.tabs button[data-name="${name}"]`).click();
    const scope=await wait(()=>view(name),'Fo 模式');
    if(!isNew){
      await wait(()=>scope.querySelectorAll('.instance-option').length===args.instanceRows.length,'实例列表');
      // Allow Fo's asynchronously refreshed list to settle and verify before selection.
      await wait(()=>[...scope.querySelectorAll('.instance-option')].every((o,i)=>o.querySelector('strong')?.textContent===args.instanceRows[i].name),'实例标签');
      const options=[...scope.querySelectorAll('.instance-option')];
      for(let i=0;i<options.length;i++){const cb=options[i].querySelector('input');const selected=r.instances.some(x=>x.uuid===args.instanceRows[i].uuid);if(cb.checked!==selected)cb.click();}
      set(scope,'开机方式',r.mode);
    }
    if(r.filters){
      const f=r.filters,target=isNew?scope:scope.querySelector('.clone-filter-editor');
      if(isNew)await choose(picker(scope,'可选地区 · 多选，↑↓调整地区优先级'),r.regions.map(x=>x.name));
      await choose(picker(target,isNew?'可选 GPU 型号 · 多选，↑↓调整优先级':'目标 GPU · 多选，↑↓调整优先级'),f.gpus);
      set(target,isNew?'每个实例 GPU 数量':'克隆 GPU 数量',f.gpuCount);
      set(target,isNew?'实例最低内存（GB，0 不限制）':'克隆实例最低内存（GB，0 不限制）',f.minMemoryGb);
      set(target,isNew?'主机可扩容容量至少（GB）':'克隆主机可扩容容量至少（GB）',f.minExpandGb);
      set(target,isNew?'实际额外扩容（GB，0 使用基础盘）':'克隆实际额外扩容（GB）',f.expandGb);
      set(target,isNew?'显卡驱动筛选':'克隆显卡驱动筛选',f.driver.mode);
      if(f.driver.mode==='minimum'){
        const label=isNew?'最低驱动版本':'克隆最低驱动版本';
        await wait(()=>[...field(target,label).options].some(x=>x.value===f.driver.value),'驱动版本');set(target,label,f.driver.value);
      }else if(f.driver.mode==='exact'){
        const versions=f.driver.value.split(',');await wait(()=>versions.every(v=>[...target.querySelectorAll('.driver-choices label')].some(x=>x.textContent.trim()===v)),'指定驱动');
        for(const x of target.querySelectorAll('.driver-choices label')){const cb=x.querySelector('input'),on=versions.includes(x.textContent.trim());if(cb.checked!==on)cb.click();}
      }
      if(isNew){
        set(scope,'镜像来源',r.image.type);await wait(()=>[...field(scope,'使用的镜像').options].some(x=>x.value===r.image.uuid),'镜像列表');
        set(scope,'使用的镜像',r.image.uuid);set(scope,'任务名称',`${r.name} [${p.marker}]`);
      }
    }
    assertForm();return {verified:true};
  }
  if(op==='submit'){
    assertForm();const scope=view(name),button=btn(scope,isNew?'添加并启动新实例任务':'启动所选实例抢卡');
    if(!button||button.disabled)throw new Error('Fo 启动按钮不可用');
    button.click();return {clicked:true};
  }
  throw new Error('不支持的操作');
}
