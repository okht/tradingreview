import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableIntervals, selectChartData } from '../src/market-data.js';
const trades = [{id:'t1',symbol:'600519',time:'2025-09-02T10:00',side:'buy'},{id:'t2',symbol:'600519',time:'2025-09-03T14:00',side:'sell'}];
const marketData = {status:'ok',symbol:'600519.SH',tradeSymbol:'600519',interval:'1D',currency:'CNY',timeZone:'Asia/Shanghai',adjust:'none',bars:[
  {time:'2025-09-01',open:10,high:12,low:9,close:11,closedAt:'2025-09-02T00:00:00+08:00'},
  {time:'2025-09-02',open:11,high:14,low:10,close:13,closedAt:'2025-09-03T00:00:00+08:00'},
  {time:'2025-09-03',open:13,high:15,low:12,close:14,closedAt:'2025-09-04T00:00:00+08:00'},
]};
test('real daily source enables only derivable periods and exact instrument',()=>{
  assert.deepEqual(getAvailableIntervals({mode:'import',trades,marketData}),['1D','1W','1M']);
  assert.deepEqual(getAvailableIntervals({mode:'import',trades:[{...trades[0],symbol:'000001'}],marketData}),[]);
  assert.deepEqual(selectChartData({mode:'import',trades,marketData,interval:'4H'}),{candles:[],markers:[]});
});
test('daily-only real source explicitly leaves current OHLC unknown instead of turning a final bar into an intraday snapshot',()=>{
  const result=selectChartData({mode:'import',trades,marketData,cutoff:trades[0].time,showFuture:false,interval:'1W'});
  assert.equal(result.candles.length,1); assert.equal(result.candles[0].high,12); assert.equal(result.candles[0].sourceTo,'2025-09-01');
  assert.deepEqual(result.markers,[]);
  assert.deepEqual(result.currentBar,{time:'2025-09-01',asOf:'2025-09-02T10:00:00+08:00',status:'unknown',ohlc:null,reason:'daily-only-no-intraday'});
  const daily=selectChartData({mode:'import',trades,marketData,cutoff:trades[0].time,showFuture:false});
  assert.equal(daily.currentBar.time,'2025-09-02'); assert.equal(daily.currentBar.ohlc,null);
  assert.ok(daily.candles.every(bar=>bar.time<'2025-09-02'));
  assert.equal(selectChartData({mode:'import',trades,marketData,showFuture:true}).markers.length,2);
});

test('changing later real daily values cannot affect the earlier decision view or fill the unknown current snapshot',()=>{
  const options={mode:'import',trades,cutoff:trades[0].time,showFuture:false,interval:'1M'};
  const changed={...marketData,bars:marketData.bars.map(bar=>bar.time>='2025-09-02'?{...bar,open:99,high:120,low:80,close:110}:bar)};
  assert.deepEqual(selectChartData({...options,marketData:changed}),selectChartData({...options,marketData}));
  assert.equal(selectChartData({...options,marketData}).currentBar.ohlc,null);
});
test('invalid OHLC, unknown closedAt and invalid cutoff never become visible historical bars',()=>{
  const invalid={...marketData,bars:[{...marketData.bars[0],high:8},{...marketData.bars[1],closedAt:'unknown'}]};
  assert.deepEqual(selectChartData({mode:'import',trades,marketData:invalid}),{candles:[],markers:[]});
  assert.deepEqual(selectChartData({mode:'import',trades,marketData,cutoff:'bad',showFuture:false}),{candles:[],markers:[]});
});
