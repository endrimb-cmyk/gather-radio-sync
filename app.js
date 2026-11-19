import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import { getDatabase, ref, onValue, runTransaction, update, serverTimestamp, increment } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-database.js';

const $ = (id) => document.getElementById(id);
const setShown = (id, visible) => $(id).classList.toggle('hide', !visible);
const setMessage = (message, id = 'alert') => { $(id).textContent = message; setShown(id, !!message); };
const roomPattern = /^[a-zA-Z0-9_-]{6,48}$/;
const videoPattern = /^[a-zA-Z0-9_-]{11}$/;
const playlistPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const url = new URL(location.href);
let roomId = url.searchParams.get('room') || '';
let db, authUser, roomRef, stateRef, room, state;
let isDJ = false, listening = false, player = null, playerReady = false;
let pendingYT = null, currentLoaded = '', serverOffset = 0;
let lastDjVideo = '', lastReport = 0, joining = false, roomObserved = false;
let ignoredEventsUntil = 0;

const getTime = () => Date.now() + serverOffset;
const positionAt = (s) => !s ? 0 : Math.max(0, Number(s.position || 0) + (s.playing ? Math.max(0, (getTime() - Number(s.updatedAt || getTime())) / 1000) : 0));
const ytTime = () => playerReady ? Number(player.getCurrentTime()) || 0 : 0;
const ytVideo = () => playerReady ? (player.getVideoData()?.video_id || '') : '';
const ytState = () => playerReady ? player.getPlayerState() : -1;
const status = (label, type = '') => { $('connection').textContent = label; $('connection').className = 'badge ' + type; };

function parseMedia(value) {
  let u;
  try { u = new URL(value.trim()); } catch { throw new Error('Встав коректний URL YouTube / YouTube Music.'); }
  if (u.protocol !== 'https:' || !['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtu.be','www.youtu.be'].includes(u.hostname.toLowerCase()))
    throw new Error('Дозволені тільки посилання YouTube або YouTube Music (https).');
  const videoId = (u.hostname.endsWith('youtu.be') ? u.pathname.slice(1).split('/')[0] : u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : u.searchParams.get('v')) || '';
  const playlistId = u.searchParams.get('list') || '';
  if (videoId && !videoPattern.test(videoId)) throw new Error('Невірний ідентифікатор відео.');
  if (playlistId && !playlistPattern.test(playlistId)) throw new Error('Невірний ідентифікатор плейлиста.');
  if (!videoId && !playlistId) throw new Error('Не знайдено ID відео або плейлиста в посиланні.');
  return {videoId, playlistId};
}
function sharedURL() {
  const u = new URL(location.href);
  u.searchParams.set('room', roomId);
  u.hash = '';
  return u.toString();
}
function render() {
  const active = !!room;
  setShown('setupPane', !active && !roomId);
  setShown('roomPane', active);
  setShown('djPane', active && isDJ);
  setShown('joinBtn', active && !listening);
  setShown('leaveBtn', active && listening);
  $('role').textContent = isDJ ? '🎙️ Ведучий' : '🎧 Слухач';
  $('role').className = isDJ ? 'badge live' : 'badge';
  if (!active) return;
  $('shareLink').value = sharedURL();
  $('songName').textContent = state?.videoId ? `YouTube: ${state.videoId}` : (state?.playlistId ? 'Плейлист додано, очікуємо Play від ведучого' : 'Музика ще не обрана');
  $('songDetail').textContent = `${state?.playing ? '🟢 Грає' : '⏸ Пауза'}${state?.playlistId ? ' · плейлист активний' : ''}${state?.videoId ? ` · позиція ~${Math.floor(positionAt(state))} c` : ''}`;
  $('joinText').textContent = listening ? (state?.playing ? 'Ти підключений до ефіру.' : 'Ти підключений. Ведучий поки не запустив музику.') : 'Підключення добровільне: звук не вмикається, поки ти не натиснеш кнопку.';
  $('playBtn').disabled = !state?.videoId && !state?.playlistId;
  $('pauseBtn').disabled = !state?.videoId;
  $('nextBtn').disabled = !state?.playlistId;
}
function openExternalAdvice(error) {
  const suffix = error ? ` (${error})` : '';
  setMessage('Не вдалося запустити плеєр усередині Gather' + suffix + '. Спробуй відкрити адресу ефіру в окремій вкладці браузера.', 'playbackHint');
}

