import { tokens } from '@okht/huikan-design-system/tokens';

/** Filled trade annotations rendered in the chart's own canvas coordinate space. */
export const TRADE_BADGE_STYLE = Object.freeze({
  height: 18,
  minWidth: 18,
  radius: 4,
  fontSize: 11,
  fontWeight: 600,
  paddingX: 4,
  pointerHeight: 3,
  pointerHalfWidth: 3,
  wickGap: 3,
  badgeGap: 2,
});

function timeKey(time) {
  if (time && typeof time === 'object') {
    return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
  }
  return time;
}

function roundedBadge(context, x, y, width, height, radius) {
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

class TradeBadgePrimitive {
  constructor(markers, candles) {
    const byTime = new Map(candles.map(candle => [timeKey(candle.time), candle]));
    this.items = markers.flatMap(marker => {
      const candle = byTime.get(timeKey(marker.time));
      const below = marker.position === 'belowBar';
      const price = below ? candle?.low : candle?.high;
      if (!candle || !Number.isFinite(price)) return [];
      return [{ time: marker.time, price, below, color: marker.color, text: marker.text }];
    });
    this.coordinates = [];
    this.views = [{ zOrder: () => 'normal', renderer: () => this }];
  }

  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    requestUpdate();
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.coordinates = [];
  }

  updateAllViews() {
    if (!this.chart || !this.series) return;
    const timeScale = this.chart.timeScale();
    this.coordinates = this.items.flatMap(item => {
      const x = timeScale.timeToCoordinate(item.time);
      const y = this.series.priceToCoordinate(item.price);
      return Number.isFinite(x) && Number.isFinite(y) ? [{ ...item, x, y }] : [];
    });
  }

  paneViews() { return this.views; }

  // Annotation pixels must never become prices or change the candle autoscale.
  autoscaleInfo() { return null; }

  draw(target) {
    if (!this.coordinates.length) return;
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio, bitmapSize }) => {
      const s = TRADE_BADGE_STYLE;
      const width = bitmapSize.width / horizontalPixelRatio;
      const height = bitmapSize.height / verticalPixelRatio;
      const snapX = value => Math.round(value * horizontalPixelRatio) / horizontalPixelRatio;
      const snapY = value => Math.round(value * verticalPixelRatio) / verticalPixelRatio;
      context.save();
      try {
        context.scale(horizontalPixelRatio, verticalPixelRatio);
        context.font = `${s.fontWeight} ${s.fontSize}px ${tokens['font-family']}`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        const placed = [];
        for (const item of this.coordinates) {
          if (item.x < 0 || item.x > width || item.y < 0 || item.y > height) continue;
          const badgeWidth = Math.max(s.minWidth, Math.ceil(context.measureText(item.text).width) + s.paddingX * 2);
          const x = snapX(item.x);
          const anchorY = snapY(item.y + (item.below ? s.wickGap : -s.wickGap));
          let y = snapY(item.below ? anchorY + s.pointerHeight : anchorY - s.pointerHeight - s.height);
          const left = snapX(Math.max(1, Math.min(width - badgeWidth - 1, x - badgeWidth / 2)));
          // Move only colliding badges outward. Each move clears at least one
          // previous rectangle; a short second pass handles an earlier neighbour.
          for (let pass = 0; pass <= placed.length; pass++) {
            const collision = placed.find(other => other.below === item.below
              && left < other.left + other.width + s.badgeGap && left + badgeWidth + s.badgeGap > other.left
              && y < other.y + s.height + s.badgeGap && y + s.height + s.badgeGap > other.y);
            if (!collision) break;
            y = snapY(item.below ? collision.y + s.height + s.badgeGap : collision.y - s.height - s.badgeGap);
          }
          const edgeY = item.below ? y : y + s.height;
          const tipY = edgeY + (item.below ? -s.pointerHeight : s.pointerHeight);
          const tipX = snapX(Math.max(left + s.radius + s.pointerHalfWidth,
            Math.min(left + badgeWidth - s.radius - s.pointerHalfWidth, x)));
          placed.push({ ...item, x, anchorY, left, y, width: badgeWidth, edgeY, tipX, tipY });
        }
        // Draw connectors first so any neighbouring badge body covers the line.
        for (const item of placed) {
          if (Math.abs(item.tipX - item.x) < 0.5 && Math.abs(item.tipY - item.anchorY) < 0.5) continue;
          context.strokeStyle = item.color;
          context.lineWidth = 1;
          context.globalAlpha = 0.65;
          context.beginPath();
          context.moveTo(item.x, item.anchorY);
          context.lineTo(item.tipX, item.tipY);
          context.stroke();
        }
        context.globalAlpha = 1;
        for (const item of placed) {
          context.fillStyle = item.color;
          context.beginPath();
          roundedBadge(context, item.left, item.y, item.width, s.height, s.radius);
          context.moveTo(item.tipX - s.pointerHalfWidth, item.edgeY);
          context.lineTo(item.tipX, item.tipY);
          context.lineTo(item.tipX + s.pointerHalfWidth, item.edgeY);
          context.closePath();
          context.fill();
          context.fillStyle = tokens['text-inverse'];
          context.fillText(item.text, snapX(item.left + item.width / 2), snapY(item.y + s.height / 2 + 0.5));
        }
      } finally {
        context.restore();
      }
    });
  }
}

/** Attach once per chart data set; detach before removing the chart. */
export function attachTradeBadgeMarkers(series, groupedMarkers, candles) {
  const primitive = new TradeBadgePrimitive(groupedMarkers, candles);
  series.attachPrimitive(primitive);
  let attached = true;
  return {
    detach() {
      if (!attached) return;
      attached = false;
      series.detachPrimitive(primitive);
    },
  };
}
