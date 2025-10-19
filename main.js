import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const API_TOKEN = Deno.env.get("TINKOFF_API_TOKEN");
const TINKOFF_API_URL = "https://invest-public-api.tinkoff.ru/rest";
const CACHE_TTL_MS = 5000;

// Кэш
let cachedAccountId = null;
const tickerFigiMap = new Map();
const priceCache = new Map();

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

function moneyValueToFloat(moneyValue) {
    if (!moneyValue) return 0;
    return moneyValue.units + (moneyValue.nano || 0) / 1_000_000_000;
}

function generateOrderId() {
    return `order_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
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

// Получение FIGI для тикера
async function getFigiForTicker(ticker) {
    if (tickerFigiMap.has(ticker)) {
        return tickerFigiMap.get(ticker);
    }

    try {
        const { instruments } = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
            query: ticker,
        });

        const instrument = instruments.find(inst => inst.ticker === ticker);
        
        if (!instrument) {
            throw new Error(`Instrument not found for ticker: ${ticker}`);
        }

        tickerFigiMap.set(ticker, instrument.figi);
        return instrument.figi;
    } catch (error) {
        console.error(`Error finding FIGI for ${ticker}:`, error);
        throw error;
    }
}

// Получение ID счета
async function getAccountId() {
    if (cachedAccountId) {
        return cachedAccountId;
    }
    
    try {
        const { accounts } = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts', {});
        
        if (!accounts || accounts.length === 0) {
            throw new Error("No accounts found");
        }
        
        cachedAccountId = accounts[0].id;
        console.log(`✅ Using Account ID: ${cachedAccountId}`);
        return cachedAccountId;
    } catch (error) {
        console.error("Error fetching account ID:", error);
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
        // GET /api/price?ticker=SBER
        if (path === '/api/price' && request.method === 'GET') {
            const ticker = url.searchParams.get('ticker') || 'SBER';
            
            // Проверка кеша
            const cachedPrice = priceCache.get(ticker);
            if (cachedPrice && Date.now() - cachedPrice.timestamp < CACHE_TTL_MS) {
                return new Response(JSON.stringify({ 
                    success: true, 
                    data: cachedPrice 
                }), { headers });
            }

            try {
                const figi = await getFigiForTicker(ticker);
                const orderbook = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.MarketDataService/GetOrderBook', {
                    figi: figi,
                    depth: 1
                });
                
                const priceData = {
                    price: quotationToFloat(orderbook.lastPrice),
                    timestamp: Date.now(),
                    figi,
                    ticker
                };
                
                priceCache.set(ticker, priceData);
                
                return new Response(JSON.stringify({
                    success: true,
                    data: priceData
                }), { headers });
                
            } catch (error) {
                console.error(`Error getting price for ${ticker}:`, error);
                // Fallback данные
                const mockPrice = {
                    price: 190 + Math.random() * 2,
                    timestamp: Date.now(),
                    ticker,
                    isMock: true
                };
                return new Response(JSON.stringify({
                    success: true,
                    data: mockPrice
                }), { headers });
            }
        }
        
        // GET /api/portfolio
        if (path === '/api/portfolio' && request.method === 'GET') {
            try {
                const accountId = await getAccountId();
                const portfolio = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio', {
                    accountId: accountId
                });
                
                return new Response(JSON.stringify({
                    success: true,
                    data: {
                        totalAmount: moneyValueToFloat(portfolio.totalAmountPortfolio),
                        positions: portfolio.positions || []
                    }
                }), { headers });
            } catch (error) {
                console.error("Error getting portfolio:", error);
                return new Response(JSON.stringify({
                    success: true,
                    data: {
                        totalAmount: 0,
                        positions: [],
                        isMock: true
                    }
                }), { headers });
            }
        }
        
        // POST /api/order/limit
        if (path === '/api/order/limit' && request.method === 'POST') {
            try {
                const body = await request.json();
                const { ticker, quantity, price, direction } = body;

                if (!ticker || !quantity || !price || !direction) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: "Missing required fields: ticker, quantity, price, direction"
                    }), { headers, status: 400 });
                }

                const figi = await getFigiForTicker(ticker);
                const accountId = await getAccountId();

                const orderResponse = await tinkoffRequest('/tinkoff.public.invest.api.contract.v1.OrdersService/PostOrder', {
                    figi,
                    quantity: parseInt(quantity),
                    price: floatToQuotation(parseFloat(price)),
                    direction: direction.toLowerCase() === 'buy' ? 'ORDER_DIRECTION_BUY' : 'ORDER_DIRECTION_SELL',
                    accountId,
                    orderType: 'ORDER_TYPE_LIMIT',
                    orderId: generateOrderId(),
                });

                return new Response(JSON.stringify({
                    success: true,
                    data: {
                        orderId: orderResponse.orderId,
                        status: orderResponse.executionReportStatus,
                        message: "Order placed successfully"
                    }
                }), { headers });
                
            } catch (error) {
                console.error("Error placing order:", error);
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message
                }), { headers, status: 500 });
            }
        }
        
        // GET /api/status
        if (path === '/api/status' && request.method === 'GET') {
            try {
                await getAccountId(); // Проверяем доступность API
                return new Response(JSON.stringify({
                    success: true,
                    data: {
                        status: "online",
                        timestamp: new Date().toISOString(),
                        hasToken: !!API_TOKEN,
                        message: "Tinkoff API connected successfully"
                    }
                }), { headers });
            } catch (error) {
                return new Response(JSON.stringify({
                    success: true,
                    data: {
                        status: "limited",
                        timestamp: new Date().toISOString(),
                        hasToken: !!API_TOKEN,
                        message: "API available in limited mode",
                        error: error.message
                    }
                }), { headers });
            }
        }
        
        // Health check
        if (path === '/health' && request.method === 'GET') {
            return new Response(JSON.stringify({
                status: 'OK',
                timestamp: new Date().toISOString()
            }), { headers });
        }
        
        // 404 для неизвестных маршрутов
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
