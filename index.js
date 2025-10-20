require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.on('error', (error) => {
  console.error('client error:', error.message);
});

const BYBIT_BASE = 'https://api.bybit.com';
const ALERT_CHANNEL_ID = process.env.ALERT_CHANNEL_ID;
const ALERT_ROLE_ID = process.env.ALERT_ROLE_ID || null;

const THRESHOLDS = {
  BIG_MOVE: 5,
  FAST_MOVE: 3
};

const alertCooldowns = new Map();
const COOLDOWN_MS = 60 * 60 * 1000;

let isWarmedUp = false;

async function fetchMarketData() {
  const url = BYBIT_BASE + '/v5/market/tickers';
  const response = await axios.get(url, {
    params: { category: 'linear' }
  });
  
  const marketData = [];
  
  if (response.data && response.data.result && response.data.result.list) {
    for (const ticker of response.data.result.list) {
      if (!ticker.symbol || !ticker.lastPrice) continue;
      
      marketData.push({
        symbol: ticker.symbol,
        price: parseFloat(ticker.lastPrice),
        volume24h: parseFloat(ticker.turnover24h || 0),
        priceChange24h: parseFloat(ticker.price24hPcnt || 0) * 100,
        highPrice24h: parseFloat(ticker.highPrice24h || 0),
        lowPrice24h: parseFloat(ticker.lowPrice24h || 0)
      });
    }
  }
  
  return marketData;
}

async function getRecentKlineData(symbol, interval, limit) {
  try {
    const url = BYBIT_BASE + '/v5/market/kline';
    const response = await axios.get(url, {
      params: {
        category: 'linear',
        symbol: symbol,
        interval: interval,
        limit: limit
      }
    });
    
    if (response.data && response.data.result && response.data.result.list) {
      return response.data.result.list.map(candle => ({
        timestamp: parseInt(candle[0]),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5])
      }));
    }
  } catch (err) {
    return null;
  }
  return null;
}

function calculateVolatility(klines) {
  if (!klines || klines.length < 2) return 0;
  
  const returns = [];
  for (let i = 1; i < klines.length; i++) {
    const priceChange = (klines[i].close - klines[i-1].close) / klines[i-1].close;
    returns.push(priceChange);
  }
  
  const mean = returns.reduce((sum, val) => sum + val, 0) / returns.length;
  const variance = returns.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance) * 100;
  
  return volatility;
}

function calculateTicks(klines) {
  return Math.floor(klines.reduce((sum, k) => sum + k.volume, 0) / klines.length);
}

async function analyzeSymbol(symbol) {
  const klines5m = await getRecentKlineData(symbol, '5', 30);
  const klines15m = await getRecentKlineData(symbol, '15', 5);
  
  if (!klines5m || !klines15m || klines5m.length < 10) return null;
  
  const currentPrice = klines5m[0].close;
  
  const oldPrice5m = klines5m[0].open;
  const priceChange5m = ((currentPrice - oldPrice5m) / oldPrice5m) * 100;
  
  const oldPrice15m = klines5m[2].open;
  const priceChange15m = ((currentPrice - oldPrice15m) / oldPrice15m) * 100;
  
  const volatility15m = calculateVolatility(klines15m);
  const ticks5m = calculateTicks(klines5m.slice(0, 1));
  
  const volume5m = klines5m[0].volume;
  const volume15m = klines5m.slice(0, 3).reduce((sum, k) => sum + k.volume, 0);
  
  const avgVolume = klines5m.slice(3, 10).reduce((sum, k) => sum + k.volume, 0) / 7;
  
  let volumeSpike = 0;
  if (avgVolume > 0) {
    volumeSpike = ((volume5m - avgVolume) / avgVolume) * 100;
  }
  
  return {
    symbol,
    price: currentPrice,
    ticks5m,
    volatility15m,
    priceChange5m,
    priceChange15m,
    volume5m,
    volume15m,
    volumeSpike
  };
}

function shouldAlert(analysis) {
  if (analysis.volume15m < 50000) return null;
  
  if (Math.abs(analysis.priceChange15m) >= THRESHOLDS.BIG_MOVE) {
    return 'big_move';
  }
  
  if (Math.abs(analysis.priceChange5m) >= THRESHOLDS.FAST_MOVE && analysis.volumeSpike > 50) {
    return 'fast_move';
  }
  
  return null;
}

function canSendAlert(symbol) {
  const lastAlert = alertCooldowns.get(symbol);
  if (!lastAlert) return true;
  
  const timeSince = Date.now() - lastAlert;
  return timeSince >= COOLDOWN_MS;
}

