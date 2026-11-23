import {firebaseConfig} from './config.js';
import {initializeApp} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithPopup, signInAnonymously, signOut
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  getDatabase, ref, onValue, runTransaction, update, serverTimestamp, increment
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-database.js';

const $ = id => document.getElementById(id);
const shown = (id, yes) => $(id).classList.toggle('hide', !yes);
const roomPattern = /^[A-Za-z0-9_-]{6,48}$/;
const videoPattern = /^[A-Za-z0-9_-]{11}$/;
const pageURL = new URL(location.href);
let roomId = pageURL.searchParams.get('room') || '';
let auth, db, user = null, room = null, state = null, isDJ = false;
let unsubscribeRoom = null, roomRef = null, stateRef = null, serverOffset = 0;
let googleAccessToken = '', youtubeAccessExpiry = 0;
let listening = false, joining = false, player = null, playerReady = false;
let ytPromise = null, loadedKey = '', lastDJVideo = '', lastPublished = 0, ignorePlayerUntil = 0;
let activeCatalogTab = 'search', catalogBusy = false;
let lastRecentSignature = '';
function recentKey(){return '044-radio-recent-v4-'+(user?.uid||'guest');}
function readRecent(){
  try{const items=JSON.parse(localStorage.getItem(recentKey())||'[]');return Array.isArray(items)?items.filter(x=>videoPattern.test(x?.id||'')).slice(0,12):[];}catch{return [];}
}
function rememberVideo(id,title,artist){
  if(!isGoogle()||!videoPattern.test(id))return;
  const songs=readRecent().filter(x=>x.id!==id);
  songs.unshift({id,title:String(title||'YouTube').slice(0,160),artist:String(artist||'YouTube').slice(0,120)});
  try{localStorage.setItem(recentKey(),JSON.stringify(songs.slice(0,12)));}catch{}
  lastRecentSignature='';renderRecent();
}
function renderRecent(){
  const entries=isGoogle()?readRecent():[];
  const key=JSON.stringify([user?.uid,entries]);if(lastRecentSignature===key)return;
  lastRecentSignature=key;
  const host=$('recentGrid');host.replaceChildren();
  shown('recentEmpty',!entries.length);
  for(const item of entries){
    const card=document.createElement('div');card.className='track';
    const img=document.createElement('img');img.src=currentCover(item.id);img.alt='Обкладинка';img.loading='lazy';
    const details=document.createElement('div');details.className='details';
    const name=document.createElement('strong');name.textContent=item.title;
    const artist=document.createElement('span');artist.textContent=item.artist;
    const button=document.createElement('button');button.className='small';button.textContent='В ефір';
    button.disabled=!isDJ;button.title=isDJ?'Додати композицію до спільного ефіру':'Створи свій ефір, щоб керувати музикою';
    button.addEventListener('click',()=>setSelectedVideo(item.id,item.title,item.artist));
    details.append(name,artist,button);card.append(img,details);host.appendChild(card);
  }
}
function goToSection(id){
  let el=$(id);
  if(!el||el.classList.contains('hide'))el=$('setupPane');
  el?.scrollIntoView({behavior:'smooth',block:'start'});
}
function setNav(id){
  for(const node of document.querySelectorAll('.nav')) node.classList.toggle('active',node.id===id);
}
function goToCatalog(tab){
  if(!room){goToSection('setupPane');alertUser('Спочатку увійди через Google та створи спільний ефір.');return;}
  if(!isDJ){goToSection('roomPane');alertUser('Ти підключений як слухач. Музику обирає тільки власник кімнати.');return;}
  alertUser('');chooseTab(tab);goToSection('djPane');
}


