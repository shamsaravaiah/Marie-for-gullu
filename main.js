const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');

let win = null;
let tray = null;
let foodWin = null;

// ---- sizes ----
const WIN_W = 220;
const WIN_H = 200;
const PLATE = 100;
const SPEED = 2.6;          // pixels per tick while walking
const RUN_SPEED = 5.4;      // pixels per tick while running
const TICK = 30;            // ms between movement ticks
const SLEEP_AFTER = 18000;  // ms of stillness before the pet naps
const HUNGER_AFTER = 28000; // ms after the last meal before the cat gets hungry
const EAT_TIME = 4500;      // ms spent eating
const MOUTH = 184;          // x of the pet's mouth within the artwork (facing right)
const NECK_Y = 60;          // y of the pet's neck/scruff within the window (for carrying)

// ---- pet state ----
let currentPet = 'cat';     // 'cat' | 'shiba' | 'husky' | 'fortune'
let mode = 'idle';          // idle | walk | wag | run | sleep | eat | groom | hungry | rollover | biscuit
let facing = 'right';       // 'left' | 'right'
let petX = 0, petY = 0;
let targetX = null;
let nextDecision = 0;
let lastActivity = Date.now();
let lastFed = Date.now();
let happyUntil = 0;
let actionUntil = 0;
let dragging = false;
let lastSent = '';

// ---- food state ----
let foodActive = false;
let plateX = 0, plateY = 0;
let eatStart = 0;

// ---- forced sleep (Sleep 💤 menu item) ----
// When true, the pet stays asleep regardless of the idle timer until the user
// pokes, drags, drops food, or otherwise interacts with it.
let forcedSleep = false;

function workArea() { return screen.getPrimaryDisplay().workArea; }

// Pin a window above the macOS Dock and the Windows taskbar. The
// 'screen-saver' level sits above both, but macOS resets the level on
// some focus/visibility transitions and Windows can lose HWND_TOPMOST
// when another topmost window appears — so we re-apply on 'show',
// 'focus', and 'blur'.
function pinAlwaysOnTop(w) {
  if (!w || w.isDestroyed()) return;
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}
function wirePinning(w) {
  pinAlwaysOnTop(w);
  w.on('show', () => pinAlwaysOnTop(w));
  w.on('focus', () => pinAlwaysOnTop(w));
  w.on('blur', () => pinAlwaysOnTop(w));
}

function clampX(x) {
  const wa = workArea();
  return Math.max(wa.x, Math.min(wa.x + wa.width - WIN_W, x));
}

function groundY() {
  const wa = workArea();
  return wa.y + wa.height - WIN_H + 18;
}

function petCenter() { return petX + WIN_W / 2; }

function sendState() {
  if (!win || win.isDestroyed()) return;
  const sig = mode + '|' + facing + '|' + currentPet;
  if (sig === lastSent) return;
  lastSent = sig;
  win.webContents.send('state', { mode, facing, pet: currentPet });
}

function applyPosition() {
  if (!win || win.isDestroyed()) return;
  win.setBounds({ x: Math.round(petX), y: Math.round(petY), width: WIN_W, height: WIN_H });
}

function wake() {
  lastActivity = Date.now();
  forcedSleep = false;
  if (mode === 'sleep' || mode === 'groom' || mode === 'biscuit' || mode === 'rollover') {
    mode = 'idle';
    nextDecision = Date.now() + 700;
  }
}

function forceSleep() {
  if (foodActive) removeFood();
  targetX = null;
  forcedSleep = true;
  mode = 'sleep';
  sendState();
}

function isHungry(now) { return now - lastFed > HUNGER_AFTER; }

function settle(now) {
  mode = isHungry(now) ? 'hungry' : 'idle';
  targetX = null;
  nextDecision = now + 700;
}

function chooseMoveMode(now) {
  if (now < happyUntil) return 'wag';
  if (Math.random() < 0.45) return 'run';
  return 'walk';
}

function speedFor(m) { return m === 'run' ? RUN_SPEED : SPEED; }

function startMove(now, x) {
  targetX = clampX(x);
  facing = targetX < petX ? 'left' : 'right';
  mode = chooseMoveMode(now);
  lastActivity = now;
}

