
// main test-file

const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
require("dotenv").config();

// ====== Config from environment ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const GROUP_ID = process.env.GROUP_ID;
const ADMIN_ID = process.env.ADMIN_ID;

// Safety fallback for BASE_URL
let BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  if (process.env.RENDER_EXTERNAL_URL) {
    BASE_URL = process.env.RENDER_EXTERNAL_URL;
  } else if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
    BASE_URL = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
  } else {
    // Railway URL fallback
    BASE_URL = "https://dailykamai-bot.up.railway.app";
    // console.log("⚠️ BASE_URL not set. Using fallback:", BASE_URL);
  }
}

if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID) {
  console.error(
    "Missing required env vars. Set BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID."
  );
  process.exit(1);
}

// console.log("🌍 Using BASE_URL:", BASE_URL);

// ====== Constants ======
const AD_REWARD = 3; // ₹3 per ad
const REFERRAL_REWARD = 50; // ₹50 per referral
const DAILY_LIMIT = 20; // 20 ads/day
const AD_SECONDS = 30; // 30s required
const MIN_WITHDRAW = 500; // ₹500 min
const MIN_REFERRALS = 5; // 5 referrals
const ADVANCED_REFERRALS = 15; // 15 referrals for full withdrawal
const MIN_DAYS_FOR_WITHDRAW = 3; // 3 days since firstSeen

// ====== Setup Express & Bot ======
const app = express();
app.use(express.static(path.join(__dirname, "public")));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ====== MongoDB Setup ======
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

// Drop old indexes to avoid duplicate-null unique errors (runs once when db opens)
mongoose.connection.once("open", async () => {
  try {
    const cols = await mongoose.connection.db.collections();
    for (const c of cols) {
      if (c.collectionName === "users") {
        // console.log("🧹 Dropping 'users' indexes (if any) ...");
        await c.dropIndexes().catch(() => {});
      }
    }
  } catch (e) {
    // console.warn("Index cleanup warning:", e.message || e);
  }
});

// ====== User schema ======
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true },
  firstSeen: { type: Date, default: Date.now },
  balance: { type: Number, default: 0 },
  referralCount: { type: Number, default: 0 },
  referredBy: { type: Number, default: null },
  upi: { type: String, default: "" },
  adsWatchedToday: { type: Number, default: 0 },
  lastAdAt: { type: Date, default: null },
  lastReset: { type: Date, default: () => new Date() },
  joinedGroup: { type: Boolean, default: false },
  firstName: { type: String, default: "" },
});

const User = mongoose.model("User", userSchema);

// ====== Reply keyboard (buttons below typing area) ======
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      ["🎬 Ad Dekho", "💰 Balance"],
      ["👥 Refer & Earn", "🏦 Withdraw Funds"],
      ["🎁 Join Group"],
    ],
    resize_keyboard: true,
  },
};

// ====== Helpers ======
async function ensureUser(telegramId, firstName) {
  let u = await User.findOne({ telegramId });
  if (!u) {
    u = new User({ telegramId, firstSeen: new Date() });
    if (firstName) u.firstName = firstName;
    await u.save();
  }
  return u;
}

async function resetDailyIfNeeded(user) {
  const now = new Date();
  if (!user.lastReset || now.toDateString() !== new Date(user.lastReset).toDateString()) {
    user.adsWatchedToday = 0;
    user.lastReset = now;
    await user.save();
  }
}

async function ensureGroupFlag(user) {
  try {
    const member = await bot.getChatMember(String(GROUP_ID), user.telegramId).catch(() => null);
    if (member && ["member", "administrator", "creator"].includes(member.status)) {
      if (!user.joinedGroup) {
        user.joinedGroup = true;
        await user.save();
      }
      return true;
    }
  } catch (e) {}
  return false;
}

// escape HTML to avoid injection when including dynamic strings (UPI, names)
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ====== Cron: daily reset at midnight server time ======
cron.schedule("0 0 * * *", async () => {
  try {
    await User.updateMany({}, { $set: { adsWatchedToday: 0, lastReset: new Date() } });
    // console.log("🔁 Daily reset: adsWatchedToday cleared");
  } catch (e) {
    // console.error("Daily reset error:", e);
  }
});

// ====== /start handler (supports referral code) ======
bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const refId = match && match[1] ? Number(match[1]) : null;

  try {
    let user = await User.findOne({ telegramId });

    // If user doesn’t exist → show greeting & stop here
    if (!user) {
      user = new User({ telegramId, firstSeen: new Date(), firstName: msg.from.first_name });
      await user.save();

      const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\n💬 Suru karne ke liye <b>/start</b> message bheje.`;
      return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
    }

    // Existing user flow
    if (refId && refId !== telegramId) {
      const refUser = await User.findOne({ telegramId: refId });
      if (refUser && !user.referredBy) {
        refUser.balance += REFERRAL_REWARD;
        refUser.referralCount += 1;
        await refUser.save();

        user.referredBy = refId;
        await user.save();

        try {
          await bot.sendMessage(
            refUser.telegramId,
            `🎉 You earned ₹${REFERRAL_REWARD} for referring a friend!`,
            { parse_mode: "HTML" }
          );
        } catch {}
      }
    }

    const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nAap yahan video ads dekh kar paise kama sakte hain. Har ad ke liye ₹${AD_REWARD} milta hai. Doston ko refer karke ₹${REFERRAL_REWARD} kamaaye.\n\nNiche diye gaye options me se choose karein. suru karne ke liye /start chat me bheje `;
    await bot.sendMessage(chatId, welcome, { parse_mode: "HTML", ...mainKeyboard });
  } catch (err) {
    console.error("Start error:", err);
    bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again.");
  }
});

// ====== Broadcast (admin only) ======
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const text = match[1].trim();
  const users = await User.find({}, "telegramId");
  let sent = 0;
  for (const u of users) {
    try {
      await bot.sendMessage(u.telegramId, `📢 <b>Admin Broadcast</b>\n\n${escapeHtml(text)}`, { parse_mode: "HTML" });
      sent++;
    } catch {}
  }
  bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sent} users.`);
});

// ====== Callback queries for pre-ad and pre-ref interactions ======
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const telegramId = q.from.id;
  const data = q.data;

  if (data === "pre_ad") {
    const text = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milega.\n\n⚠️ Video khatam hone tak tab close na karein.\n\nNiche diye gaye button se ad dekhe.`;
    const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
    await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]] } });
    await bot.answerCallbackQuery(q.id);
    return;
  }

  if (data === "pre_ref") {
    const user = await ensureUser(telegramId);
    const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
    const text = `👥 Invite karke ₹${REFERRAL_REWARD} kamaaye!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link:`;
    await bot.sendMessage(chatId, `${text}\n${refLink}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📤 Apne doston ko invite karein", switch_inline_query: `Join DailyKamai! ${refLink}` }]] } });
    await bot.answerCallbackQuery(q.id);
    return;
  }

  await bot.answerCallbackQuery(q.id);
});

// ====== Handle reply-keyboard messages (main flow) ======
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  if (text.startsWith("/start")) return;

  const user = await ensureUser(telegramId, msg.from.first_name);
  await resetDailyIfNeeded(user);

  const joined = await ensureGroupFlag(user);
  if (!joined) {
    return bot.sendMessage(chatId, `📢 Aapko features use karne ke liye hamare Telegram group join karna zaroori hai.\n\nClick below to join and then come back.`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] } });
  }

  // ===== 🎬 Ad Dekho =====
  if (text === "🎬 Ad Dekho") {
    if (user.adsWatchedToday >= DAILY_LIMIT) return bot.sendMessage(chatId, `🚫 Aapne aaj ${DAILY_LIMIT} ads dekh liye hain. Kal fir se try karein.`, { parse_mode: "HTML", ...mainKeyboard });
    const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
    return bot.sendMessage(chatId, `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milenge.\nVideo khatam hone tak tab close na karein.\n\nNiche button se ad dekhiye.`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "▶️ Watch Ad", url: adUrl }]] } });
  }

  // ===== 💰 Balance =====
  if (text === "💰 Balance") return bot.sendMessage(chatId, `<b>💰 Aapka Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });

  // ===== 👥 Refer & Earn =====
  if (text === "👥 Refer & Earn") {
    const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
    return bot.sendMessage(chatId, `👥 Refer & Earn ₹${REFERRAL_REWARD}!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link: ${refLink}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📤 Apne doston ko invite karein", switch_inline_query: `Join DailyKamai! ${refLink}` }]] } });
  }

  // ===== 🏦 Withdraw Funds =====
  if (text === "🏦 Withdraw Funds") {
    if (!user.upi) {
      const sent = await bot.sendMessage(chatId, "🏦 Send your UPI ID (name@bank).", { parse_mode: "HTML", reply_markup: { force_reply: true } });
      const listener = async (m) => { if (!m.text || m.from.id !== telegramId) return; if (!m.reply_to_message || m.reply_to_message.message_id !== sent.message_id) return; user.upi = m.text.trim(); await user.save(); bot.sendMessage(chatId, `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`, { parse_mode: "HTML", ...mainKeyboard }); bot.removeListener("message", listener); };
      bot.on("message", listener);
      return;
    }

    if (user.balance < MIN_WITHDRAW) return bot.sendMessage(chatId, `⚠️ Minimum ₹${MIN_WITHDRAW} needed. Your balance: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard });
    if (user.referralCount < MIN_REFERRALS) return bot.sendMessage(chatId, `👥 Need at least ${MIN_REFERRALS} referrals. Yours: ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });
    if (user.referralCount < ADVANCED_REFERRALS) return bot.sendMessage(chatId, `👥 Full withdrawal allowed after ${ADVANCED_REFERRALS} referrals. Yours: ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });

    const days = Math.floor((Date.now() - new Date(user.firstSeen).getTime()) / (1000*60*60*24));
    if (days < MIN_DAYS_FOR_WITHDRAW) return bot.sendMessage(chatId, `⏳ Withdrawal allowed after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} left)`, { parse_mode: "HTML", ...mainKeyboard });

    const payout = user.balance; user.balance = 0; await user.save();
    return bot.sendMessage(chatId, `✅ Withdrawal request placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`, { parse_mode: "HTML", ...mainKeyboard });
  }

  // ===== 🎁 Join Group =====
  if (text === "🎁 Join Group") return bot.sendMessage(chatId, `📢 Join our official Telegram group for updates and withdrawal announcements:`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] } });

  return bot.sendMessage(chatId, "Menu se koi option choose karein.", { parse_mode: "HTML", ...mainKeyboard });
});

// ====== Express endpoints ======

// ✅ Fixed /ad route
const adFilePath = path.join(__dirname, "public", "ad.html");
app.get("/ad", (req, res) => {
  res.sendFile(adFilePath, (err) => {
    if (err) {
      console.error("Error sending ad.html:", err);
      res.status(500).send("❌ Could not load ad page");
    }
  });
});

