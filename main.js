const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let tray = null;
let foodWin = null;
let ballWin = null;

// ---- sizes ----
const WIN_W = 220;
const WIN_H = 200;
const PLATE = 100;
const BALL = 90;
const PLAY_LOOP = 1600;     // ms, matches the play sprite strip
const SPEED = 1.7;          // pixels per tick while walking
const RUN_SPEED = 3.4;      // pixels per tick while running
const TICK = 30;            // ms between movement ticks
const SLEEP_AFTER = 18000;  // ms of stillness before the pet naps
let petName = 'Mochi';
let hungryTimesPerDay = 3;
let onboarded = false;
let welcomeWin = null;
const EAT_TIME = 6000;      // ms spent eating
const MOUTH = 158;          // x of the pet's mouth within the window (facing right)
const NECK_Y = 60;          // y of the pet's neck/scruff within the window (for carrying)

// ---- pet state ----
let currentPet = 'cat';     // 'cat' | 'shiba' | 'husky' | 'fortune'
let mode = 'idle';          // idle | walk | wag | run | sleep | eat | groom | hungry | rollover | biscuit | play
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

// ---- yarn ball ----
let ballActive = false;
let ballX = 0, ballY = 0;
let playAnchor = 0;
let playStart = 0;
let ballChases = 0;

// ---- butterfly (about every 90 minutes) ----
const FLY_W = 72;
const FLY_H = 72;
const BUTTERFLY_EVERY = 90 * 60 * 1000;
let flyWin = null;
let flyActive = false;
let flyX = 0, flyY = 0, flyVX = 0, flyVY = 0;
let flyUntil = 0;
let nextButterfly = Date.now() + BUTTERFLY_EVERY;

// ---- forced sleep (Sleep 💤 menu item) ----
// When true, the pet stays asleep regardless of the idle timer until the user
// pokes, drags, drops food, or otherwise interacts with it.
let forcedSleep = false;

function workArea() { return screen.getPrimaryDisplay().workArea; }

// Keep overlay windows painted across Spaces. Re-pinning on focus/blur
// makes the window flash during a three-finger swipe, so this runs once.
function pinAlwaysOnTop(w) {
  if (!w || w.isDestroyed()) return;
  w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  if (process.platform === 'darwin') w.setWindowButtonVisibility(false);
}
function wirePinning(w) {
  pinAlwaysOnTop(w);
}

function overlayOptions(extra) {
  const opts = Object.assign({
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  }, extra);
  if (process.platform === 'darwin') opts.type = 'panel';
  return opts;
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
  if (mode === 'sleep' || mode === 'groom' || mode === 'biscuit' || mode === 'rollover' || mode === 'play') {
    mode = 'idle';
    nextDecision = Date.now() + 700;
  }
}

function forceSleep() {
  if (foodActive) removeFood();
  if (ballActive) removeBall();
  if (flyActive) removeButterfly();
  targetX = null;
  forcedSleep = true;
  mode = 'sleep';
  sendState();
}

function hungerInterval() {
  const n = Math.min(12, Math.max(1, hungryTimesPerDay));
  return (24 * 60 * 60 * 1000) / n;
}

function isHungry(now) { return now - lastFed > hungerInterval(); }

function settingsPath() {
  return path.join(app.getPath('userData'), 'pet-settings.json');
}

function cleanName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return name || 'Mochi';
}

function clampTimes(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 3;
  return Math.min(12, Math.max(1, v));
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (!data || !data.onboarded || !data.name) return;
    onboarded = true;
    petName = cleanName(data.name);
    hungryTimesPerDay = clampTimes(data.hungryTimesPerDay);
    if (typeof data.lastFed === 'number') lastFed = data.lastFed;
  } catch (e) {}
}

