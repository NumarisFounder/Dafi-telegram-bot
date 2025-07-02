const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const QRCode = require('qrcode');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

// Security middleware
app.use(helmet());
app.use(bodyParser.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Environment variables with validation
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PAYTABS_SERVER_KEY = process.env.PAYTABS_SERVER_KEY;
const PAYTABS_PROFILE_ID = process.env.PAYTABS_PROFILE_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

// Validate required environment variables
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Enhanced in-memory storage (use Redis/MongoDB in production)
const users = new Map();
const businesses = new Map();
const payments = new Map();
const sessions = new Map();

// Enhanced languages with better translations
const lang = {
  ar: {
    welcome: "🎉 مرحباً بك في DAFI!\n\nمنصة المدفوعات الفورية للشركات الصغيرة والمتوسطة في السعودية\n\n💳 ادفع واستلم بسهولة\n📊 تتبع مبيعاتك\n🔔 إشعارات فورية\n\n🏢 مدعوم من NumAris Ltd.",
    choose_lang: "اختر لغتك / Choose your language:",
    business_register: "📝 تسجيل عملك التجاري",
    create_payment: "💳 إنشاء رابط دفع",
    view_dashboard: "📊 لوحة المبيعات",
    settings: "⚙️ الإعدادات",
    help: "❓ المساعدة",
    enter_business_name: "أدخل اسم عملك التجاري:",
    enter_business_phone: "أدخل رقم هاتف العمل (مثال: +966501234567):",
    enter_amount: "أدخل المبلغ بالريال السعودي (مثال: 100):",
    enter_description: "أدخل وصف المنتج/الخدمة:",
    payment_created: "✅ تم إنشاء رابط الدفع بنجاح!",
    total_sales: "إجمالي المبيعات",
    today_sales: "مبيعات اليوم",
    pending_payments: "المدفوعات المعلقة",
    invalid_amount: "❌ يرجى إدخال مبلغ صحيح (1-50000 ريال)",
    invalid_phone: "❌ يرجى إدخال رقم هاتف صحيح",
    business_registered: "✅ تم تسجيل عملك التجاري بنجاح!",
    register_first: "❌ يرجى تسجيل عملك التجاري أولاً",
    payment_received: "🎉 تم استلام الدفعة!",
    payment_failed: "❌ فشل في الدفع"
  },
  en: {
    welcome: "🎉 Welcome to DAFI!\n\nInstant Payment Platform for Saudi SME\n\n💳 Pay & Receive Instantly\n📊 Track Your Sales\n🔔 Real-time Notifications\n\n🏢 Powered by NumAris Ltd.",
    choose_lang: "اختر لغتك / Choose your language:",
    business_register: "📝 Register Business",
    create_payment: "💳 Create Payment Link",
    view_dashboard: "📊 Sales Dashboard",
    settings: "⚙️ Settings",
    help: "❓ Help",
    enter_business_name: "Enter your business name:",
    enter_business_phone: "Enter business phone number (example: +966501234567):",
    enter_amount: "Enter amount in SAR (example: 100):",
    enter_description: "Enter product/service description:",
    payment_created: "✅ Payment link created successfully!",
    total_sales: "Total Sales",
    today_sales: "Today's Sales",
    pending_payments: "Pending Payments",
    invalid_amount: "❌ Please enter a valid amount (1-50000 SAR)",
    invalid_phone: "❌ Please enter a valid phone number",
    business_registered: "✅ Business registered successfully!",
    register_first: "❌ Please register your business first",
    payment_received: "🎉 Payment Received!",
    payment_failed: "❌ Payment Failed"
  }
};

// Enhanced user session management
function getUser(chatId) {
  if (!users.has(chatId)) {
    users.set(chatId, {
      id: chatId,
      language: 'en',
      step: 'start',
      tempData: {},
      createdAt: new Date(),
      lastActivity: new Date()
    });
  }
  const user = users.get(chatId);
  user.lastActivity = new Date();
  return user;
}

function getUserLang(chatId) {
  const user = getUser(chatId);
  return lang[user.language];
}

// Enhanced validation functions
function validateAmount(amount) {
  const num = parseFloat(amount);
  return !isNaN(num) && num >= 1 && num <= 50000;
}

function validatePhone(phone) {
  // Basic phone validation - can be enhanced
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phone.replace(/\s/g, ''));
}

