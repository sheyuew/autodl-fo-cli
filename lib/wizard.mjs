export async function confirmAndStart(plan,ask,rpc){
  const answer=await ask('确认启动以上任务？yes/no [no]: ');
  if(answer.trim().toLowerCase()!=='yes')return null;
  return rpc({op:'start',id:plan.id,confirmation:plan.confirmation});
}