async function generateChartUrl(symbol) {
  try {
    const limit = 120;
    const interval = '1';
    const category = 'linear';
    
    console.log('fetching chart for ' + symbol);
    
    const url = BYBIT_BASE + '/v5/market/kline';
    const bybitResponse = await axios.get(url, {
      params: {
        symbol: symbol,
        interval: interval,
        category: category,
        limit: limit
      }
    });

    if (bybitResponse.data.retCode !== 0) {
      throw new Error('bybit api error: ' + bybitResponse.data.retMsg);
    }

    const klineData = bybitResponse.data.result.list.reverse();

    const ohlcData = klineData.map(k => ({
      x: parseInt(k[0]),
      o: parseFloat(k[1]),
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4])
    }));

    const chartSymbol = symbol.replace('USDT', '/USDT');

    const chartConfig = {
      type: 'candlestick',
      data: {
        datasets: [{
          data: ohlcData,
          color: {
            up: '#25e621',
            down: '#d31602',
            unchanged: '#999'
          },
          border: {
            up: '#25e621',
            down: '#d31602',
            unchanged: '#999'
          }
        }]
      },
      options: {
        title: { display: false },
        plugins: {
          legend: {
            display: false
          },
          annotation: {
            annotations: {
              symbolLabel: {
                type: 'label',
                content: chartSymbol,
                drawTime: 'beforeDatasetsDraw',
                x: '50%',
                y: 50,
                font: {
                  size: 72,
                  color: '#484848',
                  weight: 'bold'
                }
              }
            }
          }
        },
        scales: {
          x: {
            type: 'time',
            time: {
              unit: 'minute',
              displayFormats: {
                minute: 'HH:mm'
              }
            },
            grid: {
              display: false,
              drawBorder: false
            },
            ticks: {
              font: { color: '#999999' },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 6
            }
          },
          y: {
            grid: {
              display: false,
              drawBorder: false
            },
            ticks: {
              font: { color: '#999999' }
            }
          }
        }
      }
    };

    const postBody = {
      chart: chartConfig,
      width: 800,
      height: 400,
      backgroundColor: '#111111',
      version: '3'
    };

    const quickChartResponse = await axios.post(
      'https://quickchart.io/chart/create',
      postBody,
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (quickChartResponse.data && quickChartResponse.data.success) {
      return quickChartResponse.data.url;
    } else {
      throw new Error('quickchart didnt return url');
    }

  } catch (error) {
    console.error('chart gen failed for ' + symbol + ':', error.message);
    return null;
  }
}

async function sendAlert(channel, analysis, alertType) {
  let cleanSymbol = analysis.symbol.replace('USDT', '');
  if (cleanSymbol.endsWith('PERP')) {
    cleanSymbol = cleanSymbol.slice(0, -4);
  }
  
  const alertTypeNames = {
    big_move: 'Big Move Alert',
    fast_move: 'Fast Move Alert'
  };
  
  const alertName = alertTypeNames[alertType] || 'Volatility Alert';
  const title = cleanSymbol + '/USDT - (' + alertName + ')';
  
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x000000)
    .setTimestamp()
    .setFooter({ text: 'Volatility Monitor' });
  
  // format price based on its value
  let priceValue;
  if (analysis.price < 0.01) {
    priceValue = '$' + analysis.price.toFixed(6);
  } else if (analysis.price < 1) {
    priceValue = '$' + analysis.price.toFixed(4);
  } else {
    priceValue = '$' + analysis.price.toFixed(2);
  }
  
  if (alertType === 'fast_move') {
    const ticksValue = analysis.ticks5m.toLocaleString();
    const changeValue = (analysis.priceChange5m >= 0 ? '+' : '') + analysis.priceChange5m.toFixed(4) + '%';
    const volumeIncValue = (analysis.volumeSpike >= 0 ? '+' : '') + analysis.volumeSpike.toFixed(2) + '%';
    const volumeValue = Math.floor(analysis.volume15m).toLocaleString() + '$';
    
    embed.addFields(
      { name: 'Price', value: priceValue, inline: true },
      { name: 'Change 5m', value: changeValue, inline: true },
      { name: 'Ticks 5m', value: ticksValue, inline: true },
      { name: 'Volume Increase', value: volumeIncValue, inline: true },
      { name: 'Volume 15m', value: volumeValue, inline: true }
    );
  } else {
    const ticksValue = analysis.ticks5m.toLocaleString();
    const volatilityValue = analysis.volatility15m.toFixed(4);
    const changeValue = (analysis.priceChange15m >= 0 ? '+' : '') + analysis.priceChange15m.toFixed(4) + '%';
    const volumeValue = Math.floor(analysis.volume15m).toLocaleString() + '$';
    
    embed.addFields(
      { name: 'Price', value: priceValue, inline: true },
      { name: 'Change 15m', value: changeValue, inline: true },
      { name: 'Ticks 5m', value: ticksValue, inline: true },
      { name: 'Volatility 15m', value: volatilityValue, inline: true },
      { name: 'Volume 15m', value: volumeValue, inline: true }
    );
  }
  
  const chartUrl = await generateChartUrl(analysis.symbol);
  if (chartUrl) {
    embed.setImage(chartUrl);
  }
  
  try {
    const messagePayload = { embeds: [embed] };
    
    if (ALERT_ROLE_ID) {
      messagePayload.content = '<@&' + ALERT_ROLE_ID + '>';
    }
    
    await channel.send(messagePayload);
    console.log('sent alert for ' + cleanSymbol + ' (' + alertType + ')');
    alertCooldowns.set(analysis.symbol, Date.now());
  } catch (error) {
    console.error('failed to send alert for ' + cleanSymbol + ':', error.message);
  }
}