function saveSettings() {
  if (!onboarded) return;
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify({
      onboarded: true,
      name: petName,
      hungryTimesPerDay,
      lastFed,
    }, null, 2));
  } catch (e) {}
}

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

  // ----- yarn ball: run over, then bat it so the ball rolls with her paw -----
  if (ballActive) {
    const wa = workArea();
    const ballOnRight = (ballX + BALL / 2) >= petCenter();
    const beside = ballOnRight ? ballX - WIN_W + 28 : ballX + BALL - 28;
    if (mode !== 'play') {
      targetX = clampX(beside);
      const dx = targetX - petX;
      if (Math.abs(dx) <= 8) {
        petX = targetX;
        facing = ballOnRight ? 'right' : 'left';
        mode = 'play';
        playStart = now;
        playAnchor = ballX;
        applyPosition();
      } else {
        mode = 'run';
        facing = dx < 0 ? 'left' : 'right';
        petX += Math.sign(dx) * Math.min(RUN_SPEED, Math.abs(dx));
        applyPosition();
      }
    } else {
      const t = ((now - playStart) % PLAY_LOOP) / PLAY_LOOP;
      const nudge = t < 0.25 ? 0 : t < 0.5 ? 8 : t < 0.75 ? 52 : 16;
      const lift = t >= 0.5 && t < 0.75 ? -10 : 0;
      const dir = facing === 'right' ? 1 : -1;
      ballX = Math.max(wa.x, Math.min(wa.x + wa.width - BALL, playAnchor + dir * nudge));
      placeBall();
      if (ballWin && !ballWin.isDestroyed()) {
        ballWin.webContents.send('ball-react', { rot: dir * nudge * 5, lift });
      }
      if (now - playStart > PLAY_LOOP * 3) {
        ballChases += 1;
        if (ballChases >= 3) {
          removeBall();
          happyUntil = now + 8000;
          sendState();
          return;
        }
        const kick = 100 + Math.random() * 90;
        ballX = Math.max(wa.x, Math.min(wa.x + wa.width - BALL, playAnchor + dir * kick));
        playAnchor = ballX;
        placeBall();
        mode = 'run';
      }
    }
    sendState();
    return;
  }

  if (updateButterfly(now)) {
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
        mode = 'rollover'; actionUntil = now + 2400;
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
  if (ballActive) removeBall();
  if (flyActive) removeButterfly();
  if (foodWin && !foodWin.isDestroyed()) { foodWin.focus(); return; }
  const wa = workArea();
  plateX = Math.max(wa.x, Math.min(wa.x + wa.width - PLATE, wa.x + (wa.width - PLATE) / 2));
  plateY = wa.y + wa.height - PLATE + 18;
  foodWin = new BrowserWindow(overlayOptions({
    width: PLATE, height: PLATE, x: Math.round(plateX), y: Math.round(plateY),
  }));
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
  saveSettings();
  removeFood();
}

function ballGroundY() {
  const wa = workArea();
  return wa.y + wa.height - BALL + 18;
}

function placeBall() {
  if (ballWin && !ballWin.isDestroyed()) {
    ballWin.setBounds({ x: Math.round(ballX), y: Math.round(ballY), width: BALL, height: BALL });
  }
}

function dropBall() {
  if (foodActive) removeFood();
  if (flyActive) removeButterfly();
  if (ballWin && !ballWin.isDestroyed()) { ballWin.focus(); return; }
  const wa = workArea();
  ballX = wa.x + Math.random() * (wa.width - BALL);
  ballY = ballGroundY();
  ballChases = 0;
  playStart = 0;
  ballWin = new BrowserWindow(overlayOptions({
    width: BALL, height: BALL, x: Math.round(ballX), y: Math.round(ballY),
  }));
  wirePinning(ballWin);
  ballWin.loadFile('ball.html');
  const place = () => placeBall();
  ballWin.once('show', place);
  ballWin.webContents.once('did-finish-load', place);
  ballWin.on('closed', () => { ballWin = null; ballActive = false; });
  ballActive = true;
  mode = 'run';
  wake();
  lastSent = '';
  if (tray) tray.setContextMenu(buildMenu());
}

function removeBall() {
  if (ballWin && !ballWin.isDestroyed()) ballWin.destroy();
  ballWin = null;
  ballActive = false;
  ballChases = 0;
  if (mode === 'play' || mode === 'run') {
    mode = 'idle';
    targetX = null;
    nextDecision = Date.now() + 800;
    lastActivity = Date.now();
  }
  if (tray) tray.setContextMenu(buildMenu());
}

function placeButterfly() {
  if (flyWin && !flyWin.isDestroyed()) {
    flyWin.setBounds({ x: Math.round(flyX), y: Math.round(flyY), width: FLY_W, height: FLY_H });
  }
}

