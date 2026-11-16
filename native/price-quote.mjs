const fail=()=>Object.assign(new Error('未取得完整的按量计算与存储报价，请刷新后重新确认'),{code:'QUOTE_UNAVAILABLE'});
const money=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const rounded=value=>Math.round(value*1e6)/1e6;
function diskPrice(info,key,bytes){
 if(info===undefined&&bytes===0)return 0;
 const value=info?.[key];if(!money(value))throw fail();return value/1000;
}
/** AutoDL prices are milli-CNY; compute is hourly and persistent disks are daily. */
export function quoteOrderPrice(price,{expandDataDiskBytes=0,expandSystemDiskBytes=0}={}){
 if(![expandDataDiskBytes,expandSystemDiskBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||!money(price?.payg_price)||(price.prepay_expand_data_disk!==undefined&&price.prepay_expand_data_disk!==false))throw fail();
 const computeHourly=price.payg_price/1000;
 const dataDiskDaily=diskPrice(price.data_disk_info,'data_disk_deal_daily_price',expandDataDiskBytes);
 const systemDiskDaily=diskPrice(price.system_disk_info,'deal_daily_price',expandSystemDiskBytes);
 const storageDaily=rounded(dataDiskDaily+systemDiskDaily);
 return {currency:'CNY',computeHourly,dataDiskDaily,systemDiskDaily,storageDaily,totalHourly:rounded(computeHourly+storageDaily/24),storagePrepaid:false,storageChargedWhileStopped:true};
}
