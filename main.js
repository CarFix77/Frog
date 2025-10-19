import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const API_TOKEN = Deno.env.get("TINKOFF_API_TOKEN");
const TINKOFF_API_URL = "https://invest-public-api.tinkoff.ru/rest";

// Кэш
let cache = {
  prices: {},
  portfolio: null,
  lastUpdate: 0
};

// Утилиты
function quotationToFloat(quotation) {
  if (!quotation) return 0;
  return quotation.units + (quotation.nano || 0) / 1_000_000_000;
}

function floatToQuotation(value) {
  const units = Math.trunc(value);
  const nano = Math.round((value - units) * 1_000_000_000);
  return { units, nano };
}

// Запросы к Tinkoff API
async function tinkoffRequest(endpoint, body = {}) {
  try {
    const response = await fetch(`${TINKOFF_API_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Tinkoff API error:', error);
    throw error;
  }
}

// Получение цены
async function getCurrentPrice(ticker = 'SBER') {
  try {
    const now = Date.now();
    if (now - cache.lastUpdate < 5000 && cache.prices[ticker]) {
      return cache.prices[ticker];
    }

    // Ищем инструмент
    const searchResult = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
      query: ticker
    });
    
    if (!searchResult.instruments || searchResult.instruments.length === 0) {
      throw new Error(`Instrument not found: ${ticker}`);
    }
    
    const instrument = searchResult.instruments[0];
    const figi = instrument.figi;

    // Получаем стакан
    const orderbook = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.MarketDataService/GetOrderBook', {
      figi: figi,
      depth: 1
    });
    
    const priceData = {
      price: quotationToFloat(orderbook.lastPrice),
      figi: figi,
      ticker: ticker,
      timestamp: now
    };
    
    cache.prices[ticker] = priceData;
    cache.lastUpdate = now;
    
    return priceData;
  } catch (error) {
    console.error('Error getting price:', error);
    // Fallback данные
    return {
      price: 190 + Math.random() * 2,
      ticker: ticker,
      timestamp: Date.now(),
      isMock: true
    };
  }
}

// Получение портфеля
async function getPortfolio() {
  try {
    const accounts = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts');
    
    if (!accounts.accounts || accounts.accounts.length === 0) {
      throw new Error("No accounts found");
    }
    
    const accountId = accounts.accounts[0].id;
    
    const portfolio = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio', {
      accountId: accountId
    });
    
    return portfolio;
  } catch (error) {
    console.error('Error getting portfolio:', error);
    return { totalAmountPortfolio: { units: 0, nano: 0 }, positions: [] };
  }
}

// Размещение ордера
async function placeLimitOrder(ticker, quantity, price, direction) {
  try {
    // Ищем инструмент
    const searchResult = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
      query: ticker
    });
    
    if (!searchResult.instruments || searchResult.instruments.length === 0) {
      throw new Error(`Instrument not found: ${ticker}`);
    }
    
    const instrument = searchResult.instruments[0];
    const figi = instrument.figi;

    // Получаем аккаунт
    const accounts = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts');
    const accountId = accounts.accounts[0].id;

    // Размещаем ордер
    const orderResult = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.OrdersService/PostOrder', {
      figi: figi,
      quantity: parseInt(quantity),
      price: floatToQuotation(parseFloat(price)),
      direction: direction === 'buy' ? 'ORDER_DIRECTION_BUY' : 'ORDER_DIRECTION_SELL',
      accountId: accountId,
      orderType: 'ORDER_TYPE_LIMIT',
      orderId: `order_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    });

    return orderResult;
  } catch (error) {
    console.error('Error placing order:', error);
    throw error;
  }
}

// HTTP обработчик
async function handler(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  
  // Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }
  
  try {
    // Роуты API
    if (path === '/api/price' && request.method === 'GET') {
      const ticker = url.searchParams.get('ticker') || 'SBER';
      const priceData = await getCurrentPrice(ticker);
      
      return new Response(JSON.stringify({
        success: true,
        data: priceData
      }), { headers });
    }
    
    if (path === '/api/portfolio' && request.method === 'GET') {
      const portfolio = await getPortfolio();
      
      return new Response(JSON.stringify({
        success: true,
        data: portfolio
      }), { headers });
    }
    
    if (path === '/api/order/limit' && request.method === 'POST') {
      const body = await request.json();
      const { ticker, quantity, price, direction } = body;
      
      if (!ticker || !quantity || !price || !direction) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields: ticker, quantity, price, direction'
        }), { headers, status: 400 });
      }
      
      const result = await placeLimitOrder(ticker, quantity, price, direction);
      
      return new Response(JSON.stringify({
        success: true,
        data: result
      }), { headers });
    }
    
    if (path === '/api/status' && request.method === 'GET') {
      return new Response(JSON.stringify({
        success: true,
        data: {
          status: 'online',
          timestamp: new Date().toISOString(),
          hasToken: !!API_TOKEN,
          message: 'Tinkoff API server is running'
        }
      }), { headers });
    }
    
    // Health check
    if (path === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'OK',
        timestamp: new Date().toISOString()
      }), { headers });
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: 'Route not found'
    }), { headers, status: 404 });
    
  } catch (error) {
    console.error('Handler error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), { headers, status: 500 });
  }
}

// Запуск сервера
console.log('Server starting on port 8000');
serve(handler, { port: 8000 });
