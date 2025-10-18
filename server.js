// server.js

// --- Конфигурация и импорты ---
require('dotenv').config(); // Загружает переменные окружения из .env файла
const express = require('express');
const cors = require('cors');
const { TinkoffInvestApi } = require('@tinkoff/invest-api');
const {
  Instrument, // Для типов (не используется напрямую, но для понимания)
  Quotation,
  M oneyValue,
  Account,
  InstrumentIdType,
  OrderDirection,
  OrderType,
} = require('@tinkoff/invest-api/src/generated/instruments'); // Для использования enum значений напрямую

const app = express();
const PORT = process.env.PORT || 8000;
const API_TOKEN = process.env.TINKOFF_API_TOKEN;
const CACHE_TTL_MS = 5000; // Cache Time-To-Live for prices: 5 seconds

// Проверка наличия токена
if (!API_TOKEN) {
  console.error("❌ TINKOFF_API_TOKEN environment variable is not set.");
  process.exit(1);
}

// --- Инициализация Express.js и SDK ---
app.use(cors()); // Включаем CORS для всех запросов
app.use(express.json()); // Включаем парсинг JSON для тела запросов

const api = new TinkoffInvestApi({ token: API_TOKEN });

let cachedAccountId;
const tickerFigiMap = new Map(); // 'SBMX' -> 'BBGXXXXXX'
const priceCache = new Map(); // 'SBMX' -> { price: 1.0025, timestamp: 123456789 }

// --- Вспомогательные функции ---

/** Конвертирует Quotation (units + nano) в обычное число с плавающей точкой */
function quotationToFloat(quotation) {
  if (!quotation) return 0;
  return quotation.units + (quotation.nano || 0) / 1_000_000_000;
}

/** Конвертирует float в Quotation */
function floatToQuotation(value) {
  const units = Math.trunc(value);
  const nano = Math.round((value - units) * 1_000_000_000);
  return { units, nano };
}

/** Конвертирует MoneyValue в обычное число */
function moneyValueToFloat(moneyValue) {
  if (!moneyValue) return 0;
  return moneyValue.units + (moneyValue.nano || 0) / 1_000_000_000;
}