function tick() {
  if (!win || win.isDestroyed() || dragging) return;
  // Forced sleep freezes the pet in the sleep pose until the user wakes it.
  if (forcedSleep) { mode = 'sleep'; sendState(); return; }
  const now = Date.now();

  // ----- feeding overrides normal behavior -----
  if (foodActive) {
    const plateCenterX = plateX + PLATE / 2;
    targetX = clampX(plateCenterX - MOUTH);
    const dx = targetX - petX;
    if (Math.abs(dx) <= 4) {
      facing = 'right';
      if (mode !== 'eat') { mode = 'eat'; eatStart = now; }
      else if (now - eatStart > EAT_TIME) { finishEat(); sendState(); return; }
    } else {
      mode = (now < happyUntil) ? 'wag' : (Math.abs(dx) > 260 ? 'run' : 'walk');
      facing = dx < 0 ? 'left' : 'right';
      petX += Math.sign(dx) * Math.min(speedFor(mode), Math.abs(dx));
      applyPosition();
    }
    sendState();
    return;
  }

  if (mode === 'groom' || mode === 'biscuit' || mode === 'rollover') {
    if (now >= actionUntil) settle(now);
    sendState();
    return;
  }

  // ----- moving -----
  if (mode === 'walk' || mode === 'wag' || mode === 'run') {
    const speed = speedFor(mode);
    if (targetX === null) {
      settle(now);
    } else {
      const dx = targetX - petX;
      if (Math.abs(dx) <= speed) {
        petX = targetX; targetX = null;
        settle(now);
        nextDecision = now + (1200 + Math.random() * 2200);
      } else {
        facing = dx < 0 ? 'left' : 'right';
        if (now < happyUntil && mode !== 'wag') mode = 'wag';
        petX += Math.sign(dx) * speed;
      }
      applyPosition();
    }
  } else if (mode === 'hungry') {
    // stays put and meows until it is fed or picked up
  } else if (mode === 'idle' || mode === 'sleep') {
    if (isHungry(now)) {
      mode = 'hungry';
    } else if (mode === 'idle' && now >= nextDecision) {
      const r = Math.random();
      if (r < 0.34) {
        startMove(now, workArea().x + Math.random() * (workArea().width - WIN_W));
      } else if (r < 0.52) {
        mode = 'groom'; actionUntil = now + 4200;
      } else if (r < 0.66) {
        mode = 'biscuit'; actionUntil = now + 3600;
      } else if (r < 0.78) {
        mode = 'rollover'; actionUntil = now + 1400;
      } else {
        nextDecision = now + (1500 + Math.random() * 2500);
      }
    } else if (mode === 'idle' && now - lastActivity > SLEEP_AFTER) {
      mode = 'sleep';
    }
  }

  sendState();
}

function centerPet() {
  const wa = workArea();
  petX = clampX(wa.x + (wa.width - WIN_W) / 2);
  petY = groundY();
  applyPosition();
  wake();
}