function status(message, cls='') { $('connection').textContent=message; $('connection').className='pill '+cls; }
function alertUser(message) { $('alert').textContent=message || ''; shown('alert',!!message); }
function catalogMessage(message) { $('catalogMessage').textContent=message || ''; shown('catalogMessage',!!message); }
function playbackHint(message) { $('playbackHint').textContent=message || ''; shown('playbackHint',!!message); }
function isGoogle() { return user?.providerData?.some(p => p.providerId === 'google.com') === true; }
function serverNow() { return Date.now() + serverOffset; }
function songPosition(s=state) { return !s?0:Math.max(0, Number(s.position || 0)+(s.playing?Math.max(0,(serverNow()-Number(s.updatedAt||serverNow()))/1000):0)); }
function ytVideo() { return playerReady ? (player.getVideoData()?.video_id || '') : ''; }
function ytTime() { return playerReady ? (Number(player.getCurrentTime()) || 0) : 0; }
function ytState() { return playerReady ? player.getPlayerState() : -1; }
function linkToRoom() { const u=new URL(location.href);u.searchParams.set('room',roomId);u.hash='';return u.toString(); }
function currentCover(id) { return videoPattern.test(id||'') ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="120" height="120"%3E%3Crect width="120" height="120" fill="%2338304e"/%3E%3Ctext x="60" y="75" text-anchor="middle" font-size="53"%3E%F0%9F%8E%B5%3C/text%3E%3C/svg%3E'; }

function render() {
  const loggedIn = isGoogle();
  $('accountName').textContent = loggedIn ? (user.displayName || user.email || 'Google-акаунт') : 'Гість · слухач';
  shown('loginBtn', !loggedIn); shown('logoutBtn', loggedIn);
  $('loginBtn').disabled = !user;
  $('createBtn').disabled = !loggedIn;
  shown('setupPane', !roomId);
  shown('roomPane', !!room);
  shown('djPane', !!room && isDJ);
  shown('joinBtn', !!room && !listening);
  shown('leaveBtn', !!room && listening);
  $('role').textContent = isDJ ? '🎙️ Ведучий' : '🎧 Слухач';
  $('role').className = 'pill' + (isDJ?' ok':'');
  if (!room) {shown('miniPlayer',false);renderRecent();return;}
  $('shareLink').value = linkToRoom();
  $('songName').textContent = state?.videoTitle || (state?.videoId ? 'Відтворення YouTube' : 'Музика ще не обрана');
  $('songArtist').textContent = state?.channelTitle || (state?.videoId ? 'YouTube' : 'Очікуємо ведучого');
  $('cover').src = currentCover(state?.videoId);
  $('nowStatus').textContent = state?.playing ? '● Зараз грає' : '● На паузі';
  $('songDetail').textContent = (state?.videoId ? `Позиція ~${Math.floor(songPosition())} с` : 'Поки немає треку')+(state?.playlistId?' · плейлист':'');
  $('joinText').textContent = listening ? 'Ти підключений до спільного ефіру. Керування — у ведучого.' : 'Приєднуйся добровільно. Назву й обкладинку видно навіть без прослуховування.';
  $('playBtn').disabled = !(state?.videoId || state?.playlistId);
  $('pauseBtn').disabled = !state?.videoId;
  $('nextBtn').disabled = !state?.playlistId;
  shown('authorizeCatalogBtn', isDJ && !usableGoogleToken());
  const active=!!state?.videoId;
  shown('miniPlayer', active);
  if(active){
    $('miniCover').src=currentCover(state.videoId);
    $('miniTitle').textContent=state.videoTitle||'YouTube';
    $('miniArtist').textContent=state.channelTitle||'YouTube';
    $('miniStatus').textContent=state.playing?'● Зараз грає':'II На паузі';
  }
  renderRecent();
}

function usableGoogleToken() { return !!googleAccessToken && Date.now() < youtubeAccessExpiry; }
function makeProvider() { const p=new GoogleAuthProvider();p.addScope('https://www.googleapis.com/auth/youtube.readonly');return p; }
async function googleLogin() {
  if (!auth) return;
  try {
    const p = makeProvider();
    if (!isGoogle()) p.setCustomParameters({prompt:'select_account'});
    const result = await signInWithPopup(auth,p);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    googleAccessToken = credential?.accessToken || '';
    youtubeAccessExpiry = Date.now()+50*60*1000;
    if (!googleAccessToken) catalogMessage('Вхід збережено, але доступ до YouTube API не отримано. Повтори підключення каталогу.');
    else catalogMessage('YouTube-каталог підключений. Шукай треки або відкрий свої плейлисти.');
    render();
  } catch (e) {
    if (e.code !== 'auth/popup-closed-by-user') alertUser('Не вдалося увійти через Google: '+(e.message||e)+'. Перевір Google Sign-in, Authorized domains та тестових користувачів OAuth. Усередині Gather відкрий сайт в окремій вкладці.');
  }
}
async function googleLogout() {
  if (!auth) return;
  try {
    // Explicit logout invalidates the local session. A guest account is created for listening.
    if (listening && isDJ) leave();
    googleAccessToken='';youtubeAccessExpiry=0;
    await signOut(auth);
    catalogMessage('');
    alertUser('Ти вийшов із Google на цьому сайті. Ефір збережено; щоб знову керувати ним, увійди в той самий Google-акаунт.');
  } catch(e) { alertUser('Помилка виходу: '+(e.message||e)); }
}

async function createRoom() {
  if (!isGoogle() || !db) { alertUser('Спочатку увійди через Google, щоб створити ефір.');return; }
  $('createBtn').disabled=true;
  const random=new Uint8Array(14);crypto.getRandomValues(random);
  const id='radio_'+[...random].map(x=>x.toString(16).padStart(2,'0')).join('');
  try {
    const r=await runTransaction(ref(db,'rooms/'+id), value => value || {
      djUid:user.uid,
      state:{videoId:'',playlistId:'',videoTitle:'',channelTitle:'',playing:false,position:0,updatedAt:serverNow(),revision:0}
    });
    if(!r.committed)throw Error('Ця кімната зайнята. Спробуй ще раз.');
    roomId=id;pageURL.searchParams.set('room',id);history.replaceState(null,'',pageURL.toString());
    listenRoom();alertUser('');
  } catch(e) { alertUser('Не вдалося створити кімнату: '+(e.message||e));$('createBtn').disabled=false; }
}
function listenRoom() {
  if (unsubscribeRoom) { unsubscribeRoom();unsubscribeRoom=null; }
  room=null;state=null;isDJ=false;
  if (!user || !roomPattern.test(roomId)) return;
  roomRef=ref(db,'rooms/'+roomId); stateRef=ref(db,'rooms/'+roomId+'/state');
  unsubscribeRoom=onValue(roomRef, snap => {
    if (!snap.exists()) { room=null;state=null;isDJ=false;status('Немає кімнати','bad');alertUser('Кімната за цим посиланням не знайдена. Створи нову кімнату через головну адресу сайту.');render();return; }
    room=snap.val();state=room.state||null;
    const wasDJ=isDJ;isDJ=(room.djUid===user?.uid && isGoogle());
    status(state?.playing?'● Ефір працює':'● Пауза','ok');render();
    if (listening && playerReady && state) {
      if (isDJ) {
        if (!wasDJ || (state.playlistId && loadedKey!==`playlist:${state.playlistId}`) || (!state.playlistId && state.videoId && loadedKey!==state.videoId && ytVideo()!==state.videoId)) cueDJ();
      } else syncListener();
    }
  }, error => {status('Помилка Firebase','bad');alertUser('Доступ до кімнати заборонений: '+error.message+'. Перевір, чи опубліковані нові правила database.rules.json.');});
}

async function publish(patch) {
  if (!isDJ || !stateRef) return false;
  try { await update(stateRef,{...patch,updatedAt:serverTimestamp(),revision:increment(1)});return true; }
  catch(e) { alertUser('Не вдалося керувати ефіром: '+(e.message||e));return false; }
}
function youtubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytPromise) return ytPromise;
  ytPromise=new Promise((resolve,reject)=>{
    window.onYouTubeIframeAPIReady=()=>resolve(window.YT);
    const el=document.createElement('script');el.src='https://www.youtube.com/iframe_api';
    el.onerror=()=>reject(Error('YouTube IFrame API не завантажився'));
    document.head.appendChild(el);
  });
  return ytPromise;
}
async function join() {
  if (listening || joining || !room) return;
  joining=true;listening=true;
  shown('playerWrap',true);render();playbackHint('Завантажуємо офіційний YouTube-плеєр…');
  try {
    const YT=await youtubeAPI();if(!listening)return;
    player=new YT.Player('player',{
      width:'640',height:'360',playerVars:{playsinline:1,controls:1,enablejsapi:1,origin:location.origin,rel:0},
      events:{
        onReady:()=>{
          playerReady=true;playbackHint('');
          if(isDJ)cueDJ();else syncListener(true);
          if(state?.playing)showUnblock();
        },
        onStateChange:onYTState,
        onError:e=>playbackHint('Помилка YouTube '+e.data+'. Деякі композиції не дозволяють відтворення у вбудованому плеєрі.'),
        onAutoplayBlocked:showUnblock
      }
    });
  } catch(e) { listening=false;shown('playerWrap',false);playbackHint(e.message||String(e));render(); }
  finally{joining=false;}
}
function leave() {
  listening=false;playerReady=false;loadedKey='';lastDJVideo='';
  try{player?.destroy()}catch{}
  player=null;
  $('playerWrap').innerHTML='<div id="player"></div><p class="note">Для прослуховування YouTube вимагає видимий офіційний плеєр.</p>';
  shown('playerWrap',false);shown('unblockBtn',false);playbackHint('');render();
}
function showUnblock() {
  if(!listening || !state?.playing) return;
  shown('unblockBtn',true);
  playbackHint('Браузер може блокувати автоматичний звук. Натисни «Увімкнути відтворення» або Play у YouTube-плеєрі.');
}
function cueDJ() {
  if (!isDJ||!listening||!playerReady||!state)return;
  try {
    if(state.playlistId){ loadedKey='playlist:'+state.playlistId; player.cuePlaylist({listType:'playlist',list:state.playlistId,index:0}); }
    else if(state.videoId){ loadedKey=state.videoId;player.cueVideoById({videoId:state.videoId,startSeconds:songPosition()}); }
  } catch(e){playbackHint('Плеєр не зміг завантажити вибір: '+e.message);}
}
function syncListener(force=false) {
  if(isDJ||!listening||!playerReady||!state?.videoId)return;
  const desired=songPosition();
  try{
    if(loadedKey!==state.videoId){
      loadedKey=state.videoId;
      if(state.playing)player.loadVideoById({videoId:state.videoId,startSeconds:desired});
      else player.cueVideoById({videoId:state.videoId,startSeconds:desired});
      if(state.playing)showUnblock();
      return;
    }
    if(Math.abs(ytTime()-desired)>(force ? 0.9 : 2.5))player.seekTo(desired,true);
    if(state.playing && ytState()!==window.YT.PlayerState.PLAYING){player.playVideo();showUnblock();}
    else if(!state.playing && ytState()===window.YT.PlayerState.PLAYING)player.pauseVideo();
  } catch(e){playbackHint('Не вдалося синхронізуватися: '+e.message);}
}
function onYTState(e) {
  if(!listening||!playerReady)return;
  if(!isDJ){
    if(e.data===window.YT.PlayerState.PLAYING){shown('unblockBtn',false);playbackHint('');syncListener();}
    return;
  }
  if(Date.now()<ignorePlayerUntil)return;
  const vid=ytVideo()||state?.videoId||'';
  if(!videoPattern.test(vid))return;
  const data=player.getVideoData?.()||{};
  const meta={videoId:vid,videoTitle:String(data.title||state?.videoTitle||'YouTube').slice(0,160),channelTitle:String(data.author||state?.channelTitle||'YouTube').slice(0,120)};
  if(e.data===window.YT.PlayerState.PLAYING){
    shown('unblockBtn',false);playbackHint('');
    if(lastDJVideo!==vid||!state?.playing||Date.now()-lastPublished>2200){
      lastDJVideo=vid;lastPublished=Date.now();rememberVideo(vid,meta.videoTitle,meta.channelTitle);publish({...meta,playing:true,position:ytTime()});
    }
  } else if(e.data===window.YT.PlayerState.PAUSED){
    if(state?.playing){lastPublished=Date.now();publish({...meta,playing:false,position:ytTime()});}
  } else if(e.data===window.YT.PlayerState.ENDED&&!state?.playlistId)publish({...meta,playing:false,position:ytTime()});
}
function djPlay() {
  if(!isDJ||!(state?.videoId||state?.playlistId))return;
  if(!listening){join();playbackHint('Після завантаження плеєра натисни «Відтворити» ще раз.');return;}
  if(!playerReady){playbackHint('Плеєр ще завантажується.');return;}
  if(state.playlistId && loadedKey!==`playlist:${state.playlistId}` || !state.playlistId && loadedKey!==state.videoId)cueDJ();
  player.playVideo();
}
function djSeek(delta) {
  if(!isDJ||!playerReady||!state?.videoId)return;
  const pos=Math.max(0,ytTime()+delta);player.seekTo(pos,true);
  publish({videoId:ytVideo()||state.videoId,playing:ytState()===window.YT.PlayerState.PLAYING,position:pos});
}
function djNext(){if(isDJ&&playerReady&&state?.playlistId)player.nextVideo();}