app.get("/reward", async (req, res) => {
  try {
    const userId = Number(req.query.user);
    if (!userId) return res.status(400).send("Missing user");
    const user = await User.findOne({ telegramId: userId });
    if (!user) return res.status(404).send("User not found");

    await resetDailyIfNeeded(user);
    if (user.adsWatchedToday >= DAILY_LIMIT) return res.status(429).send("Daily limit reached");

    const now = new Date();
    if (user.lastAdAt && now.getTime() - new Date(user.lastAdAt).getTime() < (AD_SECONDS - 1) * 1000) return res.status(429).send("Too soon");

    user.balance += AD_REWARD;
    user.adsWatchedToday += 1;
    user.lastAdAt = new Date();
    await user.save();

    try { await bot.sendMessage(user.telegramId, `🎉 You earned ₹${AD_REWARD}. Balance: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard }); } catch {}

    return res.send("OK");
  } catch (e) { console.error("Reward error:", e); return res.status(500).send("Server error"); }
});

// ====== Health check ======
app.get("/", (req, res) => res.send("✅ DailyKamai bot is running!"));
app.get("/health-check", (req, res) => res.status(200).send("✅ Alive and healthy!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => { /* console.log(`🌐 Web server running on port ${PORT}`); */ });

// app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server running on port ${PORT}`));
console.log("🤖 DailyKamai Bot is running...");

// ====== Keep-alive ping ======
cron.schedule("*/5 * * * *", async () => {
  try {
    const res = await fetch(`${BASE_URL}/health-check`);
    if (res.ok) console.log(`🟢 Keep-alive OK at ${new Date().toLocaleTimeString()}`);
    else console.log(`🟠 Keep-alive failed: HTTP ${res.status}`);
  } catch (err) {
    console.error(`🔴 Keep-alive error: ${err.message}`);
  }
});


// end test-file



// New test->
// index.js — DailyKamai final (bot + express + ad verification)
// Requires environment variables: BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL

// const express = require("express");
// const path = require("path");
// const mongoose = require("mongoose");
// const TelegramBot = require("node-telegram-bot-api");
// const cron = require("node-cron");
// require("dotenv").config();

// // ====== Config from environment ======
// const BOT_TOKEN = process.env.BOT_TOKEN;
// const MONGO_URI = process.env.MONGO_URI;
// const GROUP_ID = process.env.GROUP_ID;
// const ADMIN_ID = process.env.ADMIN_ID;

// // Safety fallback for BASE_URL
// let BASE_URL = process.env.BASE_URL;
// if (!BASE_URL) {
//   if (process.env.RENDER_EXTERNAL_URL) {
//     BASE_URL = process.env.RENDER_EXTERNAL_URL;
//   } else if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
//     BASE_URL = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
//   } else {
//     // Railway URL fallback
//     BASE_URL = "https://dailykamai-bot.up.railway.app";
//     console.log("⚠️ BASE_URL not set. Using fallback:", BASE_URL);
//   }
// }

// if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID) {
//   console.error(
//     "Missing required env vars. Set BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID."
//   );
//   process.exit(1);
// }

// console.log("🌍 Using BASE_URL:", BASE_URL);

// // ====== Constants ======
// const AD_REWARD = 3; // ₹3 per ad
// const REFERRAL_REWARD = 50; // ₹50 per referral
// const DAILY_LIMIT = 20; // 20 ads/day
// const AD_SECONDS = 30; // 30s required
// const MIN_WITHDRAW = 500; // ₹500 min
// const MIN_REFERRALS = 5; // 5 referrals
// const ADVANCED_REFERRALS = 15; // 15 referrals for full withdrawal
// const MIN_DAYS_FOR_WITHDRAW = 3; // 3 days since firstSeen

// // ====== Setup Express & Bot ======
// const app = express();
// app.use(express.static(path.join(__dirname, "public")));

// const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// // ====== MongoDB Setup ======
// mongoose
//   .connect(MONGO_URI)
//   .then(() => console.log("✅ MongoDB connected"))
//   .catch((err) => {
//     console.error("❌ MongoDB connection error:", err);
//     process.exit(1);
//   });

// // Drop old indexes to avoid duplicate-null unique errors (runs once when db opens)
// mongoose.connection.once("open", async () => {
//   try {
//     const cols = await mongoose.connection.db.collections();
//     for (const c of cols) {
//       if (c.collectionName === "users") {
//         console.log("🧹 Dropping 'users' indexes (if any) ...");
//         await c.dropIndexes().catch(() => {});
//       }
//     }
//   } catch (e) {
//     console.warn("Index cleanup warning:", e.message || e);
//   }
// });

// // ====== User schema ======
// const userSchema = new mongoose.Schema({
//   telegramId: { type: Number, unique: true, required: true },
//   firstSeen: { type: Date, default: Date.now },
//   balance: { type: Number, default: 0 },
//   referralCount: { type: Number, default: 0 },
//   referredBy: { type: Number, default: null },
//   upi: { type: String, default: "" },
//   adsWatchedToday: { type: Number, default: 0 },
//   lastAdAt: { type: Date, default: null },
//   lastReset: { type: Date, default: () => new Date() },
//   joinedGroup: { type: Boolean, default: false },
//   firstName: { type: String, default: "" },
// });

// const User = mongoose.model("User", userSchema);

// // ====== Reply keyboard (buttons below typing area) ======
// const mainKeyboard = {
//   reply_markup: {
//     keyboard: [
//       ["🎬 Ad Dekho", "💰 Balance"],
//       ["👥 Refer & Earn", "🏦 Withdraw Funds"],
//       ["🎁 Join Group"],
//     ],
//     resize_keyboard: true,
//   },
// };

// // ====== Helpers ======
// async function ensureUser(telegramId, firstName) {
//   let u = await User.findOne({ telegramId });
//   if (!u) {
//     u = new User({ telegramId, firstSeen: new Date() });
//     if (firstName) u.firstName = firstName;
//     await u.save();
//   }
//   return u;
// }

// async function resetDailyIfNeeded(user) {
//   const now = new Date();
//   if (!user.lastReset || now.toDateString() !== new Date(user.lastReset).toDateString()) {
//     user.adsWatchedToday = 0;
//     user.lastReset = now;
//     await user.save();
//   }
// }

// async function ensureGroupFlag(user) {
//   try {
//     const member = await bot.getChatMember(String(GROUP_ID), user.telegramId).catch(() => null);
//     if (member && ["member", "administrator", "creator"].includes(member.status)) {
//       if (!user.joinedGroup) {
//         user.joinedGroup = true;
//         await user.save();
//       }
//       return true;
//     }
//   } catch (e) {}
//   return false;
// }

// // escape HTML to avoid injection when including dynamic strings (UPI, names)
// function escapeHtml(text) {
//   if (!text) return "";
//   return String(text)
//     .replace(/&/g, "&amp;")
//     .replace(/</g, "&lt;")
//     .replace(/>/g, "&gt;");
// }

// // ====== Cron: daily reset at midnight server time ======
// cron.schedule("0 0 * * *", async () => {
//   try {
//     await User.updateMany({}, { $set: { adsWatchedToday: 0, lastReset: new Date() } });
//     console.log("🔁 Daily reset: adsWatchedToday cleared");
//   } catch (e) {
//     console.error("Daily reset error:", e);
//   }
// });

// // ====== /start handler (supports referral code) ======
// bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
//   const chatId = msg.chat.id;
//   const telegramId = msg.from.id;
//   const refId = match && match[1] ? Number(match[1]) : null;

//   try {
//     let user = await User.findOne({ telegramId });

//     // If user doesn’t exist → show greeting & stop here
//     if (!user) {
//       user = new User({ telegramId, firstSeen: new Date(), firstName: msg.from.first_name });
//       await user.save();

//       const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\n💬 Suru karne ke liye <b>/start</b> message bheje.`;
//       return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
//     }

//     // Existing user flow
//     if (refId && refId !== telegramId) {
//       const refUser = await User.findOne({ telegramId: refId });
//       if (refUser && !user.referredBy) {
//         refUser.balance += REFERRAL_REWARD;
//         refUser.referralCount += 1;
//         await refUser.save();

//         user.referredBy = refId;
//         await user.save();

//         try {
//           await bot.sendMessage(
//             refUser.telegramId,
//             `🎉 You earned ₹${REFERRAL_REWARD} for referring a friend!`,
//             { parse_mode: "HTML" }
//           );
//         } catch {}
//       }
//     }

//     const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nWatch ads to earn ₹${AD_REWARD} per ad.\nRefer friends to earn ₹${REFERRAL_REWARD}.\n\nChoose an option below.`;
//     await bot.sendMessage(chatId, welcome, { parse_mode: "HTML", ...mainKeyboard });
//   } catch (err) {
//     console.error("Start error:", err);
//     bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again.");
//   }
// });

// // ====== Broadcast (admin only) ======
// bot.onText(/\/broadcast (.+)/, async (msg, match) => {
//   if (String(msg.from.id) !== String(ADMIN_ID)) return;
//   const text = match[1].trim();
//   const users = await User.find({}, "telegramId");
//   let sent = 0;
//   for (const u of users) {
//     try {
//       await bot.sendMessage(u.telegramId, `📢 <b>Admin Broadcast</b>\n\n${escapeHtml(text)}`, { parse_mode: "HTML" });
//       sent++;
//     } catch {}
//   }
//   bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sent} users.`);
// });

// // ====== Callback queries for pre-ad and pre-ref interactions ======
// bot.on("callback_query", async (q) => {
//   const chatId = q.message.chat.id;
//   const telegramId = q.from.id;
//   const data = q.data;

//   if (data === "pre_ad") {
//     const text = `🎬 Earn ₹${AD_REWARD} for watching an ad.\nDo not close until video ends.`;
//     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
//     await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "▶️ Watch Ad", url: adUrl }]] } });
//     await bot.answerCallbackQuery(q.id);
//     return;
//   }

//   if (data === "pre_ref") {
//     const user = await ensureUser(telegramId);
//     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
//     const text = `👥 Invite and earn ₹${REFERRAL_REWARD}!\nInvited so far: ${user.referralCount}\nYour referral link:`;
//     await bot.sendMessage(chatId, `${text}\n${refLink}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📤 Invite friends", switch_inline_query: `Join DailyKamai! ${refLink}` }]] } });
//     await bot.answerCallbackQuery(q.id);
//     return;
//   }

//   await bot.answerCallbackQuery(q.id);
// });

// // ====== Handle reply-keyboard messages (main flow) ======
// bot.on("message", async (msg) => {
//   if (!msg.text) return;
//   const text = msg.text.trim();
//   const chatId = msg.chat.id;
//   const telegramId = msg.from.id;

//   if (text.startsWith("/start")) return;

//   const user = await ensureUser(telegramId, msg.from.first_name);
//   await resetDailyIfNeeded(user);

//   const joined = await ensureGroupFlag(user);
//   if (!joined) {
//     return bot.sendMessage(chatId, `📢 Join our Telegram group to use features.`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] } });
//   }

//   // ===== 🎬 Ad Dekho =====
//   if (text === "🎬 Ad Dekho") {
//     if (user.adsWatchedToday >= DAILY_LIMIT) return bot.sendMessage(chatId, `🚫 Daily limit ${DAILY_LIMIT} reached. Try tomorrow.`, { parse_mode: "HTML", ...mainKeyboard });
//     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
//     return bot.sendMessage(chatId, `🎬 Earn ₹${AD_REWARD} per ad.`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "▶️ Watch Ad", url: adUrl }]] } });
//   }

//   // ===== 💰 Balance =====
//   if (text === "💰 Balance") return bot.sendMessage(chatId, `<b>💰 Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });

//   // ===== 👥 Refer & Earn =====
//   if (text === "👥 Refer & Earn") {
//     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
//     return bot.sendMessage(chatId, `👥 Refer & earn ₹${REFERRAL_REWARD}!\nYour referrals: ${user.referralCount}\nLink: ${refLink}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📤 Invite", switch_inline_query: `Join DailyKamai! ${refLink}` }]] } });
//   }

//   // ===== 🏦 Withdraw Funds =====
//   if (text === "🏦 Withdraw Funds") {
//     if (!user.upi) {
//       const sent = await bot.sendMessage(chatId, "🏦 Send your UPI ID (name@bank).", { parse_mode: "HTML", reply_markup: { force_reply: true } });
//       const listener = async (m) => { if (!m.text || m.from.id !== telegramId) return; if (!m.reply_to_message || m.reply_to_message.message_id !== sent.message_id) return; user.upi = m.text.trim(); await user.save(); bot.sendMessage(chatId, `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`, { parse_mode: "HTML", ...mainKeyboard }); bot.removeListener("message", listener); };
//       bot.on("message", listener);
//       return;
//     }

//     if (user.balance < MIN_WITHDRAW) return bot.sendMessage(chatId, `⚠️ Minimum ₹${MIN_WITHDRAW} needed. Your balance: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard });
//     if (user.referralCount < MIN_REFERRALS) return bot.sendMessage(chatId, `👥 Need at least ${MIN_REFERRALS} referrals. Yours: ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });
//     if (user.referralCount < ADVANCED_REFERRALS) return bot.sendMessage(chatId, `👥 Full withdrawal allowed after ${ADVANCED_REFERRALS} referrals. Yours: ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });

//     const days = Math.floor((Date.now() - new Date(user.firstSeen).getTime()) / (1000*60*60*24));
//     if (days < MIN_DAYS_FOR_WITHDRAW) return bot.sendMessage(chatId, `⏳ Withdrawal allowed after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} left)`, { parse_mode: "HTML", ...mainKeyboard });

//     const payout = user.balance; user.balance = 0; await user.save();
//     return bot.sendMessage(chatId, `✅ Withdrawal request placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`, { parse_mode: "HTML", ...mainKeyboard });
//   }

//   // ===== 🎁 Join Group =====
//   if (text === "🎁 Join Group") return bot.sendMessage(chatId, `📢 Join official Telegram group:`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] } });

//   return bot.sendMessage(chatId, "Menu se koi option choose karein.", { parse_mode: "HTML", ...mainKeyboard });
// });

// // ====== Express endpoints ======
// app.get("/ad", (req, res) => res.sendFile(path.join(__dirname, "public", "ad.html")));

// app.get("/reward", async (req, res) => {
//   try {
//     const userId = Number(req.query.user);
//     if (!userId) return res.status(400).send("Missing user");
//     const user = await User.findOne({ telegramId: userId });
//     if (!user) return res.status(404).send("User not found");

//     await resetDailyIfNeeded(user);
//     if (user.adsWatchedToday >= DAILY_LIMIT) return res.status(429).send("Daily limit reached");

//     const now = new Date();
//     if (user.lastAdAt && now.getTime() - new Date(user.lastAdAt).getTime() < (AD_SECONDS - 1) * 1000) return res.status(429).send("Too soon");

//     user.balance += AD_REWARD;
//     user.adsWatchedToday += 1;
//     user.lastAdAt = new Date();
//     await user.save();

//     try { await bot.sendMessage(user.telegramId, `🎉 You earned ₹${AD_REWARD}. Balance: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard }); } catch {}

//     return res.send("OK");
//   } catch (e) { console.error("Reward error:", e); return res.status(500).send("Server error"); }
// });

// // ====== Health check ======
// app.get("/", (req, res) => res.send("✅ DailyKamai bot is running!"));
// app.get("/health-check", (req, res) => res.status(200).send("✅ Alive and healthy!"));

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server running on port ${PORT}`));
// console.log("🤖 DailyKamai Bot is running...");

// // ====== Keep-alive ping ======
// cron.schedule("*/5 * * * *", async () => {
//   try {
//     const res = await fetch(`${BASE_URL}/health-check`);
//     if (res.ok) console.log(`🟢 Keep-alive OK at ${new Date().toLocaleTimeString()}`);
//     else console.log(`🟠 Keep-alive failed: HTTP ${res.status}`);
//   } catch (err) {
//     console.error(`🔴 Keep-alive error: ${err.message}`);
//   }
// });


// end test->

// // index.js — DailyKamai final (bot + express + ad verification)
// // Requires environment variables: BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL

// const express = require("express");
// const path = require("path");
// const mongoose = require("mongoose");
// const TelegramBot = require("node-telegram-bot-api");
// const cron = require("node-cron");
// require("dotenv").config();

// // ====== Config from environment ======
// const BOT_TOKEN = process.env.BOT_TOKEN;
// const MONGO_URI = process.env.MONGO_URI;
// const GROUP_ID = process.env.GROUP_ID;
// const ADMIN_ID = process.env.ADMIN_ID;
// const BASE_URL = process.env.BASE_URL;

// if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID || !BASE_URL) {
//   console.error(
//     "Missing required env vars. Set BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL."
//   );
//   process.exit(1);
// }

// // ====== Constants ======
// const AD_REWARD = 3; 
// const REFERRAL_REWARD = 50; 
// const DAILY_LIMIT = 20; 
// const AD_SECONDS = 30; 
// const MIN_WITHDRAW = 500; 
// const MIN_REFERRALS = 5; 
// const ADVANCED_REFERRALS = 15; 
// const MIN_DAYS_FOR_WITHDRAW = 3; 

// // ====== Setup Express & Bot ======
// const app = express();
// app.use(express.static(path.join(__dirname, "public")));

// const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// // ====== MongoDB Setup ======
// mongoose.connect(MONGO_URI)
//   .then(() => console.log("✅ MongoDB connected"))
//   .catch((err) => {
//     console.error("❌ MongoDB connection error:", err);
//     process.exit(1);
//   });

// mongoose.connection.once("open", async () => {
//   try {
//     const cols = await mongoose.connection.db.collections();
//     for (const c of cols) {
//       if (c.collectionName === "users") {
//         console.log("🧹 Dropping 'users' indexes (if any) ...");
//         await c.dropIndexes().catch(() => {});
//       }
//     }
//   } catch (e) {
//     console.warn("Index cleanup warning:", e.message || e);
//   }
// });

// // ====== User schema ======
// const userSchema = new mongoose.Schema({
//   telegramId: { type: Number, unique: true, required: true },
//   firstSeen: { type: Date, default: Date.now },
//   balance: { type: Number, default: 0 },
//   referralCount: { type: Number, default: 0 },
//   referredBy: { type: Number, default: null },
//   upi: { type: String, default: "" },
//   adsWatchedToday: { type: Number, default: 0 },
//   lastAdAt: { type: Date, default: null },
//   lastReset: { type: Date, default: () => new Date() },
//   joinedGroup: { type: Boolean, default: false },
//   firstName: { type: String, default: "" },
// });

// const User = mongoose.model("User", userSchema);

// // ====== Reply keyboard ======
// const mainKeyboard = {
//   reply_markup: {
//     keyboard: [
//       ["🎬 Ad Dekho", "💰 Balance"],
//       ["👥 Refer & Earn", "🏦 Withdraw Funds"],
//       ["🎁 Join Group"],
//     ],
//     resize_keyboard: true,
//   },
// };

// // ====== Helpers ======
// async function ensureUser(telegramId, firstName) {
//   let u = await User.findOne({ telegramId });
//   if (!u) {
//     u = new User({ telegramId, firstSeen: new Date(), firstName });
//     await u.save();
//   }
//   return u;
// }

// async function resetDailyIfNeeded(user) {
//   const now = new Date();
//   if (!user.lastReset || now.toDateString() !== new Date(user.lastReset).toDateString()) {
//     user.adsWatchedToday = 0;
//     user.lastReset = now;
//     await user.save();
//   }
// }

// async function ensureGroupFlag(user) {
//   try {
//     const member = await bot.getChatMember(String(GROUP_ID), user.telegramId).catch(() => null);
//     if (member && ["member", "administrator", "creator"].includes(member.status)) {
//       if (!user.joinedGroup) {
//         user.joinedGroup = true;
//         await user.save();
//       }
//       return true;
//     }
//   } catch (e) {}
//   return false;
// }

// function escapeHtml(text) {
//   if (!text) return "";
//   return String(text)
//     .replace(/&/g, "&amp;")
//     .replace(/</g, "&lt;")
//     .replace(/>/g, "&gt;");
// }

// // ====== Cron: daily reset ======
// cron.schedule("0 0 * * *", async () => {
//   try {
//     await User.updateMany({}, { $set: { adsWatchedToday: 0, lastReset: new Date() } });
//     console.log("🔁 Daily reset: adsWatchedToday cleared");
//   } catch (e) {
//     console.error("Daily reset error:", e);
//   }
// });

// // ====== /start handler ======
// bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
//   const chatId = msg.chat.id;
//   const telegramId = msg.from.id;
//   const refId = match && match[1] ? Number(match[1]) : null;

//   try {
//     let user = await User.findOne({ telegramId });

//     if (!user) {
//       user = new User({ telegramId, firstSeen: new Date(), firstName: msg.from.first_name });
//       await user.save();

//       const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\n💬 Start by sending /start message.`;
//       return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
//     }

//     if (refId && refId !== telegramId) {
//       const refUser = await User.findOne({ telegramId: refId });
//       if (refUser && !user.referredBy) {
//         refUser.balance += REFERRAL_REWARD;
//         refUser.referralCount += 1;
//         await refUser.save();

//         user.referredBy = refId;
//         await user.save();

//         try {
//           await bot.sendMessage(
//             refUser.telegramId,
//             `🎉 You earned ₹${REFERRAL_REWARD} for referring a friend!`,
//             { parse_mode: "HTML" }
//           );
//         } catch {}
//       }
//     }

//     const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nWatch ads to earn ₹${AD_REWARD} per ad.\nRefer friends to earn ₹${REFERRAL_REWARD}.\n\nChoose an option below.`;
//     await bot.sendMessage(chatId, welcome, { parse_mode: "HTML", ...mainKeyboard });
//   } catch (err) {
//     console.error("Start error:", err);
//     bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again.");
//   }
// });

// // ====== Broadcast (admin) ======
// bot.onText(/\/broadcast (.+)/, async (msg, match) => {
//   if (String(msg.from.id) !== String(ADMIN_ID)) return;
//   const text = match[1].trim();
//   const users = await User.find({}, "telegramId");
//   let sent = 0;
//   for (const u of users) {
//     try {
//       await bot.sendMessage(u.telegramId, `📢 <b>Admin Broadcast</b>\n\n${escapeHtml(text)}`, { parse_mode: "HTML" });
//       sent++;
//     } catch {}
//   }
//   bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sent} users.`);
// });

// // ====== Callback queries ======
// bot.on("callback_query", async (q) => {
//   const chatId = q.message.chat.id;
//   const telegramId = q.from.id;
//   const data = q.data;

//   if (data === "pre_ad") {
//     const text = `🎬 Earn ₹${AD_REWARD} for watching an ad.\n\nDo not close until video ends.`;
//     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
//     await bot.sendMessage(chatId, text, {
//       parse_mode: "HTML",
//       reply_markup: { inline_keyboard: [[{ text: "▶️ Watch Ad", url: adUrl }]] },
//     });
//     await bot.answerCallbackQuery(q.id);
//     return;
//   }

//   if (data === "pre_ref") {
//     const user = await ensureUser(telegramId);
//     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
//     const text = `👥 Invite and earn ₹${REFERRAL_REWARD}!\nInvited so far: ${user.referralCount}\nYour referral link:`;
//     await bot.sendMessage(chatId, `${text}\n${refLink}`, {
//       parse_mode: "HTML",
//       reply_markup: {
//         inline_keyboard: [[{ text: "📤 Invite friends", switch_inline_query: `Join DailyKamai! ${refLink}` }]],
//       },
//     });
//     await bot.answerCallbackQuery(q.id);
//     return;
//   }

//   await bot.answerCallbackQuery(q.id);
// });

// // ====== Reply keyboard messages ======
// bot.on("message", async (msg) => {
//   if (!msg.text) return;
//   const text = msg.text.trim();
//   const chatId = msg.chat.id;
//   const telegramId = msg.from.id;

//   if (text.startsWith("/start")) return;

//   const user = await ensureUser(telegramId, msg.from.first_name);
//   await resetDailyIfNeeded(user);

//   const joined = await ensureGroupFlag(user);
//   if (!joined) {
//     return bot.sendMessage(
//       chatId,
//       `📢 Join our Telegram group to use features.`,
//       {
//         parse_mode: "HTML",
//         reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] },
//       },
//     );
//   }

//   // ===== 🎬 Ad Dekho =====
//   if (text === "🎬 Ad Dekho") {
//     if (user.adsWatchedToday >= DAILY_LIMIT) {
//       return bot.sendMessage(chatId, `🚫 Daily limit ${DAILY_LIMIT} reached. Try tomorrow.`, { parse_mode: "HTML", ...mainKeyboard });
//     }
//     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
//     return bot.sendMessage(chatId, `🎬 Earn ₹${AD_REWARD} per ad.`, {
//       parse_mode: "HTML",
//       reply_markup: { inline_keyboard: [[{ text: "▶️ Watch Ad", url: adUrl }]] },
//     });
//   }

//   // ===== 💰 Balance =====
//   if (text === "💰 Balance") {
//     return bot.sendMessage(chatId, `<b>💰 Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });
//   }

//   // ===== 👥 Refer & Earn =====
//   if (text === "👥 Refer & Earn") {
//     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
//     return bot.sendMessage(chatId, `👥 Refer & earn ₹${REFERRAL_REWARD}!\nYour referrals: ${user.referralCount}\nLink: ${refLink}`, {
//       parse_mode: "HTML",
//       reply_markup: { inline_keyboard: [[{ text: "📤 Invite", switch_inline_query: `Join DailyKamai! ${refLink}` }]] },
//     });
//   }

//   // ===== 🏦 Withdraw Funds =====
//   if (text === "🏦 Withdraw Funds") {
//     if (!user.upi) {
//       const sent = await bot.sendMessage(chatId, "🏦 Send your UPI ID (name@bank).", { parse_mode: "HTML", reply_markup: { force_reply: true } });
//       const listener = async (m) => {
//         if (!m.text || m.from.id !== telegramId) return;
//         if (!m.reply_to_message || m.reply_to_message.message_id !== sent.message_id) return;
//         user.upi = m.text.trim();
//         await user.save();
//         bot.sendMessage(chatId, `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`, { parse_mode: "HTML", ...mainKeyboard });
//         bot.removeListener("message", listener);
//       };
//       bot.on("message", listener);
//       return;
//     }

//     if (user.balance < MIN_WITHDRAW) return bot.sendMessage(chatId, `⚠️ Minimum ₹${MIN_WITHDRAW} needed. Your balance: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard });
//     if (user.referralCount < MIN_REFERRALS) return bot.sendMessage(chatId, `👥 Need at least ${MIN_REFERRALS} referrals. Yours: ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });
//     if (user.referralCount < ADVANCED_REFERRALS) return bot.sendMessage(chatId, `👥 Full withdrawal allowed after ${ADVANCED_REFERRALS} referrals. Yours: ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });

//     const days = Math.floor((Date.now() - new Date(user.firstSeen).getTime()) / (1000 * 60 * 60 * 24));
//     if (days < MIN_DAYS_FOR_WITHDRAW) return bot.sendMessage(chatId, `⏳ Withdrawal allowed after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} left)`, { parse_mode: "HTML", ...mainKeyboard });

//     const payout = user.balance;
//     user.balance = 0;
//     await user.save();

//     return bot.sendMessage(chatId, `✅ Withdrawal request placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`, { parse_mode: "HTML", ...mainKeyboard });
//   }

//   // ===== 🎁 Join Group =====
//   if (text === "🎁 Join Group") {
//     return bot.sendMessage(chatId, `📢 Join official Telegram group:`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] } });
//   }

//   return bot.sendMessage(chatId, "Menu se koi option choose karein.", { parse_mode: "HTML", ...mainKeyboard });
// });

// // ====== Express endpoints ======
// app.get("/ad", (req, res) => res.sendFile(path.join(__dirname, "public/ad.html")));

// app.get("/reward", async (req, res) => {
//   try {
//     const userId = Number(req.query.user);
//     if (!userId) return res.status(400).send("Missing user");
//     const user = await User.findOne({ telegramId: userId });
//     if (!user) return res.status(404).send("User not found");

//     await resetDailyIfNeeded(user);
//     if (user.adsWatchedToday >= DAILY_LIMIT) return res.status(429).send("Daily limit reached");

//     const now = new Date();
//     if (user.lastAdAt && now.getTime() - new Date(user.lastAdAt).getTime() < (AD_SECONDS - 1) * 1000) return res.status(429).send("Too soon");

//     user.balance += AD_REWARD;
//     user.adsWatchedToday += 1;
//     user.lastAdAt = new Date();
//     await user.save();

//     try { await bot.sendMessage(user.telegramId, `🎉 You earned ₹${AD_REWARD}. Balance: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard }); } catch {}

//     return res.send("OK");
//   } catch (e) {
//     console.error("Reward error:", e);
//     return res.status(500).send("Server error");
//   }
// });

// // ====== Health check ======
// app.get("/", (req, res) => res.send("✅ DailyKamai bot is running!"));
// app.get("/health-check", (req, res) => res.status(200).send("✅ Alive and healthy!"));

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server running on port ${PORT}`));
// console.log("🤖 DailyKamai Bot is running...");

// // ====== Keep-alive ping ======
// cron.schedule("*/5 * * * *", async () => {
//   try {
//     const res = await fetch(`${BASE_URL}/health-check`);
//     if (res.ok) console.log(`🟢 Keep-alive OK at ${new Date().toLocaleTimeString()}`);
//     else console.log(`🟠 Keep-alive failed: HTTP ${res.status}`);
//   } catch (err) {
//     console.error(`🔴 Keep-alive error: ${err.message}`);
//   }
// });


// // index.js — DailyKamai final (bot + express + ad verification)
// // Requires environment variables: BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL

// const express = require("express");
// const path = require("path");
// const mongoose = require("mongoose");
// const TelegramBot = require("node-telegram-bot-api");
// const cron = require("node-cron");
// require("dotenv").config();

// // ====== Config from environment ======
// const BOT_TOKEN = process.env.BOT_TOKEN;
// const MONGO_URI = process.env.MONGO_URI;
// const GROUP_ID = process.env.GROUP_ID; // string, like "-1001234..."
// const ADMIN_ID = process.env.ADMIN_ID; // string or number
// const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID || !BASE_URL) {
//   console.error(
//     "Missing required env vars. Set BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL.",
//   );
//   process.exit(1);
// }

// // ====== Constants ======
// const AD_REWARD = 3; // ₹3 per ad
// const REFERRAL_REWARD = 50; // ₹50 per referral
// const DAILY_LIMIT = 20; // 20 ads/day
// const AD_SECONDS = 30; // 30s required
// const MIN_WITHDRAW = 500; // ₹500 min
// const MIN_REFERRALS = 5; // 5 referrals
// const MIN_DAYS_FOR_WITHDRAW = 3; // 3 days since firstSeen

// // ====== Setup Express & Bot ======
// const app = express();
// app.use(express.static(path.join(__dirname, "public")));

// const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// // ====== MongoDB Setup ======
// mongoose
//   .connect(MONGO_URI)
//   .then(() => console.log("✅ MongoDB connected"))
//   .catch((err) => {
//     console.error("❌ MongoDB connection error:", err);
//     process.exit(1);
//   });

// // Drop old indexes to avoid duplicate-null unique errors (runs once when db opens)
// mongoose.connection.once("open", async () => {
//   try {
//     const cols = await mongoose.connection.db.collections();
//     for (const c of cols) {
//       if (c.collectionName === "users") {
//         console.log("🧹 Dropping 'users' indexes (if any) ...");
//         await c.dropIndexes().catch(() => {});
//       }
//     }
//   } catch (e) {
//     console.warn("Index cleanup warning:", e.message || e);
//   }
// });

// // ====== User schema ======
// const userSchema = new mongoose.Schema({
//   telegramId: { type: Number, unique: true, required: true },
//   firstSeen: { type: Date, default: Date.now },
//   balance: { type: Number, default: 0 },
//   referralCount: { type: Number, default: 0 },
//   referredBy: { type: Number, default: null },
//   upi: { type: String, default: "" },
//   adsWatchedToday: { type: Number, default: 0 },
//   lastAdAt: { type: Date, default: null },
//   lastReset: { type: Date, default: () => new Date() },
//   joinedGroup: { type: Boolean, default: false },
// });

// const User = mongoose.model("User", userSchema);

// // ====== Reply keyboard (buttons below typing area) ======
// const mainKeyboard = {
//   reply_markup: {
//     keyboard: [
//       ["🎬 Ad Dekho", "💰 Balance"],
//       ["👥 Refer & Earn", "🏦 Withdraw Funds"],
//       ["🎁 Join Group"],
//     ],
//     resize_keyboard: true,
//   },
// };

// // ====== Helpers ======
// async function ensureUser(telegramId, firstName) {
//   let u = await User.findOne({ telegramId });
//   if (!u) {
//     u = new User({ telegramId, firstSeen: new Date() });
//     if (firstName) u.firstName = firstName;
//     await u.save();
//   }
//   return u;
// }

// async function resetDailyIfNeeded(user) {
//   const now = new Date();
//   if (
//     !user.lastReset ||
//     now.toDateString() !== new Date(user.lastReset).toDateString()
//   ) {
//     user.adsWatchedToday = 0;
//     user.lastReset = now;
//     await user.save();
//   }
// }

// async function ensureGroupFlag(user) {
//   try {
//     const member = await bot
//       .getChatMember(String(GROUP_ID), user.telegramId)
//       .catch(() => null);
//     if (
//       member &&
//       ["member", "administrator", "creator"].includes(member.status)
//     ) {
//       if (!user.joinedGroup) {
//         user.joinedGroup = true;
//         await user.save();
//       }
//       return true;
//     }
//   } catch (e) {
//     // ignore errors
//   }
//   return false;
// }

// // escape HTML to avoid injection when including dynamic strings (UPI, names)
// function escapeHtml(text) {
//   if (!text) return "";
//   return String(text)
//     .replace(/&/g, "&amp;")
//     .replace(/</g, "&lt;")
//     .replace(/>/g, "&gt;");
// }

// // ====== Cron: daily reset at midnight server time ======
// cron.schedule("0 0 * * *", async () => {
//   try {
//     await User.updateMany(
//       {},
//       { $set: { adsWatchedToday: 0, lastReset: new Date() } },
//     );
//     console.log("🔁 Daily reset: adsWatchedToday cleared");
//   } catch (e) {
//     console.error("Daily reset error:", e);
//   }
// });

// // ====== /start handler (supports referral code) ======
// bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
//   const chatId = msg.chat.id;
//   const telegramId = msg.from.id;
//   const refId = match && match[1] ? Number(match[1]) : null;

//   try {
//     let user = await User.findOne({ telegramId });

//     // If user doesn’t exist → show greeting & stop here
//     if (!user) {
//       user = new User({ telegramId, firstSeen: new Date() });
//       await user.save();

//       const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\n💬 Suru karne ke liye <b>/start</b> message me bheje.`;
//       return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
//     }

//     // Existing user flow
//     if (refId && refId !== telegramId) {
//       const refUser = await User.findOne({ telegramId: refId });
//       if (refUser && !user.referredBy) {
//         refUser.balance += REFERRAL_REWARD;
//         refUser.referralCount += 1;
//         await refUser.save();

//         user.referredBy = refId;
//         await user.save();

//         try {
//           await bot.sendMessage(
//             refUser.telegramId,
//             `🎉 Aapko ₹${REFERRAL_REWARD} mila kyunki aapne ek friend refer kiya!`,
//             { parse_mode: "HTML" },
//           );
//         } catch (e) {
//           /* ignore */
//         }
//       }
//     }

//     const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nAap yahan video ads dekh kar paise kama sakte hain. Har ad ke liye ₹${AD_REWARD} milta hai. Doston ko refer karke ₹${REFERRAL_REWARD} kamaaye.\n\nNiche diye gaye options me se choose karein. suru karne ke liye /start chat me bheje `;
//     await bot.sendMessage(chatId, welcome, {
//       parse_mode: "HTML",
//       ...mainKeyboard,
//     });
//   } catch (err) {
//     console.error("Start error:", err);
//     bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again.");
//   }
// });

// // ====== Broadcast (admin only) ======
// bot.onText(/\/broadcast (.+)/, async (msg, match) => {
//   try {
//     if (String(msg.from.id) !== String(ADMIN_ID)) return;
//     const text = match[1].trim();
//     const users = await User.find({}, "telegramId");

//     let sent = 0;
//     for (const u of users) {
//       try {
//         await bot.sendMessage(
//           u.telegramId,
//           `📢 <b>Admin Broadcast</b>\n\n${escapeHtml(text)}`,
//           { parse_mode: "HTML" },
//         );
//         sent++;
//       } catch (e) {
//         /* ignore per-user errors */
//       }
//     }
//     bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sent} users.`);
//   } catch (e) {
//     console.error("Broadcast error:", e);
//     bot.sendMessage(msg.chat.id, "⚠️ Broadcast failed.");
//   }
// });

// // ====== Callback queries for pre-ad and pre-ref interactions ======
// bot.on("callback_query", async (q) => {
//   const chatId = q.message.chat.id;
//   const telegramId = q.from.id;
//   const data = q.data;

//   if (data === "pre_ad") {
//     // show interactive ad instructions and button to open ad page
//     const text = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milega.\n\n⚠️ Video khatam hone tak tab close na karein.\n\nNiche diye gaye button se ad dekhe.`;
//     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
//     await bot.sendMessage(chatId, text, {
//       parse_mode: "HTML",
//       reply_markup: {
//         inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
//       },
//     });
//     await bot.answerCallbackQuery(q.id);
//     return;
//   }

//   if (data === "pre_ref") {
//     // show referral info + link + forward button
//     const user = await ensureUser(telegramId);
//     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
//     const text = `👥 Invite karke ₹${REFERRAL_REWARD} kamaaye!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link:`;
//     await bot.sendMessage(chatId, `${text}\n${refLink}`, {
//       parse_mode: "HTML",
//       reply_markup: {
//         inline_keyboard: [
//           [
//             {
//               text: "📤 Apne doston ko invite karein",
//               switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
//             },
//           ],
//         ],
//       },
//     });
//     await bot.answerCallbackQuery(q.id);
//     return;
//   }

//   await bot.answerCallbackQuery(q.id);
// });

// // ====== Handle reply-keyboard messages (main flow) ======
// bot.on("message", async (msg) => {
//   if (!msg.text) return;
//   const text = msg.text.trim();
//   const chatId = msg.chat.id;
//   const telegramId = msg.from.id;

//   // ignore /start here
//   if (text.startsWith("/start")) return;

//   // Ensure user exists
//   const user = await ensureUser(telegramId, msg.from.first_name);
//   // daily reset safety
//   await resetDailyIfNeeded(user);

//   // If user hasn't joined group, prompt join (we check on every action)
//   const joined = await ensureGroupFlag(user);
//   if (!joined) {
//     // Prompt user to join group and return — cannot use features until joined
//     return bot.sendMessage(
//       chatId,
//       `📢 Aapko features use karne ke liye hamare Telegram group join karna zaroori hai.\n\nClick below to join and then come back.`,
//       {
//         parse_mode: "HTML",
//         reply_markup: {
//           inline_keyboard: [
//             [{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }],
//           ],
//         },
//       },
//     );
//   }

//   // ===== Button: 🎬 Ad Dekho =====
//   if (text === "🎬 Ad Dekho") {
//     // check daily limit
//     if (user.adsWatchedToday >= DAILY_LIMIT) {
//       return bot.sendMessage(
//         chatId,
//         `🚫 Aapne aaj ${DAILY_LIMIT} ads dekh liye hain. Kal fir se try karein.`,
//         { parse_mode: "HTML", ...mainKeyboard },
//       );
//     }

//     // show pre-ad information and open link (same as pre_ad callback)
//     const textBefore = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milenge.\nVideo khatam hone tak tab close na karein.\n\nNiche button se ad dekhiye.`;
//     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
//     await bot.sendMessage(chatId, textBefore, {
//       parse_mode: "HTML",
//       reply_markup: {
//         inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
//       },
//     });

//     return;
//   }

//   // ===== Button: 💰 Balance =====
//   if (text === "💰 Balance") {
//     return bot.sendMessage(
//       chatId,
//       `<b>💰 Aapka Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`,
//       { parse_mode: "HTML", ...mainKeyboard },
//     );
//   }

//   // ===== Button: 👥 Refer & Earn =====
//   if (text === "👥 Refer & Earn") {
//     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
//     const msgText = `👥 Refer & Earn ₹${REFERRAL_REWARD}!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link: ${refLink}`;
//     await bot.sendMessage(chatId, msgText, {
//       parse_mode: "HTML",
//       reply_markup: {
//         inline_keyboard: [
//           [
//             {
//               text: "📤 Apne doston ko invite karein",
//               switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
//             },
//           ],
//         ],
//       },
//     });
//     return;
//   }

//   // ===== Button: 🏦 Withdraw Funds =====
//   if (text === "🏦 Withdraw Funds") {
//     // ask for UPI if not exists
//     if (!user.upi) {
//       const sent = await bot.sendMessage(
//         chatId,
//         "🏦 Kripya apna UPI ID bheje (example: name@bank).",
//         { parse_mode: "HTML", reply_markup: { force_reply: true } },
//       );

//       // one-time listener for reply
//       const listener = async (m) => {
//         if (!m.text) return;
//         if (m.from.id !== telegramId) return;
//         if (
//           !m.reply_to_message ||
//           m.reply_to_message.message_id !== sent.message_id
//         )
//           return;

//         user.upi = m.text.trim();
//         await user.save();
//         bot.sendMessage(
//           chatId,
//           `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`,
//           { parse_mode: "HTML", ...mainKeyboard },
//         );
//         bot.removeListener("message", listener);
//       };
//       bot.on("message", listener);
//       return;
//     }

//     // check conditions
//     if (user.balance < MIN_WITHDRAW) {
//       return bot.sendMessage(
//         chatId,
//         `⚠️ Minimum withdrawal ₹${MIN_WITHDRAW} required. Aapka balance: ₹${user.balance}`,
//         { parse_mode: "HTML", ...mainKeyboard },
//       );
//     }

//     if (user.referralCount < MIN_REFERRALS) {
//       return bot.sendMessage(
//         chatId,
//         `👥 Minimum ${MIN_REFERRALS} referrals required. Aapke referrals: ${user.referralCount}`,
//         { parse_mode: "HTML", ...mainKeyboard },
//       );
//     }

//     // check joined group again
//     const isMember = await ensureGroupFlag(user);
//     if (!isMember) {
//       return bot.sendMessage(
//         chatId,
//         `🚨 Aapko group join karna zaroori hai for withdrawals.`,
//         { parse_mode: "HTML", ...mainKeyboard },
//       );
//     }

//     // check days since firstSeen
//     const days = Math.floor(
//       (Date.now() - new Date(user.firstSeen).getTime()) / (1000 * 60 * 60 * 24),
//     );
//     if (days < MIN_DAYS_FOR_WITHDRAW) {
//       return bot.sendMessage(
//         chatId,
//         `⏳ Withdrawal allowed after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} days left)`,
//         { parse_mode: "HTML", ...mainKeyboard },
//       );
//     }

//      // ✅ NEW CONDITION: must have at least 15 referrals
//     if (user.referralCount < 15) {
//       return bot.sendMessage(
//         chatId,
//         `👥 Withdrawal allowed only after completing 15 referrals.\nAapke referrals: ${user.referralCount}`,
//         { parse_mode: "HTML", ...mainKeyboard },
//       );
//     }

//     // passed all checks
//     const payout = user.balance;
//     user.balance = 0;
//     await user.save();

//     return bot.sendMessage(
//       chatId,
//       `✅ Withdrawal request placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`,
//       { parse_mode: "HTML", ...mainKeyboard },
//     );
//   }

//   // ===== Button: 🎁 Join Group =====
//   if (text === "🎁 Join Group") {
//     return bot.sendMessage(
//       chatId,
//       `📢 Join our official Telegram group for updates and withdrawal announcements:`,
//       {
//         parse_mode: "HTML",
//         reply_markup: {
//           inline_keyboard: [
//             [{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }],
//           ],
//         },
//       },
//     );
//   }

//   // default: show keyboard
//   return bot.sendMessage(chatId, "Menu se koi option choose karein.", {
//     parse_mode: "HTML",
//     ...mainKeyboard,
//   });
// });

// // ====== Express endpoints: ad page & reward (called from ad.html) ======

// // serve ad page (public/ad.html)
// app.get("/ad", (req, res) => {
//   res.sendFile(path.join(__dirname, "public", "ad.html"));
// });

// // reward endpoint: called by client after 30s
// app.get("/reward", async (req, res) => {
//   try {
//     const userId = Number(req.query.user);
//     if (!userId) return res.status(400).send("Missing user");
//     const user = await User.findOne({ telegramId: userId });
//     if (!user) return res.status(404).send("User not found");

//     // safety: reset check
//     await resetDailyIfNeeded(user);

//     // daily limit
//     if (user.adsWatchedToday >= DAILY_LIMIT) {
//       return res.status(429).send("Daily limit reached");
//     }

//     // prevent fast double reward: check lastAdAt
//     const now = new Date();
//     if (
//       user.lastAdAt &&
//       now.getTime() - new Date(user.lastAdAt).getTime() <
//         (AD_SECONDS - 1) * 1000
//     ) {
//       // too soon — ignore
//       return res.status(429).send("Too soon");
//     }

//     // credit reward
//     user.balance += AD_REWARD;
//     user.adsWatchedToday += 1;
//     user.lastAdAt = new Date();
//     await user.save();

//     // notify user in Telegram
//     try {
//       await bot.sendMessage(
//         user.telegramId,
//         `🎉 Aapne ₹${AD_REWARD} kamaye ad dekhne ke liye. Dhanyawad!\n\n💰 Aapka total balance: ₹${user.balance}`,
//         { parse_mode: "HTML", ...mainKeyboard },
//       );
//     } catch (e) {
//       // ignore send errors
//       console.warn("Could not send TG message on reward:", e.message || e);
//     }

//     return res.send("OK");
//   } catch (e) {
//     console.error("Reward error:", e);
//     return res.status(500).send("Server error");
//   }
// });

// // ====== Simple keep-alive root route ======
// app.get("/", (req, res) => {
//   res.send("✅ DailyKamai bot is running fine!");
// });

// // ====== Health Check (for uptime pings) ======
// app.get("/health-check", (req, res) => {
//   res.status(200).send("✅ DailyKamai bot is alive and healthy!");
// });

// // ====== Start Express Server ======
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, "0.0.0.0", () =>
//   console.log(`🌐 Web server running on port ${PORT}`)
// );

// console.log("🤖 DailyKamai Bot is running...");

// // ====== Auto Keep-Alive (Render / Replit / Local) ======

// // Detect base URL automatically
// // let baseUrl = process.env.BASE_URL;
// // if (!baseUrl) {
// //   if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
// //     // Replit environment
// //     baseUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
// //   } else if (process.env.RENDER_EXTERNAL_URL) {
// //     // Render environment
// //     baseUrl = process.env.RENDER_EXTERNAL_URL;
// //   } else {
// //     // Localhost fallback
// //     baseUrl = `http://localhost:${PORT}`;
// //   }
// // }

// // console.log(`🌍 Using base URL for keep-alive: ${baseUrl}`);
// // const BASE_URL = process.env.BASE_URL;

// if (!BASE_URL) {
//   console.error("❌ BASE_URL is missing! Set it in Railway env variables to your public HTTPS URL.");
//   process.exit(1);
// }

// console.log(`🌍 Using BASE_URL: ${BASE_URL}`);


// // Use built-in fetch (Node 18+ — already available in Render)
// cron.schedule("*/5 * * * *", async () => {
//   try {
//     const res = await fetch(`${baseUrl}/health-check`);
//     if (res.ok) {
//       console.log(`🟢 Keep-alive ping OK at ${new Date().toLocaleTimeString()}`);
//     } else {
//       console.log(`🟠 Keep-alive ping failed: HTTP ${res.status}`);
//     }
//   } catch (err) {
//     console.error(`🔴 Keep-alive error: ${err.message}`);
//   }
// });








// // ====== Auto Keep-Alive (Render / Replit / Local) ======
// // const fetch = require("node-fetch");
// // const cron = require("node-cron");

// // Detect base URL automatically
// let baseUrl = process.env.BASE_URL;
// if (!baseUrl) {
//   if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
//     // Replit environment
//     baseUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
//   } else if (process.env.RENDER_EXTERNAL_URL) {
//     // Render environment
//     baseUrl = process.env.RENDER_EXTERNAL_URL;
//   } else {
//     // Localhost fallback
//     baseUrl = `http://localhost:${PORT}`;
//   }
// }

// console.log(`🌍 Using base URL for keep-alive: ${baseUrl}`);

// // Ping every 5 minutes to keep service awake
// cron.schedule("*/5 * * * *", async () => {
//   try {
//     const res = await fetch(`${baseUrl}/health-check`);
//     if (res.ok) {
//       console.log(`🟢 Keep-alive ping OK at ${new Date().toLocaleTimeString()}`);
//     } else {
//       console.log(`🟠 Keep-alive ping failed: HTTP ${res.status}`);
//     }
//   } catch (err) {
//     console.error(`🔴 Keep-alive error: ${err.message}`);
//   }
// });


// // start express
// const PORT = process.env.PORT || 3000;
// // ====== Simple keep-alive for Replit ======
// app.get("/", (req, res) => {
//   res.send("✅ DailyKamai bot is running fine!");
// });

// // ====== Health Check (for UptimeRobot ping) ======
// app.get("/health-check", (req, res) => {
//   res.status(200).send("✅ Bot is alive and healthy!");
// });

// // app.listen(PORT, () => console.log(`🌐 Web server running on ${PORT}`));
// app.listen(PORT, "0.0.0.0", () =>
//   console.log(`🌐 Web server running on ${PORT}`),
// );

// console.log("🤖 DailyKamai Bot is running...");




// // index.js — DailyKamai Bot safe for Render
// require("dotenv").config();
// const express = require("express");
// const mongoose = require("mongoose");
// const TelegramBot = require("node-telegram-bot-api");

// const app = express();

// // ====== Config ======
// const BOT_TOKEN = process.env.BOT_TOKEN;
// const MONGO_URI = process.env.MONGO_URI;
// const GROUP_ID = process.env.GROUP_ID;
// const ADMIN_ID = process.env.ADMIN_ID;
// const BASE_URL = process.env.BASE_URL; // https://yourapp.onrender.com
// const PORT = process.env.PORT || 10000;
// const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;

// // ====== Models ======
// const userSchema = new mongoose.Schema({
//   telegramId: Number,
//   username: String,
//   referrals: { type: Number, default: 0 },
//   upiSet: { type: Boolean, default: false },
//   joinedGroup: { type: Boolean, default: false },
//   withdrawalRequested: { type: Boolean, default: false },
// });
// const User = mongoose.model("User", userSchema);

// // ====== Bot Setup ======
// const bot = new TelegramBot(BOT_TOKEN, { webHook: { port: PORT, host: "0.0.0.0" } });

// // ====== Middleware ======
// app.use(express.json());

// // ====== Webhook Endpoint ======
// app.post(WEBHOOK_PATH, (req, res) => {
//   bot.processUpdate(req.body);
//   res.sendStatus(200);
// });

// // ====== Bot Logic ======
// bot.onText(/\/start/, async (msg) => {
//   const chatId = msg.chat.id;
//   let user = await User.findOne({ telegramId: chatId });
//   if (!user) {
//     user = new User({ telegramId: chatId, username: msg.from.username });
//     await user.save();
//   }

//   const buttons = [
//     [{ text: "Set UPI", callback_data: "set_upi" }],
//     [{ text: "Join Group", url: `https://t.me/${GROUP_ID.replace("-100", "")}` }],
//     [{ text: "Withdraw", callback_data: "withdraw" }],
//   ];

//   bot.sendMessage(chatId, `Welcome ${msg.from.first_name}! Complete tasks in order: \n1️⃣ Set UPI\n2️⃣ Join Group\n3️⃣ Refer friends`, {
//     reply_markup: { inline_keyboard: buttons },
//   });
// });

// // ====== Inline button callbacks ======
// bot.on("callback_query", async (query) => {
//   const chatId = query.message.chat.id;
//   const data = query.data;
//   const user = await User.findOne({ telegramId: chatId });

//   if (!user) return;

//   if (data === "set_upi") {
//     if (!user.upiSet) {
//       user.upiSet = true;
//       await user.save();
//       bot.sendMessage(chatId, "✅ UPI set! Now join the group and refer 5 friends.");
//     } else {
//       bot.sendMessage(chatId, "UPI already set!");
//     }
//   }

//   if (data === "withdraw") {
//     if (!user.upiSet || !user.joinedGroup || user.referrals < 5) {
//       bot.sendMessage(chatId, "You must complete tasks first before withdrawing!");
//     } else if (user.withdrawalRequested) {
//       bot.sendMessage(chatId, "Withdrawal already requested!");
//     } else {
//       user.withdrawalRequested = true;
//       await user.save();
//       bot.sendMessage(chatId, "✅ Withdrawal request submitted!");
//     }
//   }
// });

// // ====== Handle referral messages ======
// bot.onText(/\/refer (.+)/, async (msg, match) => {
//   const chatId = msg.chat.id;
//   const referredUsername = match[1];

//   const user = await User.findOne({ telegramId: chatId });
//   if (!user) return;

//   user.referrals += 1;

//   if (user.referrals >= 5 && !user.joinedGroup) {
//     bot.sendMessage(chatId, "✅ You completed 5 referrals! Now join the group to unlock more tasks.");
//   }

//   if (user.referrals >= 15) {
//     bot.sendMessage(chatId, "🎉 You completed 15 referrals! You can now withdraw.");
//   }

//   await user.save();
// });

// // ====== MongoDB Connect & Bot Startup ======
// mongoose.connect(MONGO_URI)
//   .then(() => {
//     console.log("✅ MongoDB connected");

//     (async () => {
//       try {
//         await bot.setWebHook(`${BASE_URL}${WEBHOOK_PATH}`);
//         console.log("🤖 Bot webhook set!");
//       } catch (err) {
//         console.error("❌ Failed to set webhook:", err);
//       }
//     })();

//   })
//   .catch(err => console.error("❌ MongoDB connection error:", err));

// // ====== Start Express server ======
// app.listen(PORT, () => {
//   console.log(`🌐 Web server running on port ${PORT}`);
//   console.log(`🤖 DailyKamai Bot webhook URL: ${BASE_URL}${WEBHOOK_PATH}`);
// });



// // index.js — DailyKamai final (webhook version)
// // Requires environment variables: BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL, PORT

// // const express = require("express");
// // const path = require("path");
// // const mongoose = require("mongoose");
// // const TelegramBot = require("node-telegram-bot-api");
// // const cron = require("node-cron");
// // require("dotenv").config();

// // // ====== Config from environment ======
// // const BOT_TOKEN = process.env.BOT_TOKEN;
// // const MONGO_URI = process.env.MONGO_URI;
// // const GROUP_ID = process.env.GROUP_ID;
// // const ADMIN_ID = process.env.ADMIN_ID;
// // const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
// // const PORT = process.env.PORT || 3000;
// // const WEBHOOK_PATH = `/bot${BOT_TOKEN}`; // unique webhook path

// // if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID || !BASE_URL) {
// //   console.error(
// //     "Missing required env vars. Set BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL."
// //   );
// //   process.exit(1);
// // }

// // // ====== Constants ======
// // const AD_REWARD = 3;
// // const REFERRAL_REWARD = 50;
// // const DAILY_LIMIT = 20;
// // const AD_SECONDS = 30;
// // const MIN_WITHDRAW = 500;
// // const MIN_REFERRALS = 5;
// // const MIN_DAYS_FOR_WITHDRAW = 3;

// // // ====== Setup Express & Bot ======
// // const app = express();
// // app.use(express.json()); // webhook needs JSON body
// // app.use(express.static(path.join(__dirname, "public")));

// // const bot = new TelegramBot(BOT_TOKEN, { webHook: { port: PORT } });
// // bot.setWebHook(`${BASE_URL}${WEBHOOK_PATH}`);

// // // ====== MongoDB Setup ======
// // mongoose
// //   .connect(MONGO_URI)
// //   .then(() => console.log("✅ MongoDB connected"))
// //   .catch((err) => {
// //     console.error("❌ MongoDB connection error:", err);
// //     process.exit(1);
// //   });

// // // Drop old indexes to avoid duplicate-null unique errors
// // mongoose.connection.once("open", async () => {
// //   try {
// //     const cols = await mongoose.connection.db.collections();
// //     for (const c of cols) {
// //       if (c.collectionName === "users") {
// //         console.log("🧹 Dropping 'users' indexes (if any) ...");
// //         await c.dropIndexes().catch(() => {});
// //       }
// //     }
// //   } catch (e) {
// //     console.warn("Index cleanup warning:", e.message || e);
// //   }
// // });

// // // ====== User schema ======
// // const userSchema = new mongoose.Schema({
// //   telegramId: { type: Number, unique: true, required: true },
// //   firstSeen: { type: Date, default: Date.now },
// //   balance: { type: Number, default: 0 },
// //   referralCount: { type: Number, default: 0 },
// //   referredBy: { type: Number, default: null },
// //   upi: { type: String, default: "" },
// //   adsWatchedToday: { type: Number, default: 0 },
// //   lastAdAt: { type: Date, default: null },
// //   lastReset: { type: Date, default: () => new Date() },
// //   joinedGroup: { type: Boolean, default: false },
// //   firstName: { type: String, default: "" },
// // });

// // const User = mongoose.model("User", userSchema);

// // // ====== Reply keyboard ======
// // const mainKeyboard = {
// //   reply_markup: {
// //     keyboard: [
// //       ["🎬 Ad Dekho", "💰 Balance"],
// //       ["👥 Refer & Earn", "🏦 Withdraw Funds"],
// //       ["🎁 Join Group"],
// //     ],
// //     resize_keyboard: true,
// //   },
// // };

// // // ====== Helpers ======
// // async function ensureUser(telegramId, firstName) {
// //   let u = await User.findOne({ telegramId });
// //   if (!u) {
// //     u = new User({ telegramId, firstSeen: new Date(), firstName });
// //     await u.save();
// //   }
// //   return u;
// // }

// // async function resetDailyIfNeeded(user) {
// //   const now = new Date();
// //   if (!user.lastReset || now.toDateString() !== new Date(user.lastReset).toDateString()) {
// //     user.adsWatchedToday = 0;
// //     user.lastReset = now;
// //     await user.save();
// //   }
// // }

// // async function ensureGroupFlag(user) {
// //   try {
// //     const member = await bot.getChatMember(String(GROUP_ID), user.telegramId).catch(() => null);
// //     if (member && ["member", "administrator", "creator"].includes(member.status)) {
// //       if (!user.joinedGroup) {
// //         user.joinedGroup = true;
// //         await user.save();
// //       }
// //       return true;
// //     }
// //   } catch (e) {}
// //   return false;
// // }

// // function escapeHtml(text) {
// //   if (!text) return "";
// //   return String(text)
// //     .replace(/&/g, "&amp;")
// //     .replace(/</g, "&lt;")
// //     .replace(/>/g, "&gt;");
// // }

// // // ====== Cron: daily reset ======
// // cron.schedule("0 0 * * *", async () => {
// //   try {
// //     await User.updateMany({}, { $set: { adsWatchedToday: 0, lastReset: new Date() } });
// //     console.log("🔁 Daily reset: adsWatchedToday cleared");
// //   } catch (e) {
// //     console.error("Daily reset error:", e);
// //   }
// // });

// // // ====== Webhook handler ======
// // app.post(WEBHOOK_PATH, async (req, res) => {
// //   try {
// //     bot.processUpdate(req.body);
// //     res.sendStatus(200);
// //   } catch (err) {
// //     console.error("Webhook processing error:", err);
// //     res.sendStatus(500);
// //   }
// // });

// // // ====== /start handler (supports referral code) ======
// // bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;
// //   const refId = match && match[1] ? Number(match[1]) : null;

// //   try {
// //     let user = await User.findOne({ telegramId });

// //     if (!user) {
// //       user = new User({ telegramId, firstSeen: new Date(), firstName: msg.from.first_name });
// //       await user.save();
// //       const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\n💬 Start using bot with /start.`;
// //       return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
// //     }

// //     // handle referral
// //     if (refId && refId !== telegramId) {
// //       const refUser = await User.findOne({ telegramId: refId });
// //       if (refUser && !user.referredBy) {
// //         refUser.balance += REFERRAL_REWARD;
// //         refUser.referralCount += 1;
// //         await refUser.save();

// //         user.referredBy = refId;
// //         await user.save();

// //         try {
// //           await bot.sendMessage(
// //             refUser.telegramId,
// //             `🎉 Aapko ₹${REFERRAL_REWARD} mila kyunki aapne ek friend refer kiya!`,
// //             { parse_mode: "HTML" }
// //           );
// //         } catch (e) {}
// //       }
// //     }

// //     const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nAap yahan video ads dekh kar paise kama sakte hain. Har ad ke liye ₹${AD_REWARD} milta hai. Doston ko refer karke ₹${REFERRAL_REWARD} kamaaye.\n\nNiche diye gaye options me se choose karein.`;
// //     await bot.sendMessage(chatId, welcome, { parse_mode: "HTML", ...mainKeyboard });
// //   } catch (err) {
// //     console.error("Start error:", err);
// //     bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again.");
// //   }
// // });

// // // ====== Broadcast (admin only) ======
// // bot.onText(/\/broadcast (.+)/, async (msg, match) => {
// //   try {
// //     if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //     const text = match[1].trim();
// //     const users = await User.find({}, "telegramId");

// //     let sent = 0;
// //     for (const u of users) {
// //       try {
// //         await bot.sendMessage(
// //           u.telegramId,
// //           `📢 <b>Admin Broadcast</b>\n\n${escapeHtml(text)}`,
// //           { parse_mode: "HTML" }
// //         );
// //         sent++;
// //       } catch (e) {}
// //     }
// //     bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sent} users.`);
// //   } catch (e) {
// //     console.error("Broadcast error:", e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Broadcast failed.");
// //   }
// // });

// // // ====== Callback queries ======
// // bot.on("callback_query", async (q) => {
// //   const chatId = q.message.chat.id;
// //   const telegramId = q.from.id;
// //   const data = q.data;

// //   if (data === "pre_ad") {
// //     const text = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milega.\n\n⚠️ Video khatam hone tak tab close na karein.\n\nNiche button se ad dekhe.`;
// //     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
// //     await bot.sendMessage(chatId, text, {
// //       parse_mode: "HTML",
// //       reply_markup: { inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]] },
// //     });
// //     await bot.answerCallbackQuery(q.id);
// //     return;
// //   }

// //   if (data === "pre_ref") {
// //     const user = await ensureUser(telegramId);
// //     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
// //     const text = `👥 Invite karke ₹${REFERRAL_REWARD} kamaaye!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link: ${refLink}`;
// //     await bot.sendMessage(chatId, text, {
// //       parse_mode: "HTML",
// //       reply_markup: { inline_keyboard: [[{ text: "📤 Invite friends", switch_inline_query: `Join DailyKamai! ${refLink}` }]] },
// //     });
// //     await bot.answerCallbackQuery(q.id);
// //     return;
// //   }

// //   await bot.answerCallbackQuery(q.id);
// // });

// // // ====== Reply-keyboard messages ======
// // bot.on("message", async (msg) => {
// //   if (!msg.text) return;
// //   const text = msg.text.trim();
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;

// //   if (text.startsWith("/start")) return;

// //   const user = await ensureUser(telegramId, msg.from.first_name);
// //   await resetDailyIfNeeded(user);

// //   const joined = await ensureGroupFlag(user);
// //   if (!joined) {
// //     return bot.sendMessage(chatId, `📢 Aapko features use karne ke liye hamare Telegram group join karna zaroori hai.\n\nClick below to join and then come back.`, {
// //       parse_mode: "HTML",
// //       reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] },
// //     });
// //   }

// //   // ===== Button Handlers ======
// //   if (text === "🎬 Ad Dekho") {
// //     if (user.adsWatchedToday >= DAILY_LIMIT) return bot.sendMessage(chatId, `🚫 Aapne aaj ${DAILY_LIMIT} ads dekh liye hain. Kal fir se try karein.`, { parse_mode: "HTML", ...mainKeyboard });

// //     const textBefore = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milenge.\nVideo khatam hone tak tab close na karein.\n\nNiche button se ad dekhiye.`;
// //     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
// //     return bot.sendMessage(chatId, textBefore, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]] } });
// //   }

// //   if (text === "💰 Balance") {
// //     return bot.sendMessage(chatId, `<b>💰 Aapka Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });
// //   }

// //   if (text === "👥 Refer & Earn") {
// //     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
// //     return bot.sendMessage(chatId, `👥 Refer & Earn ₹${REFERRAL_REWARD}!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link: ${refLink}`, {
// //       parse_mode: "HTML",
// //       reply_markup: { inline_keyboard: [[{ text: "📤 Invite friends", switch_inline_query: `Join DailyKamai! ${refLink}` }]] },
// //     });
// //   }

// //   if (text === "🏦 Withdraw Funds") {
// //     if (!user.upi) {
// //       const sent = await bot.sendMessage(chatId, "🏦 Kripya apna UPI ID bheje (example: name@bank).", { parse_mode: "HTML", reply_markup: { force_reply: true } });
// //       const listener = async (m) => {
// //         if (!m.text) return;
// //         if (m.from.id !== telegramId) return;
// //         if (!m.reply_to_message || m.reply_to_message.message_id !== sent.message_id) return;

// //         user.upi = m.text.trim();
// //         await user.save();
// //         bot.sendMessage(chatId, `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`, { parse_mode: "HTML", ...mainKeyboard });
// //         bot.removeListener("message", listener);
// //       };
// //       bot.on("message", listener);
// //       return;
// //     }

// //     if (user.balance < MIN_WITHDRAW) return bot.sendMessage(chatId, `⚠️ Minimum withdrawal ₹${MIN_WITHDRAW} required. Aapka balance: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard });
// //     if (user.referralCount < MIN_REFERRALS) return bot.sendMessage(chatId, `👥 Minimum ${MIN_REFERRALS} referrals required. Aapke referrals: ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });
// //     const isMember = await ensureGroupFlag(user);
// //     if (!isMember) return bot.sendMessage(chatId, `🚨 Aapko group join karna zaroori hai for withdrawals.`, { parse_mode: "HTML", ...mainKeyboard });
// //     const days = Math.floor((Date.now() - new Date(user.firstSeen).getTime()) / (1000 * 60 * 60 * 24));
// //     if (days < MIN_DAYS_FOR_WITHDRAW) return bot.sendMessage(chatId, `⏳ Withdrawal allowed after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} days left)`, { parse_mode: "HTML", ...mainKeyboard });
// //     if (user.referralCount < 15) return bot.sendMessage(chatId, `👥 Withdrawal allowed only after completing 15 referrals.\nAapke referrals: ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });

// //     const payout = user.balance;
// //     user.balance = 0;
// //     await user.save();
// //     return bot.sendMessage(chatId, `✅ Withdrawal request placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`, { parse_mode: "HTML", ...mainKeyboard });
// //   }

// //   if (text === "🎁 Join Group") {
// //     return bot.sendMessage(chatId, `📢 Join our official Telegram group for updates and withdrawal announcements:`, {
// //       parse_mode: "HTML",
// //       reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] },
// //     });
// //   }

// //   return bot.sendMessage(chatId, "Menu se koi option choose karein.", { parse_mode: "HTML", ...mainKeyboard });
// // });

// // // ====== Express endpoints: ad page & reward ======
// // app.get("/ad", (req, res) => res.sendFile(path.join(__dirname, "public", "ad.html")));

// // app.get("/reward", async (req, res) => {
// //   try {
// //     const userId = Number(req.query.user);
// //     if (!userId) return res.status(400).send("Missing user");
// //     const user = await User.findOne({ telegramId: userId });
// //     if (!user) return res.status(404).send("User not found");

// //     await resetDailyIfNeeded(user);

// //     if (user.adsWatchedToday >= DAILY_LIMIT) return res.status(429).send("Daily limit reached");

// //     const now = new Date();
// //     if (user.lastAdAt && now.getTime() - new Date(user.lastAdAt).getTime() < (AD_SECONDS - 1) * 1000)
// //       return res.status(429).send("Too soon");

// //     user.balance += AD_REWARD;
// //     user.adsWatchedToday += 1;
// //     user.lastAdAt = new Date();
// //     await user.save();

// //     try {
// //       await bot.sendMessage(user.telegramId, `🎉 Aapne ₹${AD_REWARD} kamaye ad dekhne ke liye. Dhanyawad!\n\n💰 Aapka total balance: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard });
// //     } catch (e) {}

// //     return res.send("OK");
// //   } catch (e) {
// //     console.error("Reward error:", e);
// //     return res.status(500).send("Server error");
// //   }
// // });

// // // ====== Root & health ======
// // app.get("/", (req, res) => res.send("✅ DailyKamai bot is running fine!"));
// // app.get("/health-check", (req, res) => res.status(200).send("✅ DailyKamai bot is alive and healthy!"));

// // // ====== Start server ======
// // app.listen(PORT, "0.0.0.0", () => {
// //   console.log(`🌐 Web server running on port ${PORT}`);
// //   console.log(`🤖 DailyKamai Bot webhook URL: ${BASE_URL}${WEBHOOK_PATH}`);
// // });

// // // ====== Keep-alive ping ======
// // let keepAliveUrl = BASE_URL;
// // cron.schedule("*/5 * * * *", async () => {
// //   try {
// //     const res = await fetch(`${keepAliveUrl}/health-check`);
// //     if (res.ok) console.log(`🟢 Keep-alive ping OK at ${new Date().toLocaleTimeString()}`);
// //     else console.log(`🟠 Keep-alive ping failed: HTTP ${res.status}`);
// //   } catch (err) {
// //     console.error(`🔴 Keep-alive error: ${err.message}`);
// //   }
// // });












// // miche ka code pagal hai












// // index.js — DailyKamai final (bot + express + ad verification)
// // Requires environment variables: BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL

// // const express = require("express");
// // const path = require("path");
// // const mongoose = require("mongoose");
// // const TelegramBot = require("node-telegram-bot-api");
// // const cron = require("node-cron");
// // require("dotenv").config();

// // // ====== Config from environment ======
// // const BOT_TOKEN = process.env.BOT_TOKEN;
// // const MONGO_URI = process.env.MONGO_URI;
// // const GROUP_ID = process.env.GROUP_ID; // string, like "-1001234..."
// // const ADMIN_ID = process.env.ADMIN_ID; // string or number
// // const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// // if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID || !BASE_URL) {
// //   console.error(
// //     "Missing required env vars. Set BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL.",
// //   );
// //   process.exit(1);
// // }

// // // ====== Constants ======
// // const AD_REWARD = 3; // ₹3 per ad
// // const REFERRAL_REWARD = 50; // ₹50 per referral
// // const DAILY_LIMIT = 20; // 20 ads/day
// // const AD_SECONDS = 30; // 30s required
// // const MIN_WITHDRAW = 500; // ₹500 min
// // const MIN_REFERRALS = 5; // 5 referrals
// // const MIN_DAYS_FOR_WITHDRAW = 3; // 3 days since firstSeen

// // // ====== Setup Express & Bot ======
// // const app = express();
// // app.use(express.static(path.join(__dirname, "public")));

// // const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// // // ====== MongoDB Setup ======
// // mongoose
// //   .connect(MONGO_URI)
// //   .then(() => console.log("✅ MongoDB connected"))
// //   .catch((err) => {
// //     console.error("❌ MongoDB connection error:", err);
// //     process.exit(1);
// //   });

// // // Drop old indexes to avoid duplicate-null unique errors (runs once when db opens)
// // mongoose.connection.once("open", async () => {
// //   try {
// //     const cols = await mongoose.connection.db.collections();
// //     for (const c of cols) {
// //       if (c.collectionName === "users") {
// //         console.log("🧹 Dropping 'users' indexes (if any) ...");
// //         await c.dropIndexes().catch(() => {});
// //       }
// //     }
// //   } catch (e) {
// //     console.warn("Index cleanup warning:", e.message || e);
// //   }
// // });

// // // ====== User schema ======
// // const userSchema = new mongoose.Schema({
// //   telegramId: { type: Number, unique: true, required: true },
// //   firstSeen: { type: Date, default: Date.now },
// //   balance: { type: Number, default: 0 },
// //   referralCount: { type: Number, default: 0 },
// //   referredBy: { type: Number, default: null },
// //   upi: { type: String, default: "" },
// //   adsWatchedToday: { type: Number, default: 0 },
// //   lastAdAt: { type: Date, default: null },
// //   lastReset: { type: Date, default: () => new Date() },
// //   joinedGroup: { type: Boolean, default: false },
// // });

// // const User = mongoose.model("User", userSchema);

// // // ====== Reply keyboard (buttons below typing area) ======
// // const mainKeyboard = {
// //   reply_markup: {
// //     keyboard: [
// //       ["🎬 Ad Dekho", "💰 Balance"],
// //       ["👥 Refer & Earn", "🏦 Withdraw Funds"],
// //       ["🎁 Join Group"],
// //     ],
// //     resize_keyboard: true,
// //   },
// // };

// // // ====== Helpers ======
// // async function ensureUser(telegramId, firstName) {
// //   let u = await User.findOne({ telegramId });
// //   if (!u) {
// //     u = new User({ telegramId, firstSeen: new Date() });
// //     if (firstName) u.firstName = firstName;
// //     await u.save();
// //   }
// //   return u;
// // }

// // async function resetDailyIfNeeded(user) {
// //   const now = new Date();
// //   if (
// //     !user.lastReset ||
// //     now.toDateString() !== new Date(user.lastReset).toDateString()
// //   ) {
// //     user.adsWatchedToday = 0;
// //     user.lastReset = now;
// //     await user.save();
// //   }
// // }

// // async function ensureGroupFlag(user) {
// //   try {
// //     const member = await bot
// //       .getChatMember(String(GROUP_ID), user.telegramId)
// //       .catch(() => null);
// //     if (
// //       member &&
// //       ["member", "administrator", "creator"].includes(member.status)
// //     ) {
// //       if (!user.joinedGroup) {
// //         user.joinedGroup = true;
// //         await user.save();
// //       }
// //       return true;
// //     }
// //   } catch (e) {
// //     // ignore errors
// //   }
// //   return false;
// // }

// // // escape HTML to avoid injection when including dynamic strings (UPI, names)
// // function escapeHtml(text) {
// //   if (!text) return "";
// //   return String(text)
// //     .replace(/&/g, "&amp;")
// //     .replace(/</g, "&lt;")
// //     .replace(/>/g, "&gt;");
// // }

// // // ====== Cron: daily reset at midnight server time ======
// // cron.schedule("0 0 * * *", async () => {
// //   try {
// //     await User.updateMany(
// //       {},
// //       { $set: { adsWatchedToday: 0, lastReset: new Date() } },
// //     );
// //     console.log("🔁 Daily reset: adsWatchedToday cleared");
// //   } catch (e) {
// //     console.error("Daily reset error:", e);
// //   }
// // });

// // // ====== /start handler (supports referral code) ======
// // bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;
// //   const refId = match && match[1] ? Number(match[1]) : null;

// //   try {
// //     let user = await User.findOne({ telegramId });

// //     // If user doesn’t exist → show greeting & stop here
// //     if (!user) {
// //       user = new User({ telegramId, firstSeen: new Date() });
// //       await user.save();

// //       const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\n💬 Suru karne ke liye <b>/start</b> message me bheje.`;
// //       return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
// //     }

// //     // Existing user flow
// //     if (refId && refId !== telegramId) {
// //       const refUser = await User.findOne({ telegramId: refId });
// //       if (refUser && !user.referredBy) {
// //         refUser.balance += REFERRAL_REWARD;
// //         refUser.referralCount += 1;
// //         await refUser.save();

// //         user.referredBy = refId;
// //         await user.save();

// //         try {
// //           await bot.sendMessage(
// //             refUser.telegramId,
// //             `🎉 Aapko ₹${REFERRAL_REWARD} mila kyunki aapne ek friend refer kiya!`,
// //             { parse_mode: "HTML" },
// //           );
// //         } catch (e) {
// //           /* ignore */
// //         }
// //       }
// //     }

// //     const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nAap yahan video ads dekh kar paise kama sakte hain. Har ad ke liye ₹${AD_REWARD} milta hai. Doston ko refer karke ₹${REFERRAL_REWARD} kamaaye.\n\nNiche diye gaye options me se choose karein. suru karne ke liye /start chat me bheje `;
// //     await bot.sendMessage(chatId, welcome, {
// //       parse_mode: "HTML",
// //       ...mainKeyboard,
// //     });
// //   } catch (err) {
// //     console.error("Start error:", err);
// //     bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again.");
// //   }
// // });

// // // ====== Broadcast (admin only) ======
// // bot.onText(/\/broadcast (.+)/, async (msg, match) => {
// //   try {
// //     if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //     const text = match[1].trim();
// //     const users = await User.find({}, "telegramId");

// //     let sent = 0;
// //     for (const u of users) {
// //       try {
// //         await bot.sendMessage(
// //           u.telegramId,
// //           `📢 <b>Admin Broadcast</b>\n\n${escapeHtml(text)}`,
// //           { parse_mode: "HTML" },
// //         );
// //         sent++;
// //       } catch (e) {
// //         /* ignore per-user errors */
// //       }
// //     }
// //     bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sent} users.`);
// //   } catch (e) {
// //     console.error("Broadcast error:", e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Broadcast failed.");
// //   }
// // });

// // // ====== Callback queries for pre-ad and pre-ref interactions ======
// // bot.on("callback_query", async (q) => {
// //   const chatId = q.message.chat.id;
// //   const telegramId = q.from.id;
// //   const data = q.data;

// //   if (data === "pre_ad") {
// //     // show interactive ad instructions and button to open ad page
// //     const text = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milega.\n\n⚠️ Video khatam hone tak tab close na karein.\n\nNiche diye gaye button se ad dekhe.`;
// //     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
// //     await bot.sendMessage(chatId, text, {
// //       parse_mode: "HTML",
// //       reply_markup: {
// //         inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
// //       },
// //     });
// //     await bot.answerCallbackQuery(q.id);
// //     return;
// //   }

// //   if (data === "pre_ref") {
// //     // show referral info + link + forward button
// //     const user = await ensureUser(telegramId);
// //     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
// //     const text = `👥 Invite karke ₹${REFERRAL_REWARD} kamaaye!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link:`;
// //     await bot.sendMessage(chatId, `${text}\n${refLink}`, {
// //       parse_mode: "HTML",
// //       reply_markup: {
// //         inline_keyboard: [
// //           [
// //             {
// //               text: "📤 Apne doston ko invite karein",
// //               switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
// //             },
// //           ],
// //         ],
// //       },
// //     });
// //     await bot.answerCallbackQuery(q.id);
// //     return;
// //   }

// //   await bot.answerCallbackQuery(q.id);
// // });

// // // ====== Handle reply-keyboard messages (main flow) ======
// // bot.on("message", async (msg) => {
// //   if (!msg.text) return;
// //   const text = msg.text.trim();
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;

// //   // ignore /start here
// //   if (text.startsWith("/start")) return;

// //   // Ensure user exists
// //   const user = await ensureUser(telegramId, msg.from.first_name);
// //   // daily reset safety
// //   await resetDailyIfNeeded(user);

// //   // If user hasn't joined group, prompt join (we check on every action)
// //   const joined = await ensureGroupFlag(user);
// //   if (!joined) {
// //     // Prompt user to join group and return — cannot use features until joined
// //     return bot.sendMessage(
// //       chatId,
// //       `📢 Aapko features use karne ke liye hamare Telegram group join karna zaroori hai.\n\nClick below to join and then come back.`,
// //       {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [
// //             [{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }],
// //           ],
// //         },
// //       },
// //     );
// //   }

// //   // ===== Button: 🎬 Ad Dekho =====
// //   if (text === "🎬 Ad Dekho") {
// //     // check daily limit
// //     if (user.adsWatchedToday >= DAILY_LIMIT) {
// //       return bot.sendMessage(
// //         chatId,
// //         `🚫 Aapne aaj ${DAILY_LIMIT} ads dekh liye hain. Kal fir se try karein.`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     // show pre-ad information and open link (same as pre_ad callback)
// //     const textBefore = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milenge.\nVideo khatam hone tak tab close na karein.\n\nNiche button se ad dekhiye.`;
// //     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
// //     await bot.sendMessage(chatId, textBefore, {
// //       parse_mode: "HTML",
// //       reply_markup: {
// //         inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
// //       },
// //     });

// //     return;
// //   }

// //   // ===== Button: 💰 Balance =====
// //   if (text === "💰 Balance") {
// //     return bot.sendMessage(
// //       chatId,
// //       `<b>💰 Aapka Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`,
// //       { parse_mode: "HTML", ...mainKeyboard },
// //     );
// //   }

// //   // ===== Button: 👥 Refer & Earn =====
// //   if (text === "👥 Refer & Earn") {
// //     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
// //     const msgText = `👥 Refer & Earn ₹${REFERRAL_REWARD}!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link: ${refLink}`;
// //     await bot.sendMessage(chatId, msgText, {
// //       parse_mode: "HTML",
// //       reply_markup: {
// //         inline_keyboard: [
// //           [
// //             {
// //               text: "📤 Apne doston ko invite karein",
// //               switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
// //             },
// //           ],
// //         ],
// //       },
// //     });
// //     return;
// //   }

// //   // ===== Button: 🏦 Withdraw Funds =====
// //   if (text === "🏦 Withdraw Funds") {
// //     // ask for UPI if not exists
// //     if (!user.upi) {
// //       const sent = await bot.sendMessage(
// //         chatId,
// //         "🏦 Kripya apna UPI ID bheje (example: name@bank).",
// //         { parse_mode: "HTML", reply_markup: { force_reply: true } },
// //       );

// //       // one-time listener for reply
// //       const listener = async (m) => {
// //         if (!m.text) return;
// //         if (m.from.id !== telegramId) return;
// //         if (
// //           !m.reply_to_message ||
// //           m.reply_to_message.message_id !== sent.message_id
// //         )
// //           return;

// //         user.upi = m.text.trim();
// //         await user.save();
// //         bot.sendMessage(
// //           chatId,
// //           `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`,
// //           { parse_mode: "HTML", ...mainKeyboard },
// //         );
// //         bot.removeListener("message", listener);
// //       };
// //       bot.on("message", listener);
// //       return;
// //     }

// //     // check conditions
// //     if (user.balance < MIN_WITHDRAW) {
// //       return bot.sendMessage(
// //         chatId,
// //         `⚠️ Minimum withdrawal ₹${MIN_WITHDRAW} required. Aapka balance: ₹${user.balance}`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     if (user.referralCount < MIN_REFERRALS) {
// //       return bot.sendMessage(
// //         chatId,
// //         `👥 Minimum ${MIN_REFERRALS} referrals required. Aapke referrals: ${user.referralCount}`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     // check joined group again
// //     const isMember = await ensureGroupFlag(user);
// //     if (!isMember) {
// //       return bot.sendMessage(
// //         chatId,
// //         `🚨 Aapko group join karna zaroori hai for withdrawals.`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     // check days since firstSeen
// //     const days = Math.floor(
// //       (Date.now() - new Date(user.firstSeen).getTime()) / (1000 * 60 * 60 * 24),
// //     );
// //     if (days < MIN_DAYS_FOR_WITHDRAW) {
// //       return bot.sendMessage(
// //         chatId,
// //         `⏳ Withdrawal allowed after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} days left)`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //      // ✅ NEW CONDITION: must have at least 15 referrals
// //     if (user.referralCount < 15) {
// //       return bot.sendMessage(
// //         chatId,
// //         `👥 Withdrawal allowed only after completing 15 referrals.\nAapke referrals: ${user.referralCount}`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     // passed all checks
// //     const payout = user.balance;
// //     user.balance = 0;
// //     await user.save();

// //     return bot.sendMessage(
// //       chatId,
// //       `✅ Withdrawal request placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`,
// //       { parse_mode: "HTML", ...mainKeyboard },
// //     );
// //   }

// //   // ===== Button: 🎁 Join Group =====
// //   if (text === "🎁 Join Group") {
// //     return bot.sendMessage(
// //       chatId,
// //       `📢 Join our official Telegram group for updates and withdrawal announcements:`,
// //       {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [
// //             [{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }],
// //           ],
// //         },
// //       },
// //     );
// //   }

// //   // default: show keyboard
// //   return bot.sendMessage(chatId, "Menu se koi option choose karein.", {
// //     parse_mode: "HTML",
// //     ...mainKeyboard,
// //   });
// // });

// // // ====== Express endpoints: ad page & reward (called from ad.html) ======

// // // serve ad page (public/ad.html)
// // app.get("/ad", (req, res) => {
// //   res.sendFile(path.join(__dirname, "public", "ad.html"));
// // });

// // // reward endpoint: called by client after 30s
// // app.get("/reward", async (req, res) => {
// //   try {
// //     const userId = Number(req.query.user);
// //     if (!userId) return res.status(400).send("Missing user");
// //     const user = await User.findOne({ telegramId: userId });
// //     if (!user) return res.status(404).send("User not found");

// //     // safety: reset check
// //     await resetDailyIfNeeded(user);

// //     // daily limit
// //     if (user.adsWatchedToday >= DAILY_LIMIT) {
// //       return res.status(429).send("Daily limit reached");
// //     }

// //     // prevent fast double reward: check lastAdAt
// //     const now = new Date();
// //     if (
// //       user.lastAdAt &&
// //       now.getTime() - new Date(user.lastAdAt).getTime() <
// //         (AD_SECONDS - 1) * 1000
// //     ) {
// //       // too soon — ignore
// //       return res.status(429).send("Too soon");
// //     }

// //     // credit reward
// //     user.balance += AD_REWARD;
// //     user.adsWatchedToday += 1;
// //     user.lastAdAt = new Date();
// //     await user.save();

// //     // notify user in Telegram
// //     try {
// //       await bot.sendMessage(
// //         user.telegramId,
// //         `🎉 Aapne ₹${AD_REWARD} kamaye ad dekhne ke liye. Dhanyawad!\n\n💰 Aapka total balance: ₹${user.balance}`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     } catch (e) {
// //       // ignore send errors
// //       console.warn("Could not send TG message on reward:", e.message || e);
// //     }

// //     return res.send("OK");
// //   } catch (e) {
// //     console.error("Reward error:", e);
// //     return res.status(500).send("Server error");
// //   }
// // });

// // // ====== Simple keep-alive root route ======
// // app.get("/", (req, res) => {
// //   res.send("✅ DailyKamai bot is running fine!");
// // });

// // // ====== Health Check (for uptime pings) ======
// // app.get("/health-check", (req, res) => {
// //   res.status(200).send("✅ DailyKamai bot is alive and healthy!");
// // });

// // // ====== Start Express Server ======
// // const PORT = process.env.PORT || 3000;
// // app.listen(PORT, "0.0.0.0", () =>
// //   console.log(`🌐 Web server running on port ${PORT}`)
// // );

// // console.log("🤖 DailyKamai Bot is running...");

// // // ====== Auto Keep-Alive (Render / Replit / Local) ======

// // // Detect base URL automatically
// // let baseUrl = process.env.BASE_URL;
// // if (!baseUrl) {
// //   if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
// //     // Replit environment
// //     baseUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
// //   } else if (process.env.RENDER_EXTERNAL_URL) {
// //     // Render environment
// //     baseUrl = process.env.RENDER_EXTERNAL_URL;
// //   } else {
// //     // Localhost fallback
// //     baseUrl = `http://localhost:${PORT}`;
// //   }
// // }

// // console.log(`🌍 Using base URL for keep-alive: ${baseUrl}`);

// // // Use built-in fetch (Node 18+ — already available in Render)
// // cron.schedule("*/5 * * * *", async () => {
// //   try {
// //     const res = await fetch(`${baseUrl}/health-check`);
// //     if (res.ok) {
// //       console.log(`🟢 Keep-alive ping OK at ${new Date().toLocaleTimeString()}`);
// //     } else {
// //       console.log(`🟠 Keep-alive ping failed: HTTP ${res.status}`);
// //     }
// //   } catch (err) {
// //     console.error(`🔴 Keep-alive error: ${err.message}`);
// //   }
// // });





// // mai end karta huuuuuuuuuuuu...


// // // index.js — DailyKamai final (bot + express + ad verification)
// // // Requires environment variables: BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL

// // const express = require("express");
// // const path = require("path");
// // const mongoose = require("mongoose");
// // const TelegramBot = require("node-telegram-bot-api");
// // const cron = require("node-cron");
// // require("dotenv").config();

// // // ====== Config from environment ======
// // const BOT_TOKEN = process.env.BOT_TOKEN;
// // const MONGO_URI = process.env.MONGO_URI;
// // const GROUP_ID = process.env.GROUP_ID; // string, like "-1001234..."
// // const ADMIN_ID = process.env.ADMIN_ID; // string or number
// // const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// // if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID || !BASE_URL) {
// //   console.error(
// //     "Missing required env vars. Set BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL.",
// //   );
// //   process.exit(1);
// // }

// // // ====== Constants ======
// // const AD_REWARD = 3; // ₹3 per ad
// // const REFERRAL_REWARD = 50; // ₹50 per referral
// // const DAILY_LIMIT = 20; // 20 ads/day
// // const AD_SECONDS = 30; // 30s required
// // const MIN_WITHDRAW = 500; // ₹500 min
// // const MIN_REFERRALS = 5; // 5 referrals
// // const MIN_DAYS_FOR_WITHDRAW = 3; // 3 days since firstSeen

// // // ====== Setup Express & Bot ======
// // const app = express();
// // app.use(express.static(path.join(__dirname, "public")));

// // const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// // // ====== MongoDB Setup ======
// // mongoose
// //   .connect(MONGO_URI)
// //   .then(() => console.log("✅ MongoDB connected"))
// //   .catch((err) => {
// //     console.error("❌ MongoDB connection error:", err);
// //     process.exit(1);
// //   });

// // // Drop old indexes to avoid duplicate-null unique errors (runs once when db opens)
// // mongoose.connection.once("open", async () => {
// //   try {
// //     const cols = await mongoose.connection.db.collections();
// //     for (const c of cols) {
// //       if (c.collectionName === "users") {
// //         console.log("🧹 Dropping 'users' indexes (if any) ...");
// //         await c.dropIndexes().catch(() => {});
// //       }
// //     }
// //   } catch (e) {
// //     console.warn("Index cleanup warning:", e.message || e);
// //   }
// // });

// // // ====== User schema ======
// // const userSchema = new mongoose.Schema({
// //   telegramId: { type: Number, unique: true, required: true },
// //   firstSeen: { type: Date, default: Date.now },
// //   balance: { type: Number, default: 0 },
// //   referralCount: { type: Number, default: 0 },
// //   referredBy: { type: Number, default: null },
// //   upi: { type: String, default: "" },
// //   adsWatchedToday: { type: Number, default: 0 },
// //   lastAdAt: { type: Date, default: null },
// //   lastReset: { type: Date, default: () => new Date() },
// //   joinedGroup: { type: Boolean, default: false },
// // });

// // const User = mongoose.model("User", userSchema);

// // // ====== Reply keyboard (buttons below typing area) ======
// // const mainKeyboard = {
// //   reply_markup: {
// //     keyboard: [
// //       ["🎬 Ad Dekho", "💰 Balance"],
// //       ["👥 Refer & Earn", "🏦 Withdraw Funds"],
// //       ["🎁 Join Group"],
// //     ],
// //     resize_keyboard: true,
// //   },
// // };

// // // ====== Helpers ======
// // async function ensureUser(telegramId, firstName) {
// //   let u = await User.findOne({ telegramId });
// //   if (!u) {
// //     u = new User({ telegramId, firstSeen: new Date() });
// //     if (firstName) u.firstName = firstName;
// //     await u.save();
// //   }
// //   return u;
// // }

// // async function resetDailyIfNeeded(user) {
// //   const now = new Date();
// //   if (
// //     !user.lastReset ||
// //     now.toDateString() !== new Date(user.lastReset).toDateString()
// //   ) {
// //     user.adsWatchedToday = 0;
// //     user.lastReset = now;
// //     await user.save();
// //   }
// // }

// // async function ensureGroupFlag(user) {
// //   try {
// //     const member = await bot
// //       .getChatMember(String(GROUP_ID), user.telegramId)
// //       .catch(() => null);
// //     if (
// //       member &&
// //       ["member", "administrator", "creator"].includes(member.status)
// //     ) {
// //       if (!user.joinedGroup) {
// //         user.joinedGroup = true;
// //         await user.save();
// //       }
// //       return true;
// //     }
// //   } catch (e) {
// //     // ignore errors
// //   }
// //   return false;
// // }

// // // escape HTML to avoid injection when including dynamic strings (UPI, names)
// // function escapeHtml(text) {
// //   if (!text) return "";
// //   return String(text)
// //     .replace(/&/g, "&amp;")
// //     .replace(/</g, "&lt;")
// //     .replace(/>/g, "&gt;");
// // }

// // // ====== Cron: daily reset at midnight server time ======
// // cron.schedule("0 0 * * *", async () => {
// //   try {
// //     await User.updateMany(
// //       {},
// //       { $set: { adsWatchedToday: 0, lastReset: new Date() } },
// //     );
// //     console.log("🔁 Daily reset: adsWatchedToday cleared");
// //   } catch (e) {
// //     console.error("Daily reset error:", e);
// //   }
// // });

// // // ====== /start handler (supports referral code) ======
// // bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;
// //   const refId = match && match[1] ? Number(match[1]) : null;

// //   try {
// //     let user = await User.findOne({ telegramId });

// //     // If user doesn’t exist → show greeting & stop here
// //     if (!user) {
// //       user = new User({ telegramId, firstSeen: new Date() });
// //       await user.save();

// //       const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\n💬 Suru karne ke liye <b>/start</b> message me bheje.`;
// //       return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
// //     }

// //     // Existing user flow
// //     if (refId && refId !== telegramId) {
// //       const refUser = await User.findOne({ telegramId: refId });
// //       if (refUser && !user.referredBy) {
// //         refUser.balance += REFERRAL_REWARD;
// //         refUser.referralCount += 1;
// //         await refUser.save();

// //         user.referredBy = refId;
// //         await user.save();

// //         try {
// //           await bot.sendMessage(
// //             refUser.telegramId,
// //             `🎉 Aapko ₹${REFERRAL_REWARD} mila kyunki aapne ek friend refer kiya!`,
// //             { parse_mode: "HTML" },
// //           );
// //         } catch (e) {
// //           /* ignore */
// //         }
// //       }
// //     }

// //     const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nAap yahan video ads dekh kar paise kama sakte hain. Har ad ke liye ₹${AD_REWARD} milta hai. Doston ko refer karke ₹${REFERRAL_REWARD} kamaaye.\n\nNiche diye gaye options me se choose karein. suru karne ke liye /start chat me bheje `;
// //     await bot.sendMessage(chatId, welcome, {
// //       parse_mode: "HTML",
// //       ...mainKeyboard,
// //     });
// //   } catch (err) {
// //     console.error("Start error:", err);
// //     bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again.");
// //   }
// // });

// // // ====== Broadcast (admin only) ======
// // bot.onText(/\/broadcast (.+)/, async (msg, match) => {
// //   try {
// //     if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //     const text = match[1].trim();
// //     const users = await User.find({}, "telegramId");

// //     let sent = 0;
// //     for (const u of users) {
// //       try {
// //         await bot.sendMessage(
// //           u.telegramId,
// //           `📢 <b>Admin Broadcast</b>\n\n${escapeHtml(text)}`,
// //           { parse_mode: "HTML" },
// //         );
// //         sent++;
// //       } catch (e) {
// //         /* ignore per-user errors */
// //       }
// //     }
// //     bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sent} users.`);
// //   } catch (e) {
// //     console.error("Broadcast error:", e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Broadcast failed.");
// //   }
// // });

// // // ====== Callback queries for pre-ad and pre-ref interactions ======
// // bot.on("callback_query", async (q) => {
// //   const chatId = q.message.chat.id;
// //   const telegramId = q.from.id;
// //   const data = q.data;

// //   if (data === "pre_ad") {
// //     // show interactive ad instructions and button to open ad page
// //     const text = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milega.\n\n⚠️ Video khatam hone tak tab close na karein.\n\nNiche diye gaye button se ad dekhe.`;
// //     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
// //     await bot.sendMessage(chatId, text, {
// //       parse_mode: "HTML",
// //       reply_markup: {
// //         inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
// //       },
// //     });
// //     await bot.answerCallbackQuery(q.id);
// //     return;
// //   }

// //   if (data === "pre_ref") {
// //     // show referral info + link + forward button
// //     const user = await ensureUser(telegramId);
// //     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
// //     const text = `👥 Invite karke ₹${REFERRAL_REWARD} kamaaye!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link:`;
// //     await bot.sendMessage(chatId, `${text}\n${refLink}`, {
// //       parse_mode: "HTML",
// //       reply_markup: {
// //         inline_keyboard: [
// //           [
// //             {
// //               text: "📤 Apne doston ko invite karein",
// //               switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
// //             },
// //           ],
// //         ],
// //       },
// //     });
// //     await bot.answerCallbackQuery(q.id);
// //     return;
// //   }

// //   await bot.answerCallbackQuery(q.id);
// // });

// // // ====== Handle reply-keyboard messages (main flow) ======
// // bot.on("message", async (msg) => {
// //   if (!msg.text) return;
// //   const text = msg.text.trim();
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;

// //   // ignore /start here
// //   if (text.startsWith("/start")) return;

// //   // Ensure user exists
// //   const user = await ensureUser(telegramId, msg.from.first_name);
// //   // daily reset safety
// //   await resetDailyIfNeeded(user);

// //   // If user hasn't joined group, prompt join (we check on every action)
// //   const joined = await ensureGroupFlag(user);
// //   if (!joined) {
// //     // Prompt user to join group and return — cannot use features until joined
// //     return bot.sendMessage(
// //       chatId,
// //       `📢 Aapko features use karne ke liye hamare Telegram group join karna zaroori hai.\n\nClick below to join and then come back.`,
// //       {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [
// //             [{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }],
// //           ],
// //         },
// //       },
// //     );
// //   }

// //   // ===== Button: 🎬 Ad Dekho =====
// //   if (text === "🎬 Ad Dekho") {
// //     // check daily limit
// //     if (user.adsWatchedToday >= DAILY_LIMIT) {
// //       return bot.sendMessage(
// //         chatId,
// //         `🚫 Aapne aaj ${DAILY_LIMIT} ads dekh liye hain. Kal fir se try karein.`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     // show pre-ad information and open link (same as pre_ad callback)
// //     const textBefore = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milenge.\nVideo khatam hone tak tab close na karein.\n\nNiche button se ad dekhiye.`;
// //     const adUrl = `${BASE_URL}/ad?user=${telegramId}`;
// //     await bot.sendMessage(chatId, textBefore, {
// //       parse_mode: "HTML",
// //       reply_markup: {
// //         inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
// //       },
// //     });

// //     return;
// //   }

// //   // ===== Button: 💰 Balance =====
// //   if (text === "💰 Balance") {
// //     return bot.sendMessage(
// //       chatId,
// //       `<b>💰 Aapka Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`,
// //       { parse_mode: "HTML", ...mainKeyboard },
// //     );
// //   }

// //   // ===== Button: 👥 Refer & Earn =====
// //   if (text === "👥 Refer & Earn") {
// //     const refLink = `https://t.me/${(await bot.getMe()).username}?start=${telegramId}`;
// //     const msgText = `👥 Refer & Earn ₹${REFERRAL_REWARD}!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link: ${refLink}`;
// //     await bot.sendMessage(chatId, msgText, {
// //       parse_mode: "HTML",
// //       reply_markup: {
// //         inline_keyboard: [
// //           [
// //             {
// //               text: "📤 Apne doston ko invite karein",
// //               switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
// //             },
// //           ],
// //         ],
// //       },
// //     });
// //     return;
// //   }

// //   // ===== Button: 🏦 Withdraw Funds =====
// //   if (text === "🏦 Withdraw Funds") {
// //     // ask for UPI if not exists
// //     if (!user.upi) {
// //       const sent = await bot.sendMessage(
// //         chatId,
// //         "🏦 Kripya apna UPI ID bheje (example: name@bank).",
// //         { parse_mode: "HTML", reply_markup: { force_reply: true } },
// //       );

// //       // one-time listener for reply
// //       const listener = async (m) => {
// //         if (!m.text) return;
// //         if (m.from.id !== telegramId) return;
// //         if (
// //           !m.reply_to_message ||
// //           m.reply_to_message.message_id !== sent.message_id
// //         )
// //           return;

// //         user.upi = m.text.trim();
// //         await user.save();
// //         bot.sendMessage(
// //           chatId,
// //           `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`,
// //           { parse_mode: "HTML", ...mainKeyboard },
// //         );
// //         bot.removeListener("message", listener);
// //       };
// //       bot.on("message", listener);
// //       return;
// //     }

// //     // check conditions
// //     if (user.balance < MIN_WITHDRAW) {
// //       return bot.sendMessage(
// //         chatId,
// //         `⚠️ Minimum withdrawal ₹${MIN_WITHDRAW} required. Aapka balance: ₹${user.balance}`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     if (user.referralCount < MIN_REFERRALS) {
// //       return bot.sendMessage(
// //         chatId,
// //         `👥 Minimum ${MIN_REFERRALS} referrals required. Aapke referrals: ${user.referralCount}`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     // check joined group again
// //     const isMember = await ensureGroupFlag(user);
// //     if (!isMember) {
// //       return bot.sendMessage(
// //         chatId,
// //         `🚨 Aapko group join karna zaroori hai for withdrawals.`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     // check days since firstSeen
// //     const days = Math.floor(
// //       (Date.now() - new Date(user.firstSeen).getTime()) / (1000 * 60 * 60 * 24),
// //     );
// //     if (days < MIN_DAYS_FOR_WITHDRAW) {
// //       return bot.sendMessage(
// //         chatId,
// //         `⏳ Withdrawal allowed after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} days left)`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //      // ✅ NEW CONDITION: must have at least 15 referrals
// //     if (user.referralCount < 15) {
// //       return bot.sendMessage(
// //         chatId,
// //         `👥 Withdrawal allowed only after completing 15 referrals.\nAapke referrals: ${user.referralCount}`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     }

// //     // passed all checks
// //     const payout = user.balance;
// //     user.balance = 0;
// //     await user.save();

// //     return bot.sendMessage(
// //       chatId,
// //       `✅ Withdrawal request placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`,
// //       { parse_mode: "HTML", ...mainKeyboard },
// //     );
// //   }

// //   // ===== Button: 🎁 Join Group =====
// //   if (text === "🎁 Join Group") {
// //     return bot.sendMessage(
// //       chatId,
// //       `📢 Join our official Telegram group for updates and withdrawal announcements:`,
// //       {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [
// //             [{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }],
// //           ],
// //         },
// //       },
// //     );
// //   }

// //   // default: show keyboard
// //   return bot.sendMessage(chatId, "Menu se koi option choose karein.", {
// //     parse_mode: "HTML",
// //     ...mainKeyboard,
// //   });
// // });

// // // ====== Express endpoints: ad page & reward (called from ad.html) ======

// // // serve ad page (public/ad.html)
// // app.get("/ad", (req, res) => {
// //   res.sendFile(path.join(__dirname, "public", "ad.html"));
// // });

// // // reward endpoint: called by client after 30s
// // app.get("/reward", async (req, res) => {
// //   try {
// //     const userId = Number(req.query.user);
// //     if (!userId) return res.status(400).send("Missing user");
// //     const user = await User.findOne({ telegramId: userId });
// //     if (!user) return res.status(404).send("User not found");

// //     // safety: reset check
// //     await resetDailyIfNeeded(user);

// //     // daily limit
// //     if (user.adsWatchedToday >= DAILY_LIMIT) {
// //       return res.status(429).send("Daily limit reached");
// //     }

// //     // prevent fast double reward: check lastAdAt
// //     const now = new Date();
// //     if (
// //       user.lastAdAt &&
// //       now.getTime() - new Date(user.lastAdAt).getTime() <
// //         (AD_SECONDS - 1) * 1000
// //     ) {
// //       // too soon — ignore
// //       return res.status(429).send("Too soon");
// //     }

// //     // credit reward
// //     user.balance += AD_REWARD;
// //     user.adsWatchedToday += 1;
// //     user.lastAdAt = new Date();
// //     await user.save();

// //     // notify user in Telegram
// //     try {
// //       await bot.sendMessage(
// //         user.telegramId,
// //         `🎉 Aapne ₹${AD_REWARD} kamaye ad dekhne ke liye. Dhanyawad!\n\n💰 Aapka total balance: ₹${user.balance}`,
// //         { parse_mode: "HTML", ...mainKeyboard },
// //       );
// //     } catch (e) {
// //       // ignore send errors
// //       console.warn("Could not send TG message on reward:", e.message || e);
// //     }

// //     return res.send("OK");
// //   } catch (e) {
// //     console.error("Reward error:", e);
// //     return res.status(500).send("Server error");
// //   }
// // });

// // // ====== Simple keep-alive root route ======
// // app.get("/", (req, res) => {
// //   res.send("✅ DailyKamai bot is running fine!");
// // });

// // // ====== Health Check (for uptime pings) ======
// // app.get("/health-check", (req, res) => {
// //   res.status(200).send("✅ DailyKamai bot is alive and healthy!");
// // });

// // // ====== Start Express Server ======
// // const PORT = process.env.PORT || 3000;
// // app.listen(PORT, "0.0.0.0", () =>
// //   console.log(`🌐 Web server running on port ${PORT}`)
// // );

// // console.log("🤖 DailyKamai Bot is running...");

// // // ====== Auto Keep-Alive (Render / Replit / Local) ======

// // // Detect base URL automatically
// // let baseUrl = process.env.BASE_URL;
// // if (!baseUrl) {
// //   if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
// //     // Replit environment
// //     baseUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
// //   } else if (process.env.RENDER_EXTERNAL_URL) {
// //     // Render environment
// //     baseUrl = process.env.RENDER_EXTERNAL_URL;
// //   } else {
// //     // Localhost fallback
// //     baseUrl = `http://localhost:${PORT}`;
// //   }
// // }

// // console.log(`🌍 Using base URL for keep-alive: ${baseUrl}`);

// // // Use built-in fetch (Node 18+ — already available in Render)
// // cron.schedule("*/5 * * * *", async () => {
// //   try {
// //     const res = await fetch(`${baseUrl}/health-check`);
// //     if (res.ok) {
// //       console.log(`🟢 Keep-alive ping OK at ${new Date().toLocaleTimeString()}`);
// //     } else {
// //       console.log(`🟠 Keep-alive ping failed: HTTP ${res.status}`);
// //     }
// //   } catch (err) {
// //     console.error(`🔴 Keep-alive error: ${err.message}`);
// //   }
// // });





// // index.js — DailyKamai final (bot + express + ad verification)
// // Requires environment variables: BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID, BASE_URL

// // "use strict";

// // const express = require("express");
// // const path = require("path");
// // const mongoose = require("mongoose");
// // const TelegramBot = require("node-telegram-bot-api");
// // const cron = require("node-cron");
// // require("dotenv").config();

// // // ====== Config from environment ======
// // const BOT_TOKEN = process.env.BOT_TOKEN;
// // const MONGO_URI = process.env.MONGO_URI;
// // const GROUP_ID = process.env.GROUP_ID; // string, like "-1001234..."
// // const ADMIN_ID = process.env.ADMIN_ID; // string or number
// // const BASE_URL_ENV = process.env.BASE_URL;

// // if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID) {
// //   console.error(
// //     "Missing required env vars. Set BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID (and optionally BASE_URL).",
// //   );
// //   process.exit(1);
// // }

// // // ====== Constants ======
// // const AD_REWARD = 3; // ₹3 per ad
// // const REFERRAL_REWARD = 50; // ₹50 per referral
// // const DAILY_LIMIT = 20; // 20 ads/day
// // const AD_SECONDS = 30; // 30s required
// // const MIN_WITHDRAW = 500; // ₹500 min
// // const MIN_REFERRALS = 5; // 5 referrals
// // const MIN_DAYS_FOR_WITHDRAW = 3; // 3 days since firstSeen

// // // ====== Setup Express & Bot ======
// // const app = express();
// // app.use(express.static(path.join(__dirname, "public")));

// // // ====== MongoDB Setup ======
// // mongoose.set("strictQuery", true);
// // mongoose
// //   .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
// //   .then(() => console.log("✅ MongoDB connected"))
// //   .catch((err) => {
// //     console.error("❌ MongoDB connection error:", err);
// //     // Fatal: cannot proceed without DB
// //     process.exit(1);
// //   });

// // // Drop old indexes to avoid duplicate-null unique errors (runs once when db opens)
// // // KEEP this guarded and non-fatal
// // mongoose.connection.once("open", async () => {
// //   try {
// //     const cols = await mongoose.connection.db.collections();
// //     for (const c of cols) {
// //       if (c.collectionName === "users") {
// //         console.log("🧹 Dropping 'users' indexes (if any) ...");
// //         await c.dropIndexes().catch((err) => {
// //           // Not fatal; just warn so it won't crash startup
// //           if (err && err.message) console.warn("dropIndexes:", err.message);
// //         });
// //       }
// //     }
// //   } catch (e) {
// //     console.warn("Index cleanup warning:", e && e.message ? e.message : e);
// //   }
// // });

// // // ====== User schema ======
// // const userSchema = new mongoose.Schema({
// //   telegramId: { type: Number, unique: true, required: true },
// //   firstSeen: { type: Date, default: Date.now },
// //   balance: { type: Number, default: 0 },
// //   referralCount: { type: Number, default: 0 },
// //   referredBy: { type: Number, default: null },
// //   upi: { type: String, default: "" },
// //   adsWatchedToday: { type: Number, default: 0 },
// //   lastAdAt: { type: Date, default: null },
// //   lastReset: { type: Date, default: () => new Date() },
// //   joinedGroup: { type: Boolean, default: false },
// //   firstName: { type: String, default: "" },
// // });

// // const User = mongoose.model("User", userSchema);

// // // ====== Reply keyboard (buttons below typing area) ======
// // const mainKeyboard = {
// //   reply_markup: {
// //     keyboard: [
// //       ["🎬 Ad Dekho", "💰 Balance"],
// //       ["👥 Refer & Earn", "🏦 Withdraw Funds"],
// //       ["🎁 Join Group"],
// //     ],
// //     resize_keyboard: true,
// //   },
// // };

// // // ====== Helpers ======
// // async function ensureUser(telegramId, firstName) {
// //   let u = await User.findOne({ telegramId });
// //   if (!u) {
// //     u = new User({ telegramId, firstSeen: new Date(), firstName: firstName || "" });
// //     await u.save();
// //   }
// //   return u;
// // }

// // async function resetDailyIfNeeded(user) {
// //   const now = new Date();
// //   if (!user.lastReset || now.toDateString() !== new Date(user.lastReset).toDateString()) {
// //     user.adsWatchedToday = 0;
// //     user.lastReset = now;
// //     await user.save();
// //   }
// // }

// // async function ensureGroupFlag(user) {
// //   try {
// //     const member = await bot.getChatMember(String(GROUP_ID), user.telegramId).catch(() => null);
// //     if (member && ["member", "administrator", "creator"].includes(member.status)) {
// //       if (!user.joinedGroup) {
// //         user.joinedGroup = true;
// //         await user.save();
// //       }
// //       return true;
// //     }
// //   } catch (e) {
// //     // ignore errors (some Telegram errors occur for privacy)
// //   }
// //   return false;
// // }

// // // escape HTML to avoid injection when including dynamic strings (UPI, names)
// // function escapeHtml(text) {
// //   if (!text) return "";
// //   return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// // }

// // // ====== Start Express Server ======
// // const PORT = process.env.PORT || 3000;
// // app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server running on port ${PORT}`));

// // console.log("🤖 DailyKamai Bot is running...");

// // // ====== Initialize Telegram Bot with safe handlers ======
// // let bot;
// // try {
// //   bot = new TelegramBot(BOT_TOKEN, { polling: true });
// // } catch (e) {
// //   console.error("TelegramBot initialization error:", e);
// //   // If bot fails to construct, exit — we can't operate without bot
// //   process.exit(1);
// // }

// // // Handle polling errors gracefully (do not let them crash the process)
// // bot.on("polling_error", (err) => {
// //   try {
// //     console.error("polling_error:", err && err.message ? err.message : err);
// //     // if you want to inspect full object:
// //     // console.error(err);
// //   } catch (e) {
// //     console.error("Error while logging polling_error:", e);
// //   }
// // });

// // // Also catch webhook_error (if used in future)
// // bot.on("webhook_error", (err) => {
// //   console.error("webhook_error:", err && err.message ? err.message : err);
// // });

// // // ====== Cron: daily reset at midnight server time ======
// // cron.schedule("0 0 * * *", async () => {
// //   try {
// //     await User.updateMany({}, { $set: { adsWatchedToday: 0, lastReset: new Date() } });
// //     console.log("🔁 Daily reset: adsWatchedToday cleared");
// //   } catch (e) {
// //     console.error("Daily reset error:", e && e.message ? e.message : e);
// //   }
// // });

// // // ====== /start handler (supports referral code) ======
// // bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;
// //   const refId = match && match[1] ? Number(match[1]) : null;

// //   try {
// //     let user = await User.findOne({ telegramId });

// //     // If user doesn’t exist → show greeting & save basic user
// //     if (!user) {
// //       user = new User({ telegramId, firstSeen: new Date(), firstName: msg.from.first_name || "" });
// //       await user.save();

// //       const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\n💬 Suru karne ke liye /start message me bheje.`;
// //       return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
// //     }

// //     // Existing user flow
// //     if (refId && refId !== telegramId) {
// //       const refUser = await User.findOne({ telegramId: refId });
// //       if (refUser && !user.referredBy) {
// //         refUser.balance += REFERRAL_REWARD;
// //         refUser.referralCount += 1;
// //         await refUser.save();

// //         user.referredBy = refId;
// //         await user.save();

// //         try {
// //           await bot.sendMessage(refUser.telegramId, `🎉 Aapko ₹${REFERRAL_REWARD} mila kyunki aapne ek friend refer kiya!`, {
// //             parse_mode: "HTML",
// //             ...mainKeyboard,
// //           });
// //         } catch (e) {
// //           // ignore message send errors
// //           console.warn("Could not notify referrer:", e && e.message ? e.message : e);
// //         }
// //       }
// //     }

// //     const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nAap yahan video ads dekh kar paise kama sakte hain. Har ad ke liye ₹${AD_REWARD} milta hai. Doston ko refer karke ₹${REFERRAL_REWARD} kamaaye.\n\nNiche diye gaye options me se choose karein. suru karne ke liye /start chat me bheje `;
// //     await bot.sendMessage(chatId, welcome, { parse_mode: "HTML", ...mainKeyboard });
// //   } catch (err) {
// //     console.error("Start error:", err && err.message ? err.message : err);
// //     try {
// //       await bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again.");
// //     } catch (e) {
// //       // ignore
// //     }
// //   }
// // });

// // // ====== Broadcast (admin only) ======
// // bot.onText(/\/broadcast (.+)/, async (msg, match) => {
// //   try {
// //     if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //     const text = match[1].trim();
// //     const users = await User.find({}, "telegramId");

// //     let sent = 0;
// //     for (const u of users) {
// //       try {
// //         await bot.sendMessage(u.telegramId, `📢 <b>Admin Broadcast</b>\n\n${escapeHtml(text)}`, {
// //           parse_mode: "HTML",
// //         });
// //         sent++;
// //       } catch (e) {
// //         // ignore per-user errors (user blocked bot, etc.)
// //       }
// //     }
// //     bot.sendMessage(msg.chat.id, `✅ Broadcast sent to ${sent} users.`);
// //   } catch (e) {
// //     console.error("Broadcast error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Broadcast failed.");
// //   }
// // });

// // // ====== Callback queries for pre-ad and pre-ref interactions ======
// // bot.on("callback_query", async (q) => {
// //   const chatId = q.message.chat.id;
// //   const telegramId = q.from.id;
// //   const data = q.data;

// //   try {
// //     if (data === "pre_ad") {
// //       const text = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milega.\n\n⚠️ Video khatam hone tak tab close na karein.\n\nNiche diye gaye button se ad dekhe.`;
// //       const adUrl = `${getBaseUrlForPing()}/ad?user=${telegramId}`;
// //       await bot.sendMessage(chatId, text, {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
// //         },
// //       });
// //       await bot.answerCallbackQuery(q.id);
// //       return;
// //     }

// //     if (data === "pre_ref") {
// //       const user = await ensureUser(telegramId);
// //       const botInfo = await bot.getMe().catch(() => ({}));
// //       const refLink = `https://t.me/${botInfo.username || "DailyKamaiBot"}?start=${telegramId}`;
// //       const text = `👥 Invite karke ₹${REFERRAL_REWARD} kamaaye!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link:`;
// //       await bot.sendMessage(chatId, `${text}\n${refLink}`, {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [
// //             [
// //               {
// //                 text: "📤 Apne doston ko invite karein",
// //                 switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
// //               },
// //             ],
// //           ],
// //         },
// //       });
// //       await bot.answerCallbackQuery(q.id);
// //       return;
// //     }

// //     await bot.answerCallbackQuery(q.id);
// //   } catch (e) {
// //     console.error("callback_query error:", e && e.message ? e.message : e);
// //     try {
// //       await bot.answerCallbackQuery(q.id);
// //     } catch {}
// //   }
// // });

// // // ====== Handle reply-keyboard messages (main flow) ======
// // bot.on("message", async (msg) => {
// //   if (!msg.text) return;
// //   const text = msg.text.trim();
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;

// //   // ignore /start here (it's handled earlier)
// //   if (text.startsWith("/start")) return;

// //   try {
// //     const user = await ensureUser(telegramId, msg.from.first_name);
// //     await resetDailyIfNeeded(user);

// //     // If user hasn't joined group, prompt join (we check on every action)
// //     const joined = await ensureGroupFlag(user);
// //     if (!joined) {
// //       return bot.sendMessage(
// //         chatId,
// //         `📢 Aapko features use karne ke liye hamare Telegram group join karna zaroori hai.\n\nClick below to join and then come back.`,
// //         {
// //           parse_mode: "HTML",
// //           reply_markup: {
// //             inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]],
// //           },
// //         },
// //       );
// //     }

// //     // ===== Button: 🎬 Ad Dekho =====
// //     if (text === "🎬 Ad Dekho") {
// //       if (user.adsWatchedToday >= DAILY_LIMIT) {
// //         return bot.sendMessage(
// //           chatId,
// //           `🚫 Aapne aaj ${DAILY_LIMIT} ads dekh liye hain. Kal fir se try karein.`,
// //           { parse_mode: "HTML", ...mainKeyboard },
// //         );
// //       }

// //       const textBefore = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milenge.\nVideo khatam hone tak tab close na karein.\n\nNiche button se ad dekhiye.`;
// //       const adUrl = `${getBaseUrlForPing()}/ad?user=${telegramId}`;
// //       await bot.sendMessage(chatId, textBefore, {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
// //         },
// //       });

// //       return;
// //     }

// //     // ===== Button: 💰 Balance =====
// //     if (text === "💰 Balance") {
// //       return bot.sendMessage(chatId, `<b>💰 Aapka Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`, {
// //         parse_mode: "HTML",
// //         ...mainKeyboard,
// //       });
// //     }

// //     // ===== Button: 👥 Refer & Earn =====
// //     if (text === "👥 Refer & Earn") {
// //       const botInfo = await bot.getMe().catch(() => ({}));
// //       const refLink = `https://t.me/${botInfo.username || "DailyKamaiBot"}?start=${telegramId}`;
// //       const msgText = `👥 Refer & Earn ₹${REFERRAL_REWARD}!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link: ${refLink}`;
// //       await bot.sendMessage(chatId, msgText, {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [
// //             [
// //               {
// //                 text: "📤 Apne doston ko invite karein",
// //                 switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
// //               },
// //             ],
// //           ],
// //         },
// //       });
// //       return;
// //     }

// //     // ===== Button: 🏦 Withdraw Funds =====
// //     if (text === "🏦 Withdraw Funds") {
// //       if (!user.upi) {
// //         const sent = await bot.sendMessage(chatId, "🏦 Kripya apna UPI ID bheje (example: name@bank).", {
// //           parse_mode: "HTML",
// //           reply_markup: { force_reply: true },
// //         });

// //         const listener = async (m) => {
// //           if (!m.text) return;
// //           if (m.from.id !== telegramId) return;
// //           if (!m.reply_to_message || m.reply_to_message.message_id !== sent.message_id) return;

// //           user.upi = m.text.trim();
// //           await user.save();
// //           bot.sendMessage(chatId, `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`, { parse_mode: "HTML", ...mainKeyboard });
// //           bot.removeListener("message", listener);
// //         };
// //         bot.on("message", listener);
// //         return;
// //       }

// //       if (user.balance < MIN_WITHDRAW) {
// //         return bot.sendMessage(chatId, `⚠️ Minimum withdrawal ₹${MIN_WITHDRAW} required. Aapka balance: ₹${user.balance}`, {
// //           parse_mode: "HTML",
// //           ...mainKeyboard,
// //         });
// //       }

// //       if (user.referralCount < MIN_REFERRALS) {
// //         return bot.sendMessage(chatId, `👥 Minimum ${MIN_REFERRALS} referrals required. Aapke referrals: ${user.referralCount}`, {
// //           parse_mode: "HTML",
// //           ...mainKeyboard,
// //         });
// //       }

// //       const isMember = await ensureGroupFlag(user);
// //       if (!isMember) {
// //         return bot.sendMessage(chatId, `🚨 Aapko group join karna zaroori hai for withdrawals.`, { parse_mode: "HTML", ...mainKeyboard });
// //       }

// //       const days = Math.floor((Date.now() - new Date(user.firstSeen).getTime()) / (1000 * 60 * 60 * 24));
// //       if (days < MIN_DAYS_FOR_WITHDRAW) {
// //         return bot.sendMessage(chatId, `⏳ Withdrawal allowed after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} days left)`, {
// //           parse_mode: "HTML",
// //           ...mainKeyboard,
// //         });
// //       }

// //       // ✅ NEW CONDITION retained from your code
// //       if (user.referralCount < 15) {
// //         return bot.sendMessage(chatId, `👥 Withdrawal allowed only after completing 15 referrals.\nAapke referrals: ${user.referralCount}`, {
// //           parse_mode: "HTML",
// //         });
// //       }

// //       const payout = user.balance;
// //       user.balance = 0;
// //       await user.save();

// //       return bot.sendMessage(chatId, `✅ Withdrawal request placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`, {
// //         parse_mode: "HTML",
// //         ...mainKeyboard,
// //       });
// //     }

// //     // ===== Button: 🎁 Join Group =====
// //     if (text === "🎁 Join Group") {
// //       return bot.sendMessage(chatId, `📢 Join our official Telegram group for updates and withdrawal announcements:`, {
// //         parse_mode: "HTML",
// //         reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] },
// //       });
// //     }

// //     // default: show keyboard
// //     return bot.sendMessage(chatId, "Menu se koi option choose karein.", { parse_mode: "HTML", ...mainKeyboard });
// //   } catch (err) {
// //     console.error("message handler error:", err && err.message ? err.message : err);
// //     try {
// //       await bot.sendMessage(chatId, "⚠️ Koi error hua. Dobara try karein.");
// //     } catch {}
// //   }
// // });

// // // ====== Express endpoints: ad page & reward (called from ad.html) ======
// // // serve ad page (public/ad.html)
// // app.get("/ad", (req, res) => {
// //   res.sendFile(path.join(__dirname, "public", "ad.html"));
// // });

// // // reward endpoint: called by client after 30s
// // app.get("/reward", async (req, res) => {
// //   try {
// //     const userId = Number(req.query.user);
// //     if (!userId) return res.status(400).send("Missing user");
// //     const user = await User.findOne({ telegramId: userId });
// //     if (!user) return res.status(404).send("User not found");

// //     await resetDailyIfNeeded(user);

// //     if (user.adsWatchedToday >= DAILY_LIMIT) {
// //       return res.status(429).send("Daily limit reached");
// //     }

// //     const now = new Date();
// //     if (user.lastAdAt && now.getTime() - new Date(user.lastAdAt).getTime() < (AD_SECONDS - 1) * 1000) {
// //       return res.status(429).send("Too soon");
// //     }

// //     user.balance += AD_REWARD;
// //     user.adsWatchedToday += 1;
// //     user.lastAdAt = new Date();
// //     await user.save();

// //     try {
// //       await bot.sendMessage(user.telegramId, `🎉 Aapne ₹${AD_REWARD} kamaye ad dekhne ke liye. Dhanyawad!\n\n💰 Aapka total balance: ₹${user.balance}`, {
// //         parse_mode: "HTML",
// //         ...mainKeyboard,
// //       });
// //     } catch (e) {
// //       console.warn("Could not send TG message on reward:", e && e.message ? e.message : e);
// //     }

// //     return res.send("OK");
// //   } catch (e) {
// //     console.error("Reward error:", e && e.message ? e.message : e);
// //     return res.status(500).send("Server error");
// //   }
// // });

// // // ====== Simple keep-alive root route ======
// // app.get("/", (req, res) => {
// //   res.send("✅ DailyKamai bot is running fine!");
// // });

// // // ====== Health Check (for uptime pings) ======
// // app.get("/health-check", (req, res) => {
// //   res.status(200).send("✅ DailyKamai bot is alive and healthy!");
// // });

// // // ====== KEEP-ALIVE (safe) ======
// // function getBaseUrlForPing() {
// //   // Priority: explicit BASE_URL env -> RENDER_EXTERNAL_URL -> BASE_URL_ENV -> localhost fallback
// //   if (process.env.BASE_URL) return process.env.BASE_URL;
// //   if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
// //   if (BASE_URL_ENV) return BASE_URL_ENV;
// //   // fallback to server address
// //   return `http://localhost:${PORT}`;
// // }

// // const baseUrlForPing = getBaseUrlForPing();
// // console.log(`🌍 Using base URL for keep-alive: ${baseUrlForPing}`);

// // // Ping every 5 minutes to keep service awake (matches your previous cron schedule)
// // cron.schedule("*/5 * * * *", async () => {
// //   // use AbortController to avoid hanging forever
// //   const controller = new AbortController();
// //   const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout

// //   try {
// //     const res = await fetch(`${baseUrlForPing}/health-check`, { signal: controller.signal });
// //     if (res.ok) {
// //       console.log(`🟢 Keep-alive ping OK at ${new Date().toLocaleTimeString()}`);
// //     } else {
// //       console.log(`🟠 Keep-alive ping failed: HTTP ${res.status}`);
// //     }
// //   } catch (err) {
// //     // IMPORTANT: swallow errors to avoid crashing the process
// //     if (err && err.name === "AbortError") {
// //       console.error("🔴 Keep-alive error: request timed out (Abort)");
// //     } else {
// //       console.error("🔴 Keep-alive error:", err && err.message ? err.message : err);
// //     }
// //   } finally {
// //     clearTimeout(timeout);
// //   }
// // });

// // // ====== Global process handlers (prevent single network error from killing the process) ======
// // process.on("unhandledRejection", (reason, promise) => {
// //   console.error("Unhandled Rejection at:", promise, "reason:", reason);
// //   // do not exit; just log so Render won't mark as crashed repeatedly
// // });

// // process.on("uncaughtException", (err) => {
// //   // Log and continue — this is safer to avoid restart loops caused by transient errors.
// //   // In future you may choose to exit and let supervisor restart the process cleanly.
// //   console.error("Uncaught Exception:", err && err.stack ? err.stack : err);
// // });

// // // End of file



//  // New File start here ..

// // index.js — DailyKamai final (bot + express + ad verification) — Polling + single-group admin controls
// // "use strict";

// // const express = require("express");
// // const path = require("path");
// // const mongoose = require("mongoose");
// // const TelegramBot = require("node-telegram-bot-api");
// // const cron = require("node-cron");
// // require("dotenv").config();

// // // ====== Config from environment ======
// // const BOT_TOKEN = process.env.BOT_TOKEN;
// // const MONGO_URI = process.env.MONGO_URI;
// // const GROUP_ID = process.env.GROUP_ID; // string, like "-1001234..."
// // const ADMIN_ID = process.env.ADMIN_ID; // string or number
// // const BASE_URL_ENV = process.env.BASE_URL; // optional, used for keep-alive determination

// // if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID) {
// //   console.error(
// //     "Missing required env vars. Set BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID (and optionally BASE_URL)."
// //   );
// //   process.exit(1);
// // }

// // // ====== Constants ======
// // const AD_REWARD = 3; // ₹3 per ad
// // const REFERRAL_REWARD = 50; // ₹50 per referral
// // const DAILY_LIMIT = 20; // 20 ads/day
// // const AD_SECONDS = 30; // 30s required
// // const MIN_WITHDRAW = 500; // ₹500 min
// // const MIN_REFERRALS = 5; // 5 referrals
// // const MIN_DAYS_FOR_WITHDRAW = 3; // 3 days since firstSeen

// // // ====== Setup Express & Bot ======
// // const app = express();
// // app.use(express.json());
// // app.use(express.static(path.join(__dirname, "public")));

// // // ====== MongoDB Setup ======
// // mongoose.set("strictQuery", true);
// // mongoose
// //   .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
// //   .then(() => console.log("✅ MongoDB connected"))
// //   .catch((err) => {
// //     console.error("❌ MongoDB connection error:", err);
// //     process.exit(1);
// //   });

// // // defensive index drop (non-fatal)
// // mongoose.connection.once("open", async () => {
// //   try {
// //     const cols = await mongoose.connection.db.collections();
// //     for (const c of cols) {
// //       if (c.collectionName === "users") {
// //         console.log("🧹 Dropping 'users' indexes (if any) ...");
// //         await c.dropIndexes().catch((err) => {
// //           if (err && err.message) console.warn("dropIndexes:", err.message);
// //         });
// //       }
// //     }
// //   } catch (e) {
// //     console.warn("Index cleanup warning:", e && e.message ? e.message : e);
// //   }
// // });

// // // ====== User schema ======
// // const userSchema = new mongoose.Schema({
// //   telegramId: { type: Number, unique: true, required: true },
// //   firstSeen: { type: Date, default: Date.now },
// //   balance: { type: Number, default: 0 },
// //   referralCount: { type: Number, default: 0 },
// //   referredBy: { type: Number, default: null },
// //   upi: { type: String, default: "" },
// //   adsWatchedToday: { type: Number, default: 0 },
// //   lastAdAt: { type: Date, default: null },
// //   lastReset: { type: Date, default: () => new Date() },
// //   joinedGroup: { type: Boolean, default: false },
// //   firstName: { type: String, default: "" },
// // });
// // const User = mongoose.model("User", userSchema);

// // // ====== Config schema (persist broadcast message + interval) ======
// // const configSchema = new mongoose.Schema({
// //   key: { type: String, unique: true, required: true }, // only one doc with key = "broadcast"
// //   broadcastMessage: { type: String, default: "" },
// //   intervalMinutes: { type: Number, default: 60 }, // default every 60 minutes
// //   enabled: { type: Boolean, default: false }, // whether automatic broadcast is enabled
// // });
// // const Config = mongoose.model("Config", configSchema);

// // // ====== Reply keyboard ======
// // const mainKeyboard = {
// //   reply_markup: {
// //     keyboard: [
// //       ["🎬 Ad Dekho", "💰 Balance"],
// //       ["👥 Refer & Earn", "🏦 Withdraw Funds"],
// //       ["🎁 Join Group"],
// //     ],
// //     resize_keyboard: true,
// //   },
// // };

// // // ====== Helpers ======
// // function escapeHtml(text) {
// //   if (!text) return "";
// //   return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// // }

// // async function ensureUser(telegramId, firstName) {
// //   let u = await User.findOne({ telegramId });
// //   if (!u) {
// //     u = new User({ telegramId, firstSeen: new Date(), firstName: firstName || "" });
// //     await u.save();
// //   }
// //   return u;
// // }

// // async function resetDailyIfNeeded(user) {
// //   const now = new Date();
// //   if (!user.lastReset || now.toDateString() !== new Date(user.lastReset).toDateString()) {
// //     user.adsWatchedToday = 0;
// //     user.lastReset = now;
// //     await user.save();
// //   }
// // }

// // let bot; // declared early so helper functions can use it
// // async function ensureGroupFlag(user) {
// //   try {
// //     // if bot not ready, return false (no crash)
// //     if (!bot) return false;
// //     const member = await bot.getChatMember(String(GROUP_ID), user.telegramId).catch(() => null);
// //     if (member && ["member", "administrator", "creator"].includes(member.status)) {
// //       if (!user.joinedGroup) {
// //         user.joinedGroup = true;
// //         await user.save();
// //       }
// //       return true;
// //     }
// //   } catch (e) {
// //     // ignore privacy/permission errors
// //   }
// //   return false;
// // }

// // // ====== Start Express Server ======
// // const PORT = process.env.PORT || 3000;
// // app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server running on port ${PORT}`));
// // console.log("🤖 DailyKamai Bot is running...");

// // // ====== Initialize Telegram Bot (Polling) ======
// // try {
// //   bot = new TelegramBot(BOT_TOKEN, { polling: true });
// //   console.log("🔁 Bot using polling mode (suitable for Render free)");
// // } catch (e) {
// //   console.error("TelegramBot initialization error:", e);
// //   process.exit(1);
// // }

// // // safe polling error logger
// // bot.on("polling_error", (err) => {
// //   try {
// //     console.error("polling_error:", err && err.message ? err.message : err);
// //   } catch (e) {
// //     console.error("Error while logging polling_error:", e);
// //   }
// // });

// // // ====== Cron: daily reset ======
// // cron.schedule("0 0 * * *", async () => {
// //   try {
// //     await User.updateMany({}, { $set: { adsWatchedToday: 0, lastReset: new Date() } });
// //     console.log("🔁 Daily reset: adsWatchedToday cleared");
// //   } catch (e) {
// //     console.error("Daily reset error:", e && e.message ? e.message : e);
// //   }
// // });

// // // ====== Broadcast Controller (single-group) ======
// // let broadcastIntervalId = null;
// // async function loadAndStartBroadcastIfNeeded() {
// //   try {
// //     let cfg = await Config.findOne({ key: "broadcast" });
// //     if (!cfg) {
// //       cfg = new Config({ key: "broadcast", broadcastMessage: "", intervalMinutes: 60, enabled: false });
// //       await cfg.save();
// //     }

// //     stopBroadcastInterval(); // clear any old interval

// //     if (cfg.enabled && cfg.broadcastMessage && Number(cfg.intervalMinutes) > 0) {
// //       // start setInterval-based broadcaster
// //       const ms = Number(cfg.intervalMinutes) * 60 * 1000;
// //       broadcastIntervalId = setInterval(async () => {
// //         try {
// //           console.log(`📣 Broadcasting to group ${GROUP_ID} (scheduled)`);
// //           await bot.sendMessage(String(GROUP_ID), cfg.broadcastMessage, { parse_mode: "HTML" }).catch((e) => {
// //             console.warn("Broadcast send error:", e && e.message ? e.message : e);
// //           });
// //         } catch (e) {
// //           console.error("Broadcast loop error:", e && e.message ? e.message : e);
// //         }
// //       }, ms);
// //       console.log(`🟢 Automatic broadcast enabled: every ${cfg.intervalMinutes} minute(s)`);
// //     } else {
// //       console.log("⚪ Automatic broadcast disabled (cfg.enabled=false or message empty)");
// //     }
// //   } catch (e) {
// //     console.error("loadAndStartBroadcastIfNeeded error:", e && e.message ? e.message : e);
// //   }
// // }

// // function stopBroadcastInterval() {
// //   try {
// //     if (broadcastIntervalId) {
// //       clearInterval(broadcastIntervalId);
// //       broadcastIntervalId = null;
// //       console.log("🔴 Broadcast interval stopped");
// //     }
// //   } catch (e) {
// //     console.warn("stopBroadcastInterval error:", e && e.message ? e.message : e);
// //   }
// // }

// // // load config at startup
// // loadAndStartBroadcastIfNeeded().catch((e) => console.warn("Startup broadcast init err:", e && e.message ? e.message : e));

// // // ====== Admin commands (single group) ======
// // // /setmessage <text>   -> set broadcast message (admin only)
// // // /setinterval <minutes> -> set interval minutes (admin only)
// // // /listgroups -> show configured group(s) details (single-group returns GROUP_ID info)
// // // /broadcastnow -> send broadcast immediately (admin only)
// // bot.onText(/\/setmessage\s+([\s\S]+)/, async (msg, match) => {
// //   const fromId = String(msg.from.id);
// //   if (fromId !== String(ADMIN_ID)) return;
// //   const newMsg = match[1].trim();
// //   try {
// //     const cfg = await Config.findOneAndUpdate(
// //       { key: "broadcast" },
// //       { $set: { broadcastMessage: newMsg } },
// //       { upsert: true, new: true }
// //     );
// //     await loadAndStartBroadcastIfNeeded();
// //     await bot.sendMessage(msg.chat.id, `✅ Broadcast message updated.\n\nPreview:\n${newMsg}`, { parse_mode: "HTML" });
// //   } catch (e) {
// //     console.error("/setmessage error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Failed to update broadcast message.");
// //   }
// // });

// // bot.onText(/\/setinterval\s+(\d+)/, async (msg, match) => {
// //   const fromId = String(msg.from.id);
// //   if (fromId !== String(ADMIN_ID)) return;
// //   const minutes = Number(match[1]);
// //   if (!Number.isInteger(minutes) || minutes <= 0) {
// //     return bot.sendMessage(msg.chat.id, "⚠️ Interval must be a positive integer (minutes).");
// //   }
// //   try {
// //     await Config.findOneAndUpdate({ key: "broadcast" }, { $set: { intervalMinutes: minutes } }, { upsert: true });
// //     await loadAndStartBroadcastIfNeeded();
// //     await bot.sendMessage(msg.chat.id, `✅ Broadcast interval set to ${minutes} minute(s).`);
// //   } catch (e) {
// //     console.error("/setinterval error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Failed to set interval.");
// //   }
// // });

// // bot.onText(/\/listgroups/, async (msg) => {
// //   const fromId = String(msg.from.id);
// //   if (fromId !== String(ADMIN_ID)) {
// //     // allow admin-only to prevent info leak
// //     return;
// //   }
// //   try {
// //     // single group — return GROUP_ID and chat info if accessible
// //     let chatInfo = null;
// //     try {
// //       chatInfo = await bot.getChat(String(GROUP_ID));
// //     } catch (e) {
// //       // ignore
// //     }
// //     const title = chatInfo && chatInfo.title ? chatInfo.title : "Unknown (bot might not have access)";
// //     await bot.sendMessage(msg.chat.id, `📋 Configured single group:\nID: ${GROUP_ID}\nTitle: ${title}`);
// //   } catch (e) {
// //     console.error("/listgroups error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Failed to list groups.");
// //   }
// // });

// // bot.onText(/\/broadcastnow(?:\s+([\s\S]+))?/, async (msg, match) => {
// //   const fromId = String(msg.from.id);
// //   if (fromId !== String(ADMIN_ID)) return;
// //   const immediateText = match && match[1] ? match[1].trim() : null;
// //   try {
// //     const cfg = await Config.findOne({ key: "broadcast" });
// //     const textToSend = immediateText || (cfg && cfg.broadcastMessage) || "📣 Announcement";
// //     await bot.sendMessage(String(GROUP_ID), textToSend, { parse_mode: "HTML" });
// //     await bot.sendMessage(msg.chat.id, "✅ Broadcast sent to group.");
// //   } catch (e) {
// //     console.error("/broadcastnow error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Failed to send broadcast.");
// //   }
// // });

// // // ====== /start handler (supports referral code) ======
// // bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;
// //   const refId = match && match[1] ? Number(match[1]) : null;

// //   try {
// //     let user = await User.findOne({ telegramId });

// //     // New user: create and greet
// //     if (!user) {
// //       user = new User({ telegramId, firstSeen: new Date(), firstName: msg.from.first_name || "" });
// //       await user.save();

// //       const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\n💬 Suru karne ke liye /start message me bheje.`;
// //       return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
// //     }

// //     // existing user and referral handling
// //     if (refId && refId !== telegramId) {
// //       const refUser = await User.findOne({ telegramId: refId });
// //       if (refUser && !user.referredBy) {
// //         refUser.balance += REFERRAL_REWARD;
// //         refUser.referralCount += 1;
// //         await refUser.save();

// //         user.referredBy = refId;
// //         await user.save();

// //         try {
// //           await bot.sendMessage(refUser.telegramId, `🎉 Aapko ₹${REFERRAL_REWARD} mila kyunki aapne ek friend refer kiya!`, {
// //             parse_mode: "HTML",
// //             ...mainKeyboard,
// //           });
// //         } catch (e) {
// //           console.warn("Could not notify referrer:", e && e.message ? e.message : e);
// //         }
// //       }
// //     }

// //     const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nAap yahan video ads dekh kar paise kama sakte hain. Har ad ke liye ₹${AD_REWARD} milta hai. Doston ko refer karke ₹${REFERRAL_REWARD} kamaaye.\n\nNiche diye gaye options me se choose karein.`;
// //     await bot.sendMessage(chatId, welcome, { parse_mode: "HTML", ...mainKeyboard });
// //   } catch (err) {
// //     console.error("Start error:", err && err.message ? err.message : err);
// //     try {
// //       await bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again.");
// //     } catch (e) {
// //       // ignore
// //     }
// //   }
// // });

// // // ====== Broadcast interactive callbacks (pre_ad / pre_ref) ======
// // bot.on("callback_query", async (q) => {
// //   const chatId = q.message.chat.id;
// //   const telegramId = q.from.id;
// //   const data = q.data;

// //   try {
// //     if (data === "pre_ad") {
// //       const text = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milega.\n\n⚠️ Video khatam hone tak tab close na karein.\n\nNiche diye gaye button se ad dekhe.`;
// //       const adUrl = `${getBaseUrlForPing()}/ad?user=${telegramId}`;
// //       await bot.sendMessage(chatId, text, {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
// //         },
// //       });
// //       await bot.answerCallbackQuery(q.id);
// //       return;
// //     }

// //     if (data === "pre_ref") {
// //       const user = await ensureUser(telegramId);
// //       const botInfo = await bot.getMe().catch(() => ({}));
// //       const refLink = `https://t.me/${botInfo.username || "DailyKamaiBot"}?start=${telegramId}`;
// //       const text = `👥 Invite karke ₹${REFERRAL_REWARD} kamaaye!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link:`;
// //       await bot.sendMessage(chatId, `${text}\n${refLink}`, {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [
// //             [
// //               {
// //                 text: "📤 Apne doston ko invite karein",
// //                 switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
// //               },
// //             ],
// //           ],
// //         },
// //       });
// //       await bot.answerCallbackQuery(q.id);
// //       return;
// //     }

// //     await bot.answerCallbackQuery(q.id);
// //   } catch (e) {
// //     console.error("callback_query error:", e && e.message ? e.message : e);
// //     try {
// //       await bot.answerCallbackQuery(q.id);
// //     } catch (_) {}
// //   }
// // });

// // // ====== Handle reply-keyboard messages (main flow) ======
// // bot.on("message", async (msg) => {
// //   if (!msg.text) return;
// //   const text = msg.text.trim();
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;

// //   // ignore /start here (it's handled above)
// //   if (text.startsWith("/start")) return;

// //   try {
// //     const user = await ensureUser(telegramId, msg.from.first_name);
// //     await resetDailyIfNeeded(user);

// //     const joined = await ensureGroupFlag(user);
// //     if (!joined) {
// //       return bot.sendMessage(
// //         chatId,
// //         `📢 Aapko features use karne ke liye hamare Telegram group join karna zaroori hai.\n\nClick below to join and then come back.`,
// //         {
// //           parse_mode: "HTML",
// //           reply_markup: {
// //             inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]],
// //           },
// //         }
// //       );
// //     }

// //     // ===== Button: 🎬 Ad Dekho =====
// //     if (text === "🎬 Ad Dekho") {
// //       if (user.adsWatchedToday >= DAILY_LIMIT) {
// //         return bot.sendMessage(chatId, `🚫 Aapne aaj ${DAILY_LIMIT} ads dekh liye hain. Kal fir se try karein.`, {
// //           parse_mode: "HTML",
// //           ...mainKeyboard,
// //         });
// //       }

// //       const textBefore = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milenge.\nVideo khatam hone tak tab close na karein.\n\nNiche button se ad dekhiye.`;
// //       const adUrl = `${getBaseUrlForPing()}/ad?user=${telegramId}`;
// //       await bot.sendMessage(chatId, textBefore, {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]],
// //         },
// //       });

// //       return;
// //     }

// //     // ===== Button: 💰 Balance =====
// //     if (text === "💰 Balance") {
// //       return bot.sendMessage(chatId, `<b>💰 Aapka Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`, {
// //         parse_mode: "HTML",
// //         ...mainKeyboard,
// //       });
// //     }

// //     // ===== Button: 👥 Refer & Earn =====
// //     if (text === "👥 Refer & Earn") {
// //       const botInfo = await bot.getMe().catch(() => ({}));
// //       const refLink = `https://t.me/${botInfo.username || "DailyKamaiBot"}?start=${telegramId}`;
// //       const msgText = `👥 Refer & Earn ₹${REFERRAL_REWARD}!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link: ${refLink}`;
// //       await bot.sendMessage(chatId, msgText, {
// //         parse_mode: "HTML",
// //         reply_markup: {
// //           inline_keyboard: [
// //             [
// //               {
// //                 text: "📤 Apne doston ko invite karein",
// //                 switch_inline_query: `Join DailyKamai and earn! ${refLink}`,
// //               },
// //             ],
// //           ],
// //         },
// //       });
// //       return;
// //     }

// //     // ===== Button: 🏦 Withdraw Funds =====
// //     if (text === "🏦 Withdraw Funds") {
// //       if (!user.upi) {
// //         const sent = await bot.sendMessage(chatId, "🏦 Kripya apna UPI ID bheje (example: name@bank).", {
// //           parse_mode: "HTML",
// //           reply_markup: { force_reply: true },
// //         });

// //         const listener = async (m) => {
// //           if (!m.text) return;
// //           if (m.from.id !== telegramId) return;
// //           if (!m.reply_to_message || m.reply_to_message.message_id !== sent.message_id) return;

// //           user.upi = m.text.trim();
// //           await user.save();
// //           bot.sendMessage(chatId, `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`, { parse_mode: "HTML", ...mainKeyboard });
// //           bot.removeListener("message", listener);
// //         };
// //         bot.on("message", listener);
// //         return;
// //       }

// //       if (user.balance < MIN_WITHDRAW) {
// //         return bot.sendMessage(chatId, `⚠️ Minimum withdrawal ₹${MIN_WITHDRAW} required. Aapka balance: ₹${user.balance}`, {
// //           parse_mode: "HTML",
// //           ...mainKeyboard,
// //         });
// //       }

// //       if (user.referralCount < MIN_REFERRALS) {
// //         return bot.sendMessage(chatId, `👥 Minimum ${MIN_REFERRALS} referrals required. Aapke referrals: ${user.referralCount}`, {
// //           parse_mode: "HTML",
// //           ...mainKeyboard,
// //         });
// //       }

// //       const isMember = await ensureGroupFlag(user);
// //       if (!isMember) {
// //         return bot.sendMessage(chatId, `🚨 Aapko group join karna zaroori hai for withdrawals.`, { parse_mode: "HTML", ...mainKeyboard });
// //       }

// //       const days = Math.floor((Date.now() - new Date(user.firstSeen).getTime()) / (1000 * 60 * 60 * 24));
// //       if (days < MIN_DAYS_FOR_WITHDRAW) {
// //         return bot.sendMessage(chatId, `⏳ Withdrawal allowed after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} days left)`, {
// //           parse_mode: "HTML",
// //           ...mainKeyboard,
// //         });
// //       }

// //       if (user.referralCount < 15) {
// //         return bot.sendMessage(chatId, `👥 Withdrawal allowed only after completing 15 referrals.\nAapke referrals: ${user.referralCount}`, {
// //           parse_mode: "HTML",
// //         });
// //       }

// //       const payout = user.balance;
// //       user.balance = 0;
// //       await user.save();

// //       return bot.sendMessage(chatId, `✅ Withdrawal request placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`, {
// //         parse_mode: "HTML",
// //         ...mainKeyboard,
// //       });
// //     }

// //     // ===== Button: 🎁 Join Group =====
// //     if (text === "🎁 Join Group") {
// //       return bot.sendMessage(chatId, `📢 Join our official Telegram group for updates and withdrawal announcements:`, {
// //         parse_mode: "HTML",
// //         reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] },
// //       });
// //     }

// //     // default
// //     return bot.sendMessage(chatId, "Menu se koi option choose karein.", { parse_mode: "HTML", ...mainKeyboard });
// //   } catch (err) {
// //     console.error("message handler error:", err && err.message ? err.message : err);
// //     try {
// //       await bot.sendMessage(chatId, "⚠️ Koi error hua. Dobara try karein.");
// //     } catch (_) {}
// //   }
// // });

// // // ====== Express endpoints: ad page & reward ======
// // app.get("/ad", (req, res) => {
// //   res.sendFile(path.join(__dirname, "public", "ad.html"));
// // });

// // app.get("/reward", async (req, res) => {
// //   try {
// //     const userId = Number(req.query.user);
// //     if (!userId) return res.status(400).send("Missing user");
// //     const user = await User.findOne({ telegramId: userId });
// //     if (!user) return res.status(404).send("User not found");

// //     await resetDailyIfNeeded(user);

// //     if (user.adsWatchedToday >= DAILY_LIMIT) {
// //       return res.status(429).send("Daily limit reached");
// //     }

// //     const now = new Date();
// //     if (user.lastAdAt && now.getTime() - new Date(user.lastAdAt).getTime() < (AD_SECONDS - 1) * 1000) {
// //       return res.status(429).send("Too soon");
// //     }

// //     user.balance += AD_REWARD;
// //     user.adsWatchedToday += 1;
// //     user.lastAdAt = new Date();
// //     await user.save();

// //     try {
// //       await bot.sendMessage(user.telegramId, `🎉 Aapne ₹${AD_REWARD} kamaye ad dekhne ke liye. Dhanyawad!\n\n💰 Aapka total balance: ₹${user.balance}`, {
// //         parse_mode: "HTML",
// //         ...mainKeyboard,
// //       });
// //     } catch (e) {
// //       console.warn("Could not send TG message on reward:", e && e.message ? e.message : e);
// //     }

// //     return res.send("OK");
// //   } catch (e) {
// //     console.error("Reward error:", e && e.message ? e.message : e);
// //     return res.status(500).send("Server error");
// //   }
// // });

// // // ====== Simple keep-alive root route ======
// // app.get("/", (req, res) => {
// //   res.send("✅ DailyKamai bot is running fine!");
// // });

// // // ====== Health Check ======
// // app.get("/health-check", (req, res) => {
// //   res.status(200).send("✅ DailyKamai bot is alive and healthy!");
// // });

// // // optional route for external pings to keep instance awake
// // app.get("/keep_alive", (req, res) => {
// //   res.status(200).send("OK");
// // });

// // // ====== KEEP-ALIVE (safe) ======
// // function getBaseUrlForPing() {
// //   if (process.env.BASE_URL) return process.env.BASE_URL;
// //   if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
// //   if (BASE_URL_ENV) return BASE_URL_ENV;
// //   return `http://localhost:${PORT}`;
// // }
// // const baseUrlForPing = getBaseUrlForPing();
// // console.log(`🌍 Using base URL for keep-alive: ${baseUrlForPing}`);

// // // Ping every 5 minutes (safe, errors swallowed) — useful alongside UptimeRobot / cron-job.org
// // cron.schedule("*/5 * * * *", async () => {
// //   const controller = new AbortController();
// //   const timeout = setTimeout(() => controller.abort(), 10_000);
// //   try {
// //     const res = await fetch(`${baseUrlForPing}/health-check`, { signal: controller.signal });
// //     if (res.ok) {
// //       console.log(`🟢 Keep-alive ping OK at ${new Date().toLocaleTimeString()}`);
// //     } else {
// //       console.log(`🟠 Keep-alive ping failed: HTTP ${res.status}`);
// //     }
// //   } catch (err) {
// //     if (err && err.name === "AbortError") {
// //       console.error("🔴 Keep-alive error: request timed out (Abort)");
// //     } else {
// //       console.error("🔴 Keep-alive error:", err && err.message ? err.message : err);
// //     }
// //   } finally {
// //     clearTimeout(timeout);
// //   }
// // });

// // // ====== Global process handlers ======
// // process.on("unhandledRejection", (reason, promise) => {
// //   console.error("Unhandled Rejection at:", promise, "reason:", reason);
// // });
// // process.on("uncaughtException", (err) => {
// //   console.error("Uncaught Exception:", err && err.stack ? err.stack : err);
// // });

// // ====== Graceful shutdown helper (optional) ======
// // async function shutdown() {
// //   try {
// //     console.log("Shutting down...");
// //     stopBroadcastInterval();
// //     await mongoose.disconnect();
// //     process.exit(0);
// //   } catch (e) {
// //     console.error("Shutdown error:", e && e.message ? e.message : e);
// //     process.exit(1);
// //   }
// // }
// // process.on("SIGINT", shutdown);
// // process.on("SIGTERM", shutdown);

// // ====== End of file ======


// // Again New file..

// // index.js — DailyKamai final (cleaned + optimized) — Polling + single-group + keep-alive + MAU
// // "use strict";

// // const express = require("express");
// // const path = require("path");
// // const mongoose = require("mongoose");
// // const TelegramBot = require("node-telegram-bot-api");
// // const cron = require("node-cron");
// // require("dotenv").config();

// // // ====== Config from environment ======
// // const BOT_TOKEN = process.env.BOT_TOKEN;
// // const MONGO_URI = process.env.MONGO_URI;
// // const GROUP_ID = process.env.GROUP_ID; // e.g. "-100123456..."
// // const ADMIN_ID = process.env.ADMIN_ID; // e.g. "123456789"
// // const BASE_URL_ENV = process.env.BASE_URL || "https://dailykamai-bot.onrender.com";

// // if (!BOT_TOKEN || !MONGO_URI || !GROUP_ID || !ADMIN_ID) {
// //   console.error("Missing env vars: BOT_TOKEN, MONGO_URI, GROUP_ID, ADMIN_ID required.");
// //   process.exit(1);
// // }

// // // ====== Constants ======
// // const AD_REWARD = 3;
// // const REFERRAL_REWARD = 50;
// // const DAILY_LIMIT = 20;
// // const AD_SECONDS = 30;
// // const MIN_WITHDRAW = 500;
// // const MIN_REFERRALS = 5;
// // const MIN_DAYS_FOR_WITHDRAW = 3;

// // // ====== Express setup ======
// // const app = express();
// // app.use(express.json());
// // app.use(express.static(path.join(__dirname, "public")));

// // const PORT = process.env.PORT || 3000;

// // // ====== MongoDB setup ======
// // mongoose.set("strictQuery", true);
// // mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
// //   .then(() => console.log("✅ MongoDB connected"))
// //   .catch((err) => {
// //     console.error("❌ MongoDB connection error:", err);
// //     process.exit(1);
// //   });

// // // ====== Schemas ======
// // const userSchema = new mongoose.Schema({
// //   telegramId: { type: Number, unique: true, required: true },
// //   firstSeen: { type: Date, default: Date.now },
// //   lastActivity: { type: Date, default: Date.now }, // NEW: track activity for MAU
// //   balance: { type: Number, default: 0 },
// //   referralCount: { type: Number, default: 0 },
// //   referredBy: { type: Number, default: null },
// //   upi: { type: String, default: "" },
// //   adsWatchedToday: { type: Number, default: 0 },
// //   lastAdAt: { type: Date, default: null },
// //   lastReset: { type: Date, default: () => new Date() },
// //   joinedGroup: { type: Boolean, default: false },
// //   firstName: { type: String, default: "" },
// // });
// // const User = mongoose.model("User", userSchema);

// // const configSchema = new mongoose.Schema({
// //   key: { type: String, unique: true, required: true },
// //   broadcastMessage: { type: String, default: "" },
// //   intervalMinutes: { type: Number, default: 60 },
// //   enabled: { type: Boolean, default: false },
// // });
// // const Config = mongoose.model("Config", configSchema);

// // // ====== Keyboard ======
// // const mainKeyboard = {
// //   reply_markup: {
// //     keyboard: [
// //       ["🎬 Ad Dekho", "💰 Balance"],
// //       ["👥 Refer & Earn", "🏦 Withdraw Funds"],
// //       ["🎁 Join Group"],
// //     ],
// //     resize_keyboard: true,
// //   },
// // };

// // // ====== Helpers ======
// // function escapeHtml(text) {
// //   if (!text) return "";
// //   return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// // }

// // async function ensureUser(telegramId, firstName) {
// //   let u = await User.findOne({ telegramId });
// //   if (!u) {
// //     u = new User({ telegramId, firstSeen: new Date(), firstName: firstName || "", lastActivity: new Date() });
// //     await u.save();
// //     return u;
// //   }
// //   // update lastActivity when ensuring (keeps MAU accurate when called)
// //   u.lastActivity = new Date();
// //   if (firstName && !u.firstName) u.firstName = firstName;
// //   await u.save().catch(() => {});
// //   return u;
// // }

// // async function resetDailyIfNeeded(user) {
// //   const now = new Date();
// //   if (!user.lastReset || now.toDateString() !== new Date(user.lastReset).toDateString()) {
// //     user.adsWatchedToday = 0;
// //     user.lastReset = now;
// //     await user.save().catch(() => {});
// //   }
// // }

// // let bot;
// // async function ensureGroupFlag(user) {
// //   try {
// //     if (!bot) return false;
// //     const member = await bot.getChatMember(String(GROUP_ID), user.telegramId).catch(() => null);
// //     if (member && ["member", "administrator", "creator"].includes(member.status)) {
// //       if (!user.joinedGroup) {
// //         user.joinedGroup = true;
// //         await user.save().catch(() => {});
// //       }
// //       return true;
// //     }
// //   } catch (e) {
// //     // ignore
// //   }
// //   return false;
// // }

// // // ====== Start server ======
// // app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server running on port ${PORT}`));
// // console.log("🤖 DailyKamai Bot is starting...");

// // // ====== Initialize bot (Polling) ======
// // try {
// //   bot = new TelegramBot(BOT_TOKEN, { polling: true });
// //   console.log("🔁 Using polling mode (good for Render free)");
// // } catch (e) {
// //   console.error("TelegramBot init error:", e);
// //   process.exit(1);
// // }

// // // log polling errors safely
// // bot.on("polling_error", (err) => {
// //   try { console.error("polling_error:", err && err.message ? err.message : err); } catch (e) {}
// // });

// // // ====== Daily reset (midnight server time) ======
// // cron.schedule("0 0 * * *", async () => {
// //   try {
// //     await User.updateMany({}, { $set: { adsWatchedToday: 0, lastReset: new Date() } });
// //     console.log("🔁 Daily reset executed");
// //   } catch (e) {
// //     console.error("Daily reset error:", e && e.message ? e.message : e);
// //   }
// // });

// // // ====== Broadcast controller (single-group) ======
// // let broadcastIntervalId = null;
// // async function startBroadcastInterval(cfg) {
// //   stopBroadcastInterval();
// //   if (!cfg || !cfg.enabled || !cfg.broadcastMessage || !Number(cfg.intervalMinutes)) {
// //     console.log("⚪ Broadcast disabled or misconfigured");
// //     return;
// //   }
// //   const ms = Number(cfg.intervalMinutes) * 60 * 1000;
// //   broadcastIntervalId = setInterval(async () => {
// //     try {
// //       console.log(`📣 Scheduled broadcast to ${GROUP_ID}`);
// //       await bot.sendMessage(String(GROUP_ID), cfg.broadcastMessage, { parse_mode: "HTML" }).catch((e) => {
// //         console.warn("Broadcast send failed:", e && e.message ? e.message : e);
// //       });
// //     } catch (e) {
// //       console.error("Broadcast loop error:", e && e.message ? e.message : e);
// //     }
// //   }, ms);
// //   console.log(`🟢 Broadcast scheduled every ${cfg.intervalMinutes} minute(s)`);
// // }

// // function stopBroadcastInterval() {
// //   if (broadcastIntervalId) {
// //     clearInterval(broadcastIntervalId);
// //     broadcastIntervalId = null;
// //     console.log("🔴 Broadcast interval stopped");
// //   }
// // }
// // async function loadBroadcastConfig() {
// //   try {
// //     let cfg = await Config.findOne({ key: "broadcast" });
// //     if (!cfg) {
// //       cfg = new Config({ key: "broadcast", broadcastMessage: "", intervalMinutes: 60, enabled: false });
// //       await cfg.save();
// //     }
// //     await startBroadcastInterval(cfg);
// //   } catch (e) {
// //     console.error("loadBroadcastConfig error:", e && e.message ? e.message : e);
// //   }
// // }
// // loadBroadcastConfig().catch(() => {});

// // // ====== Admin commands ======
// // bot.onText(/\/setmessage\s+([\s\S]+)/, async (msg, match) => {
// //   if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //   const text = match[1].trim();
// //   try {
// //     await Config.findOneAndUpdate({ key: "broadcast" }, { $set: { broadcastMessage: text } }, { upsert: true });
// //     await loadBroadcastConfig();
// //     await bot.sendMessage(msg.chat.id, "✅ Broadcast message updated.", { parse_mode: "HTML" });
// //   } catch (e) {
// //     console.error("/setmessage error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Failed to update broadcast message.");
// //   }
// // });

// // bot.onText(/\/setinterval\s+(\d+)/, async (msg, match) => {
// //   if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //   const minutes = Number(match[1]);
// //   if (!Number.isInteger(minutes) || minutes <= 0) return bot.sendMessage(msg.chat.id, "⚠️ Interval must be positive integer (minutes).");
// //   try {
// //     await Config.findOneAndUpdate({ key: "broadcast" }, { $set: { intervalMinutes: minutes } }, { upsert: true });
// //     await loadBroadcastConfig();
// //     await bot.sendMessage(msg.chat.id, `✅ Broadcast interval set to ${minutes} minute(s).`);
// //   } catch (e) {
// //     console.error("/setinterval error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Failed to set interval.");
// //   }
// // });

// // bot.onText(/\/listgroups/, async (msg) => {
// //   if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //   try {
// //     let chatInfo = null;
// //     try { chatInfo = await bot.getChat(String(GROUP_ID)); } catch (_) {}
// //     const title = chatInfo && chatInfo.title ? chatInfo.title : "Unknown (bot may not have access)";
// //     await bot.sendMessage(msg.chat.id, `📋 Configured group:\nID: ${GROUP_ID}\nTitle: ${title}`);
// //   } catch (e) {
// //     console.error("/listgroups error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Failed to list group.");
// //   }
// // });

// // bot.onText(/\/broadcastnow(?:\s+([\s\S]+))?/, async (msg, match) => {
// //   if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //   const immediate = match && match[1] ? match[1].trim() : null;
// //   try {
// //     const cfg = await Config.findOne({ key: "broadcast" });
// //     const text = immediate || (cfg && cfg.broadcastMessage) || "📣 Announcement";
// //     await bot.sendMessage(String(GROUP_ID), text, { parse_mode: "HTML" });
// //     await bot.sendMessage(msg.chat.id, "✅ Broadcast sent.");
// //   } catch (e) {
// //     console.error("/broadcastnow error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Broadcast failed.");
// //   }
// // });

// // // ====== /start handler ======
// // bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;
// //   const refId = match && match[1] ? Number(match[1]) : null;

// //   try {
// //     let user = await User.findOne({ telegramId });

// //     if (!user) {
// //       user = new User({ telegramId, firstSeen: new Date(), firstName: msg.from.first_name || "", lastActivity: new Date() });
// //       await user.save();
// //       const greetMsg = `👋 <b>Welcome to DailyKamai</b>\n\n📜 User Agreement: <a href="https://telegra.ph/DailyKamai-User-Agreement-11-03">Read here</a>\n\nChoose an option below to get started.`;
// //       return bot.sendMessage(chatId, greetMsg, { parse_mode: "HTML" });
// //     }

// //     // referral handling
// //     if (refId && refId !== telegramId) {
// //       const refUser = await User.findOne({ telegramId: refId });
// //       if (refUser && !user.referredBy) {
// //         refUser.balance += REFERRAL_REWARD;
// //         refUser.referralCount += 1;
// //         await refUser.save().catch(() => {});
// //         user.referredBy = refId;
// //         await user.save().catch(() => {});
// //         try {
// //           await bot.sendMessage(refUser.telegramId, `🎉 Aapko ₹${REFERRAL_REWARD} mila kyunki aapne ek friend refer kiya!`, { parse_mode: "HTML", ...mainKeyboard });
// //         } catch (_) {}
// //       }
// //     }

// //     // update lastActivity and reply
// //     user.lastActivity = new Date();
// //     await user.save().catch(() => {});
// //     const welcome = `<b>👋 Welcome back to DailyKamai</b>\n\nHar ad ke liye ₹${AD_REWARD} milta hai. Refer karke ₹${REFERRAL_REWARD} kamaye.\n\nChoose from the menu.`;
// //     await bot.sendMessage(chatId, welcome, { parse_mode: "HTML", ...mainKeyboard });
// //   } catch (e) {
// //     console.error("Start handler error:", e && e.message ? e.message : e);
// //     try { await bot.sendMessage(chatId, "⚠️ Error occurred. Please try /start again."); } catch (_) {}
// //   }
// // });

// // // ====== callback_query (pre_ad / pre_ref) ======
// // bot.on("callback_query", async (q) => {
// //   const chatId = q.message.chat.id;
// //   const telegramId = q.from.id;
// //   const data = q.data;
// //   try {
// //     if (data === "pre_ad") {
// //       const text = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milega.\n\n⚠️ Video khatam hone tak tab close na karein.`;
// //       const adUrl = `${BASE_URL_ENV}/ad?user=${telegramId}`;
// //       await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]] } });
// //       await bot.answerCallbackQuery(q.id);
// //       return;
// //     }
// //     if (data === "pre_ref") {
// //       const user = await ensureUser(telegramId);
// //       const botInfo = await bot.getMe().catch(() => ({}));
// //       const refLink = `https://t.me/${botInfo.username || "DailyKamaiBot"}?start=${telegramId}`;
// //       const text = `👥 Invite karke ₹${REFERRAL_REWARD} kamaaye!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link:\n${refLink}`;
// //       await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📤 Share", switch_inline_query: `Join DailyKamai and earn! ${refLink}` }]] } });
// //       await bot.answerCallbackQuery(q.id);
// //       return;
// //     }
// //     await bot.answerCallbackQuery(q.id);
// //   } catch (e) {
// //     console.error("callback_query error:", e && e.message ? e.message : e);
// //     try { await bot.answerCallbackQuery(q.id); } catch (_) {}
// //   }
// // });

// // // ====== message handler (buttons + general) ======
// // bot.on("message", async (msg) => {
// //   if (!msg.text) return;
// //   const text = msg.text.trim();
// //   const chatId = msg.chat.id;
// //   const telegramId = msg.from.id;

// //   // ignore /start because handled separately
// //   if (text.startsWith("/start")) return;

// //   try {
// //     const user = await ensureUser(telegramId, msg.from.first_name);
// //     user.lastActivity = new Date();
// //     await resetDailyIfNeeded(user);

// //     const joined = await ensureGroupFlag(user);
// //     if (!joined) {
// //       return bot.sendMessage(chatId, `📢 Please join our Telegram group to use features.`, {
// //         parse_mode: "HTML",
// //         reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] },
// //       });
// //     }

// //     // 🎬 Ad Dekho
// //     if (text === "🎬 Ad Dekho") {
// //       if (user.adsWatchedToday >= DAILY_LIMIT) {
// //         return bot.sendMessage(chatId, `🚫 Aaj ke liye limit poori ho gayi.`, { parse_mode: "HTML", ...mainKeyboard });
// //       }
// //       const adUrl = `${BASE_URL_ENV}/ad?user=${telegramId}`;
// //       const msgText = `🎬 Ek ad dekhne par aapko ₹${AD_REWARD} milenge.\nVideo khatam hone tak tab close na karein.\n\nNiche button se ad dekhiye.`;
// //       return bot.sendMessage(chatId, msgText, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "▶️ Ab Ad Dekho", url: adUrl }]] } });
// //     }

// //     // 💰 Balance
// //     if (text === "💰 Balance") {
// //       return bot.sendMessage(chatId, `<b>💰 Aapka Balance:</b> ₹${user.balance}\n<b>👥 Referrals:</b> ${user.referralCount}`, { parse_mode: "HTML", ...mainKeyboard });
// //     }

// //     // 👥 Refer & Earn
// //     if (text === "👥 Refer & Earn") {
// //       const botInfo = await bot.getMe().catch(() => ({}));
// //       const refLink = `https://t.me/${botInfo.username || "DailyKamaiBot"}?start=${telegramId}`;
// //       const msgText = `👥 Refer & Earn ₹${REFERRAL_REWARD}!\nAapne ab tak ${user.referralCount} logo ko invite kiya hai.\n\nApna referral link: ${refLink}`;
// //       return bot.sendMessage(chatId, msgText, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📤 Share", switch_inline_query: `Join DailyKamai and earn! ${refLink}` }]] } });
// //     }

// //     // 🏦 Withdraw Funds
// //     if (text === "🏦 Withdraw Funds") {
// //       if (!user.upi) {
// //         const sent = await bot.sendMessage(chatId, "🏦 Apna UPI bheje (example: name@bank).", { parse_mode: "HTML", reply_markup: { force_reply: true } });
// //         const listener = async (m) => {
// //           if (!m.text) return;
// //           if (m.from.id !== telegramId) return;
// //           if (!m.reply_to_message || m.reply_to_message.message_id !== sent.message_id) return;
// //           user.upi = m.text.trim();
// //           await user.save().catch(() => {});
// //           bot.sendMessage(chatId, `✅ UPI saved: <b>${escapeHtml(user.upi)}</b>`, { parse_mode: "HTML", ...mainKeyboard });
// //           bot.removeListener("message", listener);
// //         };
// //         bot.on("message", listener);
// //         return;
// //       }
// //       if (user.balance < MIN_WITHDRAW) return bot.sendMessage(chatId, `⚠️ Minimum withdrawal ₹${MIN_WITHDRAW}. Aapka balance: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard });
// //       if (user.referralCount < MIN_REFERRALS) return bot.sendMessage(chatId, `👥 Minimum ${MIN_REFERRALS} referrals required.`, { parse_mode: "HTML", ...mainKeyboard });

// //       const isMember = await ensureGroupFlag(user);
// //       if (!isMember) return bot.sendMessage(chatId, `🚨 Please join the group for withdrawals.`, { parse_mode: "HTML", ...mainKeyboard });

// //       const days = Math.floor((Date.now() - new Date(user.firstSeen).getTime()) / (1000 * 60 * 60 * 24));
// //       if (days < MIN_DAYS_FOR_WITHDRAW) return bot.sendMessage(chatId, `⏳ Withdrawal after ${MIN_DAYS_FOR_WITHDRAW} days. (${MIN_DAYS_FOR_WITHDRAW - days} days left)`, { parse_mode: "HTML", ...mainKeyboard });

// //       if (user.referralCount < 15) return bot.sendMessage(chatId, `👥 Withdrawals allowed after 15 referrals. You have: ${user.referralCount}`, { parse_mode: "HTML" });

// //       const payout = user.balance;
// //       user.balance = 0;
// //       await user.save().catch(() => {});
// //       return bot.sendMessage(chatId, `✅ Withdrawal placed!\nAmount: ₹${payout}\nUPI: ${escapeHtml(user.upi)}\nProcessing within 3 days.`, { parse_mode: "HTML", ...mainKeyboard });
// //     }

// //     // 🎁 Join Group
// //     if (text === "🎁 Join Group") {
// //       return bot.sendMessage(chatId, `📢 Join our official Telegram group for updates and withdrawal announcements:`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Join Group 🚀", url: "https://t.me/+p_HVj-KYkC4xNGU9" }]] } });
// //     }

// //     // default fallback
// //     return bot.sendMessage(chatId, "Menu se koi option choose karein.", { parse_mode: "HTML", ...mainKeyboard });
// //   } catch (e) {
// //     console.error("message handler error:", e && e.message ? e.message : e);
// //     try { await bot.sendMessage(chatId, "⚠️ Koi error hua. Dobara try karein."); } catch (_) {}
// //   }
// // });

// // // ====== Express endpoints: ad + reward ======
// // app.get("/ad", (req, res) => res.sendFile(path.join(__dirname, "public", "ad.html")));

// // app.get("/reward", async (req, res) => {
// //   try {
// //     const userId = Number(req.query.user);
// //     if (!userId) return res.status(400).send("Missing user");
// //     const user = await User.findOne({ telegramId: userId });
// //     if (!user) return res.status(404).send("User not found");

// //     await resetDailyIfNeeded(user);

// //     if (user.adsWatchedToday >= DAILY_LIMIT) return res.status(429).send("Daily limit reached");

// //     const now = new Date();
// //     if (user.lastAdAt && now.getTime() - new Date(user.lastAdAt).getTime() < (AD_SECONDS - 1) * 1000) return res.status(429).send("Too soon");

// //     user.balance += AD_REWARD;
// //     user.adsWatchedToday += 1;
// //     user.lastAdAt = new Date();
// //     user.lastActivity = new Date(); // update activity
// //     await user.save();

// //     try {
// //       await bot.sendMessage(user.telegramId, `🎉 Aapne ₹${AD_REWARD} kamaye! 💰 Total: ₹${user.balance}`, { parse_mode: "HTML", ...mainKeyboard });
// //     } catch (e) {
// //       console.warn("Could not notify user on reward:", e && e.message ? e.message : e);
// //     }
// //     return res.send("OK");
// //   } catch (e) {
// //     console.error("Reward error:", e && e.message ? e.message : e);
// //     return res.status(500).send("Server error");
// //   }
// // });

// // // ====== Root / health / keep_alive ======
// // app.get("/", (req, res) => res.send("✅ DailyKamai bot is running fine!"));
// // app.get("/health-check", (req, res) => res.status(200).send("✅ Bot healthy"));
// // app.get("/keep_alive", (req, res) => res.status(200).send("OK"));

// // // ====== Admin stats commands (/stats and /monthusers) ======
// // bot.onText(/\/stats/, async (msg) => {
// //   if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //   try {
// //     const totalUsers = await User.countDocuments({});
// //     const sinceDay = new Date(Date.now() - 24 * 60 * 60 * 1000);
// //     const dailyActive = await User.countDocuments({ lastActivity: { $gte: sinceDay } });
// //     const sinceWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
// //     const weeklyActive = await User.countDocuments({ lastActivity: { $gte: sinceWeek } });
// //     const sinceMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
// //     const monthlyActive = await User.countDocuments({ lastActivity: { $gte: sinceMonth } });

// //     const cfg = await Config.findOne({ key: "broadcast" });
// //     const broadcastStatus = cfg && cfg.enabled ? `Enabled every ${cfg.intervalMinutes}m` : "Disabled";

// //     const text = `📊 Bot Stats\n\nTotal users: ${totalUsers}\nDaily active (24h): ${dailyActive}\nWeekly active (7d): ${weeklyActive}\nMonthly active (30d): ${monthlyActive}\n\nBroadcast: ${broadcastStatus}`;
// //     await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
// //   } catch (e) {
// //     console.error("/stats error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Failed to fetch stats.");
// //   }
// // });

// // bot.onText(/\/monthusers/, async (msg) => {
// //   if (String(msg.from.id) !== String(ADMIN_ID)) return;
// //   try {
// //     const sinceMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
// //     const monthlyActive = await User.countDocuments({ lastActivity: { $gte: sinceMonth } });
// //     await bot.sendMessage(msg.chat.id, `📊 Monthly Active Users (30d): <b>${monthlyActive}</b>`, { parse_mode: "HTML" });
// //   } catch (e) {
// //     console.error("/monthusers error:", e && e.message ? e.message : e);
// //     bot.sendMessage(msg.chat.id, "⚠️ Failed to fetch monthly users.");
// //   }
// // });

// // // ====== KEEP-ALIVE: internal self-ping to prevent Render sleeping ======
// // const baseUrlForPing = BASE_URL_ENV || process.env.RENDER_EXTERNAL_URL || `https://dailykamai-bot.onrender.com`;
// // console.log(`🌍 Using base URL for ping: ${baseUrlForPing}`);

// // // internal self-ping every 4 minutes
// // if (baseUrlForPing && baseUrlForPing.startsWith("http")) {
// //   setInterval(() => {
// //     fetch(`${baseUrlForPing}/keep_alive`).then(() => {
// //       console.log("🔄 Self keep-alive ping sent");
// //     }).catch((err) => {
// //       console.warn("⚠️ Self keep-alive failed:", err && err.message ? err.message : err);
// //     });
// //   }, 240000); // 4 minutes
// // }

// // // ====== Global error handlers & graceful shutdown ======
// // process.on("unhandledRejection", (reason, promise) => {
// //   console.error("Unhandled Rejection at:", promise, "reason:", reason);
// // });
// // process.on("uncaughtException", (err) => {
// //   console.error("Uncaught Exception:", err && err.stack ? err.stack : err);
// // });

// // async function shutdown() {
// //   try {
// //     console.log("Shutting down...");
// //     stopBroadcastInterval();
// //     await mongoose.disconnect();
// //     process.exit(0);
// //   } catch (e) {
// //     console.error("Shutdown error:", e && e.message ? e.message : e);
// //     process.exit(1);
// //   }
// // }
// // process.on("SIGINT", shutdown);
// // process.on("SIGTERM", shutdown);

// // // ====== End of file ======

