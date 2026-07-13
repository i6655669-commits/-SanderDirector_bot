import TelegramBot from "node-telegram-bot-api";
import fs from "node:fs";
import path from "node:path";
import {
  playerExists,
  getOrCreatePlayer,
  adjustBalance,
  adminAddBalance,
  transferBalance,
  bankDeposit,
  bankWithdraw,
  getTopPlayers,
  resetBalance,
} from "./players";

// ─────────────────────────────────────────────────────────────────────────────
// КОНФИГУРАЦИЯ
// Установите переменную окружения ADMIN_ID равной вашему Telegram user ID.
// ─────────────────────────────────────────────────────────────────────────────

function getAdminId() number {
  return Number(process.env["ADMIN_ID"] ?? "0");
}

// Максимальная ставка за один раунд
const MAX_BET = 1_000_000;

/** Валидирует ставку. Возвращает null если ставка корректна, иначе текст ошибки. */
function validateBet(bet: number): string | null {
  if (!Number.isFinite(bet) || Number.isNaN(bet) || bet <= 0) {
    return "❌ Ошибка: некорректная ставка!";
  }
  if (bet > MAX_BET) {
    return `❌ Ошибка: ставка слишком велика! Максимум — ${fmt(MAX_BET)} GRAM.`;
  }
  return null;
}