function validateBusinessName(name) {
  return name && name.trim().length >= 2 && name.trim().length <= 100;
}

// Generate unique payment ID with better entropy
function generatePaymentId() {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `DAFI_${timestamp}_${random}`;
}

// Enhanced PayTabs integration with better error handling
async function createPayTabsPayment(amount, description, orderId, customerInfo) {
  try {
    if (!PAYTABS_SERVER_KEY || !PAYTABS_PROFILE_ID) {
      throw new Error('PayTabs credentials not configured');
    }

    const paymentData = {
      profile_id: PAYTABS_PROFILE_ID,
      tran_type: "sale",
      tran_class: "ecom",
      cart_id: orderId,
      cart_description: description.substring(0, 100), // Limit description length
      cart_currency: "SAR",
      cart_amount: parseFloat(amount).toFixed(2),
      callback: `${WEBHOOK_URL}/paytabs/callback`,
      return: `${WEBHOOK_URL}/paytabs/return`,
      customer_details: {
        name: customerInfo.name || "DAFI Customer",
        email: customerInfo.email || "customer@dafi.sa",
        phone: customerInfo.phone || "+33625265189",
        street1: "Business District",
        city: "Riyadh",
        state: "Riyadh Province",
        country: "SA",
        zip: "12345"
      },
      shipping_details: {
        name: customerInfo.name || "DAFI Customer",
        email: customerInfo.email || "customer@dafi.sa", 
        phone: customerInfo.phone || "+33625265189",
        street1: "Business District",
        city: "Riyadh",
        state: "Riyadh Province",
        country: "SA",
        zip: "12345"
      }
    };

    const response = await axios.post('https://secure.paytabs.sa/payment/request', paymentData, {
      headers: {
        'Authorization': PAYTABS_SERVER_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });

    return response.data;
  } catch (error) {
    console.error('PayTabs error:', error.response?.data || error.message);
    throw new Error('Payment processing temporarily unavailable');
  }
}

// Enhanced QR Code generation
async function generateQR(text) {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
  } catch (error) {
    console.error('QR generation error:', error);
    return null;
  }
}

