import fs from "node:fs";
import path from "node:path";

// Определяем путь к папке с данными в корне проекта
const DATA_DIR = path.join(process.cwd(), "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");

export interface Player {
  id: number;
  username: string;
  balance: number;
  bankBalance: number;
}

// Вспомогательная функция для чтения базы данных игроков
function readPlayers(): Record<string, Player> {
  try {
    if (!fs.existsSync(PLAYERS_FILE)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8")) as Record<string, Player>;
  } catch {
    return {};
  }
}

// Вспомогательная функция для сохранения базы данных игроков
function writePlayers(players: Record<string, Player>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PLAYERS_FILE, JSON.stringify(players, null, 2));
}

// 1. Проверить, существует ли игрок
export async function playerExists(id: number): Promise<boolean> {
  const players = readPlayers();
  return String(id) in players;
}

// 2. Получить игрока или создать нового (с начальным бонусом в 1 000 000 GRAM)
export async function getOrCreatePlayer(id: number, username?: string): Promise<Player> {
  const players = readPlayers();
  const key = String(id);
  
  if (!players[key]) {
    players[key] = {
      id,
      username: username || String(id),
      balance: 1000000, // Стартовый баланс подарка
      bankBalance: 0,
    };
    writePlayers(players);
  } else if (username && players[key].username !== username) {
    players[key].username = username;
    writePlayers(players);
  }
  
  return players[key];
}

// 3. Изменить баланс игрока на определенную сумму (прибавить или отнять)
export async function adjustBalance(id: number, amount: number): Promise<Player> {
  const players = readPlayers();
  const key = String(id);
  
  if (!players[key]) {
    throw new Error("Player not found");
  }
  
  if (players[key].balance + amount < 0) {
    throw new Error("Insufficient funds");
  }
  
  players[key].balance += amount;
  writePlayers(players);
  return players[key];
}

// 4. Начисление баланса админом
export async function adminAddBalance(id: number, amount: number): Promise<Player> {
  const players = readPlayers();
  const key = String(id);
  
  if (!players[key]) {
    players[key] = { id, username: String(id), balance: 0, bankBalance: 0 };
  }
  
  players[key].balance += amount;
  writePlayers(players);
  return players[key];
}

// 5. Перевод баланса от одного игрока другому
export async function transferBalance(fromId: number, toId: number, amount: number): Promise<{ from: Player; to: Player }> {
  const players = readPlayers();
  const fromKey = String(fromId);
  const toKey = String(toId);
  
  if (!players[fromKey] || players[fromKey].balance < amount) {
    throw new Error("Insufficient funds for transfer");
  }
  
  if (!players[toKey]) {
    throw new Error("Target player not found");
  }
  
  players[fromKey].balance -= amount;
  players[toKey].balance += amount;
  writePlayers(players);
  
  return { from: players[fromKey], to: players[toKey] };
}

// 6. Положить деньги в банк
export async function bankDeposit(id: number, amount: number): Promise<Player> {
  const players = readPlayers();
  const key = String(id);
  
  if (!players[key] || players[key].balance < amount) {
    throw new Error("Insufficient funds");
  }
  
  // Ограничение лимита банка в 100 000 000 000 GRAM
  if (players[key].bankBalance + amount > 100000000000) {
    throw new Error("Bank limit exceeded");
  }
  
  players[key].balance -= amount;
  players[key].bankBalance += amount;
  writePlayers(players);
  return players[key];
}

// 7. Снять деньги из банка
export async function bankWithdraw(id: number, amount: number): Promise<Player> {
  const players = readPlayers();
  const key = String(id);
  
  if (!players[key] || players[key].bankBalance < amount) {
    throw new Error("Insufficient bank funds");
  }
  
  players[key].bankBalance -= amount;
  players[key].balance += amount;
  writePlayers(players);
  return players[key];
}

// 8. Получить топ игроков по балансу на руках
export async function getTopPlayers(limit: number = 10): Promise<Player[]> {
  const players = readPlayers();
  return Object.values(players)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
}

// 9. Полная очистка баланса игрока
export async function resetBalance(id: number): Promise<Player> {
  const players = readPlayers();
  const key = String(id);
  
  if (!players[key]) {
    throw new Error("Player not found");
  }
  
  players[key].balance = 0;
  players[key].bankBalance = 0;
  writePlayers(players);
  return players[key];
}