// The OAuth access token stays in memory. Firebase keeps the Google account session, not the short-lived YouTube token.
async function youtubeRequest(path,params) {
  if (!usableGoogleToken()) { googleAccessToken='';render();throw Error('Потрібен доступ до YouTube-каталогу: натисни «Підключити YouTube-каталог».'); }
  const qs=new URLSearchParams(params);
  const res=await fetch('https://www.googleapis.com/youtube/v3/'+path+'?'+qs.toString(),{
    headers:{Authorization:'Bearer '+googleAccessToken}
  });
  let payload={};try{payload=await res.json()}catch{}
  if(!res.ok){
    if(res.status===401){googleAccessToken='';render();}
    throw Error(payload?.error?.message || `Помилка YouTube API ${res.status}`);
  }
  return payload;
}
function clearCards(){ $('catalogResults').replaceChildren(); }
function addCard({image,title,subtitle,buttonText,click,disabled=false}) {
  const card=document.createElement('div');card.className='track';
  const pic=document.createElement('img');pic.alt='Обкладинка';pic.loading='lazy';
  if(image && /^https:\/\//.test(image))pic.src=image;
  const details=document.createElement('div');details.className='details';
  const h=document.createElement('strong');h.textContent=title||'Без назви';
  const s=document.createElement('span');s.textContent=subtitle||'';
  const btn=document.createElement('button');btn.className='small';btn.textContent=buttonText;btn.disabled=disabled;btn.addEventListener('click',click);
  details.append(h,s,btn);card.append(pic,details);$('catalogResults').appendChild(card);
}
async function setSelectedVideo(id,title,channel,playlistId='') {
  if(!isDJ||!videoPattern.test(id))return;
  ignorePlayerUntil=Date.now()+1500;lastDJVideo='';
  const ok=await publish({videoId:id,videoTitle:String(title||'YouTube').slice(0,160),channelTitle:String(channel||'YouTube').slice(0,120),playlistId,playing:false,position:0});
  if(ok){rememberVideo(id,title,channel);catalogMessage('Обрано: '+title+'. Натисни «Відтворити».');if(!listening)join();}
}
async function searchSongs(){
  if(catalogBusy||!isDJ)return;
  const q=$('queryInput').value.trim();if(q.length<2){catalogMessage('Введи хоча б 2 символи назви або виконавця.');return;}
  catalogBusy=true;$('searchBtn').disabled=true;clearCards();catalogMessage('Шукаємо композиції…');
  try {
    const data=await youtubeRequest('search',{part:'snippet',q:q+' music',type:'video',videoEmbeddable:'true',maxResults:'18'});
    const items=(data.items||[]).filter(x=>videoPattern.test(x?.id?.videoId||''));
    if(!items.length)catalogMessage('Нічого не знайдено. Спробуй іншу назву.');else catalogMessage(`Знайдено ${items.length} результатів YouTube.`);
    for(const x of items){const t=x.snippet||{};addCard({image:t.thumbnails?.medium?.url||currentCover(x.id.videoId),title:t.title,subtitle:t.channelTitle,buttonText:'Додати в ефір',click:()=>setSelectedVideo(x.id.videoId,t.title,t.channelTitle)});}
  }catch(e){catalogMessage('Помилка пошуку: '+(e.message||e));}
  finally{catalogBusy=false;$('searchBtn').disabled=false;}
}
async function loadPlaylists(){
  if(catalogBusy||!isDJ)return;
  catalogBusy=true;$('fetchPlaylistsBtn').disabled=true;clearCards();catalogMessage('Завантаження плейлистів…');
  try {
    const data=await youtubeRequest('playlists',{part:'snippet,contentDetails,status',mine:'true',maxResults:'50'});
    const items=data.items||[];
    if(!items.length)catalogMessage('У цьому YouTube-акаунті немає доступних плейлистів. Плейлисти YouTube Music можуть не відображатися через Data API.');
    else catalogMessage(`Доступно ${items.length} плейлистів. Для вбудованого програвання потрібен публічний або доступний за посиланням плейлист.`);
    for(const p of items){
      const privacy=p.status?.privacyStatus||'';
      addCard({image:p.snippet?.thumbnails?.medium?.url||'',title:p.snippet?.title,subtitle:`${p.contentDetails?.itemCount||0} треків · ${privacy||'невідомий доступ'}`,buttonText:privacy==='private'?'Приватний':'Вибрати плейлист',disabled:privacy==='private',click:()=>choosePlaylist(p)});
    }
  }catch(e){catalogMessage('Помилка плейлистів: '+(e.message||e));}
  finally{catalogBusy=false;$('fetchPlaylistsBtn').disabled=false;}
}
async function choosePlaylist(playlist){
  if(!isDJ)return;
  catalogMessage('Отримуємо першу композицію плейлиста…');
  try{
    const data=await youtubeRequest('playlistItems',{part:'snippet,contentDetails',playlistId:playlist.id,maxResults:'10'});
    const item=(data.items||[]).find(x=>videoPattern.test(x.contentDetails?.videoId||x.snippet?.resourceId?.videoId||''));
    if(!item)throw Error('Не знайдено доступної композиції.');
    const vid=item.contentDetails?.videoId||item.snippet?.resourceId?.videoId;
    await setSelectedVideo(vid,item.snippet?.title||playlist.snippet?.title||'Плейлист',item.snippet?.videoOwnerChannelTitle||item.snippet?.channelTitle||'YouTube',playlist.id);
  }catch(e){catalogMessage('Не вдалося вибрати плейлист: '+(e.message||e));}
}
function chooseTab(tab){
  activeCatalogTab=tab;
  shown('searchPane',tab==='search');shown('playlistsPane',tab==='playlists');
  $('searchTab').classList.toggle('active',tab==='search');$('playlistsTab').classList.toggle('active',tab==='playlists');
  clearCards();catalogMessage('');
}

for(const btn of document.querySelectorAll('.nav')){
  btn.addEventListener('click',()=>{
    setNav(btn.id);
    const view=btn.dataset.view;
    if(view==='home')goToSection('homeView');
    else if(view==='explore')goToCatalog('search');
    else if(view==='library'){goToCatalog('playlists');if(isDJ&&usableGoogleToken())loadPlaylists();}
    else if(view==='room')goToSection(room?'roomPane':'setupPane');
  });
}
$('miniGoBtn').addEventListener('click',()=>{setNav('navRoom');goToSection('roomPane');});
$('openExploreBtn').addEventListener('click',()=>{setNav('navExplore');goToCatalog('search');});
for(const chip of document.querySelectorAll('[data-q]')){
  chip.addEventListener('click',()=>{
    for(const node of document.querySelectorAll('[data-q]'))node.classList.toggle('active',node===chip);
    $('queryInput').value=chip.dataset.q;
    setNav('navExplore');
    if(isDJ){goToCatalog('search');searchSongs();}
    else if(room)goToCatalog('search');
    else goToSection('setupPane');
  });
}
$('loginBtn').addEventListener('click',googleLogin);
$('logoutBtn').addEventListener('click',googleLogout);
$('authorizeCatalogBtn').addEventListener('click',googleLogin);
$('createBtn').addEventListener('click',createRoom);
$('joinBtn').addEventListener('click',join);
$('leaveBtn').addEventListener('click',leave);
$('unblockBtn').addEventListener('click',()=>{if(!playerReady)return;if(!isDJ&&state?.videoId)player.seekTo(songPosition(),true);player.playVideo();});
$('copyBtn').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(linkToRoom());$('copyBtn').textContent='✓ Скопійовано';}
  catch{$('shareLink').select();alertUser('Не вдалося скопіювати автоматично. Скопіюй виділену адресу вручну.');}
});
$('playBtn').addEventListener('click',djPlay);
$('pauseBtn').addEventListener('click',()=>{if(isDJ && playerReady)player.pauseVideo();});
$('backBtn').addEventListener('click',()=>djSeek(-10));
$('aheadBtn').addEventListener('click',()=>djSeek(10));
$('nextBtn').addEventListener('click',djNext);
$('searchTab').addEventListener('click',()=>chooseTab('search'));
$('playlistsTab').addEventListener('click',()=>chooseTab('playlists'));
$('searchBtn').addEventListener('click',()=>{setNav('navExplore');if(isDJ){chooseTab('search');goToSection('djPane');searchSongs();}else goToCatalog('search');});
$('queryInput').addEventListener('keydown',e=>{if(e.key==='Enter'){$('searchBtn').click();}});
$('fetchPlaylistsBtn').addEventListener('click',loadPlaylists);
setInterval(()=>{
  if(!listening||!playerReady||!state)return;
  if(isDJ){
    if(ytState()===window.YT.PlayerState.PLAYING && Date.now()-lastPublished>15000){
      lastPublished=Date.now();
      const d=player.getVideoData?.()||{};
      publish({videoId:ytVideo()||state.videoId,videoTitle:String(d.title||state.videoTitle||'YouTube').slice(0,160),channelTitle:String(d.author||state.channelTitle||'YouTube').slice(0,120),playing:true,position:ytTime()});
    }
  } else syncListener();
},7000);
setInterval(()=>{if(room)render();},15000);