function spawnButterfly() {
  if (foodActive || ballActive || dragging || flyActive) return;
  const wa = workArea();
  flyX = wa.x + Math.random() * (wa.width - FLY_W);
  flyY = wa.y + 30 + Math.random() * Math.max(40, wa.height * 0.4);
  flyVX = (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 1.6);
  flyVY = (Math.random() - 0.5) * 1.4;
  flyUntil = Date.now() + 32000;
  flyWin = new BrowserWindow(overlayOptions({
    width: FLY_W, height: FLY_H, x: Math.round(flyX), y: Math.round(flyY),
  }));
  wirePinning(flyWin);
  flyWin.loadFile('butterfly.html');
  flyWin.once('show', placeButterfly);
  flyWin.webContents.once('did-finish-load', placeButterfly);
  flyWin.on('closed', () => { flyWin = null; flyActive = false; });
  flyActive = true;
  nextButterfly = Date.now() + BUTTERFLY_EVERY;
  wake();
  lastSent = '';
}

function removeButterfly() {
  if (flyWin && !flyWin.isDestroyed()) flyWin.destroy();
  flyWin = null;
  flyActive = false;
  if (mode === 'play' || mode === 'run') {
    mode = 'idle';
    targetX = null;
    nextDecision = Date.now() + 800;
  }
}

// Returns true when the butterfly is steering the cat.
function updateButterfly(now) {
  if (!flyActive && now >= nextButterfly) spawnButterfly();
  if (!flyActive || !flyWin || flyWin.isDestroyed()) return false;
  if (now > flyUntil) {
    removeButterfly();
    return false;
  }
  const wa = workArea();
  if (Math.random() < 0.035) {
    flyVX = (Math.random() - 0.5) * 3.4;
    flyVY = (Math.random() - 0.5) * 2.4;
  }
  flyX += flyVX;
  flyY += flyVY;
  const maxY = wa.y + wa.height * 0.62;
  if (flyX < wa.x) { flyX = wa.x; flyVX = Math.abs(flyVX) || 1; }
  if (flyX > wa.x + wa.width - FLY_W) { flyX = wa.x + wa.width - FLY_W; flyVX = -Math.abs(flyVX) || -1; }
  if (flyY < wa.y + 16) { flyY = wa.y + 16; flyVY = Math.abs(flyVY) || 0.8; }
  if (flyY > maxY) { flyY = maxY; flyVY = -Math.abs(flyVY) || -0.8; }
  placeButterfly();

  const center = flyX + FLY_W / 2;
  const target = clampX(center - WIN_W / 2);
  const dx = target - petX;
  if (Math.abs(dx) > 22) {
    mode = 'run';
    facing = dx < 0 ? 'left' : 'right';
    petX += Math.sign(dx) * Math.min(RUN_SPEED, Math.abs(dx));
    applyPosition();
  } else {
    mode = 'play';
    facing = center < petCenter() ? 'left' : 'right';
    petY = groundY();
    applyPosition();
  }
  return true;
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: petName, enabled: false },
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
      : { label: `Feed ${petName}`, click: () => dropFood() },
    ballActive
      ? { label: 'Remove ball', click: () => removeBall() }
      : { label: `Yarn ball for ${petName}`, click: () => dropBall() },
    { label: `Let ${petName} sleep`, click: () => forceSleep() },
    { label: `Bring ${petName} here`, click: () => centerPet() },
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
  tray.setToolTip(petName);
  tray.setContextMenu(buildMenu());
  // Windows: left-click should also open the menu
  tray.on('click', () => { try { tray.popUpContextMenu(); } catch (e) {} });
}

function createWindow() {
  win = new BrowserWindow(overlayOptions({
    width: WIN_W, height: WIN_H,
    movable: true,
    focusable: true,
  }));
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
  else if (ballActive || flyActive) mode = 'run';
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

function startPet() {
  createWindow();
  createTray();
  if (app.dock) app.dock.hide();
}

function createWelcome() {
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 420;
  const H = 600;
  welcomeWin = new BrowserWindow({
    width: W,
    height: H,
    x: wa.x + Math.round((wa.width - W) / 2),
    y: wa.y + Math.round((wa.height - H) / 2),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Welcome',
    backgroundColor: '#fff6f3',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  welcomeWin.loadFile('welcome.html');
  welcomeWin.on('closed', () => {
    welcomeWin = null;
    if (!onboarded) app.quit();
  });
}

ipcMain.on('welcome-done', (_e, payload) => {
  petName = cleanName(payload && payload.name);
  hungryTimesPerDay = clampTimes(payload && payload.times);
  lastFed = Date.now();
  onboarded = true;
  saveSettings();
  startPet();
  if (welcomeWin && !welcomeWin.isDestroyed()) welcomeWin.close();
});

app.whenReady().then(() => {
  loadSettings();
  if (onboarded) startPet();
  else createWelcome();
});

app.on('before-quit', () => saveSettings());

app.on('window-all-closed', () => {});
