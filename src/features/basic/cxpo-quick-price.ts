import { setQuickPriceEnabled } from './cxpo-order-book/quick-price';

function init() {
  setQuickPriceEnabled(true);
}

features.add(import.meta.url, init, 'CXPO：在订单簿中显示幽灵价格行，以便快速压价/抬价。');