async function init(){
  if(!firebaseConfig.apiKey||!firebaseConfig.databaseURL){status('Немає Firebase','bad');alertUser('Перевір config.js — потрібна конфігурація Firebase.');return;}
  if(roomId && !roomPattern.test(roomId)){status('Невірний URL','bad');alertUser('Некоректний ідентифікатор кімнати.');return;}
  try{
    const app=initializeApp(firebaseConfig);db=getDatabase(app);auth=getAuth(app);
    onValue(ref(db,'.info/serverTimeOffset'),s=>{serverOffset=Number(s.val()||0)});
    await setPersistence(auth,browserLocalPersistence);
    onAuthStateChanged(auth,async u=>{
      user=u;
      if(!u){
        if(unsubscribeRoom){unsubscribeRoom();unsubscribeRoom=null;}
        room=null;state=null;isDJ=false;render();
        try{await signInAnonymously(auth)}catch(e){status('Auth недоступний','bad');alertUser('Увімкни Anonymous Authentication: '+(e.message||e));}
        return;
      }
      status(isGoogle()?'● Google підключено':'● Гість підключений','ok');
      if(roomId)listenRoom();else render();
    });
  }catch(e){status('Помилка налаштування','bad');alertUser('Не вдалося підключитися до Firebase: '+(e.message||e));}
}
init();