async function monitorMarket() {
  const scanStartTime = Date.now();
  
  console.log('\nscanning ' + new Date().toLocaleTimeString());
  
  try {
    const channel = await client.channels.fetch(ALERT_CHANNEL_ID);
    if (!channel) {
      console.error('cant find alert channel');
      return;
    }
    
    const marketData = await fetchMarketData();
    console.log('checking ' + marketData.length + ' symbols');
    
    let alertsSent = 0;
    let skippedDuringWarmup = 0;
    
    const batchSize = 20;
    for (let i = 0; i < marketData.length; i += batchSize) {
      const batch = marketData.slice(i, i + batchSize);
      
      for (const ticker of batch) {
        if (!canSendAlert(ticker.symbol)) continue;
        
        const analysis = await analyzeSymbol(ticker.symbol);
        if (!analysis) continue;
        
        const alertType = shouldAlert(analysis);
        if (alertType) {
          if (!isWarmedUp) {
            skippedDuringWarmup++;
            continue;
          }
          
          const change5m = (analysis.priceChange5m >= 0 ? '+' : '') + analysis.priceChange5m.toFixed(2) + '%';
          const change15m = (analysis.priceChange15m >= 0 ? '+' : '') + analysis.priceChange15m.toFixed(2) + '%';
          const volSpike = analysis.volumeSpike.toFixed(0) + '%';
          
          console.log('  ' + analysis.symbol + ' | 5m: ' + change5m + ' | 15m: ' + change15m + ' | vol: ' + volSpike + ' | ' + alertType);
          
          await sendAlert(channel, analysis, alertType);
          alertsSent++;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    const scanDuration = ((Date.now() - scanStartTime) / 1000).toFixed(1);
    
    if (!isWarmedUp) {
      console.log('warmup done, skipped ' + skippedDuringWarmup + ' alerts');
      console.log('now monitoring live');
      isWarmedUp = true;
    } else {
      console.log('done - sent ' + alertsSent + ' alerts in ' + scanDuration + 's');
    }
    
  } catch (error) {
    console.error('scan failed:', error.message);
  }
  
  console.log('waiting 1 min before next scan...\n');
  setTimeout(monitorMarket, 60 * 1000);
}

client.once('clientReady', async () => {
  console.log('\nlogged in as ' + client.user.tag);
  console.log('connected to ' + client.guilds.cache.size + ' servers');
  console.log('channel: ' + ALERT_CHANNEL_ID);
  if (ALERT_ROLE_ID) {
    console.log('role ping: ' + ALERT_ROLE_ID);
  }
  console.log('');
  
  try {
    const channel = await client.channels.fetch(ALERT_CHANNEL_ID);
    console.log('monitoring: #' + channel.name);
  } catch (error) {
    console.error('cant find alert channel, check .env');
    process.exit(1);
  }
  
  console.log('\ntriggers:');
  console.log('  big move: ' + THRESHOLDS.BIG_MOVE + '%+ in 15m');
  console.log('  fast move: ' + THRESHOLDS.FAST_MOVE + '%+ in 5m with volume spike');
  console.log('  min volume: $50k');
  console.log('  cooldown: ' + (COOLDOWN_MS / 60000) + ' min per coin');
  console.log('  scan cycle: continuous with 1min rest\n');
  
  monitorMarket();
});

process.on('unhandledRejection', (error) => {
  console.error('unhandled rejection:', error);
});

client.login(process.env.DISCORD_TOKEN);