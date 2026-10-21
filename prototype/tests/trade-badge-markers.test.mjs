import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTradeBadgeMarkers } from '../src/trade-badge-markers.js';

function harness(markers, candles) {
  let primitive;
  let detached = 0;
  let offset = 0;
  const prices = [];
  const series = {
    attachPrimitive(value) {
      primitive = value;
      primitive.attached({
        chart: { timeScale: () => ({ timeToCoordinate: time => typeof time === 'number' ? time + offset : 50 + offset }) },
        series,
        requestUpdate() {},
      });
    },
    detachPrimitive(value) { assert.equal(value, primitive); detached++; value.detached(); },
    priceToCoordinate(price) { prices.push(price); return 200 - price; },
  };
  const attachment = attachTradeBadgeMarkers(series, markers, candles);
  function draw(pixelRatio = 1) {
    const text = [];
    const scales = [];
    const connectors = [];
    let path = [];
    const context = {
      save() {}, restore() {}, beginPath() { path = []; }, moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); }, quadraticCurveTo() {}, closePath() {}, fill() {},
      stroke() { connectors.push([...path]); },
      scale(...args) { scales.push(args); },
      measureText(value) { return { width: value.length * 6 }; },
      fillText(value, x, y) { text.push({ value, x, y, color: this.fillStyle, font: this.font }); },
    };
    primitive.updateAllViews();
    primitive.paneViews()[0].renderer().draw({ useBitmapCoordinateSpace: cb => cb({ context, horizontalPixelRatio: pixelRatio, verticalPixelRatio: pixelRatio, bitmapSize: { width: 300 * pixelRatio, height: 250 * pixelRatio } }) });
    return { text, scales, connectors };
  }
  return { primitive, attachment, draw, prices, pan: value => { offset = value; }, detached: () => detached };
}

test('buy and sell badges anchor to the supplied candle extremes, including its unfinished state', () => {
  const h = harness([
    { time: 50, position: 'belowBar', text: 'B×3', color: 'red' },
    { time: 50, position: 'aboveBar', text: 'S', color: 'green' },
    { time: 60, position: 'aboveBar', text: 'S', color: 'green' },
  ], [{ time: 50, high: 110, low: 90, isPartial: true }]);
  const { text } = h.draw();
  assert.deepEqual(h.prices, [90, 110]);
  assert.deepEqual(text.map(item => item.value), ['B×3', 'S']);
  assert.ok(text[0].y > 110);
  assert.ok(text[1].y < 90);
  assert.ok(text.every(item => item.color === '#fff'));
  assert.equal(h.primitive.autoscaleInfo(0, 10), null);
});

test('native view updates follow pan and hide anchors outside the chart without changing badge scale at DPR 2', () => {
  const h = harness([{ time: 50, position: 'belowBar', text: 'B', color: 'red' }], [{ time: 50, high: 110, low: 90 }]);
  const first = h.draw();
  const retina = h.draw(2);
  assert.equal(retina.text[0].font, first.text[0].font);
  assert.equal(retina.text[0].x, first.text[0].x);
  assert.ok(Math.abs(retina.text[0].y - first.text[0].y) <= 0.5);
  assert.deepEqual(retina.scales, [[2, 2]]);
  h.pan(25);
  assert.equal(h.draw().text[0].x, 75);
  h.pan(-100);
  assert.equal(h.draw().text.length, 0);
});

test('daily business-day objects match date strings and cleanup is idempotent', () => {
  const h = harness([{ time: { year: 2025, month: 6, day: 2 }, position: 'aboveBar', text: 'S', color: 'green' }], [{ time: '2025-06-02', high: 110, low: 90 }]);
  assert.equal(h.draw().text.length, 1);
  h.attachment.detach();
  h.attachment.detach();
  assert.equal(h.detached(), 1);
  assert.equal(h.draw().text.length, 0);
});

test('adjacent same-side badges stagger only on collision and retain a connector to their candle', () => {
  const times = [40, 53, 90];
  const h = harness(times.map(time => ({ time, position: 'belowBar', text: 'B', color: 'red' })), times.map(time => ({ time, high: 110, low: 90 })));
  const { text, connectors } = h.draw();
  assert.equal(text.length, 3);
  assert.ok(text[1].y - text[0].y >= 20);
  assert.equal(text[2].y, text[0].y);
  assert.deepEqual(connectors, [[[53, 113], [53, 133]]]);
  assert.equal(h.primitive.autoscaleInfo(0, 100), null);
});

test('edge badges stay inside the pane and point back to their original candle coordinate', () => {
  const times = [3, 298];
  const h = harness(times.map(time => ({ time, position: 'aboveBar', text: 'S', color: 'green' })), times.map(time => ({ time, high: 110, low: 90 })));
  const { text, connectors } = h.draw();
  assert.equal(text.length, 2);
  assert.equal(text[0].x - 9, 1);
  assert.equal(text[1].x + 9, 299);
  assert.deepEqual(connectors.map(line => line[0]), [[3, 87], [298, 87]]);
});
