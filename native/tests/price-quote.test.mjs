import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteOrderPrice} from '../price-quote.mjs';

test('compute and both persistent disk rates use milli CNY without omitting zero-compute costs',()=>{
 const q=quoteOrderPrice({payg_price:0,data_disk_info:{data_disk_deal_daily_price:1200},system_disk_info:{deal_daily_price:2400}},{expandDataDiskBytes:1073741824,expandSystemDiskBytes:1073741824});
 assert.deepEqual(q,{currency:'CNY',computeHourly:0,dataDiskDaily:1.2,systemDiskDaily:2.4,storageDaily:3.6,totalHourly:0.15,storagePrepaid:false,storageChargedWhileStopped:true});
});
test('free disks can omit daily rates while unknown prepaid or malformed rates fail closed',()=>{
 assert.equal(quoteOrderPrice({payg_price:1000}).totalHourly,1);
 for(const price of [{payg_price:'1000'},{payg_price:1000,data_disk_info:{}},{payg_price:1000,system_disk_info:{deal_daily_price:null}},{payg_price:1000,prepay_expand_data_disk:'true'}])assert.throws(()=>quoteOrderPrice(price),{code:'QUOTE_UNAVAILABLE'});
 for(const bytes of [-1,1.5,'1000',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>quoteOrderPrice({payg_price:1},{expandDataDiskBytes:bytes}),{code:'QUOTE_UNAVAILABLE'});
});