// ---- feeding ----
function dropFood() {
  if (foodWin && !foodWin.isDestroyed()) { foodWin.focus(); return; }
  const wa = workArea();
  plateX = Math.max(wa.x, Math.min(wa.x + wa.width - PLATE, wa.x + (wa.width - PLATE) / 2));
  plateY = wa.y + wa.height - PLATE + 18;
  foodWin = new BrowserWindow({
    width: PLATE, height: PLATE, x: Math.round(plateX), y: Math.round(plateY),
    transparent: true, frame: false, resizable: false, skipTaskbar: true,
    hasShadow: false, alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  wirePinning(foodWin);
  foodWin.loadFile('food.html');
  // macOS clamps a window's spawn position above the Dock; re-apply once it's
  // shown so it lands at the intended low (over-the-Dock) spot immediately.
  const placeFood = () => {
    if (foodWin && !foodWin.isDestroyed())
      foodWin.setBounds({ x: Math.round(plateX), y: Math.round(plateY), width: PLATE, height: PLATE });
  };
  foodWin.once('show', placeFood);
  foodWin.webContents.once('did-finish-load', placeFood);
  foodWin.on('closed', () => { foodWin = null; foodActive = false; });
  foodActive = true;
  mode = 'walk';
  wake();
  if (tray) tray.setContextMenu(buildMenu());
}

function removeFood() {
  if (foodWin && !foodWin.isDestroyed()) foodWin.destroy();
  foodWin = null;
  foodActive = false;
  mode = 'idle';
  nextDecision = Date.now() + 800;
  lastActivity = Date.now();
  if (tray) tray.setContextMenu(buildMenu());
}

function finishEat() {
  lastFed = Date.now();
  happyUntil = Date.now() + 12000;
  removeFood();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Choose pet',
      submenu: [
        { label: '🐱  Cat (black & white)', type: 'radio', checked: currentPet === 'cat', click: () => setPet('cat') },
        { label: '🐕  Shiba', type: 'radio', checked: currentPet === 'shiba', click: () => setPet('shiba') },
        { label: '🐺  Husky', type: 'radio', checked: currentPet === 'husky', click: () => setPet('husky') },
        { label: '🐱  Fortune Cat (招財貓)', type: 'radio', checked: currentPet === 'fortune', click: () => setPet('fortune') },
      ],
    },
    { type: 'separator' },
    foodActive
      ? { label: 'Remove food', click: () => removeFood() }
      : { label: 'Drop food 🍖', click: () => dropFood() },
    { label: 'Sleep 💤', click: () => forceSleep() },
    { label: 'Bring to center', click: () => centerPet() },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
}

function setPet(pet) {
  currentPet = pet;
  lastSent = '';
  sendState();
  if (tray) tray.setContextMenu(buildMenu());
  wake();
}

function createTray() {
  if (process.platform === 'darwin') {
    // macOS: blank icon + emoji title shows 🐾 in the menu bar
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle('🐾');
  } else {
    // Windows/Linux: use a real icon in the system tray
    tray = new Tray(path.join(__dirname, 'tray.png'));
  }
  tray.setToolTip('Desktop Pet');
  tray.setContextMenu(buildMenu());
  // Windows: left-click should also open the menu
  tray.on('click', () => { try { tray.popUpContextMenu(); } catch (e) {} });
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    transparent: true, frame: false, resizable: false, movable: true,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  wirePinning(win);
  win.loadFile('index.html');

  petX = clampX(workArea().x + (workArea().width - WIN_W) / 2);
  petY = groundY();
  applyPosition();

  win.webContents.on('did-finish-load', () => { lastSent = ''; sendState(); });
  setInterval(tick, TICK);
}

// ---- IPC: dragging the pet ----
ipcMain.on('drag-start', () => { dragging = true; wake(); });
ipcMain.on('drag-move', (_e, { x, y, lifted }) => {
  if (!lifted) return;            // only move once it's actually picked up
  const wa = workArea();
  // anchor the pet's neck/scruff to the cursor so it hangs from the mouse
  petX = clampX(x - WIN_W / 2);
  petY = Math.max(wa.y - 50, Math.min(wa.y + wa.height - 40, y - NECK_Y));
  applyPosition();
});
ipcMain.on('drag-end', () => {
  dragging = false;
  petY = groundY();
  applyPosition();
  const now = Date.now();
  if (foodActive) mode = 'walk';
  else if (isHungry(now)) mode = 'hungry';
  else mode = 'idle';
  nextDecision = now + 900;
  lastActivity = now;
  lastSent = '';
});
ipcMain.on('poke', () => {
  happyUntil = Date.now() + 8000;
  wake();
  if (mode === 'idle') nextDecision = Date.now() + 400;
  else nextDecision = Date.now() + 1500;
  lastSent = '';
});
ipcMain.on('context-menu', () => { buildMenu().popup({ window: win }); });

// ---- IPC: dragging the food bowl ----
ipcMain.on('food-drag-start', () => { wake(); });
ipcMain.on('food-drag-move', (_e, { dx, dy }) => {
  if (!foodWin || foodWin.isDestroyed()) return;
  const wa = workArea();
  const b = foodWin.getBounds();
  plateX = Math.max(wa.x, Math.min(wa.x + wa.width - PLATE, b.x + dx));
  plateY = wa.y + wa.height - PLATE + 18;   // locked to ground level; drag only moves sideways
  foodWin.setBounds({ x: Math.round(plateX), y: Math.round(plateY), width: PLATE, height: PLATE });
  wake();
});
ipcMain.on('food-drag-end', () => {});

app.whenReady().then(() => {
  createWindow();
  createTray();
  if (app.dock) app.dock.hide();
});

app.on('window-all-closed', () => {});