// YouTube API only loads AFTER a listener has opted in.
function ytApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (pendingYT) return pendingYT;
  pendingYT = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (typeof prev === 'function') prev(); resolve(window.YT); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => reject(new Error('YouTube API недоступний'));
    document.head.appendChild(script);
  });
  return pendingYT;
}
async function join() {
  if (joining || listening) return;
  joining = true;
  listening = true;
  $('playerWrap').style.display = 'block';
  render();
  setMessage('Завантаження YouTube-плеєра…', 'playbackHint');
  try {
    const YT = await ytApi();
    if (!listening) return;
    player = new YT.Player('player', {
      width: '640', height: '360',
      playerVars: { playsinline: 1, controls: 1, enablejsapi: 1, origin: location.origin, rel: 0 },
      events: {
        onReady: () => {
          playerReady = true;
          setMessage('', 'playbackHint');
          if (isDJ) applyDJTrack(); else syncListener(true);
          if (state?.playing) showUnlock();
        },
        onStateChange: onYTState,
        onError: (e) => openExternalAdvice('помилка YouTube ' + e.data),
        onAutoplayBlocked: () => showUnlock()
      }
    });
  } catch (e) { listening = false; $('playerWrap').style.display='none'; setMessage(e.message || String(e)); render(); }
  finally { joining = false; }
}
function leave() {
  listening = false;
  playerReady = false;
  currentLoaded = '';
  lastDjVideo = '';
  if (player) { try { player.destroy(); } catch {} }
  player = null;
  $('playerWrap').innerHTML = '<div id="player"></div><p class="note">Офіційний YouTube-плеєр. Гучність можна змінювати локально.</p>';
  $('playerWrap').style.display = 'none';
  setShown('unblockBtn', false);
  setMessage('', 'playbackHint');
  render();
}
function showUnlock() {
  if (!listening || !state?.playing) return;
  setShown('unblockBtn', true);
  setMessage('Браузер може блокувати автоматичний запуск звуку. Натисни «Увімкнути звук» або Play у вікні YouTube.', 'playbackHint');
}
function applyDJTrack() {
  if (!listening || !isDJ || !playerReady || !state) return;
  try {
    if (state.playlistId) {
      currentLoaded = `playlist:${state.playlistId}`;
      player.cuePlaylist({listType:'playlist', list:state.playlistId, index:0});
    } else if (state.videoId) {
      currentLoaded = state.videoId;
      player.cueVideoById({videoId:state.videoId, startSeconds:positionAt(state)});
    }
  } catch (e) { openExternalAdvice(e.message); }
}
function syncListener(force = false) {
  if (isDJ || !listening || !playerReady || !state) return;
  if (!state.videoId) return;
  const desired = positionAt(state);
  try {
    if (currentLoaded !== state.videoId) {
      currentLoaded = state.videoId;
      if (state.playing) player.loadVideoById({videoId:state.videoId, startSeconds:desired});
      else player.cueVideoById({videoId:state.videoId, startSeconds:desired});
      if (state.playing) showUnlock();
      return;
    }
    const current = ytTime();
    if (Math.abs(current - desired) > (force ? 0.9 : 2.5)) player.seekTo(desired, true);
    if (state.playing && ytState() !== window.YT.PlayerState.PLAYING) {
      player.playVideo();
      showUnlock();
    } else if (!state.playing && ytState() === window.YT.PlayerState.PLAYING) {
      player.pauseVideo();
    }
  } catch (e) { openExternalAdvice(e.message); }
}
async function publish(patch) {
  if (!isDJ || !stateRef) return;
  try {
    await update(stateRef, {
      ...patch,
      updatedAt: serverTimestamp(),
      revision: increment(1)
    });
  } catch (e) { setMessage('Не вдалося оновити ефір: ' + (e.message || e)); }
}
function onYTState(evt) {
  if (!playerReady || !listening) return;
  if (!isDJ) {
    if (evt.data === window.YT.PlayerState.PLAYING) {
      setShown('unblockBtn', false);
      setMessage('', 'playbackHint');
      syncListener();
    }
    return;
  }
  if (Date.now() < ignoredEventsUntil) return;
  const currentId = ytVideo() || state?.videoId || '';
  if (!videoPattern.test(currentId)) return;
  if (evt.data === window.YT.PlayerState.PLAYING) {
    setShown('unblockBtn', false);
    setMessage('', 'playbackHint');
    const changed = currentId !== lastDjVideo;
    if (changed || !state?.playing || Date.now() - lastReport > 2200) {
      lastDjVideo = currentId;
      lastReport = Date.now();
      publish({videoId:currentId, playing:true, position:ytTime()});
    }
  } else if (evt.data === window.YT.PlayerState.PAUSED) {
    if (state?.playing) {
      lastReport = Date.now();
      publish({videoId:currentId, playing:false, position:ytTime()});
    }
  } else if (evt.data === window.YT.PlayerState.ENDED && !state?.playlistId) {
    publish({videoId:currentId, playing:false, position:ytTime()});
  }
}
function parseAndLoad() {
  if (!isDJ) return;
  let media;
  try { media = parseMedia($('urlInput').value); }
  catch (e) { setMessage(e.message, 'playbackHint'); return; }
  setMessage('', 'playbackHint');
  ignoredEventsUntil = Date.now() + 1200;
  lastDjVideo = '';
  publish({...media, playing:false, position:0}).then(() => {
    // The database listener updates state and loads the new item in the DJ player.
    if (!listening) join();
  });
}
function controlPlay() {
  if (!isDJ || !state?.videoId && !state?.playlistId) return;
  if (!listening) { join(); setMessage('Натисни Play ще раз після завантаження плеєра.', 'playbackHint'); return; }
  if (!playerReady) { setMessage('Плеєр завантажується. Натисни Play після його появи.', 'playbackHint'); return; }
  if (state.playlistId && currentLoaded !== `playlist:${state.playlistId}`) applyDJTrack();
  if (!state.playlistId && currentLoaded !== state.videoId) applyDJTrack();
  player.playVideo();
  // The PLAYING event will tell Firebase the video ID and playback position.
}
function seekDJ(delta) {
  if (!isDJ || !playerReady || !state?.videoId) return;
  const pos = Math.max(0, ytTime() + delta);
  player.seekTo(pos, true);
  publish({videoId:ytVideo() || state.videoId, playing:ytState() === window.YT.PlayerState.PLAYING, position:pos});
}
function nextDJ() {
  if (!isDJ || !playerReady || !state?.playlistId) return;
  try { player.nextVideo(); }
  catch (e) { setMessage('Наступний трек недоступний: '+e.message, 'playbackHint'); }
}
async function createRoom() {
  if (!authUser || roomObserved) return;
  $('createBtn').disabled = true;
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  const id = 'radio_' + [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
  const roomPath = ref(db, 'rooms/' + id);
  try {
    const result = await runTransaction(roomPath, (prev) => prev || {
      djUid: authUser.uid,
      state: {videoId:'', playlistId:'', playing:false, position:0, updatedAt:Date.now(), revision:0}
    });
    if (!result.committed) throw Error('Кімната вже існує. Спробуй ще раз.');
    roomId = id;
    url.searchParams.set('room', id);
    history.replaceState(null, '', url.toString());
    subscribeRoom();
  } catch (e) { setMessage('Помилка створення кімнати: ' + (e.message || e)); $('createBtn').disabled = false; }
}
function subscribeRoom() {
  if (roomObserved || !roomPattern.test(roomId) || !authUser) return;
  roomObserved = true;
  roomRef = ref(db, 'rooms/' + roomId);
  stateRef = ref(db, 'rooms/' + roomId + '/state');
  onValue(roomRef, (snap) => {
    if (!snap.exists()) {
      status('Немає ефіру');
      if (roomId) setMessage('Ефір за цим посиланням ще не створений. Попроси ведучого відкрити свою радіокімнату або перевір адресу.');
      return;
    }
    room = snap.val();
    state = room.state;
    const wasDJ = isDJ;
    isDJ = room.djUid === authUser.uid;
    setShown('setupPane', false);
    setMessage('');
    status(state?.playing ? '● Прямий ефір' : '● Ефір на паузі', 'live');
    render();
    if (listening && playerReady) {
      if (isDJ) {
        if (!wasDJ || (state?.playlistId && currentLoaded !== `playlist:${state.playlistId}`) || (!state?.playlistId && state?.videoId && currentLoaded !== state.videoId && ytVideo() !== state.videoId)) applyDJTrack();
      } else syncListener();
    }
  }, (error) => { status('Помилка доступу', 'error'); setMessage('Firebase відмовив у доступі: ' + error.message + '. Перевір database.rules.json, Firebase Auth і databaseURL.'); });
}
async function copyUrl() {
  const val = sharedURL();
  try { await navigator.clipboard.writeText(val); }
  catch { $('shareLink').focus(); $('shareLink').select(); document.execCommand('copy'); }
  $('copyBtn').textContent = '✓ Скопійовано';
  setTimeout(() => { $('copyBtn').textContent = 'Копіювати URL'; }, 1800);
}
$('createBtn').addEventListener('click', createRoom);
$('copyBtn').addEventListener('click', copyUrl);
$('joinBtn').addEventListener('click', join);
$('leaveBtn').addEventListener('click', leave);
$('unblockBtn').addEventListener('click', () => {
  if (!playerReady) return;
  if (state?.videoId && !isDJ) player.seekTo(positionAt(state), true);
  player.playVideo();
});
$('loadBtn').addEventListener('click', parseAndLoad);
$('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') parseAndLoad(); });
$('playBtn').addEventListener('click', controlPlay);
$('pauseBtn').addEventListener('click', () => { if (isDJ && playerReady) player.pauseVideo(); });
$('backBtn').addEventListener('click', () => seekDJ(-10));
$('aheadBtn').addEventListener('click', () => seekDJ(10));
$('nextBtn').addEventListener('click', nextDJ);

