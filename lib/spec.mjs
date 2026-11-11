const modes=new Set(['existing','clone','new']);
const pick=(items,key,value,label)=>{const row=items.find(x=>x[key]===value);if(!row)throw new Error(`${label}不可用或已改变：${value}`);return row;};
function ordered(values,label){if(!Array.isArray(values)||!values.length||new Set(values).size!==values.length||values.some(x=>typeof x!=='string'||!x.trim()))throw new Error(`${label}必须非空且不重复`);return values;}
export function resolveSpec(raw,c){
  const s=structuredClone(raw);
  if(!modes.has(s.mode))throw new Error('请选择有效模式');
  const p={account:c.account,mode:s.mode,name:s.name?.trim()||'命令行任务',instances:[],regions:[],filters:null,image:null,spec:s};
  if(s.mode!=='new'){
    p.instances=ordered(s.instances,'实例').map(id=>pick(c.instances,'uuid',id,'实例'));
    p.beforeCounts=Object.fromEntries(p.instances.map(x=>[x.uuid,(c.tasks||[]).filter(t=>t.source===x.uuid).length]));
    if(p.instances.some(x=>c.activeSources.includes(x.uuid)))throw new Error('所选实例已有运行中的 Fo 任务，请先在任务列表核对');
    if(s.mode==='existing')return p;
    p.regions=[...new Set(p.instances.map(x=>x.region))].map(id=>pick(c.regions,'id',id,'源实例地区'));
  }else p.regions=ordered(s.regions,'地区').map(id=>pick(c.regions,'id',id,'地区'));
  const gpus=ordered(s.gpus,'GPU').map(name=>pick(c.gpus,'name',name,'GPU'));
  if(!Number.isInteger(s.gpuCount)||s.gpuCount<1)throw new Error('GPU 数量必须为正整数');
  for(const k of ['minExpandGb','expandGb'])if(!Number.isInteger(s[k])||s[k]<0)throw new Error('磁盘容量必须为非负整数');
  if(!Number.isFinite(s.minMemoryGb)||s.minMemoryGb<0)throw new Error('最低内存必须为非负数');
  const d=s.driver;
  if(!d||!['any','minimum','exact'].includes(d.mode))throw new Error('驱动模式不正确');
  if(d.mode!=='any'){
    const versions=String(d.value).split(',');
    if(!versions.length||versions.some(v=>!c.drivers.includes(v)))throw new Error('所选驱动版本不可用');
    if(d.mode==='minimum'&&versions.length!==1)throw new Error('最低驱动只能选择一个版本');
  }
  p.filters={gpus:gpus.map(g=>g.name),gpuCount:s.gpuCount,minMemoryGb:s.minMemoryGb,minExpandGb:s.minExpandGb,expandGb:s.expandGb,driver:{mode:d.mode,value:d.mode==='any'?'':d.value}};
  if(s.mode==='new'){
    p.image=pick(c.images.filter(i=>i.type===s.imageType),'uuid',s.image,'镜像');
    if(gpus.some(g=>g.chip_corp!==p.image.chip_corp||g.cpu_arch!==p.image.cpu_arch))throw new Error('GPU 和镜像架构不兼容');
  }
  return p;
}
export function describePlan(p){
  const r=p.resolved||p,lines=[`模式：${{existing:'原实例开机',clone:'原实例优先，必要时克隆系统盘和数据盘',new:'新建实例'}[r.mode]}`,`账号：${r.account}`];
  if(r.mode==='new')lines.push(`任务名称：${r.name}`);
  for(const x of r.instances)lines.push(`源实例：${x.name} (${x.uuid}) · ${x.gpu} × ${x.count}`);
  if(r.filters){const f=r.filters;
    lines.push(`地区优先级：${r.regions.map(x=>x.name).join(' → ')}`,`GPU 优先级：${f.gpus.join(' → ')} · ${f.gpuCount} 张`,
      `实例总内存至少：${f.minMemoryGb} GB（0 不限制）`,`驱动：${f.driver.mode} ${f.driver.value}`,
      `主机可扩容至少：${f.minExpandGb} GB；实际额外扩容：${f.expandGb} GB`);
  }
  if(r.mode==='clone')lines.push('原实例仍按原卡数和配置优先开机；GPU/内存筛选仅用于克隆备用。','克隆地区及系统盘沿用源实例；复制数据盘所需扩容可能自动增加；保留源实例。');
  if(r.image)lines.push(`镜像：${r.image.type} · ${r.image.name} (${r.image.uuid})`);
  lines.push('计费：按量计费；Fo 0.3.5 没有价格上限。成功开机/创建后按平台实时价格计费。','每个选中的源实例各建立一个任务；新建实例模式仅建立一个任务。');
  return lines.join('\n');
}