// Enhanced keyboard functions
function getMainMenu(chatId) {
  const l = getUserLang(chatId);
  return {
    keyboard: [
      [
        { text: l.business_register },
        { text: l.create_payment }
      ],
      [
        { text: l.view_dashboard },
        { text: l.settings }
      ],
      [{ text: l.help }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getLanguageKeyboard() {
  return {
    keyboard: [
      [
        { text: "🇸🇦 العربية" },
        { text: "🇺🇸 English" }
      ]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

// Enhanced error handling wrapper
function handleBotError(chatId, error, l) {
  console.error('Bot error:', error);
  const errorMessage = l.language === 'ar' 
    ? "❌ حدث خطأ. يرجى المحاولة مرة أخرى."
    : "❌ An error occurred. Please try again.";
  
  bot.sendMessage(chatId, errorMessage, {
    reply_markup: getMainMenu(chatId)
  }).catch(console.error);
}

// Bot command handlers with enhanced error handling
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = getUser(chatId);
     await bot.sendMessage(chatId, "Hello! Please choose your language", {
      reply_markup: getLanguageKeyboard()
        });
  } catch (error) {
    console.error('Start command error:', error);
  }
});

// Enhanced message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  if (!text || text.startsWith('/')) return;
  
  try { 
    const user = getUser(chatId);
    const l = getUserLang(chatId);

    // Language selection
    if (text === "🇸🇦 العربية") {
      user.language = 'ar';
      users.set(chatId, user);
      const newL = getUserLang(chatId);
      await bot.sendMessage(chatId, newL.welcome, {
        reply_markup: getMainMenu(chatId)
      });
      return;
    }

    if (text === "🇺🇸 English") {
      user.language = 'en';
      users.set(chatId, user);
      const newL = getUserLang(chatId);
      await bot.sendMessage(chatId, newL.welcome, {
        reply_markup: getMainMenu(chatId)
      });
      return;
    }

    // Business registration flow
    if (text === l.business_register) {
      user.step = 'register_name';
      users.set(chatId, user);
      await bot.sendMessage(chatId, l.enter_business_name, {
        reply_markup: { remove_keyboard: true }
      });
      return;
    }

    if (user.step === 'register_name') {
      if (!validateBusinessName(text)) {
        await bot.sendMessage(chatId, "❌ Please enter a valid business name (2-100 characters)");
        return;
      }
      user.tempData.businessName = text.trim();
      user.step = 'register_phone';
      users.set(chatId, user);
      await bot.sendMessage(chatId, l.enter_business_phone);
      return;
    }

    if (user.step === 'register_phone') {
      if (!validatePhone(text)) {
        await bot.sendMessage(chatId, l.invalid_phone);
        return;
      }
      
      // Save business
      const businessId = 'BIZ_' + chatId;
      businesses.set(businessId, {
        id: businessId,
        ownerId: chatId,
        name: user.tempData.businessName,
        phone: text.trim(),
        createdAt: new Date(),
        totalSales: 0,
        todaySales: 0,
        transactionCount: 0
      });

      user.step = 'main';
      user.tempData = {};
      users.set(chatId, user);

      await bot.sendMessage(chatId, `${l.business_registered}\n\n🎉 ${user.tempData.businessName || 'Your business'} is ready to accept payments!`, {
        reply_markup: getMainMenu(chatId)
      });
      return;
    }

    // Payment creation flow
    if (text === l.create_payment) {
      const businessId = 'BIZ_' + chatId;
      if (!businesses.has(businessId)) {
        await bot.sendMessage(chatId, l.register_first, {
          reply_markup: getMainMenu(chatId)
        });
        return;
      }
      
      user.step = 'payment_amount';
      users.set(chatId, user);
      await bot.sendMessage(chatId, l.enter_amount, {
        reply_markup: { remove_keyboard: true }
      });
      return;
    }

    if (user.step === 'payment_amount') {
      if (!validateAmount(text)) {
        await bot.sendMessage(chatId, l.invalid_amount);
        return;
      }
      user.tempData.amount = parseFloat(text);
      user.step = 'payment_description';
      users.set(chatId, user);
      await bot.sendMessage(chatId, l.enter_description);
      return;
    }

    if (user.step === 'payment_description') {
      const paymentId = generatePaymentId();
      const amount = user.tempData.amount;
      const description = text.trim();

      // Create payment record
      payments.set(paymentId, {
        id: paymentId,
        merchantId: chatId,
        amount: amount,
        description: description,
        status: 'pending',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
      });

      // Create payment link
      const paymentUrl = `${WEBHOOK_URL}/pay/${paymentId}`;

      user.step = 'main';
      user.tempData = {};
      users.set(chatId, user);

      // Generate QR code
      try {
        const qrImage = await generateQR(paymentUrl);
        const message = `${l.payment_created}\n\n💰 Amount: ${amount} SAR\n📝 Description: ${description}\n\n🔗 Payment Link:\n${paymentUrl}\n\n📱 Share this QR code with customers:`;
        
        if (qrImage) {
          const qrBuffer = Buffer.from(qrImage.split(',')[1], 'base64');
          await bot.sendPhoto(chatId, qrBuffer, {
            caption: message,
            reply_markup: getMainMenu(chatId)
          });
        } else {
          await bot.sendMessage(chatId, message, {
            reply_markup: getMainMenu(chatId)
          });
        }
      } catch (error) {
        handleBotError(chatId, error, l);
      }
      return;
    }

    // Dashboard
    if (text === l.view_dashboard) {
      const businessId = 'BIZ_' + chatId;
      const business = businesses.get(businessId);

      if (!business) {
        await bot.sendMessage(chatId, l.register_first, {
          reply_markup: getMainMenu(chatId)
        });
        return;
      }

      const userPayments = Array.from(payments.values()).filter(p => p.merchantId === chatId);
      const totalSales = userPayments.filter(p => p.status === 'completed').reduce((sum, p) => sum + p.amount, 0);

      const today = new Date().toDateString();
      const todaySales = userPayments
        .filter(p => p.status === 'completed' && p.createdAt.toDateString() === today)
        .reduce((sum, p) => sum + p.amount, 0);

      const pendingCount = userPayments.filter(p => p.status === 'pending').length;

      const dashboard = `📊 *${business.name} Dashboard*\n\n` +
        `💰 ${l.total_sales}: ${totalSales.toFixed(2)} SAR\n` +
        `📅 ${l.today_sales}: ${todaySales.toFixed(2)} SAR\n` +
        `⏳ ${l.pending_payments}: ${pendingCount}\n` +
        `📈 Total Transactions: ${business.transactionCount}\n\n` +
        `🚀 Keep growing with DAFI!`;

      await bot.sendMessage(chatId, dashboard, {
        parse_mode: 'Markdown',
        reply_markup: getMainMenu(chatId)
      });
      return;
    }

    // Help
    if (text === l.help) {
      const helpText = user.language === 'ar'
        ? `🔥 *مساعدة DAFI*\n\n📝 *تسجيل العمل:* سجل بيانات عملك التجاري\n💳 *إنشاء رابط دفع:* أنشئ روابط دفع فورية\n📊 *لوحة المبيعات:* تتبع مبيعاتك ودخلك\n\n🆘 *المساعدة التقنية:*\n📧 altyn13@icloud.com\n📱 +33 6 25 26 51 89\n\n🏢 *NumAris Ltd.*\nRegistered in AIFC, Kazakhstan\nReg: 250440900597`
        : `🔥 *DAFI Help*\n\n📝 *Register Business:* Add your business details\n💳 *Create Payment:* Generate instant payment links\n📊 *Dashboard:* Track sales and revenue\n\n🆘 *Technical Support:*\n📧 altyn13@icloud.com\n📱 +33 6 25 26 51 89\n\n🏢 *NumAris Ltd.*\nRegistered in AIFC, Kazakhstan\nReg: 250440900597`;

      await bot.sendMessage(chatId, helpText, {
        parse_mode: 'Markdown',
        reply_markup: getMainMenu(chatId)
      });
      return;
    }

    // Settings
    if (text === l.settings) {
      await bot.sendMessage(chatId, lang.en.choose_lang, {
        reply_markup: getLanguageKeyboard()
      });
      return;
    }

  } catch (error) {
    handleBotError(chatId, error, getUserLang(chatId));
  }
});

// Enhanced webhook endpoints with security
app.get('/pay/:paymentId', async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const payment = payments.get(paymentId);

    if (!payment) {
      return res.status(404).send(`
        <html>
          <body style="text-align: center; font-family: Arial; padding: 50px;">
            <h2>❌ Payment Not Found</h2>
            <p>This payment link is invalid or has expired.</p>
            <p style="color: #666;">Powered by NumAris Ltd.</p>
          </body>
        </html>
      `);
    }

    if (payment.status !== 'pending') {
      return res.send(`
        <html>
          <body style="text-align: center; font-family: Arial; padding: 50px;">
            <h2>Payment ${payment.status}</h2>
            <p>This payment has already been processed.</p>
            <p style="color: #666;">Powered by NumAris Ltd.</p>
          </body>
        </html>
      `);
    }

    // Check if payment expired
    if (payment.expiresAt && new Date() > payment.expiresAt) {
      payment.status = 'expired';
      payments.set(paymentId, payment);
      return res.send(`
        <html>
          <body style="text-align: center; font-family: Arial; padding: 50px;">
            <h2>⏰ Payment Expired</h2>
            <p>This payment link has expired.</p>
            <p style="color: #666;">Powered by NumAris Ltd.</p>
          </body>
        </html>
      `);
    }

    // If PayTabs not configured, show demo page
    if (!PAYTABS_SERVER_KEY || !PAYTABS_PROFILE_ID) {
      return res.send(`
        <html>
          <body style="text-align: center; font-family: Arial; padding: 50px;">
            <h2>💳 DAFI Payment Demo</h2>
            <p><strong>Amount:</strong> ${payment.amount} SAR</p>
            <p><strong>Description:</strong> ${payment.description}</p>
            <br>
            <p style="color: #666;">PayTabs integration pending approval</p>
            <p style="color: #666;">Powered by NumAris Ltd.</p>
          </body>
        </html>
      `);
    }

    // Create PayTabs payment
    const paytabsResponse = await createPayTabsPayment(
      payment.amount,
      payment.description,
      paymentId,
      { name: "DAFI Customer", phone: "+33625265189" }
    );

    if (paytabsResponse.redirect_url) {
      res.redirect(paytabsResponse.redirect_url);
    } else {
      res.status(500).send(`
        <html>
          <body style="text-align: center; font-family: Arial; padding: 50px;">
            <h2>❌ Payment Error</h2>
            <p>Unable to process payment at this time.</p>
            <p>Please try again later.</p>
            <p style="color: #666;">Powered by NumAris Ltd.</p>
          </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('Payment page error:', error);
    res.status(500).send(`
      <html>
        <body style="text-align: center; font-family: Arial; padding: 50px;">
          <h2>❌ Service Temporarily Unavailable</h2>
          <p>Please try again later.</p>
          <p style="color: #666;">Powered by NumAris Ltd.</p>
        </body>
      </html>
    `);
  }
});

// Enhanced PayTabs callback with security
app.post('/paytabs/callback', (req, res) => {
  try {
    const { tran_ref, payment_result, cart_id } = req.body;

    const payment = payments.get(cart_id);
    if (!payment) {
      return res.status(404).send('Payment not found');
    }

    if (payment_result && payment_result.response_status === 'A') {
      // Payment successful
      payment.status = 'completed';
      payment.transactionRef = tran_ref;
      payment.completedAt = new Date();
      payments.set(cart_id, payment);

      // Notify merchant
      const l = getUserLang(payment.merchantId);
      const message = `🎉 ${l.payment_received}\n\n💰 Amount: ${payment.amount} SAR\n📝 ${payment.description}\n🔗 Transaction: ${tran_ref}\n\n✅ Payment completed successfully!`;

      bot.sendMessage(payment.merchantId, message).catch(console.error);

      // Update business stats
      const businessId = 'BIZ_' + payment.merchantId;
      const business = businesses.get(businessId);
      if (business) {
        business.totalSales += payment.amount;
        business.todaySales += payment.amount;
        business.transactionCount += 1;
        businesses.set(businessId, business);
      }
    } else {
      // Payment failed
      payment.status = 'failed';
      payment.failureReason = payment_result?.response_message || 'Unknown error';
      payments.set(cart_id, payment);

      const l = getUserLang(payment.merchantId);
      bot.sendMessage(payment.merchantId, `❌ ${l.payment_failed}\n💰 ${payment.amount} SAR\n📝 ${payment.description}`).catch(console.error);
    }

    res.send('OK');
  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).send('Error');
  }
});

// PayTabs return URL
app.get('/paytabs/return', (req, res) => {
  res.send(`
    <html>
      <body style="text-align: center; font-family: Arial; padding: 50px;">
        <h2>✅ Payment Processed</h2>
        <p>Thank you for using DAFI!</p>
        <p>You can close this window.</p>
        <br>
        <p style="color: #666;">Powered by NumAris Ltd.</p>
        <script>
          setTimeout(() => {
            window.close();
          }, 3000);
        </script>
      </body>
    </html>
  `);
});

// Enhanced health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'DAFI Telegram Bot',
    company: 'NumAris Ltd.',
    version: '1.0.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    stats: {
      users: users.size,
      businesses: businesses.size,
      payments: payments.size
    }
  });
});

// API endpoints for monitoring
app.get('/api/stats', (req, res) => {
  const totalPayments = Array.from(payments.values());
  const completedPayments = totalPayments.filter(p => p.status === 'completed');
  const totalRevenue = completedPayments.reduce((sum, p) => sum + p.amount, 0);

  res.json({
    users: users.size,
    businesses: businesses.size,
    totalPayments: totalPayments.length,
    completedPayments: completedPayments.length,
    totalRevenue: totalRevenue,
    timestamp: new Date().toISOString()
  });
});

// Webhook endpoint for Telegram
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Express error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 DAFI Telegram Bot running on port ${PORT}`);
  console.log(`🏢 NumAris Ltd. - AIFC, Kazakhstan`);
  console.log(`💳 Saudi Payment Platform Ready!`);
  console.log(`📧 Support: altyn13@icloud.com`);
  console.log(`📱 Phone: +33 6 25 26 51 89`);

  // Set webhook if URL is provided
  if (WEBHOOK_URL && BOT_TOKEN) {
    bot.setWebHook(`${WEBHOOK_URL}/webhook/${BOT_TOKEN}`)
      .then(() => console.log('✅ Webhook set successfully'))
      .catch(err => console.error('❌ Webhook setup failed:', err));
  }
});

module.exports = app;