/** Возвращает file_id видео для рулетки из data/config.json, или null. */
function getRouletteVideoFileId(): string | null {
  const cfg = readJson<Record<string, string>>("config.json", {});
  return cfg["rouletteVideoFileId"] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ХРАНИЛИЩЕ ДАННЫХ (JSON-файлы)
// ─────────────────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), "data");

function readJson<T>(file: string, fallback: T): T {
  const p = path.join(DATA_DIR, file);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  const p = path.join(DATA_DIR, file);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// РУЛЕТКА — вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

type RouletteColor = "red" | "black" | "green";

interface RouletteEntry {
  num: number;
  color: RouletteColor;
}

function rouletteColor(n: number): RouletteColor {
  if (n === 0) return "green";
  return RED_NUMBERS.has(n) ? "red" : "black";
}

function colorEmoji(c: RouletteColor): string {
  return c === "red" ? "🔴" : c === "black" ? "⚫️" : "🟢";
}

function colorLabel(c: RouletteColor): string {
  return c === "red" ? "К (красное)" : c === "black" ? "Ч (чёрное)" : "Зеро";
}

function addRouletteLog(entry: RouletteEntry): void {
  const log = readJson<RouletteEntry[]>("roulette-log.json", []);
  log.unshift(entry);
  writeJson("roulette-log.json", log.slice(0, 10));
}

type RouletteOutcome = "к" | "ч" | "чет" | "нечет" | "range";

interface RouletteBet {
  userId: number;
  username: string;
  amount: number;
  outcome: RouletteOutcome;
  rangeMin?: number;
  rangeMax?: number;
  label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// МИНЫ — вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

const MINES_ROWS = 4;
const MINES_COLS = 5;
const MINES_TOTAL = MINES_ROWS * MINES_COLS; // 20
const MINES_COUNT = 4;
const MINES_HOUSE_EDGE = 0.97;

function minesMultiplier(opened: number): number {
  let m = 1;
  for (let i = 0; i < opened; i++) {
    m *= (MINES_TOTAL - i) / (MINES_TOTAL - MINES_COUNT - i);
  }
  return Math.round(m * MINES_HOUSE_EDGE * 100) / 100;
}

interface MinesSession {
  chatId: number;
  userId: number;
  username: string;
  messageId: number;
  bet: number;
  mines: Set<number>;
  opened: Set<number>;
  finished: boolean;
  bustedPos: number | null;
}

function buildMinesKeyboard(
  s: MinesSession,
): InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  for (let r = 0; r < MINES_ROWS; r++) {
    const row: TelegramBot.InlineKeyboardButton[] = [];
    for (let c = 0; c < MINES_COLS; c++) {
      const pos = r * MINES_COLS + c;
      let text: string;
      let data: string;

      if (s.opened.has(pos)) {
        text = "💰";
        data = "noop";
      } else if (s.finished && s.mines.has(pos)) {
        text = pos === s.bustedPos ? "💥" : "💣";
        data = "noop";
      } else if (s.finished) {
        text = "💰";
        data = "noop";
      } else {
        text = "❓";
        data = `mo:${s.userId}:${pos}`;
      }
      row.push({ text, callback_data: data });
    }
    rows.push(row);
  }

  if (!s.finished) {
    const mult = minesMultiplier(s.opened.size);
    const potential = Math.round(s.bet * mult);
    const canCash = s.opened.size > 0;
    rows.push([{
      text: canCash
        ? `💰 Забрать выигрыш · ${potential} GRAM (×${mult})`
        : "▫️ Открывайте клетки ▫️",
      callback_data: canCash ? `mc:${s.userId}` : "noop",
    }]);
  }

  return { inline_keyboard: rows };
}

function minesStatusText(s: MinesSession): string {
  const mult = minesMultiplier(s.opened.size);
  const potential = Math.round(s.bet * mult);
  return (
    `💣 Мины · @${s.username} · Ставка: ${s.bet.toLocaleString("ru")} GRAM\n` +
    `Открыто: ${s.opened.size} · Мин скрыто: ${MINES_COUNT}\n` +
    `Текущий выигрыш: ${potential.toLocaleString("ru")} GRAM (×${mult})`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ФОРМАТИРОВАНИЕ ЧИСЕЛ
// ─────────────────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString("ru");
}

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY СОСТОЯНИЕ
// ─────────────────────────────────────────────────────────────────────────────

// Ставки рулетки для каждого чата
const rouletteBets = new Map<number, RouletteBet[]>();

// Чаты, в которых рулетка уже крутится (защита от двойного «го»)
const rouletteSpinning = new Set<number>();

// Активные игры в Мины, ключ = userId
const activeMines = new Map<number, MinesSession>();

// Ожидание ввода суммы для банка: userId → { chatId, action }
type BankAwait = { chatId: number; action: "deposit" | "withdraw" | "charity" };
const bankAwait = new Map<number, BankAwait>();

// ─────────────────────────────────────────────────────────────────────────────
// ЗАПУСК БОТА
// ─────────────────────────────────────────────────────────────────────────────

export function startBot(): TelegramBot {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");

  const bot = new TelegramBot(token, { polling: true });

  bot.on("polling_error", (err) => logger.error({ err }, "Polling error"));

  // ── ОБРАБОТЧИК СООБЩЕНИЙ ────────────────────────────────────────────────

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text?.trim();
    if (!text || !userId) return;

    const username = msg.from?.username ?? msg.from?.first_name ?? String(userId);
    const low = text.toLowerCase();

    try {

      // ────────────────────────────────────────────────────────────────────
      // 🏦 ОЖИДАНИЕ ВВОДА ДЛЯ БАНКА
      // ────────────────────────────────────────────────────────────────────

      if (bankAwait.has(userId)) {
        const pending = bankAwait.get(userId)!;
        if (pending.chatId === chatId) {
          bankAwait.delete(userId);
          const amount = parseInt(text, 10);
          if (!Number.isFinite(amount) || amount <= 0) {
            await bot.sendMessage(chatId, "❌ Некорректная сумма.", { reply_to_message_id: msg.message_id });
            return;
          }
          if (pending.action === "deposit") {
            try {
              const updated = await bankDeposit(userId, amount);
              await bot.sendMessage(
                chatId,
                `✅ @${username}, положено ${fmt(amount)} GRAM в банк.\n` +
                  `💳 В банке: ${fmt(updated.bankBalance)} GRAM\n` +
                  `💰 На руках: ${fmt(updated.balance)} GRAM`,
                { reply_to_message_id: msg.message_id },
              );
            } catch (e: unknown) {
              const msg2 = e instanceof Error ? e.message : "";
              if (msg2 === "Bank limit exceeded") {
                await bot.sendMessage(chatId, "❌ Достигнут лимит средств.", { reply_to_message_id: msg.message_id });
              } else {
                await bot.sendMessage(chatId, "❌ Недостаточно средств на балансе.", { reply_to_message_id: msg.message_id });
              }
            }
          } else if (pending.action === "withdraw") {
            try {
              const updated = await bankWithdraw(userId, amount);
              await bot.sendMessage(
                chatId,
                `✅ @${username}, снято ${fmt(amount)} GRAM из банка.\n` +
                  `💳 В банке: ${fmt(updated.bankBalance)} GRAM\n` +
                  `💰 На руках: ${fmt(updated.balance)} GRAM`,
                { reply_to_message_id: msg.message_id },
              );
            } catch {
              await bot.sendMessage(chatId, "❌ Недостаточно средств в банке.", { reply_to_message_id: msg.message_id });
            }
          } else {
            // charity
            if (amount > 1_000_000_000) {
              await bot.sendMessage(chatId, "❌ Максимальная сумма пожертвования — 1 000 000 000 GRAM.", { reply_to_message_id: msg.message_id });
              return;
            }
            try {
              const updated = await adjustBalance(userId, -amount);
              await bot.sendMessage(
                chatId,
                `❤️ @${username}, вы пожертвовали ${fmt(amount)} GRAM на благотворительность!\n` +
                  `💰 Баланс: ${fmt(updated.balance)} GRAM`,
                { reply_to_message_id: msg.message_id },
              );
            } catch {
              await bot.sendMessage(chatId, "❌ Недостаточно средств на балансе.", { reply_to_message_id: msg.message_id });
            }
          }
          return;
        }
      }

      // ────────────────────────────────────────────────────────────────────
      // 💰 БАЛАНС: "б" / "баланс"
      // ────────────────────────────────────────────────────────────────────

      if (/^(б|баланс)$/i.test(text)) {
        const isNew = !(await playerExists(userId));
        const player = await getOrCreatePlayer(userId, username);
        if (isNew) {
          await bot.sendMessage(
            chatId,
            `🎁 @${username}, ты получил ${fmt(player.balance)} GRAM!`,
            { reply_to_message_id: msg.message_id },
          );
        } else {
          await bot.sendMessage(
            chatId,
            `💰 @${username}, твой баланс: ${fmt(player.balance)} GRAM`,
            { reply_to_message_id: msg.message_id },
          );
        }
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 📋 ЛОГ РУЛЕТКИ: "лог"
      // ────────────────────────────────────────────────────────────────────

      if (/^лог$/i.test(text)) {
        const log = readJson<RouletteEntry[]>("roulette-log.json", []);
        if (log.length === 0) {
          await bot.sendMessage(chatId, "📋 История рулетки пуста.");
          return;
        }
        const lines = log.map((e) => `${colorEmoji(e.color)} ${e.num}`);
        await bot.sendMessage(chatId, `лог\n${lines.join("\n")}`);
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 🎁 БОНУС: "бонус"
      // ────────────────────────────────────────────────────────────────────

      if (/^бонус$/i.test(text)) {
        const bonuses = readJson<Record<string, string>>("bonus.json", {});
        const lastStr = bonuses[String(userId)];
        const now = Date.now();

        if (lastStr) {
          const last = new Date(lastStr).getTime();
          const diff = 24 * 60 * 60 * 1000 - (now - last);
          if (diff > 0) {
            const hh = Math.floor(diff / 3_600_000);
            const mm = Math.floor((diff % 3_600_000) / 60_000);
            const hhStr = String(hh).padStart(2, "0");
            const mmStr = String(mm).padStart(2, "0");
            await bot.sendMessage(
              chatId,
              `❌ @${username}, вы уже забирали бонус.\nДо следующего бонуса осталось: ${hhStr}:${mmStr}`,
              { reply_to_message_id: msg.message_id },
            );
            return;
          }
        }

        const amount = Math.floor(Math.random() * 500_000) + 1;
        await getOrCreatePlayer(userId, username);
        const updated = await adjustBalance(userId, amount);
        bonuses[String(userId)] = new Date(now).toISOString();
        writeJson("bonus.json", bonuses);

        await bot.sendMessage(
          chatId,
          `🎁 @${username}, вы получили ежедневный бонус: ${fmt(amount)} GRAM!\n` +
            `💰 Баланс: ${fmt(updated.balance)} GRAM`,
          { reply_to_message_id: msg.message_id },
        );
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 🔑 ADMIN: ".getmoney [сумма]"
      // ────────────────────────────────────────────────────────────────────

      const gmMatch = /^\.getmoney\s+(\d+)$/i.exec(text);
      if (gmMatch) {
        if (userId !== getAdminId()) return;
        const amount = parseInt(gmMatch[1]!, 10);
        const updated = await adminAddBalance(userId, amount);
        await bot.sendMessage(
          chatId,
          `✅ Начислено ${fmt(amount)} GRAM. Баланс: ${fmt(updated.balance)} GRAM`,
          { reply_to_message_id: msg.message_id },
        );
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 🔑 ADMIN: ".give [ID] [сумма]"
      // ────────────────────────────────────────────────────────────────────

      const giveMatch = /^\.give\s+(\d+)\s+(\d+)$/i.exec(text);
      if (giveMatch) {
        if (userId !== getAdminId()) return;
        const targetId = parseInt(giveMatch[1]!, 10);
        const amount = parseInt(giveMatch[2]!, 10);
        await getOrCreatePlayer(targetId, undefined);
        const updated = await adminAddBalance(targetId, amount);
        await bot.sendMessage(
          chatId,
          `✅ Игроку ${targetId} начислено ${fmt(amount)} GRAM.\nЕго баланс: ${fmt(updated.balance)} GRAM`,
          { reply_to_message_id: msg.message_id },
        );
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 🔑 ADMIN: ".очистить [ID]"
      // ────────────────────────────────────────────────────────────────────

      const clearMatch = /^\.очистить\s+(\d+)$/i.exec(text);
      if (clearMatch) {
        if (userId !== getAdminId()) return;
        const targetId = parseInt(clearMatch[1]!, 10);
        const updated = await resetBalance(targetId);
        await bot.sendMessage(
          chatId,
          `🗑 Баланс игрока ${targetId} очищен.\nБаланс: ${fmt(updated.balance)} GRAM`,
          { reply_to_message_id: msg.message_id },
        );
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 💸 ПЕРЕВОД: "п [сумма]" (ответ на сообщение другого пользователя)
      // ────────────────────────────────────────────────────────────────────

      const transferMatch = /^п\s+(\d+)$/i.exec(text);
      if (transferMatch) {
        const targetUser = msg.reply_to_message?.from;
        if (!targetUser) {
          await bot.sendMessage(chatId, "❌ Ответьте на сообщение игрока, которому хотите перевести GRAM.", { reply_to_message_id: msg.message_id });
          return;
        }
        if (targetUser.id === userId) {
          await bot.sendMessage(chatId, "❌ Нельзя переводить самому себе.", { reply_to_message_id: msg.message_id });
          return;
        }
        const transferAmount = parseInt(transferMatch[1]!, 10);
        if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
          await bot.sendMessage(chatId, "❌ Некорректная сумма.", { reply_to_message_id: msg.message_id });
          return;
        }
        if (transferAmount > 100_000_000) {
          await bot.sendMessage(chatId, "❌ Максимальная сумма перевода — 100 000 000 GRAM.", { reply_to_message_id: msg.message_id });
          return;
        }
        try {
          const targetName = targetUser.username ?? targetUser.first_name ?? String(targetUser.id);
          await getOrCreatePlayer(targetUser.id, targetUser.username ?? undefined);
          const result = await transferBalance(userId, targetUser.id, transferAmount);
          await bot.sendMessage(
            chatId,
            `✅ @${username} перевёл @${targetName} ${fmt(transferAmount)} GRAM.\n` +
              `💰 Ваш баланс: ${fmt(result.from.balance)} GRAM`,
            { reply_to_message_id: msg.message_id },
          );
        } catch {
          await bot.sendMessage(chatId, `❌ @${username}, недостаточно GRAM для перевода.`, { reply_to_message_id: msg.message_id });
        }
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 🪙 ОРЁЛ / РЕШКА: "[Орел|Решка] [сумма]"
      // ────────────────────────────────────────────────────────────────────

      const coinMatch = /^(орел|решка)\s+(\d+)$/i.exec(text);
      if (coinMatch) {
        const choice = coinMatch[1]!.toLowerCase(); // "орел" | "решка"
        const bet = parseInt(coinMatch[2]!, 10);

        const betErr = validateBet(bet);
        if (betErr) {
          await bot.sendMessage(chatId, betErr, { reply_to_message_id: msg.message_id });
          return;
        }

        const player = await getOrCreatePlayer(userId, username);
        if (bet > player.balance) {
          await bot.sendMessage(
            chatId,
            `❌ @${username}, недостаточно GRAM. Баланс: ${fmt(player.balance)}`,
            { reply_to_message_id: msg.message_id },
          );
          return;
        }

        const flip = Math.random() < 0.5 ? "орел" : "решка";
        const flipEmoji = flip === "орел" ? "🦅 ОРЁЛ" : "🪙 РЕШКА";
        const win = flip === choice;

        let updated;
        if (win) {
          updated = await adjustBalance(userId, bet);
          await bot.sendMessage(
            chatId,
            `🎉 выпало: ${flipEmoji}\n\n@${username}, ты ванга!\nвыигрыш: ${fmt(bet)} GRAM\n💰 Баланс: ${fmt(updated.balance)} GRAM`,
            { reply_to_message_id: msg.message_id },
          );
        } else {
          updated = await adjustBalance(userId, -bet);
          await bot.sendMessage(
            chatId,
            `💸 выпало: ${flipEmoji}\n\n@${username}, не повезло!\nпроигрыш: ${fmt(bet)} GRAM\n💰 Баланс: ${fmt(updated.balance)} GRAM`,
            { reply_to_message_id: msg.message_id },
          );
        }
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 🎰 РУЛЕТКА — ПРИНЯТЬ СТАВКУ: "[сумма] [к|ч|чет|нечет|X-Y]"
      // ────────────────────────────────────────────────────────────────────

      const betMatch = /^(\d+)\s+(к|ч|чет|нечет|(\d+)-(\d+))$/i.exec(text);
      if (betMatch) {
        const amount = parseInt(betMatch[1]!, 10);
        const outcomeRaw = betMatch[2]!.toLowerCase();

        const roulBetErr = validateBet(amount);
        if (roulBetErr) {
          await bot.sendMessage(chatId, roulBetErr, { reply_to_message_id: msg.message_id });
          return;
        }

        const player = await getOrCreatePlayer(userId, username);
        if (amount > player.balance) {
          await bot.sendMessage(
            chatId,
            `❌ @${username}, недостаточно GRAM. Баланс: ${fmt(player.balance)}`,
            { reply_to_message_id: msg.message_id },
          );
          return;
        }

        // Деньги спишем сразу, чтобы игрок не ставил дважды одно и то же
        await adjustBalance(userId, -amount);

        let outcome: RouletteOutcome;
        let label: string;
        let rangeMin: number | undefined;
        let rangeMax: number | undefined;

        if (outcomeRaw === "к") {
          outcome = "к"; label = "К (красное)";
        } else if (outcomeRaw === "ч") {
          outcome = "ч"; label = "Ч (чёрное)";
        } else if (outcomeRaw === "чет") {
          outcome = "чет"; label = "чётное";
        } else if (outcomeRaw === "нечет") {
          outcome = "нечет"; label = "нечётное";
        } else {
          // диапазон X-Y
          rangeMin = parseInt(betMatch[3]!, 10);
          rangeMax = parseInt(betMatch[4]!, 10);
          outcome = "range";
          label = `${rangeMin}-${rangeMax}`;
        }

        const bets = rouletteBets.get(chatId) ?? [];
        bets.push({ userId, username, amount, outcome, rangeMin, rangeMax, label });
        rouletteBets.set(chatId, bets);

        await bot.sendMessage(
          chatId,
          `✅ @${username}, ставка принята: ${fmt(amount)} GRAM на ${label}`,
          { reply_to_message_id: msg.message_id },
        );
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 🎰 РУЛЕТКА — ЗАПУСК: "го"
      // ────────────────────────────────────────────────────────────────────

      if (/^го$/i.test(text)) {
        // ── Защита от двойного «го» ─────────────────────────────────────
        // Node.js однопоточный: код до первого await атомарен.
        // Захватываем блокировку и очищаем ставки синхронно —
        // любое второе «го» увидит spinning=true или пустые bets.
        if (rouletteSpinning.has(chatId)) return;

        const bets = rouletteBets.get(chatId);
        if (!bets || bets.length === 0) {
          await bot.sendMessage(chatId, "❌ Нет принятых ставок. Делайте ставки!");
          return;
        }

        rouletteSpinning.add(chatId);   // блокировка
        rouletteBets.delete(chatId);    // ставки сняты до первого await

        try {
          // Отправить видео рулетки (file_id из data/config.json) или текст
          const rvFileId = getRouletteVideoFileId();
          try {
            if (rvFileId) {
              await bot.sendVideo(chatId, rvFileId, { caption: "🎰 Колесо крутится..." });
            } else {
              await bot.sendMessage(chatId, "🎰 Колесо крутится...");
            }
          } catch {
            await bot.sendMessage(chatId, "🎰 Колесо крутится...");
          }

          // Небольшая пауза для эффекта
          await new Promise((r) => setTimeout(r, 2000));

          const num = Math.floor(Math.random() * 37); // 0–36
          const color = rouletteColor(num);
          addRouletteLog({ num, color });

          // Разобрать победителей
          const winnerLines: string[] = [];

          for (const bet of bets) {
            let win = false;
            if (bet.outcome === "к") {
              win = color === "red";
            } else if (bet.outcome === "ч") {
              win = color === "black";
            } else if (bet.outcome === "чет") {
              win = num !== 0 && num % 2 === 0;
            } else if (bet.outcome === "нечет") {
              win = num % 2 === 1;
            } else if (bet.outcome === "range") {
              win = num >= (bet.rangeMin ?? 0) && num <= (bet.rangeMax ?? 36);
            }

            if (win) {
              const winnings = bet.amount * 2;
              await adjustBalance(bet.userId, winnings);
              winnerLines.push(
                `@${bet.username} — ставка ${fmt(bet.amount)} GRAM → выиграл ${fmt(winnings)} GRAM на ${bet.label}`,
              );
            }
            // проигравшие уже потеряли деньги при приёме ставки
          }

          const resultEmoji = colorEmoji(color);
          let reply =
            `${resultEmoji} Чертова ракетка, выпало: ${num}\n` +
            `Цвет: ${colorLabel(color)}\n\n`;
          reply += winnerLines.length > 0
            ? `везунчики:\n${winnerLines.join("\n")}`
            : "везунчиков нет 😔";

          await bot.sendMessage(chatId, reply);
        } finally {
          rouletteSpinning.delete(chatId); // снимаем блокировку в любом случае
        }
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 🏆 ТОП ИГРОКОВ: "/топ" / "топ"
      // ────────────────────────────────────────────────────────────────────

      if (/^\/?(топ)$/i.test(text)) {
        const top = await getTopPlayers(10);
        if (top.length === 0) {
          await bot.sendMessage(chatId, "📋 Пока нет игроков.", { reply_to_message_id: msg.message_id });
          return;
        }
        const lines = top.map((p, i) => {
          const name = p.username ? `@${p.username}` : `#${p.id}`;
          return `${i + 1}. ${name} — ${fmt(p.balance)} GRAM`;
        });
        await bot.sendMessage(chatId, `🏆 Топ игроков:\n\n${lines.join("\n")}`, { reply_to_message_id: msg.message_id });
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 🏦 БАНК: "/банк" / "банк"
      // ────────────────────────────────────────────────────────────────────

      if (/^\/?(банк)$/i.test(text)) {
        const player = await getOrCreatePlayer(userId, username);
        await bot.sendMessage(
          chatId,
          `🏛 Вас приветствует центральный банк!\n\n💰 Ваши сбережения на данный момент: ${fmt(player.bankBalance)} GRAM`,
          {
            reply_to_message_id: msg.message_id,
            reply_markup: {
              inline_keyboard: [
                [{ text: "💳 Положить",         callback_data: `bank:deposit:${userId}` }],
                [{ text: "💸 Снять",            callback_data: `bank:withdraw:${userId}` }],
                [{ text: "❤️ Благотворительность", callback_data: `bank:charity:${userId}` }],
              ],
            },
          },
        );
        return;
      }

      // ────────────────────────────────────────────────────────────────────
      // 💣 МИНЫ: "мины [сумма]"
      // ────────────────────────────────────────────────────────────────────

      const minesMatch = /^мины\s+(\d+)$/i.exec(text);
      if (minesMatch) {
        const bet = parseInt(minesMatch[1]!, 10);
        const minesBetErr = validateBet(bet);
        if (minesBetErr) {
          await bot.sendMessage(chatId, minesBetErr, { reply_to_message_id: msg.message_id });
          return;
        }

        if (activeMines.has(userId)) {
          await bot.sendMessage(
            chatId,
            `❌ @${username}, у вас уже есть активная игра в Мины!`,
            { reply_to_message_id: msg.message_id },
          );
          return;
        }

        const player = await getOrCreatePlayer(userId, username);
        if (bet > player.balance) {
          await bot.sendMessage(
            chatId,
            `❌ @${username}, недостаточно GRAM. Баланс: ${fmt(player.balance)}`,
            { reply_to_message_id: msg.message_id },
          );
          return;
        }

        // Размещаем мины случайным образом
        const mineSet = new Set<number>();
        while (mineSet.size < MINES_COUNT) {
          mineSet.add(Math.floor(Math.random() * MINES_TOTAL));
        }

        // Списываем ставку сразу
        await adjustBalance(userId, -bet);

        // Создаём временную сессию с placeholder messageId
        const session: MinesSession = {
          chatId,
          userId,
          username,
          messageId: 0,
          bet,
          mines: mineSet,
          opened: new Set(),
          finished: false,
          bustedPos: null,
        };

        const sent = await bot.sendMessage(chatId, minesStatusText(session), {
          reply_markup: buildMinesKeyboard(session),
        });

        session.messageId = sent.message_id;
        activeMines.set(userId, session);
        return;
      }

    } catch (err) {
      logger.error({ err }, "Ошибка обработки сообщения");
    }
  });

  // ── ОБРАБОТЧИК INLINE-КНОПОК ────────────────────────────────────────────

  bot.on("callback_query", async (query) => {
    try {
    const data = query.data ?? "";
    const clickerId = query.from.id;
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    if (!chatId || !messageId) return;

    if (data === "noop") {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // ── Открыть ячейку: mo:[userId]:[pos] ──────────────────────────────

    const openMatch = /^mo:(\d+):(\d+)$/.exec(data);
    if (openMatch) {
      const ownerId = parseInt(openMatch[1]!, 10);
      const pos = parseInt(openMatch[2]!, 10);

      if (clickerId !== ownerId) {
        await bot.answerCallbackQuery(query.id, { text: "Это не ваша игра 😄" });
        return;
      }

      const s = activeMines.get(ownerId);
      if (!s || s.finished || s.messageId !== messageId) {
        await bot.answerCallbackQuery(query.id);
        return;
      }

      await bot.answerCallbackQuery(query.id);

      if (s.mines.has(pos)) {
        // Взрыв!
        s.finished = true;
        s.bustedPos = pos;
        activeMines.delete(ownerId);

        const player = await getOrCreatePlayer(ownerId, undefined);

        await bot.editMessageText(
          `💥 @${s.username} попал на мину!\n` +
            `Ставка ${fmt(s.bet)} GRAM сгорела.\n` +
            `💰 Баланс: ${fmt(player.balance)} GRAM`,
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildMinesKeyboard(s),
          },
        );
        return;
      }

      // Безопасная ячейка
      s.opened.add(pos);
      const safeCells = MINES_TOTAL - MINES_COUNT;

      if (s.opened.size === safeCells) {
        // Открыто всё поле!
        s.finished = true;
        activeMines.delete(ownerId);

        const mult = minesMultiplier(s.opened.size);
        const winnings = Math.round(s.bet * mult);
        const updated = await adjustBalance(ownerId, winnings);

        await bot.editMessageText(
          `🏆 @${s.username} открыл всё поле!\n` +
            `💰 Выигрыш: ${fmt(winnings)} GRAM (×${mult})\n` +
            `💰 Баланс: ${fmt(updated.balance)} GRAM`,
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildMinesKeyboard(s),
          },
        );
        return;
      }

      await bot.editMessageText(minesStatusText(s), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildMinesKeyboard(s),
      });
      return;
    }

    // ── Забрать выигрыш: mc:[userId] ────────────────────────────────────

    const cashMatch = /^mc:(\d+)$/.exec(data);
    if (cashMatch) {
      const ownerId = parseInt(cashMatch[1]!, 10);

      if (clickerId !== ownerId) {
        await bot.answerCallbackQuery(query.id, { text: "Это не ваша игра 😄" });
        return;
      }

      const s = activeMines.get(ownerId);
      if (!s || s.finished || s.messageId !== messageId) {
        await bot.answerCallbackQuery(query.id);
        return;
      }

      await bot.answerCallbackQuery(query.id);
      s.finished = true;
      activeMines.delete(ownerId);

      const mult = minesMultiplier(s.opened.size);
      const winnings = Math.round(s.bet * mult);
      const updated = await adjustBalance(ownerId, winnings);

      await bot.editMessageText(
        `@${s.username}, забрал выигрыш 💰\n` +
          `Сумма: ${fmt(winnings)} GRAM (×${mult})\n` +
          `💰 Баланс: ${fmt(updated.balance)} GRAM`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: buildMinesKeyboard(s),
        },
      );
      return;
    }

    // ── Банк: bank:deposit:[userId] / bank:withdraw:[userId] ────────────

    const bankMatch = /^bank:(deposit|withdraw|charity):(\d+)$/.exec(data);
    if (bankMatch) {
      const action = bankMatch[1] as "deposit" | "withdraw";
      const ownerId = parseInt(bankMatch[2]!, 10);

      if (clickerId !== ownerId) {
        await bot.answerCallbackQuery(query.id, { text: "Это не ваш банк 😄" });
        return;
      }

      bankAwait.set(ownerId, { chatId, action });
      await bot.answerCallbackQuery(query.id);

      const prompt = action === "deposit"
        ? "💳 Введите сумму для пополнения банка:"
        : action === "withdraw"
          ? "💸 Введите сумму для снятия из банка:"
          : "❤️ Введите сумму пожертвования (до 1 000 000 000 GRAM):";
      await bot.sendMessage(chatId, prompt);
      return;
    }

    } catch (err) {
      logger.error({ err }, "Ошибка обработки callback_query");
    }
  });

  logger.info("Казино-бот запущен (групповой режим, GRAM)");
  return bot;
}