/** Генерация уникального ID для заявки */
function generateOrderId() {
  return `order_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Получает FIGI для тикера и кеширует его.
 * @param {string} ticker Тикер инструмента (например, 'SBMX').
 * @returns {Promise<string>} FIGI инструмента.
 */
async function getFigiForTicker(ticker) {
  if (tickerFigiMap.has(ticker)) {
    return tickerFigiMap.get(ticker);
  }

  try {
    const { instruments } = await api.instruments.findInstrument({
      query: ticker,
      instrumentIdType: InstrumentIdType.INSTRUMENT_ID_TYPE_TICKER,
    });

    const instrument = instruments.find(
      (inst) => inst.ticker === ticker && inst.instrumentType === 'etf' // Уточняем тип инструмента
    );

    if (!instrument) {
      throw new Error(`FIGI not found for ticker: ${ticker}`);
    }

    tickerFigiMap.set(ticker, instrument.figi);
    return instrument.figi;
  } catch (error) {
    console.error(`Error finding FIGI for ${ticker}:`, error);
    throw error;
  }
}

/**
 * Получает ID инвестиционного счета.
 * @returns {Promise<string>} ID счета.
 */
async function getAccountId() {
  if (cachedAccountId) {
    return cachedAccountId;
  }
  try {
    const { accounts } = await api.users.getAccounts({});
    // Ищем основной или брокерский счет
    const mainAccount = accounts.find(
      (acc) => acc.type === Account.ACCOUNT_TYPE_TINKOFF || acc.type === Account.ACCOUNT_TYPE_INVESTMENT
    );

    if (!mainAccount) {
      throw new Error("No suitable investment account found.");
    }
    cachedAccountId = mainAccount.id;
    console.log(`✅ Fetched Account ID: ${cachedAccountId}`);
    return cachedAccountId;
  } catch (error) {
    console.error("Error fetching account ID:", error);
    throw error;
  }
}

// --- API Endpoints ---

/**
 * GET /api/price?ticker=SBMX
 * Возвращает текущую цену для указанного тикера.
 */
app.get('/api/price', async (req, res) => {
  const ticker = req.query.ticker;
  if (!ticker) {
    return res.status(400).json({ success: false, error: "Missing 'ticker' parameter" });
  }

  // Проверка кеша
  const cachedPrice = priceCache.get(ticker);
  if (cachedPrice && Date.now() - cachedPrice.timestamp < CACHE_TTL_MS) {
    console.log(`Cache hit for ${ticker}`);
    return res.json({ success: true, data: cachedPrice });
  }

  try {
    const figi  = await getFigiForTicker(ticker);
    const { lastPrices } = await api.marketData.getLastPrices({ figi: [figi] });

    if (!lastPrices || lastPrices.length === 0) {
      throw new Error(`No price data for ${ticker}`);
    }

    const price = quotationToFloat(lastPrices[0].price);
    const result = { price, timestamp: Date.now() };
    priceCache.set(ticker, result); // Обновление кеша

    res.json({ success: true, data: result });
  } catch (error) {
    console.error(`Error getting price for ${ticker}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/portfolio
 * Возвращает информацию о текущем инвестиционном портфеле.
 */
app.get('/api/portfolio', async (req, res) => {
  try {
    const accountId = await getAccountId();
    const { positions } = await api.operations.getPortfolio({ accountId });

    // Преобразование позиций в более удобный формат
    const formattedPositions = await Promise.all(positions.map(async (pos) => {
      let ticker = pos.figi; // По умолчанию FIGI
      try {
        const { instrument } = await api.instruments.getInstrumentBy({
          idType: InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
          id: pos.figi,
        });
        ticker = instrument?.ticker || pos.figi;
      } catch (e) {
        console.warn(`Could not get ticker for FIGI ${pos.figi}: ${e.message}`);
      }

      return {
        figi: pos.figi,
        ticker: ticker,
        instrumentType: pos.instrumentType,
        quantity: quotationToFloat(pos.quantity),
        averageBuyPrice: moneyValueToFloat(pos.averagePositionPrice),
        currentPrice: moneyValueToFloat(pos.currentPrice),
      };
    }));

    res.json({ success: true, data: formattedPositions });
  } catch (error) {
    console.error("Error getting portfolio:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/order/limit
 * Размещает лимитную заявк у на покупку/продажу.
 * Ожидаемое тело запроса: { ticker: 'SBMX', quantity: 10, price: 1.0025, direction: 'buy'/'sell' }
 */
app.post('/api/order/limit', async (req, res) => {
  try {
    const { ticker, quantity, price, direction } = req.body;

    if (!ticker || !quantity || !price || !direction) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const figi = await getFigiForTicker(ticker);
    const accountId = await getAccountId();

    const orderDir = direction === 'buy'
      ? OrderDirection.ORDER_DIRECTION_BUY
      : OrderDirection.ORDER_DIRECTION_SELL;

    const { orderId, executionReportStatus } = await api.orders.postOrder({
      figi: figi,
      quantity: quantity,
      price: floatToQuotation(price),
      direction: orderDir,
      accountId: accountId,
      orderType: OrderType.ORDER_TYPE_LIMIT,
      orderId: generateOrderId(),
    });

    res.json({
      success: true,
      data: { orderId, executionReportStatus, message: "Order placed successfully" },
    });
  } catch (error) {
    console.error("Error placing order:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/status
 * Возвращает статус сервера и наличие токена.
 */
app.get('/api/status', async (req, res) => {
  try {
    const accountId = await getAccountId(); // Проверяем доступность аккаунта
    res.json({
      success: true,
      data: {
        status: "online",
        timestamp: new Date().toISOString(),
        hasToken: !!API_TOKEN,
        accountId: accountId,
      },
    });
  } catch (error) {
    console.error("Error checking status:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Обработка несуществующих маршрутов
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// --- Запуск сервера ---
app.listen(PORT, async () => {
  conso le.log(`Server running on http://localhost:${PORT}`);
  // Пытаемся получить ID аккаунта при старте
  try {
    await getAccountId();
  } catch (e) {
    console.error("Initial account ID fetch failed:", e.message);
  }
});