setInterval(() => {
  if (!listening || !playerReady || !state) return;
  if (isDJ) {
    // Every ~15s, refresh the DJ's precise position, including seeks made using YouTube controls.
    if (ytState() === window.YT.PlayerState.PLAYING && Date.now() - lastReport > 15000) {
      lastReport = Date.now();
      publish({videoId:ytVideo() || state.videoId, playing:true, position:ytTime()});
    }
  } else syncListener();
}, 7000);
setInterval(() => { if (room) render(); }, 15000);

async function init() {
  if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE_') || !firebaseConfig.databaseURL || firebaseConfig.databaseURL.includes('PASTE_')) {
    status('Потрібен Firebase', 'error');
    setMessage('Спочатку заповни config.js даними з Firebase Console і встанови правила з database.rules.json. Інструкція — у README.md.');
    return;
  }
  if (roomId && !roomPattern.test(roomId)) { status('Некоректний URL', 'error'); setMessage('Невірний ідентифікатор кімнати в URL.'); return; }
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    onValue(ref(db, '.info/serverTimeOffset'), (s) => { serverOffset = Number(s.val() || 0); });
    const auth = getAuth(app);
    const credential = await signInAnonymously(auth);
    authUser = credential.user;
    status('Підключено', 'live');
    if (roomId) subscribeRoom();
    else { $('createBtn').disabled = false; setMessage(''); render(); }
  } catch(e) {
    status('Firebase недоступний', 'error');
    setMessage('Помилка підключення: ' + (e.message || e) + '. Перевір Anonymous Authentication і налаштування Firebase. Якщо сайт відкрито в iframe Gather, спробуй окрему вкладку.');
  }
}
init();
